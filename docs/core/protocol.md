# protocol — 消息 / 内容块 / 事件 / 指令帧协议

## 职责

`packages/core/src/protocol/` 定义贯穿全系统的数据模型，六个文件按粒度分层：`messages.ts`（持久化单位；持久化 = 写入磁盘长期保存）、`blocks.ts`（消息内结构化片段）、`events.ts`（瞬时广播）、`wire.ts`（WS 指令帧与应答帧）、`session-events.ts`（会话事件流的持久化事件类型）、`ids.ts`（ID 体系）。三层按生命周期划分：

```
Event（瞬时，不持久化）──记录为──▶ Message（持久化单位）──内含──▶ Block（结构化片段）
```

server 与 CLI/WebUI 之间传输的就是这些类型：JSONL（每行一条 JSON 的文本文件）里每行一条 `Message`，WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）事件流里每帧一个 `AgentEvent`，daemon 不翻译、不改写。

**权威类型与出口**：这七份文件是全部线上数据形状的唯一类型出处。除 core 主入口外，它们经 `package.json` 的子路径出口 `@kclaw/core/protocol` 对外发布——纯类型与纯函数、不含任何 Node API，浏览器构建（WebUI）直接 `import type` 引用而不会把 Node 绑定的主入口打进包里（`@kclaw/core/commands` 是同一先例）。三端约定：不手抄镜像，一律引用这份权威定义；web/cli 的事件处理 switch 以 `default: const unhandled: never = event` 断言收尾，core 新增事件类型而处理端未表态时编译失败。

本页讲这组类型的机制与设计取舍；逐值陈列（每个枚举值、每种帧、每个工具的清单）在 [reference](../reference/README.md)——文档需要罗列这些值时引用那边，不另抄一份。

---

## 设计决策

- **事件名 = 块名 + 生命周期后缀**：客户端通过事件前缀即可识别需要处理的块类型；简单客户端可只监听 `*.completed` 做非流式渲染。
- **delta 统一为纯字符串增量**：文本增量与 tool args 的 JSON 片段本质相同，拼接逻辑一套。
- **`llm.*` 事件暴露每次真实模型调用**（attempt/usage/latency）——个人 agent 控成本与调试的基础。
- **`role:"tool"` 独立消息**而非塞回 user：JSONL 逐行读出即完整对话史，发给 provider 只需一层薄转换（`toProviderMessages`）。
- **工具调用跨消息用 `callId` 配对**（OpenAI 风格）；`ToolCallBlock` 同时保留 `args`（解析后，给执行器）与 `argsJson`（原始串，给审计与 provider 回放）。

---

## Message（`messages.ts`）

持久化单位。每条消息的五个公共字段：`id` / `sessionId` / `role` / `blocks` / `createdAt`（ISO-8601）；按 role 扩展出两个子形状——`AssistantMessage` 补 `model` / `usage` / `stopReason` / 可选 `latencyMs`（LLM 生成耗时，仅流成功完成时存在），`ToolMessage` 补 `grantedBy`（callId → 放行原因的映射）。`Role` 三值、`StopReason` 七值、`GrantedBy` 八值与构造函数（`newMessage` / `newToolMessage` / `newAssistantMessage`）的逐值陈列见 [reference/messages](../reference/messages.md)（含 provider finish_reason 的归一化映射表）。

role 与块的事实约定（由 agent 循环维护，非类型强制）见 [reference/blocks](../reference/blocks.md) 的 role × 块类型表。

---

## Block（`blocks.ts`）

六种类型（`text` / `thinking` / `tool_call` / `tool_result` / `note` / `attachment`）的逐字段陈列、note 的五种 kind 与附件的三种 source 见 [reference/blocks](../reference/blocks.md)。

note 是"系统写入对话的信息"（记忆注入、job 触发、迭代截断、权限拒绝/超时），属于对话内容、模型可读。类型守卫 `isBlockType(t, v)` 与 `newBlockId()` 也在此文件。

---

## Event（`events.ts`）

事件公共字段与构造：

```ts
export type AgentEvent<T extends EventType = EventType> = {
  id: string
  ts: string               // ISO-8601
  type: T
  sessionId?: string       // 缺失 == 广播（job.*）
  runId?: string
  payload: EventPayloadMap[T]
}

export function makeEvent<T extends EventType>(
  type: T, payload: EventPayloadMap[T],
  ctx: { sessionId?: string; runId?: string } = {},
): AgentEvent<T>
```

`EventType` 共 **40 种**，十一个分组（生命周期、会话元数据、流式、模型调用、人工确认、运行中提问、note 单发、消息排队与引导、上下文压缩、记忆写入、扩展）。逐事件 payload 与发射方分布的陈列见 [reference/events](../reference/events.md)。

---

## 指令帧与会话事件（`wire.ts` / `session-events.ts`）

`wire.ts` 定义 WS 的客户端→daemon 指令帧（`ClientCommand` 联合，十种）与 daemon→客户端的应答帧（各指令的 ack、`ErrorFrame`），合并为 `ServerFrame`；附件引用 `AttachmentRef{path,name,size,mimeType}` 与排队条目 `QueueEntry` 也在此（`session/store.ts` re-export 保持旧引用路径）。逐帧字段、排队处置三值与 ack 形状的陈列见 [reference/wire](../reference/wire.md)。字段规则与报错文案不在类型里——它们的唯一实现是 server 的 `command-check.ts`（见 [realtime](../server/realtime.md)）。

`session-events.ts` 定义会话事件流（`events.jsonl`，`GET /sessions/:id/events` 的返回形状）的二十二种事件类型，逐类型字段的陈列见 [reference/session-events](../reference/session-events.md)。要点：`message.truncated` 是编辑重试/重新生成的截断标记：附带 `fromMessageId`（被重做的最后一条用户消息），从它起的所有消息退出对话视图。事件流只追加这条标记、不改写任何历史行，可见性是读取端投影（`readMessages` 过滤，客户端经同名广播收敛）。截断可以叠加：重试消息的起始 id 单调递增，先于消息出现的标记决定它是否可见。`session.created` 附带创建时固化的初始权限模式 `mode`（可选，旧流默认 default）与可选 `parentSessionId`（subagent 会话的父会话标识，引擎侧一切 subagent 特化从它派生，见 [subagents](./subagents.md)）；`session.set` 附带元数据的增量补丁（`model` / `mode`（会话权限模式）/ `disposition`，键出现在补丁里才发）；旧会话流里的 `readonly` 布尔字段是 legacy，读取时映射为 `mode`。`sandbox.checked` 是每 run 一条的沙箱状态审计（`{enabled, available, unavailableReason?}`），与 `system` 一样只写事件流、不进 bus 的 `EventType`，对外部的可见性由 `session.appended` 通知帧间接承载（订阅端收到后拉 `/events` 即见）。`run.started` / `run.ended` 每 run 成对出现，把该 run 的消息事件夹成一轮边界，失败 run 也落 `run.ended`（`stopReason:"error"` 带错误），起点的 run 必有终点记录；`permission.decided` 记录每次落定的人工确认裁决（裁决、裁决者、工具身份），运行中被中止的确认不落（中止不是裁决）。`system` 事件是每 run 一条的双段系统提示词记录：`stable`（人设基座 + 注入约定）与可选 `live`（认知 + 技能清单），legacy 单文本事件只带 `text`（读作 stable）。`skill` 事件是技能进化的审计留痕：提案的产生与治理状态迁移各落一条（`op` 取 proposed/applied/rejected/reverted/deleted，`source` 取 follow/skill_create/admin），只留痕、不进投影，真相在 `.proposals/` 的提案文件（见 [skills](./skills.md)）。`team/*` 七种只追加在组长的流上（协作记录以团队目录为准，事件仅作审计记录），每条带 `version` 字段（当前为 1，由团队宿主统一注入），尽力而为、不进投影。assistant 消息可附带可选 `latencyMs`（LLM 生成耗时毫秒，流成功完成时随 `usage` 一并持久化；旧消息与失败流没有）。只放类型；运行时守卫（`isMessageEvent` 等）与 meta 投影（`applyEvent`）在 `session/events.ts`。

---

## 团队域类型（`team.ts`）

`team.ts` 是 agent team 的域类型正本：组员名单条目 `TeamMember`（生命周期 `provisioning → active | failed`，忙闲是运行时观察、不落盘）、收信箱条目 `MailboxEntry`（`pending → delivered`，"仍 pending 即未送达"是崩溃后重投的依据）、任务快照 `TaskSnapshot`（全量快照，单调 `revision` 做写入前核对）、团队记录 `TeamRecord`，以及两个对外投影——`AgentSummary`（组员条目加派生的忙闲与当前任务，面板与花名册共用）和 `TeamPanel`（`GET /sessions/:id/team` 的一次性整读载荷）。团队身份判定与收发机制见 [agent-team](./agent-team.md)。

---

## ID 体系（`ids.ts`）

```ts
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`     // 例: run_01J…，前缀 + 单调 ULID（按时间递增、可排序的唯一 ID）
}
```

13 个前缀（`msg` / `ses` / `blk` / `call` / `evt` / `run` / `conf` / `mem` / `job` / `att` / `q` / `tm` / `tma`）的用途与生成点逐项陈列见 [reference/enums](../reference/enums.md)。单调 ULID 保证同进程内 ID 按时间排序，日志/JSONL 天然有序。

---

## 持久化规则

- **实时增量事件不持久化、不回放**。WS 上推送的事件（text.delta、message.created 等）只描述"正在发生"的增量，不写入磁盘、不重发；会话的权威历史是 events.jsonl 事件流（见下"持久化格式"）。断线恢复 = HTTP `GET /sessions/:id/messages` 拉全量消息 + 只订阅新事件（WS `subscribe`）。单 WS 连接天然有序，事件不带序号——有意的简化。
- **持久化的块永远是完整的**："写到一半的块"只存在于事件流中；`onMessage` 收到的消息是终稿快照。因此 JSONL 每行读取后自洽，无需校验。
- **持久化格式**：会话目录是事件流结构（见 [storage](./storage.md)）——`sessions/<id>/events.jsonl` 是唯一权威数据，一行一条 `JSON.stringify(event)`（消息即 `{type:"message"}` 事件，附带完整 Message）；`meta.json` 是投影快照（标题/时间戳等当前值，可由事件流重建）；`queue.jsonl` 存运行态排队。崩溃安全：读到尾部残缺行（只写了一半的行）时丢弃、写前字节级修复（`storage/jsonl.ts` 的 `readJsonl` / `repairTornTail`）。
- **先持久化后广播**：`message.completed` 永远跟在 `onMessage` 之后，事件流反映的是已持久化状态。

---

## 边界与出错

- 实时事件无 ack、无重发：客户端错过的增量事件不补发，靠「HTTP 拉全量 + 只订阅新事件」补齐，而不是回放（回放语义由 events.jsonl 的唯一权威数据承载，`GET /sessions/:id/events` 可按会话回查整条事件流）。
- `message.created` 之后消息可能永远不 `completed`（空 assistant 被丢弃、宿主 hook 抛错）——客户端不能假设 created 必有 completed 配对。
- `AgentEvent.sessionId` 缺失即广播语义（`EventBus.emit` 发给全部已连接 socket），客户端不应把它当异常。
- `attachment` 的 `file` source 指向 `<home>/attachments/<session-id>/`：客户端先把文件传到该目录（HTTP `POST /sessions/:id/attachments`），发起消息时引用路径、由服务端挂载为块（见 [run-manager](../server/run-manager.md)）；大文件不进 JSONL，JSONL 里只有指向磁盘的元数据。

---

## 关联

- [agent-loop](./agent-loop.md)：谁在什么时机发这些事件
- [reference](../reference/README.md)：全部枚举与清单的陈列正本
- [storage](./storage.md)：JSONL 崩溃安全与路径布局
- [realtime](../server/realtime.md)：EventBus 的订阅与广播实现
- [architecture](../architecture.md)：三层协议在全局数据流中的位置
