# enums — 状态与模式枚举集

> 真相源分散，每节开头标注。这篇收的是不属于前几篇主题的小枚举；消息 / 块 / 事件 / 帧 / 工具 / 钩子的清单见同目录其余各篇。

## 运行触发源（4 值）

真相源：`core/src/protocol/events.ts`（RunStartedPayload）、`protocol/wire.ts`（QueueEntry）、`protocol/session-events.ts`（run.started）。

| 值 | 含义 |
|----|------|
| `user` | 人发的消息 |
| `job` | 定时任务触发 |
| `agent` | 子代理派生的子 run |
| `team` | 团队收信箱投递 / 派活 |

## 权限模式 PermissionMode（5 值）

真相源：`core/src/permissions/modes.ts`（`PERMISSION_MODES` 常量，严格校验，未知值拒绝）。从紧到松；判定链见 [permissions](../core/permissions.md)。

| 值 | 含义 |
|----|------|
| `readonly` | 只读（写与 exec 拒绝，敏感工具不可见） |
| `default` | 越界操作逐次确认 |
| `acceptEdits` | 工作区内文件写入免确认 |
| `trusted` | 沙箱与工作区内免确认，边界外直接拒绝 |
| `auto` | 反复放行的操作自动沉淀为规则 |

## 确认 / 提问的裁决与来源

真相源：`core/src/protocol/events.ts`（ConfirmationResolvedPayload / QuestionResolvedPayload、session-events.ts 的 PermissionDecidedEvent）。

裁决 `decision`（5 值；客户端能发的只有前四值，见 [wire](./wire.md)）：

| 值 | 含义 |
|----|------|
| `once` | 仅批准本次调用 |
| `project` | 批准并写项目级规则 |
| `global` | 批准并写全局规则 |
| `reject` | 拒绝 |
| `timeout` | 无人裁决等到超时（等待方产生，不是客户端发的） |

来源 `by`（3 值）：`cli` / `web` / `timeout`。

## 排队处置 SendDisposition（3 值）

真相源：`core/src/protocol/wire.ts`。steer（注入本轮）/ wait（排队下一轮）/ interrupt（终止本轮）——见 [wire](./wire.md)。

## 压缩相关

真相源：`core/src/protocol/events.ts`（CompactionPhase）、`protocol/session-events.ts`（CompactionEvent）、`session/compactor.ts`（CompactionOutcome）。

**CompactionPhase（3 值，运行时阶段）**：

| 值 | 含义 |
|----|------|
| `in-run` | 迭代边界的中途压缩（含红线与溢出急救） |
| `post-run` | run 结束后的收尾压缩 |
| `manual` | 手动 /compact |

**compaction 会话事件的 `trigger`（3 值，落盘记录）**：`manual` / `in-run` / `auto`——phase 为 post-run 的落盘时记作 `auto`。

**compaction.completed 的 `result`（3 值）**：`ok` / `failed` / `cancelled`——started 一旦发出 completed 必达。

**CompactionOutcome（4 值，压缩器具名结局）**：

| 值 | 含义 |
|----|------|
| `applied` | 新视图已生效（upto/top 命名边界，segments 计段数） |
| `declined` | 无需压缩（水位细判没收益或无可用边界），静默 |
| `failed` | 摘要器调用失败 |
| `cancelled` | run 中止信号打断，成果吞掉 |

## 记忆事件字段

真相源：`core/src/protocol/session-events.ts`（MemoryEvent）。

**trigger（7 值，写入触发）**：

| 值 | 含义 |
|----|------|
| `immediate` | `memory_save` 工具当轮增量提取 |
| `manual` | `/memory save` 命令 |
| `clear` | 切会话（/clear、/new 与新建会话共用入口） |
| `interval` | 调度器定时兜底（项目全部会话逐个补增量） |
| `follow` | 调度器补查 run 结束时挂起的空闲检查 |
| `nightly` | 夜间闲时内化（每日 consolidateHour） |
| `admin` | 管理面对记忆文件的改写 / 删除 |

**op（8 值，实际操作）**：`append` / `update` / `new-thread` / `rewrite` / `create` / `overwrite` / `delete` / `inactivate`。

**kind（2 值）**：`episode`（经历，项目主题线）/ `cognition`（认知，全局常驻事实）。

## 团队状态

真相源：`core/src/protocol/team.ts`。

| 枚举 | 值 | 含义 |
|------|----|------|
| `TeamMemberStatus` | `provisioning` / `active` / `failed` | 组员生命周期：筹备 → 就绪 \| 失败（终态）；忙闲是派生观察，不落盘 |
| `MailboxStatus` | `pending` / `delivered` | 收信箱条目投递状态；pending 是崩溃重放契约 |
| `TaskStatus` | `pending` / `in_progress` / `completed` / `failed` / `cancelled` | 任务板状态 |
| `TeamSenderKind` | `lead` / `member` / `user` | 收信来源（渲染为发件前缀） |

## provider 层（LLM 协议适配）

真相源：`core/src/provider/types.ts`。

**ProviderMessage 的 role（4 值）**：`system` / `user` / `assistant` / `tool`——发给 LLM 的消息形状（与持久化的 Role 三值不同：system 独立、无本地扩展）。

**ContentPart（2 值，用户消息内的多模态段）**：`text`（文本）/ `image_url`（图片，data: URL）。

**LlmStreamEvent（5 值，provider 流事件）**：

| 值 | 含义 |
|----|------|
| `text_delta` | 文本增量 |
| `thinking_delta` | 思考增量 |
| `tool_call_started` | 工具调用开始（index / callId / name） |
| `tool_call_delta` | 工具参数增量（args 的 JSON 片段） |
| `message_done` | 一条消息完成（stopReason + usage） |

## ID 前缀（13 值）

真相源：`core/src/protocol/ids.ts`（`IdPrefix` 联合 + `newId(prefix)`，前缀 + 单调 ULID，例 `run_01J…`）。

| 前缀 | 用途 | 生成点 |
|------|------|--------|
| `msg` | 消息 id | newMessage；入队时预分配的 messageId 同前缀 |
| `ses` | 会话 id | SessionStore.create |
| `blk` | 块 id | newBlockId |
| `call` | 工具调用 id（已声明） | 无生成点——callId 由 provider 原样传入（缺失时合成 `call_idx_<n>`） |
| `evt` | 总线事件 id | makeEvent |
| `run` | run id | runAgent |
| `conf` | 确认卡 id | 权限引擎的确认 id 工厂 |
| `mem` | 记忆（已声明） | 无生成点——线 / 认知文件按 topic / kind-name 命名 |
| `job` | 定时任务 id | jobs/scheduler.ts |
| `att` | 附件 id | server 上传路由（磁盘文件名 `<att_…>__<原名>`） |
| `q` | 提问 id | ask_user_questions 的 questionId |
| `tm` | 收信箱条目 id | 团队 store（mailbox 入队） |
| `tma` | 任务执行尝试 id | 团队 store（task attemptId） |
