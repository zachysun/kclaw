/**
 * executeRun — the daemon-proven assembly of ONE agent run (card ① engine
 * relocation, moved verbatim from server/src/run.ts `#execute` and its
 * helpers).
 *
 * This is the engine side of the handoff: the server's RunManager owns the
 * queue (ordering, cancellation bookkeeping, queue.jsonl persistence) and,
 * for each dequeued entry, calls {@link executeRun} with the shared deps and
 * a drainSteer callback (the steer buffer is queue state, so it stays with
 * the queue).
 *
 * Composition choices pinned here (unchanged from the run.ts days):
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
 * - Memory injection is an accelerator: a failing search never blocks the
 *   run (misses/errors just mean no notes).
 * - A failing usage record never affects the run; a failing follow-gate
   * schedule never affects the run.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent } from "../protocol/events.js"
import { makeEvent } from "../protocol/events.js"
import type { AttachmentBlock, NoteBlock, ToolCallBlock } from "../protocol/blocks.js"
import { newBlockId } from "../protocol/blocks.js"
import { newId } from "../protocol/ids.js"
import type { Message } from "../protocol/messages.js"
import { newMessage } from "../protocol/messages.js"
import type { AttachmentRef } from "../protocol/wire.js"
import type { LlmClient, ProviderMessage, ToolDefinition } from "../provider/types.js"
import { collectStreamText } from "../provider/collect.js"
import type { KclawConfig } from "../storage/config.js"
import type { KclawPaths } from "../storage/paths.js"
import type { UsageStore } from "../storage/usage.js"
import { estimateContextTokens } from "../session/compaction.js"
import type { SessionStore } from "../session/store.js"
import { scheduleAutoname } from "../session/autoname.js"
import type { Compactor } from "../session/compactor.js"
import { ConfigPermissionGate, realpathWithin } from "../permissions/engine.js"
import type { PermissionGate, RunOutcome } from "./loop.js"
import { runAgent } from "./loop.js"
import type { SessionSearchFn } from "../tools/session.js"
import type { ToolExecutor } from "./tools.js"
import { withLastUserText } from "./context.js"
import { createBuiltinTools } from "../tools/index.js"
import { searchSessionEvents } from "../tools/session-search.js"
import { matchSkillInvocations, scanSkillDirs, skillListPrompt, wrapSkillInvocations } from "../skills/index.js"
import type { MemorySystem } from "../memory/system.js"
import type { EventBus } from "../bus.js"
import { ConfirmationBroker, type ConfirmationResolution } from "../permissions/broker.js"

/** System prompt fallback when ~/.kclaw/AGENTS.md is missing or empty. */
const DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"

/** How many chars of the user text feed the memory lookup. */
const MEMORY_QUERY_CHARS = 200
/** Top-N memory notes injected onto the user message. */
const MEMORY_LIMIT = 5

/** Text-like MIME/exif: inlined into context when small enough. */
const TEXT_MIME = /^text\//
const TEXT_EXT = /\.(md|txt|json|csv|yaml|yml|xml|log|ts|js|tsx|jsx|py|go|rs|sh|toml|ini|env)$/i
/** Cap for inlining a text attachment into the prompt (chars). */
const TEXT_INLINE_MAX_CHARS = 8 * 1024
/** Cap for reading a text attachment off disk (bytes). */
const TEXT_INLINE_MAX_BYTES = 64 * 1024
/** Cap for embedding an image as base64 (bytes). */
const IMAGE_INLINE_MAX_BYTES = 5 * 1024 * 1024

/** withRetry's per-attempt notification shape (core provider/retry.ts onRetry). */
export type LlmRetrySink = (info: { attempt: number; error: unknown }) => void

/**
 * One queued run request (moved from server run.ts; the queue state machine
 * and the engine share this shape).
 */
export interface EnqueueInput {
  userText: string
  trigger: "user" | "job"
  /**
   * Per-run model override (a job's configured model, or a client-forced
   * one). Priority per run: input.model > session meta model > daemon
   * default. Absent → the daemon default applies.
   */
  model?: string
  /**
   * Attachments to mount onto the user message: references to files
   * already uploaded under `<home>/attachments/<sessionId>/` (validated
   * by the caller and defensively re-checked here).
   */
  attachments?: AttachmentRef[]
  /**
   * Job provenance note: when the scheduler fires a job, the tick
   * passes the 「本会话由定时任务…」 line here and it lands as a kind:"job"
   * note block right after the text block on the user message.
   */
  note?: string
  /** 单次显式处置（spec §6 层级最高）；缺省 = 会话覆盖 ?? 配置默认；job 触发强制 wait。 */
  disposition?: "steer" | "wait" | "interrupt"
  /** 内部：出队执行时传入的预分配消息 id（ws 层不传）。 */
  messageId?: string
}

/**
 * Engine deps: everything one run's assembly may reach. The daemon wires all
 * of these once (RunManager holds the same set); tests inject fakes.
 */
export interface RunEngineDeps {
  config: KclawConfig
  paths: KclawPaths
  sessions: SessionStore
  memory: MemorySystem
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
   * The RESOLVED confirmation gateway (RunManager guarantees one exists —
   * injected or internally constructed).
   */
  broker: ConfirmationBroker
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
  /**
   * Live adapter tools (e.g. the MCP manager): a FUNCTION evaluated per run,
   * so connections that come up or drop between runs (or mid-reconnect)
   * are reflected in the next LLM request. Defs are appended to the
   * builtin defs; a name collision with a builtin logs once and the
   * adapter's executor wins (schema follows the executor).
   */
  extraTools?: () => { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] }
  /** Per-run token ledger (optional; recording failures are swallowed). */
  usageStore?: UsageStore
  /** Daemon-level readonly flag (`--readonly`): all sessions start read-only. */
  readonly?: boolean
}

/** What the queue hands the engine alongside one dequeued entry. */
export interface RunHandoff {
  sessionId: string
  input: EnqueueInput
  /** The run's abort controller, registered by the queue BEFORE any await. */
  controller: AbortController
  /**
   * Steer injection (spec §5.1): the queue owns the steer buffer; the loop
   * drains it at iteration boundaries through this callback.
   */
  drainSteer: () => Message[]
}

/** The engine bundle: shared deps plus the compactor (per-run triggers). */
export interface RunEngine {
  deps: RunEngineDeps
  compactor: Compactor
}

/**
 * Turn attachment references into attachment blocks on the user message.
 * Decision per file: text-like and small → inline text (capped); image and
 * small → base64 source (multimodal parts); anything else → metadata only,
 * the agent reads it on demand via fs_read. Any path outside the session's
 * attachments dir is rejected (defense in depth — the caller validates too).
 */
export function mountAttachments(refs: AttachmentRef[], attachmentsDir: string, sessionId: string): AttachmentBlock[] {
  const blocks: AttachmentBlock[] = []
  for (const ref of refs) {
    const root = realpathWithin(join(attachmentsDir, sessionId))
    const resolved = realpathWithin(ref.path)
    if (resolved !== root && !resolved.startsWith(root + "/")) {
      throw new Error(`attachment outside the session's attachments dir: ${ref.path}`)
    }
    const isText = TEXT_MIME.test(ref.mimeType) || TEXT_EXT.test(ref.name)
    const isImage = ref.mimeType.startsWith("image/")
    if (isText && ref.size <= TEXT_INLINE_MAX_BYTES) {
      let text = readFileSync(resolved, "utf8")
      if (text.length > TEXT_INLINE_MAX_CHARS) text = `${text.slice(0, TEXT_INLINE_MAX_CHARS)}\n…[已截断]`
      blocks.push({ id: newBlockId(), type: "attachment", mimeType: ref.mimeType, name: ref.name, text, source: { type: "file", path: resolved } })
    } else if (isImage && ref.size <= IMAGE_INLINE_MAX_BYTES) {
      blocks.push({ id: newBlockId(), type: "attachment", mimeType: ref.mimeType, name: ref.name, source: { type: "base64", data: readFileSync(resolved).toString("base64") } })
    } else {
      blocks.push({ id: newBlockId(), type: "attachment", mimeType: ref.mimeType, name: ref.name, source: { type: "file", path: resolved } })
    }
  }
  return blocks
}

/**
 * Mirror of the loop's raceConfirmation (agent/loop.ts): a human
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

/**
 * Execute one dequeued entry — the former RunManager `#execute`, verbatim.
 * The controller arrives pre-registered by the queue's #executeEntry (before
 * any await), so cancellation windows and active-cleanup stay with the
 * queue; this function only consumes its signal.
 */
export async function executeRun(engine: RunEngine, handoff: RunHandoff): Promise<RunOutcome> {
  const { sessionId, input, controller } = handoff
  // 压缩取消标记只压制一次运行（spec 5.3 第 6 条）：新运行从干净状态开始。
  engine.compactor.clearCancelled(sessionId)
  const { config, paths, sessions, memory, bus } = engine.deps
  const sessionMeta = sessions.meta(sessionId)
  const workspace = sessionMeta?.workdir ?? engine.deps.workspace

  // Memory injection: the leading 200 chars of the user text look up the
  // top-5 episodes via the v2 MemorySystem facade and land as kind:"memory"
  // notes on the user message. Memory is an accelerator — a failing search
  // must never block the run, so misses/errors just mean no notes.
  const notes: NoteBlock[] = []
  try {
    for (const hit of await memory.searchEpisodes(workspace, input.userText.slice(0, MEMORY_QUERY_CHARS), MEMORY_LIMIT)) {
      notes.push({ id: newBlockId(), type: "note", kind: "memory", text: `相关经历（${hit.title}）: ${hit.text}` })
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
    ...mountAttachments(input.attachments ?? [], paths.attachmentsDir, sessionId),
  ])
  if (input.messageId !== undefined) userMessage.id = input.messageId // 气泡原地升级（spec §3.1）

  // 技能目录每 run 重扫（渐进披露第一层）：全局 + 会话工作目录的项目级，
  // 项目同名整目录覆盖。列表段追加进系统提示词，与 system 审计事件同文；
  // skill_read 工具持有同一份扫描结果（第二层，按需取正文）。
  const skills = scanSkillDirs({
    global: paths.skillsDir,
    project: join(workspace, ".kclaw", "skills"),
  })

  // 技能点名的隐式包装（Master 2026-09-03）：用户消息里任意位置的 /技能名
  // 记号精确命中已装且用户可调用的技能时，只在发给模型的那份输入上追加
  // 一行调用指示——持久化、事件流与气泡保持原始文本（所见即所发）。
  // 仅 trigger:user 生效：job 提示是 daemon 生成的内部指令，不参与点名。
  const llmUserText =
    input.trigger === "user"
      ? wrapSkillInvocations(input.userText, matchSkillInvocations(input.userText, skills))
      : undefined

  const { tools, toolDefs } = createBuiltinTools({
    workspace,
    memoryCtx: {
      system: memory,
      sessionId,
      workdir: workspace,
      immediateEnabled: config.memory.write.immediate,
    },
    tavilyApiKey: config.web.tavilyApiKey,
    exec: { timeoutMs: config.exec.timeoutMs, maxOutputBytes: config.exec.maxOutputBytes },
    web: { timeoutMs: config.web.timeoutMs, allowPrivateNetworks: config.web.allowPrivateNetworks },
    sessionSearch: buildSessionSearch(engine.deps, sessionId),
    skills,
  })
  // test/adapter seam: per-name executor overrides on top of the
  // builtins; toolDefs stay the builtins' — an override replaces behavior,
  // not the schema the model sees.
  if (engine.deps.tools !== undefined) {
    for (const [name, executor] of engine.deps.tools) tools.set(name, executor)
  }
  // Live adapter tools (MCP manager): defs appended, executor wins on a
  // name collision with a log line (schema follows the executor).
  if (engine.deps.extraTools !== undefined) {
    const extra = engine.deps.extraTools()
    for (const [name, executor] of extra.executors) {
      if (tools.has(name)) console.error(`kclaw tool name collision: ${name} (adapter overrides builtin)`)
      tools.set(name, executor)
    }
    toolDefs.push(...extra.defs)
  }

  // --- permission wiring (config gate + confirmation gateway) ---
  const pendingConfirmations = new Map<string, ToolCallBlock>()

  const baseGate = new ConfigPermissionGate(config.permissions, {
    workspace,
    safeTools: new Set([...tools].filter(([, t]) => t.risk === "safe").map(([name]) => name)),
    // Attachment reads: files under <home>/attachments are the daemon's own
    // uploaded inputs — fs_read/fs_list reach them without a confirmation.
    readRoots: [paths.attachmentsDir],
    // Readonly: the daemon-level flag OR this session's own toggle.
    readonly: engine.deps.readonly === true || sessionMeta?.readonly === true,
  })
  const confirmTimeoutMs = config.permissions.confirmTimeoutMs
  const broker = engine.deps.broker
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
    engine.deps.resolveConfirmation ?? ((confirmationId: string) => broker.wait(confirmationId))
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
  const runLlm = engine.deps.llmForRun?.(onLlmRetry) ?? engine.deps.llm
  const defaultModel = engine.deps.model ?? config.providers.entries[config.providers.default]?.model ?? ""
  // A session/job model may name a provider ENTRY ("deepseek") whose wire
  // model is the entry's `.model` ("deepseek-v4-flash"); resolve keys to that
  // model, leaving already-raw API model names untouched.
  const resolveEntry = (m: string): string => config.providers.entries[m]?.model ?? m
  const model = resolveEntry(input.model ?? sessionMeta?.model ?? defaultModel)

  // --- v3 compaction triggers (spec 5.1-5.3, 5.8) -------------------------
  // 发消息零压缩（开场预压缩已删除）。三条触发路径全部由 server 注入：
  // 中途（迭代边界水位 ≥ 红线，经循环钩子）、超限（onContextOverflow 急救）、
  // 收尾（runAgent 返回后水位 ≥ 黄线）。水位锚定最后一条 assistant 的真实
  // usage，黄/红两线的读点集中在此。
  const budget = config.sessions.contextTokens ?? 128_000
  const atRatio = config.sessions.compactAtRatio ?? 0.66
  const panicRatio = config.sessions.compactPanicRatio ?? 0.85

  // 系统提示词审计事件（第 9 种持久化事件）：拼装完成后、进入模型循环前把
  // 全量文本落盘一条 system 事件。每 run 恰好一条——steer 注入与 run 内多次
  // 模型调用复用同一份提示词，不重复记录；不加幻影会话守卫（与消息写入一致），
  // 也不吞错：写入失败即本次 run 失败，由驱动器的条目级失败兜底。
  const system = systemWithCognition(engine.deps, paths.agentsMd, workspace, skillListPrompt(skills))
  sessions.appendSystem(sessionId, { at: new Date().toISOString(), text: system })

  const outcome = await runAgent(
    {
      sessionId,
      history,
      system,
      userText: input.userText, // ignored by the loop when userMessage is set
      trigger: input.trigger,
      userMessage,
      // 运行起点的压缩视图（来自会话 meta）：upto（含）之前的原文不再发送，
      // 脉络项由打包台垫在 messages[0]。
      ...(sessionMeta?.compaction !== undefined
        ? { compaction: { upto: sessionMeta.compaction.upto, top: sessionMeta.compaction.top } }
        : {}),
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
      // 模型视图改写钩子（LLM 执行前）：技能点名的隐式包装在这里生效——
      // 只改发给模型的消息，持久化/事件流/气泡保持用户原文；未命中为
      // undefined，行为与从前完全一致。
      ...(llmUserText === undefined
        ? {}
        : { mapLlmMessages: (msgs: ProviderMessage[]) => withLastUserText(msgs, llmUserText) }),
      toolResultKeep: config.sessions.toolResultKeep ?? 8,
      // 省略预算（黄线值）透传给打包台：预算装不下的工具输出以省略占位符发送
      tokenBudget: budget * atRatio,
      // steer 注入口（spec §5.1）：迭代边界经 handoff 回调取队列的缓冲区。
      steering: handoff.drainSteer,
      // 中途压缩钩子（spec 5.3 第 5 条）：取消标记或 run 已中止 → 不压；
      // 水位 < 红线 → 不压；否则独立可取消地压缩，返回新视图（下一次请求生效）。
      midRunCompaction: () => {
        if (engine.compactor.cancelled(sessionId) || controller.signal.aborted) return Promise.resolve(null)
        const boundaryHistory = sessions.readMessages(sessionId)
        if (estimateContextTokens(boundaryHistory) < budget * panicRatio) return Promise.resolve(null)
        return engine.compactor.auto(sessionId, boundaryHistory, config, runLlm, model, {
          phase: "in-run",
          signal: controller.signal,
        })
      },
      // 超限急救钩子（spec 5.6）：不看水位线——"已经爆了"就是事实；emergency
      // 压缩成功返回新视图由循环整次重发。await 归来时 run 已中止则返回 null
      // （窄窗口：重发注定立刻被拆，不再多此一举）。
      onContextOverflow: async () => {
        const next = await engine.compactor.auto(sessionId, sessions.readMessages(sessionId), config, runLlm, model, {
          phase: "in-run",
          emergency: true,
          signal: controller.signal,
        })
        return controller.signal.aborted ? null : next
      },
      onUserMessage: (m) => {
        // The notes become part of the message BEFORE it is
        // persisted and completed. Persist first (events trail persisted
        // state), then announce each note — the loop's message.completed
        // follows, so the wire order stays
        // created → note.emitted ×N → completed. runId is known by now
        // (run.started is always a run's first event and precedes this
        // hook); the sessionId-only fallback is defensive only.
        m.blocks.push(...jobNote, ...notes)
        sessions.appendMessage(sessionId, m)
        if (input.trigger !== "job") {
          const firstText = m.blocks.find((b) => b.type === "text")?.text ?? ""
          void scheduleAutoname(
            { sessions, llm: runLlm, model, emit: busEmit },
            sessionId, firstText,
          )
        }
        const noteCtx = runId === undefined ? { sessionId } : { sessionId, runId }
        for (const block of [...jobNote, ...notes]) {
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
  // Token usage ledger: a failing record must never affect the run.
  if (engine.deps.usageStore !== undefined) {
    try {
      engine.deps.usageStore.record({
        sessionId,
        runId: runId ?? "",
        model,
        inputTokens: outcome.totalUsage.inputTokens,
        outputTokens: outcome.totalUsage.outputTokens,
        at: new Date().toISOString(),
      })
    } catch (err) {
      console.error("kclaw usage record failed:", err)
    }
  }
  // --- 收尾压缩（v3 触发三路之一，spec 5.1/5.4）-----------------------------
  // run 正常结束且水位 ≥ 黄线：压缩一次。它在 executeRun 内 await，驱动器的
  // 串行化自动保证"压缩期间新消息排队"（spec 5.4），无需额外忙碌标记；
  // aborted/error 的 run 不收尾（前者正在被拆，后者刚失败）。取消标记压制
  // 本次运行内已被用户取消的压缩（spec 5.3 第 6 条）。
  if (
    outcome.stopReason !== "aborted" && outcome.stopReason !== "error"
    && !engine.compactor.cancelled(sessionId)
  ) {
    const postRunHistory = sessions.readMessages(sessionId)
    if (estimateContextTokens(postRunHistory) >= budget * atRatio) {
      await engine.compactor.auto(sessionId, postRunHistory, config, runLlm, model, {
        phase: "post-run",
        signal: controller.signal,
      })
    }
  }
  // 跟随门禁（spec 4.2）：run 收尾（任何 stopReason）挂起一个 follow 检查；经
  // MemorySystem 落盘 <projectDir>/state.json（spec 11），daemon 重启后由 memory
  // scheduler 补查。idleMinutes=0 关闭。挂起失败静默（不影响 run 收尾）。
  if (config.memory.write.idleMinutes > 0) {
    try {
      memory.scheduleFollowCheck?.(sessionId, new Date().toISOString())
    } catch {
      // follow 挂起失败不影响 run
    }
  }
  return outcome
}

/**
 * Lazy per-run session_search backing (spec 6.4): reads the session's
 * event stream on each call and scans its compacted segments via the pure
 * searchSessionEvents. Legacy-upgrade sessions have no compaction events
 * yet → always "(无可检索内容)" until the first v2 compaction.
 */
function buildSessionSearch(deps: RunEngineDeps, sessionId: string): SessionSearchFn {
  return async (query, limit) => {
    const events = deps.sessions.readEvents(sessionId)
    return searchSessionEvents(events, query, limit)
  }
}

/** AGENTS.md persona when the file exists and is non-empty; default otherwise. */
function systemPrompt(agentsMd: string): string {
  try {
    const md = readFileSync(agentsMd, "utf8")
    if (md.trim() !== "") return md
  } catch {
    // missing/unreadable AGENTS.md → default persona
  }
  return DEFAULT_SYSTEM_PROMPT
}

/**
 * System prompt = AGENTS.md base + L2 cognition + skills listing（spec 7.1）：
 * cognitionPrompt 为空或抛错时不追加，回落到纯 base —— 认知注入失败静默跳过，
 * run 照常进行。extraSection（技能列表）为空串时同样不追加。
 */
function systemWithCognition(deps: RunEngineDeps, agentsMd: string, workspace: string, extraSection = ""): string {
  const base = systemPrompt(agentsMd)
  let cognition = ""
  try {
    cognition = deps.memory.cognitionPrompt(workspace)
  } catch {
    // 认知注入失败静默跳过（spec 7.1）
  }
  return [base, cognition, extraSection].filter((s) => s !== "").join("\n\n")
}
