/**
 * Session event-stream types — the wire shapes of GET /sessions/:id/events
 * (events.jsonl lines). Types ONLY (no SessionMeta, no Node APIs) so the
 * browser build can import them through the `@kclaw/core/protocol` subpath;
 * the guards and the meta projection (applyEvent) live in session/events.ts.
 */
import type { Message, StopReason, Usage } from "./messages.js"
import type { TaskSnapshot } from "./team.js"

export interface SessionCreatedEvent { type: "session.created"; at: string; title: string; workdir?: string; jobId?: string; /** 创建时固化的权限模式快照（config permissions.defaultMode）；缺省 default。 */ mode?: import("../permissions/modes.js").PermissionMode; /** 父会话（subagent 派生关系）：设置即子会话——列表默认过滤、记忆提取排除、用量归组到父。 */ parentSessionId?: string }
export interface SessionRenamedEvent { type: "session.renamed"; at: string; title: string }
export interface SessionDeletedEvent { type: "session.deleted"; at: string }
export interface SessionRestoredEvent { type: "session.restored"; at: string }
export interface SessionSetEvent { type: "session.set"; at: string; model?: string | null; /** @legacy pre-mode sessions; superseded by `mode` */ readonly?: boolean | null; mode?: import("../permissions/modes.js").PermissionMode | null; disposition?: "steer" | "wait" | "interrupt" | null }
export type MessageEvent = { type: "message" } & Message
/**
 * Truncation marker for edit & retry / regenerate: everything from
 * fromMessageId (the redone last user message) onward leaves the chat view.
 * The stream only ever gains this marker — no history line is rewritten;
 * visibility is a read-side projection (readMessages filtering, clients
 * converging via the matching broadcast). Truncations stack: a later retry's
 * start id always sorts after earlier ones (message ids are monotonic), so
 * the marker applying to each message is the first one after it in the stream.
 */
export interface MessageTruncatedEvent { type: "message.truncated"; at: string; fromMessageId: string }
export interface CompactionEvent { type: "compaction"; at: string; trigger: "manual" | "in-run" | "auto"; emergency?: true; focus?: string; from: string | null; upto: string; messages: number; segmentSummary: string; top: string }
export interface MemoryEvent {
  type: "memory"; at: string
  trigger: "immediate" | "manual" | "interval" | "follow" | "clear" | "nightly" | "admin"
  kind: "episode" | "cognition"
  op: "append" | "update" | "new-thread" | "rewrite" | "create" | "overwrite" | "delete" | "inactivate"
  topic?: string; file?: string; scope?: string; source?: string
}
/**
 * 系统提示词全量留痕（每 run 一条）。双段结构：stable（人设基座 + 注入约定，
 * 缓存冻结面）在前，live（认知 + 技能清单，低频变化面）在后——前缀缓存按
 * 从头逐字节相同匹配，live 变化只从变化点起失效。legacy 单文本事件只带
 * text（读作 stable）；新事件恒带 stable，live 仅在非空时携带。
 */
export interface SystemEvent { type: "system"; at: string; stable: string; live?: string; /** @legacy pre-split single-text events; reads back as the stable segment */ text?: string }
export interface SandboxCheckedEvent {
  type: "sandbox.checked"; at: string
  /** config 是否开启沙箱（sandbox.enabled）。 */
  enabled: boolean
  /** 探测结果：沙箱可用（exec 工具实际被包裹）；配置关闭时恒 false（fail-closed）。 */
  available: boolean
  /** 不可用原因（仅 available:false 时可能带；配置关闭时不含——那是主动选择）。 */
  unavailableReason?: string
}
/** 一次对话运行的起点留痕（每 run 一条，与消息事件夹出一轮的边界）。 */
export interface RunStartedEvent {
  type: "run.started"; at: string
  trigger: "user" | "job" | "agent" | "team"
}
/**
 * 一次对话运行的终点留痕（每 run 恰一条，与 run.started 成对）。stopReason
 * 为 error 时带 error；正常终点的 usage 为全程累计用量。aborted 也是正常落款
 * （用户中止是有意的终止，不是故障）。
 */
export interface RunEndedEvent {
  type: "run.ended"; at: string
  stopReason: StopReason
  usage?: Usage
  error?: { code: string; message: string }
}
/** 一次人工确认的裁决留痕（每次确认裁决一条；运行中被中止的确认不落——中止不是裁决）。 */
export interface PermissionDecidedEvent {
  type: "permission.decided"; at: string
  confirmationId: string
  decision: "once" | "project" | "global" | "reject" | "timeout"
  by: "cli" | "web" | "timeout"
  tool: { callId: string; name: string; argsJson: string }
}

// ---- Team audit events (the team/* family) ----
// Trail only: the state truth lives in the team directory
// (<workspace>/.agent-teams/<teamId>/); these events exist so the audit page
// can render the coordination timeline on the lead's stream. They never touch
// the meta projection, a write failure degrades to a warning (the team
// operation itself proceeds), and none of them advances updatedAt. Every
// event carries a schema `version` (injected by the team host) so recorded
// trails stay interpretable as the payloads evolve.

export interface TeamCreatedEvent { type: "team.created"; version: 1; at: string; teamId: string; name: string }
export interface TeamMemberProvisionedEvent { type: "team.member.provisioned"; version: 1; at: string; teamId: string; member: string; sessionId?: string; model?: string }
export interface TeamMemberSettledEvent { type: "team.member.settled"; version: 1; at: string; teamId: string; member: string; status: "active" | "failed"; reason?: string }
export interface TeamMessageQueuedEvent { type: "team.message.queued"; version: 1; at: string; teamId: string; id: string; from: string; to: string; textPreview: string }
export interface TeamMessageDeliveredEvent { type: "team.message.delivered"; version: 1; at: string; teamId: string; id: string; to: string }
export interface TeamTaskCreatedEvent { type: "team.task.created"; version: 1; at: string; teamId: string; task: TaskSnapshot }
export interface TeamTaskUpdatedEvent { type: "team.task.updated"; version: 1; at: string; teamId: string; task: TaskSnapshot }

/** The team/* audit family. */
export type TeamAuditEvent = TeamCreatedEvent | TeamMemberProvisionedEvent | TeamMemberSettledEvent | TeamMessageQueuedEvent | TeamMessageDeliveredEvent | TeamTaskCreatedEvent | TeamTaskUpdatedEvent

export type SessionEvent = SessionCreatedEvent | SessionRenamedEvent | SessionDeletedEvent | SessionRestoredEvent | SessionSetEvent | MessageEvent | MessageTruncatedEvent | CompactionEvent | MemoryEvent | SystemEvent | SandboxCheckedEvent | RunStartedEvent | RunEndedEvent | PermissionDecidedEvent | TeamAuditEvent
