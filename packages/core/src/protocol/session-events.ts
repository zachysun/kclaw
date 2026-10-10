/**
 * Session event-stream types — the wire shapes of GET /sessions/:id/events
 * (events.jsonl lines). Types ONLY (no SessionMeta, no Node APIs) so the
 * browser build can import them through the `@kclaw/core/protocol` subpath;
 * the guards and the meta projection (applyEvent) live in session/events.ts.
 */
import type { Message, StopReason, Usage } from "./messages.js"
import type { RunTrigger } from "./events.js"
import type { TaskSnapshot } from "./team.js"

export interface SessionCreatedEvent { type: "session.created"; at: string; title: string; workdir?: string; jobId?: string; /** 创建时固化的权限模式快照（config permissions.defaultMode）；不写时 default。 */ mode?: import("../permissions/modes.js").PermissionMode; /** 父会话（subagent 派生关系）：设置即子会话——列表默认过滤、记忆提取排除、用量归组到父。 */ parentSessionId?: string }
export interface SessionRenamedEvent { type: "session.renamed"; at: string; title: string; /** 触发来源：auto = autoname 生成，manual = 用户改名；旧事件无此字段按 manual 理解。 */ source?: "auto" | "manual" }
export interface SessionDeletedEvent { type: "session.deleted"; at: string }
export interface SessionRestoredEvent { type: "session.restored"; at: string }
export interface SessionSetEvent { type: "session.set"; at: string; model?: string | null; mode?: import("../permissions/modes.js").PermissionMode | null; disposition?: "steer" | "wait" | "interrupt" | null }
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
export interface CompactionEvent { type: "compaction"; at: string; trigger: "manual" | "in-run" | "auto"; emergency?: true; focus?: string; from: string | null; upto: string; messages: number; segmentSummary: string; top: string; /** 压缩前活跃段上下文 token（口径见 CompactionRecord.tokensBefore）。 */ tokensBefore?: number; /** 压缩后等效上下文 token（口径见 CompactionRecord.tokensAfter）。 */ tokensAfter?: number }
export interface MemoryEvent {
  type: "memory"; at: string
  trigger: "immediate" | "manual" | "interval" | "follow" | "clear" | "nightly" | "admin"
  kind: "episode" | "cognition"
  op: "append" | "update" | "new-thread" | "rewrite" | "create" | "overwrite" | "delete" | "inactivate"
  topic?: string; file?: string; scope?: string; source?: string
}
/**
 * 系统提示词全量记录（每 run 一条）。双段结构：stable（人设基础文本 + 注入约定，
 * 缓存冻结面）在前，live（认知 + 技能清单，低频变化面）在后——前缀缓存按
 * 从头逐字节相同匹配，live 变化只从变化点起失效。stable 恒有，live 仅在
 * 非空时携带。
 */
export interface SystemEvent { type: "system"; at: string; stable: string; live?: string }
export interface SandboxCheckedEvent {
  type: "sandbox.checked"; at: string
  /** config 是否开启沙箱（sandbox.enabled）。 */
  enabled: boolean
  /** 探测结果：沙箱可用（exec 工具实际被包裹）；配置关闭时恒 false（fail-closed）。 */
  available: boolean
  /** 不可用原因（仅 available:false 时可能带；配置关闭时不含——那是主动选择）。 */
  unavailableReason?: string
}
/** 一次对话运行的起点记录（每 run 一条，与消息事件夹出一轮的边界）。 */
export interface RunStartedEvent {
  type: "run.started"; at: string
  trigger: RunTrigger
}
/**
 * 一次对话运行的终点记录（每 run 恰一条，与 run.started 成对）。stopReason
 * 为 error 时带 error；正常终点的 usage 为全程累计用量。aborted 也是正常落款
 * （用户中止是有意的终止，不是故障）。
 */
export interface RunEndedEvent {
  type: "run.ended"; at: string
  stopReason: StopReason
  usage?: Usage
  error?: { code: string; message: string }
}
/** 一次人工确认的裁决记录（每次确认裁决一条；运行中被中止的确认不落——中止不是裁决）。 */
export interface PermissionDecidedEvent {
  type: "permission.decided"; at: string
  confirmationId: string
  decision: "once" | "project" | "global" | "reject" | "timeout"
  by: "cli" | "web" | "feishu" | "timeout"
  tool: { callId: string; name: string; argsJson: string }
}

/**
 * 技能提案审计事件（skill/* 家族，现状唯一的技能写路径记录）：提案的产生
 * 与治理状态迁移各落一条。真相在 <skillsDir>/.proposals/ 的提案文件，事件
 * 只记录——不进 meta 投影、不推进 updatedAt（与 memory 事件同约定）。归属：
 * follow/skill_create = 来源会话；admin（路由治理动作）= 项目最近活动会话
 * （scope=project）或最近全局会话（scope=global），无会话则跳过。
 */
export interface SkillEvent {
  type: "skill"; at: string
  op: "proposed" | "applied" | "rejected" | "reverted" | "deleted"
  kind: "new" | "revise"
  name: string
  scope: "global" | "project"
  source: "follow" | "skill_create" | "admin"
}

// ---- Team audit events (the team/* family) ----
// Trail only: the state truth lives in the team directory
// (<workspace>/.kclaw/teams/<team-name>/ and .kclaw/tasks/<team-name>/);
// these events exist so the audit page
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

// ---- /goal events (issue #47) ----
// goal.set 携带变更后的完整快照（所有变更形态经 op 区分）；goal.cleared
// 整体移除；goal.checked 只记录（判定器调用与验收输出，不进 meta 投影、
// 不推进 updatedAt——与 skill/memory 审计事件同约定）。快照类型见
// @kclaw/core/goal（GoalSnapshot）。

export interface GoalSetEvent {
  type: "goal.set"; at: string
  /** 变更形态：create=设定；edit=改文本/验收；pause/resume=用户暂停恢复；state=调用方驱动的状态迁移（终态/守卫暂停）。 */
  op: "create" | "edit" | "pause" | "resume" | "state"
  goal: import("../goal/types.js").GoalSnapshot
}
export interface GoalClearedEvent { type: "goal.cleared"; at: string; hadState: import("../goal/types.js").GoalState }
/**
 * 一轮判定记录（每轮至多一条）：验收命令输出 + 判定器裁决（或失败原因）。
 * gates 全过才有 verdict；判定器解析/传输失败时 judgeError 记录归类
 * 与摘要（熔断计数的依据在调用方内存里，事件只记录）。
 */
export interface GoalCheckedEvent {
  type: "goal.checked"; at: string
  /** 本轮序号（自续轮生命周期计数）。 */
  round: number
  gates: import("../goal/types.js").GoalGateOutcome[]
  verdict?: import("../goal/types.js").GoalVerdict
  reason?: string
  progress?: string
  judgeError?: { kind: "parse" | "transport"; message: string }
  /** 判定器本次调用的 token 用量（重试轮合并计）。 */
  tokens?: { inputTokens: number; outputTokens: number }
}

export type GoalEvent = GoalSetEvent | GoalClearedEvent | GoalCheckedEvent

export type SessionEvent = SessionCreatedEvent | SessionRenamedEvent | SessionDeletedEvent | SessionRestoredEvent | SessionSetEvent | MessageEvent | MessageTruncatedEvent | CompactionEvent | MemoryEvent | SkillEvent | SystemEvent | SandboxCheckedEvent | RunStartedEvent | RunEndedEvent | PermissionDecidedEvent | TeamAuditEvent | GoalEvent
