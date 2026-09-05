/**
 * Event → view-model reducer for the streaming chat view (the daemon's event
 * catalog and wire order).
 *
 * The wire shapes come from the typed canon `@kclaw/core/protocol` — no
 * hand-copied mirrors. Core's AgentEvent is generic; the AnyAgentEvent
 * distribution below turns it into a discriminated union so switch(event.type)
 * narrows payload, and the reducer's default-case sentinel turns an unhandled
 * NEW core event into a compile error instead of a silent no-op.
 *
 * Design decisions (documented for review):
 *
 * - Deltas only append to blocks the view already knows (message exists AND
 *   blockId matches). A delta for an unknown message or blockId is DROPPED:
 *   the `*.completed` events carry full blocks and `message.completed` carries
 *   the whole message, so the next calibration snapshots the true state. This
 *   is the "delta 仅当 blockId 已知才追加，否则丢弃，completed 全量校准" rule.
 * - `message.created` inserts a skeleton marked `pending`; `message.completed`
 *   replaces the message wholesale (full calibration). The view skips nothing
 *   but renders a streaming placeholder for a pending message with no blocks.
 * - Out-of-order tolerance is purely "drop unknown / replace later": events on
 *   a single WS connection arrive in order (the wire order), so the dropped
 *   deltas only matter across reconnects, where a full pull + merge resyncs.
 * - The reducer is a pure function: every transition returns a NEW state.
 */
import type {
  AgentEvent as CoreAgentEvent,
  Block,
  ConfirmationRequestedPayload,
  EventType,
  MemoryWrittenPayload,
  Message,
  Role,
} from "@kclaw/core/protocol"

export type { Block, ConfirmationRequestedPayload, Message, Role }

/**
 * The daemon's full event catalog as a discriminated union: core's generic
 * AgentEvent<T> distributed over every EventType, so switch(event.type)
 * narrows payload per case.
 */
export type AgentEvent = { [T in EventType]: CoreAgentEvent<T> }[EventType]

/** memory.written 的 payload（点击通知条跳转记忆页所需字段）——正本形状。 */
export type MemoryWrittenInfo = MemoryWrittenPayload

/** View-model — the reducer's output. */
export type RunState = "idle" | "running"

export interface TextRender { kind: "text"; blockId: string; text: string }
export interface ThinkingRender { kind: "thinking"; blockId: string; text: string }
export interface NoteRender {
  kind: "note"
  blockId: string
  noteKind: string
  text: string
  /** Structured compaction state (kind==="compact" only) — see @kclaw/core NoteBlock. */
  compact?: { segments: number; kept: number }
}
export interface ToolCallRender {
  kind: "tool_call"
  blockId: string
  callId: string
  name: string
  argsJson: string
}
export interface ToolResultRender {
  kind: "tool_result"
  blockId: string
  callId: string
  status: "ok" | "error"
  output: string
  durationMs: number
}
export interface AttachmentRender { kind: "attachment"; blockId: string; mimeType: string }

export type RenderedBlock =
  | TextRender | ThinkingRender | NoteRender | ToolCallRender | ToolResultRender | AttachmentRender

export interface RenderedMessage {
  id: string
  role: Role
  /** True between message.created and message.completed (streaming/persisting). */
  pending: boolean
  blocks: RenderedBlock[]
}

export interface ConfirmationCard {
  confirmationId: string
  toolName: string
  argsJson: string
  risk: "safe" | "sensitive"
  expiresAt: string
}

/** One waiting message of the daemon's send-message queue (view mirror). */
export interface QueueEntryView {
  messageId: string
  disposition: "steer" | "wait" | "interrupt"
  text: string
}

export interface ChatState {
  messages: RenderedMessage[]
  /**
   * Messages waiting to enter a run, in queue order (FIFO — the first row is
   * the first sent). The queue LIST is the only view of a waiting message
   * (Master 2026-08-30: 排队消息不以气泡形式进消息流): `message.queued`
   * retracts the optimistic bubble (taking its text into the row);
   * `message.created` / `message.steered` dequeue the row — the message then
   * enters the thread as a normal persisted bubble.
   */
  queue: QueueEntryView[]
  runState: RunState
  pendingConfirmations: ConfirmationCard[]
  error?: string
  /**
   * Provider retry in progress: set by `llm.failed {willRetry:true}` while the
   * run keeps streaming (so the view can show a "重试中…" hint instead of a
   * silent "running…" hang). `attempt` is the retry attempt number when the
   * event carries one, undefined ("unknown") otherwise. Cleared on
   * `llm.completed` and on run terminal events.
   */
  retryHint?: { attempt?: number } | null
  /**
   * A context compaction is running (compaction.started …
   * compaction.completed). v3 protocol: completed is ALWAYS delivered after
   * started — ANY result (ok/failed/cancelled) clears the flag. The run
   * lifecycle events also clear it as a dropped-frame backstop.
   */
  compacting?: boolean
  /**
   * 在飞压缩的阶段（compaction.started 的 payload.phase）。manual 时取消按钮
   * 不渲染（用户自己发起的压缩，取消语义不存在）；与 compacting 同生共死。
   */
  compactingPhase?: string
  /**
   * 最近一次钩子失败（hook.failed）：用户 hook 一律 fail-open，run 不受影响，
   * 但失败必须可见（spec issue #6）。保留最近一条，下一个 run 开始时清除
   * （run.started，同 error 的过期节奏）；load 阶段的失败在 run 前到达，
   * 会一直显示到下一次 run——正是"装载坏了"应有的持续性。
   */
  hookFailure?: { hook: string; position: string; error: string } | null
}

/** Build the initial view from the persisted message list (no event replay). */
export function initChat(messages: Message[]): ChatState {
  return {
    messages: messages.map((m) => renderMessage(m, false)),
    queue: [],
    runState: "idle",
    pendingConfirmations: [],
  }
}

/**
 * Reconnect merge: the freshly pulled message list is authoritative for
 * everything it contains (persisted state replaces live renders); messages the
 * fresh pull does not know (an in-flight run's unpersisted message) stay as-is.
 */
export function mergeMessages(existing: RenderedMessage[], fresh: Message[]): RenderedMessage[] {
  const freshById = new Map(fresh.map((m) => [m.id, renderMessage(m, false)]))
  // An optimistic twin whose text the server pull now carries has been
  // persisted — keep the server copy only (the twin never got message.created
  // here: reconnect does not replay it).
  const persistedTexts = new Set(
    fresh.filter((m) => m.role === "user").map((m) => firstUserText(m)),
  )
  const existing0 = existing.filter((m) =>
    !(m.id.startsWith("local-") && m.pending && persistedTexts.has(firstRenderedUserText(m))),
  )
  const merged = existing0.map((m) => freshById.get(m.id) ?? m)
  const known = new Set(existing0.map((m) => m.id))
  for (const [id, rm] of freshById) {
    if (!known.has(id)) merged.push(rm)
  }
  return merged
}

/**
 * Reconnect merge for the send-message queue (GET /queue full resync): the
 * server's list is authoritative and rebuilds the rows wholesale, in server
 * (= send) order. Rows it no longer lists were cancelled, dequeued or injected
 * while this view was away — a dequeued/injected message arrives through the
 * reconnect message pull as a normal persisted bubble, so dropping the row
 * leaves no residue.
 */
export function mergeQueue(
  state: ChatState,
  entries: Array<{ messageId: string; disposition: string; text: string }>,
): ChatState {
  if (entries.length === 0 && state.queue.length === 0) return state
  const queue: QueueEntryView[] = entries.map((e) => ({
    messageId: e.messageId,
    disposition: asDisposition(e.disposition),
    text: e.text,
  }))
  return { ...state, queue }
}

/** Narrow a wire disposition string to the view union ("wait" as the fallback). */
function asDisposition(d: string): QueueEntryView["disposition"] {
  return d === "steer" || d === "wait" || d === "interrupt" ? d : "wait"
}

/** First text block's text of a wire user message ("" when absent). */
function firstUserText(m: Message): string {
  return m.blocks.find((b) => b.type === "text")?.text ?? ""
}

/** First text render's text of a rendered user message ("" when absent). */
function firstRenderedUserText(m: RenderedMessage): string {
  const first = m.blocks.find((b) => b.kind === "text")
  return first !== undefined && first.kind === "text" ? first.text : ""
}

/**
 * Insert the optimistic echo for a just-sent user message: a pending bubble
 * with a `local-` id, replaced by the server's message.created twin later.
 * Sends the "message visible the instant it leaves the composer" feel even
 * while a pre-run compaction delays the server echo by seconds.
 */
export function appendOptimisticUser(state: ChatState, text: string): ChatState {
  const optimistic: RenderedMessage = {
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    pending: true,
    blocks: [{ kind: "text", blockId: "local", text }],
  }
  return { ...state, messages: [...state.messages, optimistic] }
}

/** Index of the optimistic twin of a server message (pending local- user bubble, same text); -1 when none. */
function findOptimisticTwinIdx(state: ChatState, server: Message): number {
  if (server.role !== "user") return -1
  const text = firstUserText(server)
  return state.messages.findIndex(
    (m) => m.id.startsWith("local-") && m.pending && firstRenderedUserText(m) === text,
  )
}

/** Index of the earliest still-pending optimistic (local-) user bubble; -1 when none. */
function earliestPendingLocalIdx(messages: RenderedMessage[]): number {
  return messages.findIndex((m) => m.id.startsWith("local-") && m.pending && m.role === "user")
}

/**
 * Busy-session send (Master 2026-08-30, second round): a message sent while a
 * run is active (or a compaction is running) will QUEUE — so it never renders
 * as a bubble. The optimistic echo moves INTO the queue list: a local row with
 * a `local-` id, renamed by the ack / `message.queued` and later replaced by
 * the real bubble when the message's turn comes (`message.created`).
 */
export function appendPendingQueueRow(state: ChatState, text: string, disposition: QueueEntryView["disposition"]): ChatState {
  return {
    ...state,
    queue: [
      ...state.queue,
      { messageId: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, disposition, text },
    ],
  }
}

/** Index of the earliest unconfirmed local- row in the queue; -1 when none. */
function earliestPendingLocalRowIdx(queue: QueueEntryView[]): number {
  return queue.findIndex((e) => e.messageId.startsWith("local-"))
}

/**
 * Ack path: an id the queue already tracks means `message.queued` won the race
 * — nothing to do, and touching the earliest local row/bubble here would STEAL
 * the next not-yet-acked message. Otherwise (ack first) the earliest unconfirmed
 * local- ROW adopts the server id in place; failing that, the earliest
 * still-pending local- bubble does (the idle→busy race sent a bubble before
 * run.started landed). The later `message.queued` finds whichever survived.
 */
export function adoptQueuedId(state: ChatState, messageId: string): ChatState {
  if (state.queue.some((e) => e.messageId === messageId)) return state
  const rowIdx = earliestPendingLocalRowIdx(state.queue)
  if (rowIdx !== -1) {
    const queue = state.queue.slice()
    queue[rowIdx] = { ...queue[rowIdx]!, messageId }
    return { ...state, queue }
  }
  const idx = earliestPendingLocalIdx(state.messages)
  if (idx === -1) return state
  const messages = state.messages.slice()
  messages[idx] = { ...messages[idx]!, id: messageId }
  return { ...state, messages }
}

/** Apply one wire event to the view, returning a NEW state. */
export function applyEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case "run.started":
      return { ...state, runState: "running", error: undefined, hookFailure: null, compacting: false, compactingPhase: undefined }
    case "run.completed":
      return { ...state, runState: "idle", retryHint: null, compacting: false, compactingPhase: undefined }
    case "run.failed":
      return { ...state, runState: "idle", error: event.payload.error?.message ?? "run failed", retryHint: null, compacting: false, compactingPhase: undefined }
    case "compaction.started":
      return { ...state, compacting: true, compactingPhase: event.payload.phase ?? undefined }
    case "compaction.completed":
      // v3: completed is guaranteed after started — ANY result (ok/failed/
      // cancelled) ends the compaction, so the flag clears unconditionally.
      return { ...state, compacting: false, compactingPhase: undefined }
    case "llm.completed":
      return { ...state, retryHint: null }
    case "llm.failed":
      // Only provider RETRIES set the hint (willRetry:true); a final
      // llm.failed {willRetry:false} is a plain terminal llm error, which
      // run.failed surfaces — leave the view untouched.
      if (event.payload.willRetry !== true) return state
      return { ...state, retryHint: {} }
    case "hook.failed":
      // 钩子失败不伤 run（fail-open），但必须可见：保留最近一条供 ChatView
      // 渲染警示行（run.started 清除，见 ChatState.hookFailure 注释）。
      return { ...state, hookFailure: { hook: event.payload.hook, position: event.payload.position, error: event.payload.error } }
    case "message.created": {
      // Queue dequeue: a created event for a queued id drops the row — the
      // message enters the thread below as a normal (persisted) bubble. Its
      // optimistic twin was retracted at message.queued time, so there is no
      // twin to merge for queued ids; a FREE-SEND message still has one, and
      // the twin path replaces it in place to keep send order.
      const queued = state.queue.some((e) => e.messageId === event.payload.message.id)
      const base = queued
        ? { ...state, queue: state.queue.filter((e) => e.messageId !== event.payload.message.id) }
        : state
      // Optimistic-echo merge: the server skeleton replaces the local twin AT
      // ITS POSITION — appending would hoist later queued optimistic bubbles
      // (sent after this one) above it until their own echoes land.
      const twinIdx = findOptimisticTwinIdx(base, event.payload.message)
      const rendered = renderMessage(event.payload.message, true)
      if (twinIdx === -1) return upsertMessage(base, rendered)
      const messages = base.messages.slice()
      messages[twinIdx] = rendered
      return { ...base, messages }
    }
    case "message.completed":
      return upsertMessage(state, renderMessage(event.payload.message, false))
    case "message.queued": {
      // Dedupe BEFORE adoption: an id we already track (ack renamed the local
      // row, or a recoverQueues replay racing an in-flight send) must not
      // steal the next message's local row/bubble — the tracked row just
      // refreshes its disposition (recoverQueues re-broadcasts demoted "wait").
      if (state.queue.some((e) => e.messageId === event.payload.messageId)) {
        const queue = state.queue.map((e) =>
          e.messageId === event.payload.messageId ? { ...e, disposition: event.payload.disposition } : e)
        return { ...state, queue }
      }
      // The waiting message's only view is the queue LIST (Master 2026-08-30):
      // a busy-session send created a local ROW — adopt it (rename, keep the
      // text). An idle→busy race instead created a local BUBBLE — retract it
      // (its text moves into the new row). Neither exists (cross-client /
      // replay edge) → the row lands with empty text; the panel's queue-text
      // resync fills it from GET /queue.
      const rowIdx = earliestPendingLocalRowIdx(state.queue)
      if (rowIdx !== -1) {
        const queue = state.queue.slice()
        queue[rowIdx] = { messageId: event.payload.messageId, disposition: event.payload.disposition, text: queue[rowIdx]!.text }
        return { ...state, queue }
      }
      const byId = state.messages.findIndex(
        (m) => m.id === event.payload.messageId && m.pending && m.role === "user",
      )
      const localIdx = byId !== -1 ? byId : earliestPendingLocalIdx(state.messages)
      const adopted = localIdx === -1 ? null : state.messages[localIdx]!
      const entry: QueueEntryView = {
        messageId: event.payload.messageId,
        disposition: event.payload.disposition,
        text: adopted === null ? "" : firstRenderedUserText(adopted),
      }
      const messages = adopted === null
        ? state.messages
        : state.messages.filter((_, i) => i !== localIdx)
      return { ...state, queue: [...state.queue, entry], messages }
    }
    case "message.steered": {
      // Injection: the message is in the run now — its row goes, and the
      // message itself lands as a normal bubble via message.created (the wire
      // emits created before steered; this also covers the reordered edge).
      const queue = state.queue.filter((e) => e.messageId !== event.payload.messageId)
      if (queue.length === state.queue.length) return state
      return { ...state, queue }
    }
    case "message.queue_cancelled": {
      // A cancelled message was never persisted — its row simply goes (the
      // optimistic bubble was already retracted at message.queued time).
      if (event.payload.all === true) {
        if (state.queue.length === 0) return state
        return { ...state, queue: [] }
      }
      if (event.payload.messageId === undefined) return state
      const queue = state.queue.filter((e) => e.messageId !== event.payload.messageId)
      if (queue.length === state.queue.length) return state
      return { ...state, queue }
    }
    case "text.created":
    case "thinking.created":
    case "tool_call.created":
    case "tool_result.created":
    case "text.completed":
    case "thinking.completed":
    case "tool_call.completed":
    case "tool_result.completed":
      return upsertBlock(state, event.payload.messageId, event.payload.block)
    case "text.delta":
    case "thinking.delta":
      return appendTextDelta(state, event.payload.messageId, event.payload.blockId, event.payload.delta)
    case "tool_call.delta":
      return appendArgsDelta(state, event.payload.messageId, event.payload.blockId, event.payload.delta)
    case "tool_result.delta":
      return appendOutputDelta(state, event.payload.messageId, event.payload.callId, event.payload.delta)
    case "note.emitted":
      return upsertBlock(state, event.payload.messageId, event.payload.block)
    case "confirmation.requested":
      return pushConfirmation(state, event.payload)
    case "confirmation.resolved":
      return removeConfirmation(state, event.payload.confirmationId)
    // The catalog's pass-through events (no view state to change): job
    // lifecycle and session renames are other views' business, attachment
    // blocks are calibrated wholesale by message.completed, llm.started is
    // bookkeeping, and memory.written escapes to the panel before the
    // reducer. They are listed so a NEW core event type trips the sentinel
    // below instead of silently no-opping.
    case "job.started":
    case "job.completed":
    case "job.failed":
    case "session.renamed":
    case "attachment.created":
    case "attachment.completed":
    case "llm.started":
    case "memory.written":
      return state
    default: {
      // Compile-time exhaustiveness sentinel: adding an EventType to core
      // without deciding it here makes `event` non-never and fails this
      // assignment — the new event must be handled or explicitly ignored.
      const unhandled: never = event
      void unhandled
      return state
    }
  }
}

function renderMessage(msg: Message, pending: boolean): RenderedMessage {
  return { id: msg.id, role: msg.role, pending, blocks: msg.blocks.map(renderBlock) }
}

function renderBlock(block: Block): RenderedBlock {
  switch (block.type) {
    case "text":
      return { kind: "text", blockId: block.id, text: block.text }
    case "thinking":
      return { kind: "thinking", blockId: block.id, text: block.text }
    case "note":
      return {
        kind: "note",
        blockId: block.id,
        noteKind: block.kind,
        text: block.text,
        ...(block.compact !== undefined ? { compact: block.compact } : {}),
      }
    case "tool_call":
      return { kind: "tool_call", blockId: block.id, callId: block.callId, name: block.name, argsJson: block.argsJson }
    case "tool_result":
      return { kind: "tool_result", blockId: block.id, callId: block.callId, status: block.status, output: block.output, durationMs: block.durationMs }
    case "attachment":
      return { kind: "attachment", blockId: block.id, mimeType: block.mimeType }
  }
}

/** Replace the message (or append it) by id. */
function upsertMessage(state: ChatState, msg: RenderedMessage): ChatState {
  const idx = state.messages.findIndex((m) => m.id === msg.id)
  if (idx === -1) return { ...state, messages: [...state.messages, msg] }
  const messages = state.messages.slice()
  messages[idx] = msg
  return { ...state, messages }
}

/**
 * Update one message via `fn`; returning null means "no change" (used for the
 * unknown-blockId drop rule, keeping the previous state reference intact).
 */
function updateMessage(
  state: ChatState,
  messageId: string,
  fn: (m: RenderedMessage) => RenderedMessage | null,
): ChatState {
  const idx = state.messages.findIndex((m) => m.id === messageId)
  if (idx === -1) return state
  const next = fn(state.messages[idx]!)
  if (next === null) return state
  const messages = state.messages.slice()
  messages[idx] = next
  return { ...state, messages }
}

/** Insert or replace a rendered block (created/completed/note events calibrate). */
function upsertBlock(state: ChatState, messageId: string, block: Block): ChatState {
  const rendered = renderBlock(block)
  return updateMessage(state, messageId, (m) => {
    const idx = m.blocks.findIndex((b) => b.blockId === rendered.blockId)
    const blocks = idx === -1 ? [...m.blocks, rendered] : m.blocks.map((b, i) => (i === idx ? rendered : b))
    return { ...m, blocks }
  })
}

/** Append a delta to a text/thinking block by blockId (unknown → drop). */
function appendTextDelta(state: ChatState, messageId: string, blockId: string, delta: string): ChatState {
  return updateMessage(state, messageId, (m) => {
    const idx = m.blocks.findIndex((b) => b.blockId === blockId && (b.kind === "text" || b.kind === "thinking"))
    if (idx === -1) return null
    const blocks = m.blocks.slice()
    const block = blocks[idx] as TextRender | ThinkingRender
    blocks[idx] = { ...block, text: block.text + delta }
    return { ...m, blocks }
  })
}

/** Append a delta to a tool_call block's argsJson by blockId (unknown → drop). */
function appendArgsDelta(state: ChatState, messageId: string, blockId: string, delta: string): ChatState {
  return updateMessage(state, messageId, (m) => {
    const idx = m.blocks.findIndex((b) => b.kind === "tool_call" && b.blockId === blockId)
    if (idx === -1) return null
    const blocks = m.blocks.slice()
    const block = blocks[idx] as ToolCallRender
    blocks[idx] = { ...block, argsJson: block.argsJson + delta }
    return { ...m, blocks }
  })
}

/** Append a delta to a tool_result's output by callId (unknown → drop). */
function appendOutputDelta(state: ChatState, messageId: string, callId: string, delta: string): ChatState {
  return updateMessage(state, messageId, (m) => {
    const idx = m.blocks.findIndex((b) => b.kind === "tool_result" && b.callId === callId)
    if (idx === -1) return null
    const blocks = m.blocks.slice()
    const block = blocks[idx] as ToolResultRender
    blocks[idx] = { ...block, output: block.output + delta }
    return { ...m, blocks }
  })
}

function pushConfirmation(state: ChatState, payload: ConfirmationRequestedPayload): ChatState {
  const card: ConfirmationCard = {
    confirmationId: payload.confirmationId,
    toolName: payload.toolCall.name,
    argsJson: payload.toolCall.argsJson,
    risk: payload.risk,
    expiresAt: payload.expiresAt,
  }
  if (state.pendingConfirmations.some((c) => c.confirmationId === card.confirmationId)) return state
  return { ...state, pendingConfirmations: [...state.pendingConfirmations, card] }
}

function removeConfirmation(state: ChatState, confirmationId: string): ChatState {
  const pending = state.pendingConfirmations.filter((c) => c.confirmationId !== confirmationId)
  if (pending.length === state.pendingConfirmations.length) return state
  return { ...state, pendingConfirmations: pending }
}
