# session-events — 持久化会话事件清单（21 种）

> 权威来源：`packages/core/src/protocol/session-events.ts`（运行时守卫与 meta 投影在 `core/src/session/events.ts`）。存储布局见 [storage](../core/storage.md)，读取接口 `GET /sessions/:id/events` 见 [http-api](../server/http-api.md)。

`events.jsonl` 每行一条 `SessionEvent`，是会话的唯一权威数据；`meta.json` 是它投影出来的快照。与[总线事件](./events.md)的区别：这些事件持久化、只追加、不改写历史行。

## 核心源码

```ts
export type SessionEvent =
  | SessionCreatedEvent | SessionRenamedEvent | SessionDeletedEvent
  | SessionRestoredEvent | SessionSetEvent
  | MessageEvent | MessageTruncatedEvent | CompactionEvent
  | MemoryEvent | SystemEvent | SandboxCheckedEvent
  | RunStartedEvent | RunEndedEvent | PermissionDecidedEvent
  | TeamAuditEvent
```

## 逐类型字段

### 会话元数据（5 种）

| 类型 | 字段 |
|------|------|
| `session.created` | `at`、`title`、`workdir?`、`jobId?`、`mode?`（创建时固化的权限模式快照，旧流默认 default）、`parentSessionId?`（subagent 派生关系） |
| `session.renamed` | `at`、`title` |
| `session.deleted` | `at` |
| `session.restored` | `at` |
| `session.set` | `at`、`model?`、`readonly?`（legacy，读取时映射为 mode）、`mode?`、`disposition?`（键出现才发） |

### 消息与运行（5 种）

| 类型 | 字段 |
|------|------|
| `message` | Message 全量（`{ type: "message" } & Message`） |
| `message.truncated` | `at`、`fromMessageId`（从它起的消息退出对话视图；读取端投影过滤） |
| `compaction` | `at`、`trigger`（manual/in-run/auto）、`emergency?`、`focus?`、`from`、`upto`、`messages`、`segmentSummary`、`top` |
| `system` | `at`、`stable`、`live?`（双段系统提示词记录，每 run 一条）、`text?`（legacy 单文本，读作 stable） |
| `sandbox.checked` | `at`、`enabled`、`available`、`unavailableReason?`（每 run 一条，不进投影） |

### 运行档案（3 种）

| 类型 | 字段 |
|------|------|
| `run.started` | `at`、`trigger`（user/job/agent/team）——每 run 一条 |
| `run.ended` | `at`、`stopReason`、`usage?`（正常终点的全程累计）、`error?`（stopReason 为 error 时）——每 run 恰一条，失败 run 也落 |
| `permission.decided` | `at`、`confirmationId`、`decision`（once/project/global/reject/timeout）、`by`（cli/web/feishu/timeout）、`tool { callId, name, argsJson }`——每次裁决一条 |

### 记忆（1 种）

| 类型 | 字段 |
|------|------|
| `memory` | `at`、`trigger`（7 种，见 [enums](./enums.md)）、`kind`（episode/cognition）、`op`（8 种，见 [enums](./enums.md)）、`topic?`、`file?`、`scope?`、`source?` |

### 团队协作（7 种，TeamAuditEvent）

只追加在组长的事件流上；协作状态以团队目录为准（`.kclaw/teams|tasks/<队名>/`），事件仅作审计记录；每条带 `version`（当前 1），不进 meta 投影、不推进 updatedAt，写失败降级为警告。

| 类型 | 字段 |
|------|------|
| `team.created` | `version`、`at`、`teamId`、`name` |
| `team.member.provisioned` | `version`、`at`、`teamId`、`member`、`sessionId?`、`model?` |
| `team.member.settled` | `version`、`at`、`teamId`、`member`、`status`（active/failed）、`reason?` |
| `team.message.queued` | `version`、`at`、`teamId`、`id`、`from`、`to`、`textPreview` |
| `team.message.delivered` | `version`、`at`、`teamId`、`id`、`to` |
| `team.task.created` | `version`、`at`、`teamId`、`task`（TaskSnapshot 全量） |
| `team.task.updated` | `version`、`at`、`teamId`、`task`（TaskSnapshot 全量） |

TaskSnapshot 的字段（`protocol/team.ts`）：`id`、`subject`、`detail`、`status`、`assignee`（null = 未认领）、`dependencies`、`attempt`、`attemptId?`、`revision`、`createdAt`、`updatedAt`。
