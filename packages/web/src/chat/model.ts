/**
 * Event → view-model reducer for the streaming chat view (the daemon's event
 * catalog and wire order).
 *
 * The web package is intentionally self-contained (no runtime dependency on
 * @kclaw/core): the structural protocol shapes below mirror the daemon's wire
 * format, so this module type-checks and runs without the core package's
 * build artifacts. The wire shapes are stable protocol contracts (see
 * packages/core/src/protocol) — only the UI-relevant subset is modeled here.
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

/** Structural Message (mirrors @kclaw/core Message). */
export type Role = "user" | "assistant" | "tool"

export interface TextBlock { id: string; type: "text"; text: string }
export interface ThinkingBlock { id: string; type: "thinking"; text: string }
export interface ToolCallBlock {
  id: string
  type: "tool_call"
  callId: string
  name: string
  args: unknown
  argsJson: string
}
export interface ToolResultBlock {
  id: string
  type: "tool_result"
  callId: string
  status: "ok" | "error"
  output: string
  data?: unknown
  durationMs: number
}
export interface NoteBlock { id: string; type: "note"; kind: string; text: string; compact?: { segments: number; kept: number } }
export interface AttachmentBlock {
  id: string
  type: "attachment"
  mimeType: string
  text?: string
  source: unknown
}
export type Block = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | NoteBlock | AttachmentBlock

export interface Message {
  id: string
  sessionId: string
  role: Role
  blocks: Block[]
  createdAt: string
}

/** Structural AgentEvent (mirrors @kclaw/core AgentEvent) — UI-relevant subset. */
interface Envelope { id: string; ts: string; sessionId?: string; runId?: string }

export interface ConfirmationRequestedPayload {
  confirmationId: string
  toolCall: ToolCallBlock
  risk: "safe" | "sensitive"
  expiresAt: string
}

/** The daemon's full event catalog, used to split handled/unhandled. */
export type EventType =
  | "run.started" | "run.completed" | "run.failed"
  | "message.created" | "message.completed"
  | "job.started" | "job.completed" | "job.failed"
  | "session.renamed"
  | "text.created" | "text.delta" | "text.completed"
  | "thinking.created" | "thinking.delta" | "thinking.completed"
  | "tool_call.created" | "tool_call.delta" | "tool_call.completed"
  | "tool_result.created" | "tool_result.delta" | "tool_result.completed"
  | "attachment.created" | "attachment.completed"
  | "llm.started" | "llm.completed" | "llm.failed"
  | "confirmation.requested" | "confirmation.resolved"
  | "note.emitted"
  | "compaction.started" | "compaction.completed"

type EventKind =
  | { type: "run.started"; payload: { trigger: string } }
  | { type: "run.completed"; payload: { stopReason: string } }
  | { type: "run.failed"; payload: { error: { code: string; message: string } } }
  | { type: "message.created" | "message.completed"; payload: { message: Message } }
  | { type: "text.created"; payload: { messageId: string; block: TextBlock } }
  | { type: "thinking.created"; payload: { messageId: string; block: ThinkingBlock } }
  | { type: "tool_call.created"; payload: { messageId: string; block: ToolCallBlock } }
  | { type: "tool_result.created"; payload: { messageId: string; block: ToolResultBlock } }
  | { type: "text.delta" | "thinking.delta" | "tool_call.delta"; payload: { messageId: string; blockId: string; delta: string } }
  | { type: "tool_result.delta"; payload: { messageId: string; callId: string; delta: string } }
  | { type: "text.completed"; payload: { messageId: string; block: TextBlock } }
  | { type: "thinking.completed"; payload: { messageId: string; block: ThinkingBlock } }
  | { type: "tool_call.completed"; payload: { messageId: string; block: ToolCallBlock } }
  | { type: "tool_result.completed"; payload: { messageId: string; block: ToolResultBlock } }
  | { type: "note.emitted"; payload: { messageId: string; block: NoteBlock } }
  | { type: "llm.completed"; payload: { usage?: unknown; stopReason?: string } }
  | { type: "llm.failed"; payload: { error?: unknown; willRetry?: boolean; attempt?: number } }
  | { type: "confirmation.requested"; payload: ConfirmationRequestedPayload }
  | { type: "confirmation.resolved"; payload: { confirmationId: string; approved: boolean; by: string } }
  | { type: "compaction.started"; payload: Record<string, never> }
  | { type: "compaction.completed"; payload: { segments?: number; kept?: number } }
  // The rest of the catalog flows through the reducer unchanged (default case).
  | { type: Exclude<EventType, HandledEventType>; payload: unknown }

/** The event types the reducer acts on (the discriminated union above). */
type HandledEventType =
  | "run.started" | "run.completed" | "run.failed"
  | "message.created" | "message.completed"
  | "text.created" | "text.delta" | "text.completed"
  | "thinking.created" | "thinking.delta" | "thinking.completed"
  | "tool_call.created" | "tool_call.delta" | "tool_call.completed"
  | "tool_result.created" | "tool_result.delta" | "tool_result.completed"
  | "confirmation.requested" | "confirmation.resolved"
  | "note.emitted" | "llm.completed" | "llm.failed"
  | "compaction.started" | "compaction.completed"

export type AgentEvent = Envelope & EventKind

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

export interface ChatState {
  messages: RenderedMessage[]
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
   * A pre-run context compaction is running (compaction.started …
   * compaction.completed). The run lifecycle events also clear it: a FAILED
   * compaction never emits completed — it falls back to full history and the
   * run starts anyway, so run.started is the reliable backstop.
   */
  compacting?: boolean
}

/** Build the initial view from the persisted message list (no event replay). */
export function initChat(messages: Message[]): ChatState {
  return {
    messages: messages.map((m) => renderMessage(m, false)),
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

/** Apply one wire event to the view, returning a NEW state. */
export function applyEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case "run.started":
      return { ...state, runState: "running", error: undefined, compacting: false }
    case "run.completed":
      return { ...state, runState: "idle", retryHint: null, compacting: false }
    case "run.failed":
      return { ...state, runState: "idle", error: event.payload.error?.message ?? "run failed", retryHint: null, compacting: false }
    case "compaction.started":
      return { ...state, compacting: true }
    case "compaction.completed":
      return { ...state, compacting: false }
    case "llm.completed":
      return { ...state, retryHint: null }
    case "llm.failed":
      // Only provider RETRIES set the hint (willRetry:true); a final
      // llm.failed {willRetry:false} is a plain terminal llm error, which
      // run.failed surfaces — leave the view untouched.
      if (event.payload.willRetry !== true) return state
      return {
        ...state,
        retryHint: {
          attempt: typeof event.payload.attempt === "number" ? event.payload.attempt : undefined,
        },
      }
    case "message.created": {
      // Optimistic-echo merge: the server skeleton replaces the local twin AT
      // ITS POSITION — appending would hoist later queued optimistic bubbles
      // (sent after this one) above it until their own echoes land.
      const twinIdx = findOptimisticTwinIdx(state, event.payload.message)
      const rendered = renderMessage(event.payload.message, true)
      if (twinIdx === -1) return upsertMessage(state, rendered)
      const messages = state.messages.slice()
      messages[twinIdx] = rendered
      return { ...state, messages }
    }
    case "message.completed":
      return upsertMessage(state, renderMessage(event.payload.message, false))
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
    default:
      return state
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
