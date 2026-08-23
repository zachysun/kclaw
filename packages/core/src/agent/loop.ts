import { newId } from "../protocol/ids.js"
import {
  newBlockId,
  type TextBlock, type ThinkingBlock, type ToolCallBlock, type ToolResultBlock, type NoteBlock, type Block,
} from "../protocol/blocks.js"
import {
  newMessage, newAssistantMessage, newToolMessage,
  type Message, type StopReason, type Usage, type GrantedBy,
} from "../protocol/messages.js"
import { makeEvent, type AgentEvent } from "../protocol/events.js"
import type { LlmClient, LlmStreamEvent, ToolDefinition } from "../provider/types.js"
import { toProviderMessages } from "./context.js"
import type { ToolExecutor } from "./tools.js"

/** Gate verdict for one tool call: run it, refuse it, or ask a human. */
export type PermissionDecision =
  | { type: "allow"; reason: "safe" | "whitelist" | "session_grant" }
  | { type: "deny"; reason: "blacklist" | "user_denied" | "timeout"; noteText: string }
  | { type: "confirm"; confirmationId: string }

/** Checked before every tool execution; missing gate == allow everything. */
export interface PermissionGate {
  check(toolCall: ToolCallBlock): Promise<PermissionDecision>
}

export interface RunInput {
  sessionId: string
  history: Message[]
  system: string
  userText: string
  trigger?: "user" | "job"
  /**
   * Pre-built user message for this run (daemon-side composition): when set,
   * the loop uses it verbatim instead of synthesizing one from `userText`
   * (which is then ignored) — and does NOT persist it via onMessage. The
   * caller owns this message's persistence (either before calling, or inside
   * `AgentDeps.onUserMessage`, where RunManager appends memory/job note blocks
   * and appends the finished message to the session log); re-persisting via
   * onMessage would write the same line twice.
   * Lifecycle events fire either way: `message.created` (the skeleton,
   * before use) and `message.completed` (after any `onUserMessage`
   * augmentation). `history` must not already contain this message.
   */
  userMessage?: Message
}

export interface AgentDeps {
  llm: LlmClient
  model: string
  window?: number
  maxIterations?: number
  /** executors keyed by tool name; calls to unknown names come back as error results */
  tools?: Map<string, ToolExecutor>
  /** tool schemas forwarded to the model so it can actually emit tool_calls */
  toolDefs?: ToolDefinition[]
  /** permission gate consulted before every tool execution */
  permissions?: PermissionGate
  /** answers confirmation.requested; missing resolver denies immediately by timeout */
  resolveConfirmation?(confirmationId: string): Promise<{ approved: boolean; by: "cli" | "web" | "timeout" }>
  /** how long a confirmation may sit unanswered before it denies (default 120s) */
  confirmTimeoutMs?: number
  /** abort guardrail: the run stops at the next checkpoint with stopReason "aborted" */
  signal?: AbortSignal
  /**
   * Retry visibility: notified for each failed LLM attempt that
   * will be retried with backoff. The retrying itself lives in the provider
   * wrapper — the loop never calls this itself (withRetry owns retries inside
   * `stream()`; a loop-level retry would double-retry). Daemon-side
   * composition wires withRetry's `onRetry` to its own per-run sink, which
   * translates each notification to an `llm.failed {willRetry:true}` event
   * and feeds the attempt counter below.
   */
  onLlmRetry?(info: { attempt: number; error: unknown }): void
  /**
   * The attempt number `llm.started` reports. Defaults to 1 — a
   * fresh call — because wrapper-level retries happen INSIDE `deps.llm.stream()`
   * after `llm.started` was already emitted; the composition that owns those
   * retries (the daemon) passes a counter here so the number reflects its
   * retry state for any `llm.started` it can still influence. Additive
   * seam; unset behaves exactly like before.
   */
  llmAttempt?(): number
  /**
   * User-message augmentation hook: called once with the user
   * message skeleton right after its `message.created` went out and BEFORE
   * the loop persists (internal path) and completes it. Lets the composition
   * that owns note injection (RunManager's memory/job notes) append note
   * blocks — announcing each on its own sink as `note.emitted` — so the wire
   * order stays message.created → note.emitted ×N → message.completed with
   * the notes part of the completed message. The returned message is what
   * the loop uses everywhere afterwards (history, provider view, outcome).
   * Additive: unset behaves exactly like before (the built message is used
   * as-is), and the hook runs on BOTH user-message paths — synthesized from
   * `userText` and caller-injected `RunInput.userMessage`. A THROWING hook
   * (or persistence sink) terminates the run: `run.failed` with code
   * "user_message_failed", and runAgent resolves with stopReason "error".
   */
  onUserMessage?(message: Message): Message
  onEvent(e: AgentEvent): void
  onMessage(m: Message): void
}

export interface RunOutcome {
  stopReason: StopReason
  totalUsage: Usage
  messages: Message[]
}

/** One tool call from the current turn, plus its scheduled position and result. */
interface ToolEntry {
  call: ToolCallBlock
  result?: ToolResultBlock
  /** set when the permission gate refused the call; attached to the tool message */
  note?: NoteBlock
  /** why the call was allowed to run; attached to the tool message */
  grantedBy?: GrantedBy
  /** true once the executor actually ran (streaming events already emitted) */
  executed: boolean
}

function errorResult(callId: string, output: string): ToolResultBlock {
  return { id: newBlockId(), type: "tool_result", callId, status: "error", output, durationMs: 0 }
}

function errorMessage(err: unknown): string {
  return String((err as { message?: string } | null | undefined)?.message ?? err)
}

/** Result output for tool calls that never ran because the run aborted first. */
const NOT_RUN_OUTPUT = "run aborted before execution"

type ConfirmationResolution = { approved: boolean; by: "cli" | "web" | "timeout" }

/**
 * `Promise.race` against a timer AND an abort signal; the timer is cleared
 * and the listener removed once the race settles. An abort wins as the
 * sentinel "aborted" — kept distinct from the timeout fallback so an aborted
 * wait is never misreported as a timeout-deny.
 */
function raceConfirmation(
  p: Promise<ConfirmationResolution>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<ConfirmationResolution | "aborted"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const sleep = new Promise<ConfirmationResolution>((resolve) => {
    timer = setTimeout(() => resolve({ approved: false, by: "timeout" }), ms)
  })
  let onAbort = () => {}
  const abort = new Promise<"aborted">((resolve) => {
    if (!signal) return
    if (signal.aborted) resolve("aborted")
    else {
      onAbort = () => resolve("aborted")
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
  return Promise.race([p, sleep, abort]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  })
}

/**
 * Guardrail wrapper around an LLM stream: the moment the abort signal fires,
 * iteration stops instead of waiting for a (possibly hanging) stream to end.
 */
async function* streamWithAbort(
  stream: AsyncIterable<LlmStreamEvent>,
  signal: AbortSignal | undefined,
): AsyncGenerator<LlmStreamEvent> {
  if (!signal) { yield* stream; return }
  const it = stream[Symbol.asyncIterator]()
  const ABORT = "__aborted__"
  const abort = new Promise<typeof ABORT>((resolve) => {
    if (signal.aborted) resolve(ABORT)
    else signal.addEventListener("abort", () => resolve(ABORT), { once: true })
  })
  try {
    while (true) {
      const next: IteratorResult<LlmStreamEvent> | typeof ABORT = await Promise.race([it.next(), abort])
      if (next === ABORT || next.done) return
      yield next.value
    }
  } finally {
    // Not awaited: a generator hung mid-await would never settle its return.
    void it.return?.(undefined)
  }
}

export async function runAgent(input: RunInput, deps: AgentDeps): Promise<RunOutcome> {
  const runId = newId("run")
  const ctx = { sessionId: input.sessionId, runId }
  const maxIterations = deps.maxIterations ?? 25
  const window = deps.window ?? 40
  const emit = (e: AgentEvent) => deps.onEvent(e)

  emit(makeEvent("run.started", { trigger: input.trigger ?? "user" }, ctx))

  // User message lifecycle: created carries the
  // SKELETON before the message is used; the optional augmentation hook then
  // appends note blocks (memory/job — the augmenter announces each on its own
  // sink as note.emitted, between created and completed); the loop persists
  // (internal path only — a caller-injected message is never re-persisted
  // through onMessage, its caller owns the write) and completes the FULL
  // message. Wire order: run.started → message.created → note.emitted ×N →
  // message.completed → llm.*, with events trailing persisted state.
  let userMsg = input.userMessage ?? newMessage(input.sessionId, "user", [
    { id: newBlockId(), type: "text", text: input.userText } satisfies TextBlock,
  ])
  emit(makeEvent("message.created", { message: userMsg }, ctx))
  // A throwing hook or persistence sink must not leave run.started dangling
  // (invariant: a started run always reaches a terminal event —
  // same pattern as the provider-failure path). Unlike a failed assistant
  // message there is nothing to complete first — the user message carries no
  // stopReason — so the terminal event is run.failed directly, and runAgent
  // RESOLVES with a stopReason "error" outcome instead of rejecting.
  try {
    if (deps.onUserMessage !== undefined) userMsg = deps.onUserMessage(userMsg)
    if (input.userMessage === undefined) deps.onMessage(userMsg)
    emit(makeEvent("message.completed", { message: userMsg }, ctx))
  } catch (err) {
    emit(makeEvent("run.failed", {
      error: { code: "user_message_failed", message: errorMessage(err) },
    }, ctx))
    return { stopReason: "error", totalUsage: { inputTokens: 0, outputTokens: 0 }, messages: [...input.history, userMsg] }
  }

  const all: Message[] = [...input.history, userMsg]
  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 }

  // Abort guardrail for a signal that fires when no message from the current
  // iteration exists (e.g. between iterations, or before the run started):
  // nothing was generated, so no assistant message is synthesized — persisting
  // an empty assistant message would be forwarded as empty content by
  // toProviderMessages on the next run, which some providers reject. A partial
  // message from a mid-stream abort takes the post-stream path instead.
  const finishAborted = (): RunOutcome => {
    emit(makeEvent("run.completed", { stopReason: "aborted", usage: totalUsage }, ctx))
    return { stopReason: "aborted", totalUsage, messages: all }
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    // Abort checkpoint: never start another LLM call after an abort.
    if (deps.signal?.aborted) return finishAborted()

    // llm.started attempt: 1 for a fresh call. Wrapper-level
    // retries happen inside deps.llm.stream() (withRetry) and surface
    // through the composition's own onRetry sink — when that composition
    // tracks the attempt number, it feeds it back via deps.llmAttempt.
    const attempt = deps.llmAttempt?.() ?? 1
    emit(makeEvent("llm.started", { model: deps.model, attempt }, ctx))
    const startedAt = Date.now()

    // Assistant skeleton exists before the first streaming event so every
    // block/delta event can carry the real messageId.
    const assistant = newAssistantMessage(input.sessionId, deps.model, [])
    emit(makeEvent("message.created", { message: assistant }, ctx))

    const texts: TextBlock[] = []
    const thinkings: ThinkingBlock[] = []
    // Tool calls aggregated by provider index; insertion order == model order.
    const toolCalls = new Map<number, ToolCallBlock>()
    let curText: TextBlock | null = null
    let curThinking: ThinkingBlock | null = null
    let stopReason: StopReason = "end_turn"
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    // Set when deps.llm.stream() threw for good (the retry wrapper gave up):
    // the run then terminates through the error lifecycle below instead of
    // rejecting — 只有 provider 彻底失败才终止 run.
    let streamError: unknown

    try {
      for await (const ev of streamWithAbort(deps.llm.stream({
        model: deps.model,
        system: input.system,
        messages: toProviderMessages(all, window),
        tools: deps.toolDefs ?? [],
      }), deps.signal)) {
        // Abort checkpoint: stop consuming the stream the moment the signal fires.
        if (deps.signal?.aborted) break
        if (ev.type === "text_delta") {
          if (!curText) {
            curText = { id: newBlockId(), type: "text", text: "" }
            emit(makeEvent("text.created", { messageId: assistant.id, block: curText }, ctx))
          }
          curText.text += ev.delta
          emit(makeEvent("text.delta", { messageId: assistant.id, blockId: curText.id, delta: ev.delta }, ctx))
        } else if (ev.type === "thinking_delta") {
          if (!curThinking) {
            curThinking = { id: newBlockId(), type: "thinking", text: "" }
            emit(makeEvent("thinking.created", { messageId: assistant.id, block: curThinking }, ctx))
          }
          curThinking.text += ev.delta
          emit(makeEvent("thinking.delta", { messageId: assistant.id, blockId: curThinking.id, delta: ev.delta }, ctx))
        } else if (ev.type === "tool_call_started") {
          const block: ToolCallBlock = {
            id: newBlockId(), type: "tool_call",
            callId: ev.callId, name: ev.name, args: undefined, argsJson: "",
          }
          toolCalls.set(ev.index, block)
          emit(makeEvent("tool_call.created", { messageId: assistant.id, block }, ctx))
        } else if (ev.type === "tool_call_delta") {
          const block = toolCalls.get(ev.index)
          if (block) {
            block.argsJson += ev.delta
            emit(makeEvent("tool_call.delta", { messageId: assistant.id, blockId: block.id, delta: ev.delta }, ctx))
          }
        } else if (ev.type === "message_done") {
          stopReason = ev.stopReason
          usage = ev.usage
        }
      }
    } catch (err) {
      streamError = err
      stopReason = "error"
    }
    if (curText) texts.push(curText)
    if (curThinking) thinkings.push(curThinking)
    // Abort checkpoint (post-stream): an aborted stream has no message_done, so
    // stamp the current assistant message here and fall through to the terminal
    // path below (message.completed + run.completed with stopReason "aborted").
    if (deps.signal?.aborted) stopReason = "aborted"
    totalUsage.inputTokens += usage.inputTokens
    totalUsage.outputTokens += usage.outputTokens
    // A failed call is terminated by llm.failed, not llm.completed — the
    // degenerate created→delta→completed triple only completes what streamed.
    if (streamError === undefined) {
      emit(makeEvent("llm.completed", { usage, stopReason, latencyMs: Date.now() - startedAt }, ctx))
    }

    // argsJson is only complete after the stream ends — parse now, in model order.
    // Parse failures never execute: they come back as error tool_results.
    const entries: ToolEntry[] = []
    // A stream that died mid-tool-call leaves dangling tool_call blocks whose
    // results can never exist; an assistant tool_call not followed by its tool
    // message makes OpenAI-compat APIs reject the next request with a 400.
    const dangling = stopReason === "aborted" || stopReason === "error"
    for (const call of toolCalls.values()) {
      const entry: ToolEntry = { call, executed: false }
      if (dangling) {
        // Synthesize rather than drop the blocks (choice documented): the
        // partial tool_call stays visible in history, and the explicit error
        // results below keep the provider view free of unpaired toolCalls.
        // No tool_call.completed — the degenerate streaming triple never
        // completed for a call whose args stream was cut short.
        entry.result = errorResult(
          call.callId,
          stopReason === "aborted" ? NOT_RUN_OUTPUT : "llm call failed before execution",
        )
        entries.push(entry)
        continue
      }
      try {
        // A tool call with no arguments stream at all leaves argsJson "" —
        // treat it as an empty object (no-args calls must not fail).
        call.args = JSON.parse(call.argsJson || "{}")
        emit(makeEvent("tool_call.completed", { messageId: assistant.id, block: call }, ctx))
      } catch {
        entry.result = errorResult(call.callId, "invalid tool args json")
        // The created→delta→completed lifecycle: completed fires on the
        // parse-failure path too, carrying the raw (unparseable) block.
        emit(makeEvent("tool_call.completed", { messageId: assistant.id, block: call }, ctx))
      }
      // Unknown tool names likewise never execute.
      if (!entry.result && !(deps.tools?.has(call.name) ?? false)) {
        entry.result = errorResult(call.callId, `unknown tool: ${call.name}`)
      }
      entries.push(entry)
    }

    const blocks: Block[] = [...thinkings, ...texts, ...[...toolCalls.values()]]
    // Truncation guardrail: when this is the last allowed iteration and the
    // loop is about to continue into a tool turn it will never take, explain
    // on THIS assistant message why the run stopped without a final answer —
    // the note must be attached BEFORE onMessage so an eagerly-serializing
    // sink (the session store's JSONL) persists it as part of the message.
    let truncationNote: NoteBlock | undefined
    if (iter === maxIterations - 1 && stopReason === "tool_use" && entries.length > 0) {
      truncationNote = {
        id: newBlockId(), type: "note", kind: "system",
        text: `已达最大迭代次数（${maxIterations}），本轮运行被截断`,
      }
      blocks.push(truncationNote)
    }
    // An assistant that produced no blocks at all (empty stream, or a failure
    // before the first token) is dropped: no onMessage, no message.completed —
    // the message.created that is already out simply never lands. Persisting
    // it would forward an empty assistant message to the provider next run.
    if (blocks.length > 0) {
      assistant.blocks = blocks
      assistant.usage = usage
      assistant.stopReason = stopReason
      for (const b of blocks) {
        if (b.type === "text") emit(makeEvent("text.completed", { messageId: assistant.id, block: b }, ctx))
        else if (b.type === "thinking") emit(makeEvent("thinking.completed", { messageId: assistant.id, block: b }, ctx))
      }
      if (truncationNote) {
        emit(makeEvent("note.emitted", { messageId: assistant.id, block: truncationNote }, ctx))
      }
      // Persist before announcing: events must reflect persisted state, and an
      // eagerly-serializing onMessage (the session store's JSONL) stores exactly this message.
      deps.onMessage(assistant)
      emit(makeEvent("message.completed", { message: assistant }, ctx))
      all.push(assistant)
    }

    // Dangling tool calls (aborted/error stream): persist the synthesized
    // error tool_results as their own tool message so the history never ends
    // an assistant tool_call without a tool message (see the comment above).
    if (dangling && entries.length > 0) {
      const toolMsg = newMessage(input.sessionId, "tool", [])
      emit(makeEvent("message.created", { message: toolMsg }, ctx))
      toolMsg.blocks = entries.map((e) => e.result!)
      for (const b of toolMsg.blocks) {
        emit(makeEvent("tool_result.created", { messageId: toolMsg.id, block: b }, ctx))
        emit(makeEvent("tool_result.completed", { messageId: toolMsg.id, block: b }, ctx))
      }
      deps.onMessage(toolMsg)
      emit(makeEvent("message.completed", { message: toolMsg }, ctx))
      all.push(toolMsg)
    }

    if (stopReason === "end_turn") {
      emit(makeEvent("run.completed", { stopReason, usage: totalUsage }, ctx))
      return { stopReason, totalUsage, messages: all }
    }

    // Provider failure: the stream died for good — bad key,
    // prolonged 5xx, network; anything the retry wrapper exhausted itself on.
    // Partial content was persisted above with stopReason "error"; terminate
    // the run. runAgent resolves — it never rejects for provider errors.
    if (stopReason === "error") {
      const error = { code: "llm_error", message: errorMessage(streamError) }
      emit(makeEvent("llm.failed", { error, willRetry: false }, ctx))
      emit(makeEvent("run.failed", { error }, ctx))
      return { stopReason: "error", totalUsage, messages: all }
    }

    if (stopReason === "tool_use" && entries.length > 0) {
      await runToolTurn(entries, { input, deps, emit, ctx, all })
      continue
    }

    // max_tokens / stop_sequence / content_filter / aborted, or a tool_use
    // with no calls at all — terminate the run.
    emit(makeEvent("run.completed", { stopReason, usage: totalUsage }, ctx))
    return { stopReason, totalUsage, messages: all }
  }

  // The loop exhausted maxIterations mid tool-turn. The truncation note was
  // already attached to — and persisted with — the final assistant message in
  // the last iteration (pre-persist, see above), so both the user and the
  // next run's model see why the run stopped without a final answer.
  emit(makeEvent("run.failed", { error: { code: "max_iterations", message: `exceeded ${maxIterations} iterations` } }, ctx))
  return { stopReason: "error", totalUsage, messages: all }
}

/** Execute one turn's batch of tool calls and append the ordered tool message. */
async function runToolTurn(
  entries: ToolEntry[],
  o: {
    input: RunInput
    deps: AgentDeps
    emit(e: AgentEvent): void
    ctx: { sessionId: string; runId: string }
    all: Message[]
  },
): Promise<void> {
  const { input, deps, emit, ctx, all } = o

  // The tool message skeleton exists before execution so tool_result.delta
  // events during execution carry the real messageId.
  const toolMsg = newToolMessage(input.sessionId, [])
  emit(makeEvent("message.created", { message: toolMsg }, ctx))

  // Permission gate: every executable call is checked before it
  // runs, in model order (confirmations reach the human one at a time).
  // Refused calls become error results + a note block on this tool message;
  // the loop itself continues so the model can react to the refusal.
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 120_000
  for (const entry of entries) {
    if (entry.result) continue // invalid args / unknown tool never reach the gate
    // Abort checkpoint: stop gating — and thereby executing — anything further.
    if (deps.signal?.aborted) break
    const decision = deps.permissions
      ? await deps.permissions.check(entry.call)
      : { type: "allow" as const, reason: "safe" as const }
    if (decision.type === "allow") {
      entry.grantedBy = decision.reason
      continue
    }
    if (decision.type === "deny") {
      entry.result = errorResult(entry.call.callId, decision.noteText)
      entry.note = {
        id: newBlockId(), type: "note",
        kind: decision.reason === "timeout" ? "timeout" : "denied",
        text: decision.noteText,
      }
      continue
    }
    // confirm: ask a human, deny on rejection or timeout.
    emit(makeEvent("confirmation.requested", {
      confirmationId: decision.confirmationId,
      toolCall: entry.call,
      risk: deps.tools!.get(entry.call.name)!.risk,
      expiresAt: new Date(Date.now() + confirmTimeoutMs).toISOString(),
    }, ctx))
    const resolution = await raceConfirmation(
      deps.resolveConfirmation?.(decision.confirmationId)
        ?? Promise.resolve({ approved: false, by: "timeout" as const }),
      confirmTimeoutMs,
      deps.signal,
    )
    if (resolution === "aborted") {
      // An abort during the wait is NOT a timeout-deny: no
      // confirmation.resolved is emitted (the confirmation never resolved);
      // the entry gets an explicit not-run result below and the run finishes
      // aborted at the next checkpoint.
      break
    }
    emit(makeEvent("confirmation.resolved", {
      confirmationId: decision.confirmationId,
      approved: resolution.approved,
      by: resolution.by,
    }, ctx))
    if (resolution.approved) {
      entry.grantedBy = "confirmed"
      continue
    }
    const timedOut = resolution.by === "timeout"
    const text = timedOut ? "确认超时，操作未执行" : "用户拒绝了该操作"
    entry.result = errorResult(entry.call.callId, text)
    entry.note = {
      id: newBlockId(), type: "note",
      kind: timedOut ? "timeout" : "denied",
      text,
    }
  }

  const runOne = async (entry: ToolEntry): Promise<ToolResultBlock> => {
    const executor = deps.tools!.get(entry.call.name)!
    const block: ToolResultBlock = {
      id: newBlockId(), type: "tool_result",
      callId: entry.call.callId, status: "ok", output: "", durationMs: 0,
    }
    emit(makeEvent("tool_result.created", { messageId: toolMsg.id, block }, ctx))
    const startedAt = performance.now()
    try {
      const res = await executor.execute(entry.call.args, {
        onOutput(delta) {
          block.output += delta
          emit(makeEvent("tool_result.delta", { messageId: toolMsg.id, callId: entry.call.callId, delta }, ctx))
        },
      })
      block.status = res.status
      block.output = res.output
      if (res.data !== undefined) block.data = res.data
    } catch (err) {
      block.status = "error"
      block.output = errorMessage(err)
    }
    block.durationMs = performance.now() - startedAt
    emit(makeEvent("tool_result.completed", { messageId: toolMsg.id, block }, ctx))
    return block
  }

  // Scheduling: parallel tools run concurrently; serial tools run
  // one-by-one after every other tool has settled, so they never overlap
  // anything. Results are written back in model order either way.
  const execEntries = entries.filter((e) => !e.result)
  const isSerial = (e: ToolEntry) => deps.tools!.get(e.call.name)!.concurrency === "serial"
  const parallel = execEntries.filter((e) => !isSerial(e))
  const serial = execEntries.filter((e) => isSerial(e))

  // Abort checkpoint: stop SCHEDULING tools once aborted; tools that already
  // started are still allowed to settle (the allSettled / awaited serial
  // calls below), then the run finishes aborted at the loop's next checkpoint.
  const toLaunch = deps.signal?.aborted ? [] : parallel
  const settled = await Promise.allSettled(toLaunch.map((e) => runOne(e)))
  toLaunch.forEach((e, i) => {
    const s = settled[i]!
    if (s.status === "fulfilled") {
      e.result = s.value
      e.executed = true
    } else {
      // runOne catches executor errors, so this is defensive only.
      e.result = errorResult(e.call.callId, errorMessage(s.reason))
    }
  })
  for (const e of serial) {
    if (deps.signal?.aborted) break
    e.result = await runOne(e)
    e.executed = true
  }

  // Anything still resultless (an abort stopped it before execution) gets an
  // explicit not-run error so the tool message stays complete.
  for (const e of entries) {
    if (!e.result) e.result = errorResult(e.call.callId, NOT_RUN_OUTPUT)
  }

  // Non-executed results (invalid args / unknown tool) get their lifecycle
  // events here; executed ones already streamed theirs.
  for (const e of entries) {
    if (e.executed || !e.result) continue
    emit(makeEvent("tool_result.created", { messageId: toolMsg.id, block: e.result }, ctx))
    emit(makeEvent("tool_result.completed", { messageId: toolMsg.id, block: e.result }, ctx))
  }

  // Refusal notes ride along on the tool message (after the results, which
  // stay in model order for the model) and are announced via note.emitted.
  const notes = entries.map((e) => e.note).filter((n): n is NoteBlock => n !== undefined)
  const grants: Record<string, GrantedBy> = {}
  for (const e of entries) if (e.grantedBy !== undefined) grants[e.call.callId] = e.grantedBy
  toolMsg.blocks = [...entries.map((e) => e.result!), ...notes]
  if (Object.keys(grants).length > 0) toolMsg.grantedBy = grants
  for (const note of notes) {
    emit(makeEvent("note.emitted", { messageId: toolMsg.id, block: note }, ctx))
  }
  // Persist before announcing (see the assistant path): events must reflect
  // persisted state.
  deps.onMessage(toolMsg)
  emit(makeEvent("message.completed", { message: toolMsg }, ctx))
  all.push(toolMsg)
}
