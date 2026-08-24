/**
 * RunManager — the daemon-side assembly of one runAgent invocation.
 *
 * `enqueue` is the send_message pipeline: per-session serialization, memory
 * note injection onto a caller-persisted user message, AGENTS.md system
 * prompt, builtin tools, a permission gate, event bus fan-out and JSONL
 * persistence — the composition proven by the integration smoke test, now
 * owned by the server.
 *
 * Composition choices pinned here:
 * - History is read BEFORE the user message is appended: runAgent places its
 *   user message after `history` (`[...input.history, userMsg]`), so it must
 *   not already contain it (would double-send the text to the provider).
 * - The user message is built here as a text-only skeleton and passed via
 *   `RunInput.userMessage`; runAgent uses it verbatim and does NOT re-persist
 *   it. Its note blocks (job provenance + memory notes) are appended — and
 *   the finished message appended to the session log — inside the run's
 *   `onUserMessage` hook, landing between the loop's
 *   message.created and message.completed so the bus carries the wire order
 *   run.started → message.created → note.emitted ×N → message.completed.
 */
import { readFileSync } from "node:fs"
import {
  collectStreamText,
  ConfigPermissionGate,
  createBuiltinTools,
  makeEvent,
  newBlockId,
  newMessage,
  runAgent,
} from "@kclaw/core"
import type {
  AgentEvent,
  KclawConfig,
  KclawPaths,
  LlmClient,
  MemoryStore,
  Message,
  NoteBlock,
  PermissionGate,
  RunOutcome,
  SessionStore,
  ToolCallBlock,
  ToolExecutor,
} from "@kclaw/core"
import type { EventBus } from "./bus.js"
import { ConfirmationBroker, type ConfirmationResolution } from "./confirm.js"
import { scheduleAutoname } from "./autoname.js"

/** System prompt fallback when ~/.kclaw/AGENTS.md is missing or empty. */
const DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"

/** How many chars of the user text feed the memory lookup. */
const MEMORY_QUERY_CHARS = 200
/** Top-N memory notes injected onto the user message. */
const MEMORY_LIMIT = 5

/** Verbatim compaction summarizer system prompt (spec-pinned). */
const COMPACT_SYSTEM_PROMPT =
  "你是对话摘要器。把给定对话（可能包含此前的旧摘要）压缩为不超过500字的中文摘要，保留：关键事实、用户偏好与约定、已做的决定、未完成事项。直接输出摘要正文，不要任何前后缀。"

/** Per-message line cap in the compaction conversation rendering. */
const RENDER_LINE_MAX_CHARS = 2000

/** Verbatim memory-extraction system prompt (spec-pinned). */
const EXTRACT_SYSTEM_PROMPT =
  "从对话中提取值得长期记住的用户个人事实（居住地、偏好、约定、背景等）。只输出 JSON 字符串数组，无值得记的内容输出 []。"

/**
 * Render a message list as one line per message (`user: <text>` /
 * `assistant: <text>`): text and note block contents joined by spaces;
 * tool_call/tool_result blocks are skipped; a message without text renders
 * as `<tool use>`; each line truncated at 2000 chars. Shared with the
 * auto-memory pipeline (T3).
 */
function renderConversation(messages: Message[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const parts: string[] = []
    for (const b of m.blocks) {
      if (b.type === "text" || b.type === "note") parts.push(b.text)
    }
    const body = parts.join(" ").trim()
    let line = `${m.role}: ${body === "" ? "<tool use>" : body}`
    if (line.length > RENDER_LINE_MAX_CHARS) line = line.slice(0, RENDER_LINE_MAX_CHARS)
    lines.push(line)
  }
  return lines.join("\n")
}

export interface RunManagerDeps {
  config: KclawConfig
  paths: KclawPaths
  sessions: SessionStore
  memory: MemoryStore
  bus: EventBus
  llm: LlmClient
  workspace: string
  /**
   * Model string sent to the provider: the daemon resolves it once
   * — provider entry, KCLAW_LLM_MODEL env fallback — because an env-only
   * provider would otherwise leave the config-derived model empty. Optional
   * for backwards compatibility: when omitted, the default provider's
   * config model is used as before (empty string when unconfigured).
   */
  model?: string
  /**
   * Confirmation gateway: pending confirmations register here when
   * the gate issues them, and WS/CLI verdicts settle through it. Missing → a
   * fresh internal broker, exposed as `manager.broker` (the daemon hands the
   * RunManager to createApp via its `run` option, which routes
   * confirmation.resolve frames to this broker).
   */
  broker?: ConfirmationBroker
  /**
   * Direct resolver override for tests. Takes precedence over the broker when
   * set — the daemon path relies on the broker alone.
   */
  resolveConfirmation?: (confirmationId: string) => Promise<{ approved: boolean; by: "cli" | "web" | "timeout" }>
  /**
   * Retry-visible llm per run: when set, EVERY
   * run builds its own client through this factory, receiving that run's
   * retry sink as `onRetry` — provider-level retries (the daemon's default
   * withRetry composition) then surface as `llm.failed {willRetry:true}`
   * events carrying THIS run's sessionId/runId, even while other sessions
   * run concurrently against the same endpoint. Takes precedence over `llm`.
   * The daemon sets it for its default composition; injected test factories
   * (plain script clients) leave it unset and use `llm` as before.
   */
  llmForRun?: (onRetry: LlmRetrySink) => LlmClient
  /**
   * Per-name executor overrides for tests/adapters:
   * merged OVER the builtin tools after construction (defs stay the
   * builtins'), so a test can swap one executor — e.g. for one that throws —
   * without rebuilding the toolset.
   */
  tools?: Map<string, ToolExecutor>
}

/** One queued run request. */
export interface EnqueueInput {
  userText: string
  trigger: "user" | "job"
  /**
   * Job provenance note: when the scheduler fires a job, the tick
   * passes the 「本会话由定时任务…」 line here and it lands as a kind:"job"
   * note block right after the text block on the user message.
   */
  note?: string
}

/** withRetry's per-attempt notification shape (core provider/retry.ts onRetry). */
export type LlmRetrySink = (info: { attempt: number; error: unknown }) => void

/**
 * Mirror of the loop's raceConfirmation (core agent/loop.ts): a human
 * resolver raced against the same confirmTimeoutMs timer and the run's abort
 * signal. On a timeout the LOOP synthesizes `{approved: false, by:
 * "timeout"}` itself and never settles the human promise, so the resolver
 * alone would never fire the broker-expire that marks the entry stale.
 * Racing here keeps this adapter's view of the resolution semantically
 * identical to the one the loop acted on (same timeout on both sides yields
 * the same value; a human verdict that wins here also wins there), and a
 * losing late verdict is discarded by the settled race.
 */
function raceResolution(
  p: Promise<ConfirmationResolution>,
  ms: number,
  signal: AbortSignal,
): Promise<ConfirmationResolution | "aborted"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const sleep = new Promise<ConfirmationResolution>((resolve) => {
    timer = setTimeout(() => resolve({ approved: false, by: "timeout" }), ms)
  })
  let onAbort = () => {}
  const abort = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted")
    else {
      onAbort = () => resolve("aborted")
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
  return Promise.race([p, sleep, abort]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  })
}

export class RunManager {
  readonly #deps: RunManagerDeps
  /** Tail of each session's run chain: same session serializes, sessions run concurrently. */
  readonly #chains = new Map<string, Promise<void>>()
  /** Abort controller of the session's ACTIVE run; absent while idle or queued. */
  readonly #active = new Map<string, AbortController>()
  /** Sessions whose QUEUED run was cancelled before it could start. */
  readonly #cancelQueued = new Set<string>()
  /** Confirmation gateway shared by every run; injected or internally constructed. */
  readonly #broker: ConfirmationBroker

  constructor(deps: RunManagerDeps) {
    this.#deps = deps
    this.#broker = deps.broker ?? new ConfirmationBroker()
  }

  /** The confirmation gateway this manager's runs answer through (WS/CLI verdicts land here). */
  get broker(): ConfirmationBroker {
    return this.#broker
  }

  /**
   * Queue one run on the session. The returned promise settles with the
   * runAgent outcome once every earlier enqueue on the SAME session has
   * settled; enqueues on different sessions proceed concurrently.
   */
  enqueue(sessionId: string, input: EnqueueInput): Promise<RunOutcome> {
    const prev = this.#chains.get(sessionId) ?? Promise.resolve()
    const run = prev.then(() => this.#execute(sessionId, input))
    // The chain tail swallows failures: one failed run must not poison the
    // session's queue for the next enqueue.
    const tail = run.then(() => undefined, () => undefined)
    this.#chains.set(sessionId, tail)
    // Drop the chain entry the moment the run itself settles — not one
    // tail-hop later: a cancel() issued from that run's awaiter continuation
    // must already see "nothing queued", and the tail-attached cleanup ran one
    // microtask behind it, leaving #chains.has stale-true after the last run.
    const dropChain = () => {
      if (this.#chains.get(sessionId) === tail) this.#chains.delete(sessionId)
    }
    void run.then(dropChain, dropChain)
    return run
  }

  /**
   * Abort the session's active run (it stops at the next checkpoint with
   * stopReason "aborted"). True — and a cancelled-at-dequeue mark — when the
   * session has no ACTIVE run but a QUEUED one: that run aborts the moment it
   * leaves the queue, before any work. False when the session has neither.
   */
  cancel(sessionId: string): boolean {
    const controller = this.#active.get(sessionId)
    if (controller !== undefined) {
      controller.abort()
      return true
    }
    if (this.#chains.has(sessionId)) {
      this.#cancelQueued.add(sessionId)
      return true
    }
    return false
  }

  async #execute(sessionId: string, input: EnqueueInput): Promise<RunOutcome> {
    // Register the controller BEFORE any await: the window between dequeue
    // and the old registration point (after memory search / history read)
    // made cancel answer "no active run" for a run that then ran to completion.
    const controller = new AbortController()
    this.#active.set(sessionId, controller)
    if (this.#cancelQueued.delete(sessionId)) controller.abort()
    const { config, paths, sessions, memory, bus, llm } = this.#deps
    const sessionMeta = sessions.meta(sessionId)
    const workspace = sessionMeta?.workdir ?? this.#deps.workspace

    // Memory injection: the leading 200 chars of the user text
    // look up the top-5 notes. Memory is an accelerator — a failing search
    // must never block the run, so misses/errors just mean no notes.
    const notes: NoteBlock[] = []
    try {
      for (const hit of await memory.search(input.userText.slice(0, MEMORY_QUERY_CHARS), MEMORY_LIMIT)) {
        notes.push({ id: newBlockId(), type: "note", kind: "memory", text: `相关记忆: ${hit.text}` })
      }
    } catch {
      // ignore: run without memory context
    }

    // History BEFORE the append (runAgent appends the user message itself).
    // The user message starts as a text-only SKELETON: its note blocks (job
    // provenance first, memory notes after) are appended inside
    // the run's onUserMessage hook, right after the loop announced the
    // skeleton via message.created, so the bus carries the wire order
    // run.started → message.created → note.emitted ×N → message.completed,
    // with the note events (inside the hook) trailing the JSONL append —
    // the persist happens first, then the notes are announced.
    const history = sessions.readMessages(sessionId)
    const jobNote: NoteBlock[] =
      input.note === undefined
        ? []
        : [{ id: newBlockId(), type: "note", kind: "job", text: input.note }]
    const userMessage = newMessage(sessionId, "user", [
      { id: newBlockId(), type: "text", text: input.userText },
    ])

    const { tools, toolDefs } = createBuiltinTools({
      workspace,
      memory,
      tavilyApiKey: config.web.tavilyApiKey,
      exec: { timeoutMs: config.exec.timeoutMs, maxOutputBytes: config.exec.maxOutputBytes },
      web: { timeoutMs: config.web.timeoutMs, allowPrivateNetworks: config.web.allowPrivateNetworks },
    })
    // test/adapter seam: per-name executor overrides on top of the
    // builtins; toolDefs stay the builtins' — an override replaces behavior,
    // not the schema the model sees.
    if (this.#deps.tools !== undefined) {
      for (const [name, executor] of this.#deps.tools) tools.set(name, executor)
    }

    // --- permission wiring (config gate + confirmation gateway) ---
    const pendingConfirmations = new Map<string, ToolCallBlock>()

    const baseGate = new ConfigPermissionGate(config.permissions, {
      workspace,
      safeTools: new Set([...tools].filter(([, t]) => t.risk === "safe").map(([name]) => name)),
    })
    const confirmTimeoutMs = config.permissions.confirmTimeoutMs
    const broker = this.#broker
    const gate: PermissionGate = {
      async check(toolCall) {
        const decision = await baseGate.check(toolCall)
        if (decision.type === "confirm") {
          pendingConfirmations.set(decision.confirmationId, toolCall)
          // Gateway registration under the gate-issued id (the loop echoes it
          // in its confirmation.requested event, which is what a WS client
          // resolves against). Purely registration — the loop emits the event
          // itself; the broker never emits.
          broker.create(
            decision.confirmationId,
            toolCall,
            tools.get(toolCall.name)?.risk ?? "sensitive",
            confirmTimeoutMs,
            sessionId,
          )
        }
        return decision
      },
    }

    // Confirmation answering: deps' direct resolver when wired (test seam),
    // else the broker's pending promise (the daemon path: WS/CLI verdicts
    // settle it). The resolver is raced against the SAME timeout the loop
    // races against (raceResolution above). Whenever the race settles WITHOUT
    // a human verdict (timeout/abort), the broker entry goes stale so a late
    // gateway resolve reports "unknown confirmation" instead of acking a
    // verdict nothing will act on.
    const baseResolver =
      this.#deps.resolveConfirmation ?? ((confirmationId: string) => broker.wait(confirmationId))
    const resolveConfirmation = async (confirmationId: string): Promise<ConfirmationResolution> => {
      const raced = await raceResolution(baseResolver(confirmationId), confirmTimeoutMs, controller.signal)
      if (raced === "aborted") {
        pendingConfirmations.delete(confirmationId)
        broker.expire(confirmationId)
        // the value is never used: the loop's own race resolved "aborted" and
        // denies without consulting the resolver
        return { approved: false, by: "timeout" }
      }
      pendingConfirmations.delete(confirmationId)
      if (raced.by === "timeout") broker.expire(confirmationId)
      return raced
    }

    // --- retry visibility --------------------------------------------------------
    // Provider-level retries live inside the llm wrapper (withRetry), where
    // the loop cannot see them. When deps.llmForRun is set, the wrapper's
    // onRetry lands in THIS closure: each notification becomes an
    // `llm.failed {willRetry:true}` event on the bus (so clients can tell a
    // hung call from a backoff), and advances the attempt counter the loop's
    // llm.started reads via AgentDeps.llmAttempt. The counter is per llm
    // call — a completed/failed call resets it, so the next iteration's
    // llm.started reports a fresh attempt 1. The runId is learned from the
    // loop's own run.started (always a run's first event, emitted before any
    // stream — and therefore before any retry — can start).
    let runId: string | undefined
    let llmAttempt = 1
    const busEmit = (e: AgentEvent): void => {
      try {
        bus.emit(e)
      } catch {
        // one broken subscriber must not kill the run — bus.emit already
        // guards each socket individually; this guard covers the remaining
        // synchronous work in emit, e.g. JSON.stringify
      }
    }
    const onLlmRetry: LlmRetrySink = (info) => {
      llmAttempt = info.attempt + 1
      busEmit(makeEvent("llm.failed", {
        error: {
          code: "llm_retry",
          message: String((info.error as { message?: string } | null | undefined)?.message ?? info.error),
        },
        willRetry: true,
      }, runId === undefined ? { sessionId } : { sessionId, runId }))
    }
    const runLlm = this.#deps.llmForRun?.(onLlmRetry) ?? llm
    const model = this.#deps.model ?? config.providers.entries[config.providers.default]?.model ?? ""

    // --- pre-run context compaction -------------------------------------------
    // Slice the history at the session's compaction marker (when valid) and,
    // when the ACTIVE window has grown past the threshold, roll the oldest
    // segment into a summary first. Any failure (LLM throw, updateMeta throw)
    // falls back to the status quo: full history, no note — the loop's own
    // window truncation remains the safety net.
    let activeHistory = history
    let compactNote: NoteBlock[] = []
    try {
      const compaction = await this.#compact(
        sessionId,
        history,
        config.sessions.compactThreshold ?? 40,
        config.sessions.compactKeep ?? 25,
        runLlm,
        model,
      )
      activeHistory = compaction.active
      if (compaction.summary !== undefined) {
        compactNote = [{
          id: newBlockId(),
          type: "note",
          kind: "compact",
          text: `早期对话已压缩（保留最近 ${compaction.active.length} 条原文）。摘要：${compaction.summary}`,
        }]
      }
    } catch (err) {
      console.error("kclaw compaction failed:", err)
    }

    try {
      const outcome = await runAgent(
        {
          sessionId,
          history: activeHistory,
          system: this.#systemPrompt(paths.agentsMd),
          userText: input.userText, // ignored by the loop when userMessage is set
          trigger: input.trigger,
          userMessage,
        },
        {
          llm: runLlm,
          model,
          tools,
          toolDefs,
          permissions: gate,
          resolveConfirmation,
          confirmTimeoutMs,
          signal: controller.signal,
          llmAttempt: () => llmAttempt,
          onUserMessage: (m) => {
            // The notes become part of the message BEFORE it is
            // persisted and completed. Persist first (events trail persisted
            // state), then announce each note — the loop's message.completed
            // follows, so the wire order stays
            // created → note.emitted ×N → completed. runId is known by now
            // (run.started is always a run's first event and precedes this
            // hook); the sessionId-only fallback is defensive only.
            m.blocks.push(...jobNote, ...compactNote, ...notes)
            sessions.appendMessage(sessionId, m)
            if (input.trigger !== "job") {
              const firstText = m.blocks.find((b) => b.type === "text")?.text ?? ""
              void scheduleAutoname(
                { sessions, llm: runLlm, model },
                sessionId, firstText,
              )
            }
            const noteCtx = runId === undefined ? { sessionId } : { sessionId, runId }
            for (const block of [...jobNote, ...compactNote, ...notes]) {
              busEmit(makeEvent("note.emitted", { messageId: m.id, block }, noteCtx))
            }
            return m
          },
          onEvent: (e) => {
            if (e.type === "run.started" && e.runId !== undefined) runId = e.runId
            else if (e.type === "llm.completed" || e.type === "llm.failed") llmAttempt = 1
            busEmit(e)
          },
          onMessage: (m) => sessions.appendMessage(m.sessionId, m),
        },
      )
      // Auto memory extraction: fire-and-forget after a clean end_turn —
      // never awaited, never affects the returned outcome; any failure
      // inside #extractMemory lands in the .catch below as a log line.
      if (outcome.stopReason === "end_turn" && config.memory.autoExtract === true) {
        const extractModel = config.memory.extractModel || model
        void this.#extractMemory(sessionId, outcome.messages, runLlm, extractModel)
          .catch((err) => console.error("kclaw memory extraction failed:", err))
      }
      return outcome
    } finally {
      if (this.#active.get(sessionId) === controller) this.#active.delete(sessionId)
    }
  }

  /**
   * Extract durable personal facts from a finished run's messages with one
   * tool-less LLM call and save each as a source-"auto" memory note (save's
   * own findSimilar dedupes/merges). The response is trimmed, an optional
   * ```json fence is stripped, then JSON.parsed — a non-array payload or any
   * non-string element abandons the whole batch (log only, no partial
   * writes); an empty array writes nothing. A single failing save is logged
   * and the remaining facts still go in. All throws propagate to the
   * caller's fire-and-forget .catch.
   */
  async #extractMemory(
    sessionId: string,
    messages: Message[],
    runLlm: LlmClient,
    model: string,
  ): Promise<void> {
    const raw = await collectStreamText(runLlm, {
      model,
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: renderConversation(messages) }],
      tools: [],
    })
    let text = raw.trim()
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
    if (fenced !== null) text = fenced[1]!.trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      console.error(`kclaw memory extraction (${sessionId}): unparseable response:`, err)
      return
    }
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
      console.error(`kclaw memory extraction (${sessionId}): response is not a string array, skipping`)
      return
    }
    for (const fact of parsed) {
      try {
        await this.#deps.memory.save({ text: fact, source: "auto" })
      } catch (err) {
        console.error(`kclaw memory extraction (${sessionId}): save failed:`, err)
      }
    }
  }

  /**
   * Slice `history` at the session's compaction marker and, when the active
   * window reaches `threshold`, roll its oldest segment (all but the last
   * `keep` messages) into a summary via one tool-less LLM call, persisting
   * `{ compactedSummary, compactedUpto }` on the session meta. Returns the
   * post-marker (post-compaction) active window plus the summary to inject
   * as a compact note — an absent marker means the full history is active; a
   * marker whose message id no longer exists (corrupt/hand-edited) is
   * likewise treated as absent. BELOW threshold the marker slice still
   * applies and the EXISTING summary (if any) is returned so the note stays
   * visible every turn. Throws propagate: the caller falls back to the
   * unsliced status quo.
   */
  async #compact(
    sessionId: string,
    history: Message[],
    threshold: number,
    keep: number,
    runLlm: LlmClient,
    model: string,
  ): Promise<{ summary: string | undefined; active: Message[] }> {
    const { sessions } = this.#deps
    const meta = sessions.meta(sessionId)
    const markerIdx = meta?.compactedUpto === undefined
      ? -1
      : history.findIndex((m) => m.id === meta.compactedUpto)
    const active = markerIdx >= 0 ? history.slice(markerIdx + 1) : history
    if (active.length >= threshold && keep < active.length) {
      const seg = active.slice(0, active.length - keep)
      const prev = meta?.compactedSummary
      const content = prev === undefined
        ? renderConversation(seg)
        : `${prev}\n\n以下是需要并入的最新被压缩对话：\n${renderConversation(seg)}`
      const summary = await collectStreamText(runLlm, {
        model,
        system: COMPACT_SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
        tools: [],
      })
      sessions.updateMeta(sessionId, { compactedSummary: summary, compactedUpto: seg[seg.length - 1]!.id })
      return { summary, active: active.slice(-keep) }
    }
    return { summary: meta?.compactedSummary, active }
  }

  /** AGENTS.md persona when the file exists and is non-empty; default otherwise. */
  #systemPrompt(agentsMd: string): string {
    try {
      const md = readFileSync(agentsMd, "utf8")
      if (md.trim() !== "") return md
    } catch {
      // missing/unreadable AGENTS.md → default persona
    }
    return DEFAULT_SYSTEM_PROMPT
  }
}
