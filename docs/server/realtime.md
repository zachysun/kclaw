# realtime — WS 协议与事件总线

## 职责

`packages/server/src/ws.ts` 的 `registerWsRoutes` 提供 `GET /ws` 端点（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送），定义连接认证、5 种客户端命令帧与各自应答（ack）。`packages/server/src/bus.ts` 的 `EventBus` 是进程内的事件分发器：把 agent 循环产生的 28 种事件按会话投递给订阅了它的连接。两者共同构成 daemon 的实时通信层。

## 设计决策

- **事件与命令一条连接、两种帧**：客户端发的命令帧（subscribe/send_message/…）有 ack 无 `payload`；服务端推的事件帧有 `id/ts/type/payload`。客户端以 `"payload" in frame` 区分两类帧，无需状态机。
- **信封零变形**：`AgentEvent` 对象从 agent 循环的 `onEvent` 一路 `JSON.stringify` 到线上，daemon 不翻译、不改写、不新增事件——协议只有一份定义（`packages/core/src/protocol/events.ts`）。
- **鉴权在连接内，不在升级请求上**：浏览器场景常无法携带自定义 header，认证放首帧 `{type:"auth", token}`（或 `?token=` 查询参数），失败时以关闭码 4001 关闭连接。HTTP 层的 Bearer 钩子因此豁免 `/ws` 路由本身。
- **订阅制而非广播制**：带 `sessionId` 的事件只发给订阅了该会话的连接（客户端打开多个标签页时，各标签页订阅各自的会话，互不串流）；无 `sessionId` 的事件（`job.*`）广播给全体已认证连接——任何客户端都应看到调度活动。
- **单连接天然有序，事件不带序号**：一条 WS 连接内帧顺序即发送顺序，客户端无需对账序号。跨连接/断线不保证——用"拉取全量消息 + 只订阅新事件"恢复，不做事件回放（有意简化：事件不持久化）。
- **投递异常不回传发射方**：单个 socket 的 `send` 抛错（连接刚断开）被 try/catch 捕获忽略，不阻断其他订阅者，也不把异常传回正在执行 run 的代码。

## 帧格式

### 客户端 → 服务端

认证首帧（连接后、任何命令前）：

```json
{"type": "auth", "token": "<daemon token>"}
```

5 种命令帧（认证后才受理）：

| 命令帧 | 字段 | 应答（ack） | 失败时的 error 帧 message |
|--------|------|------------|--------------------------|
| `{"type":"subscribe","sessionId"}` | sessionId 非空字符串 | `{"type":"subscribed","sessionId"}` | `subscribe requires a non-empty string sessionId` |
| `{"type":"unsubscribe","sessionId"}` | 同上 | `{"type":"unsubscribed","sessionId"}` | 同上（unsubscribe 版） |
| `{"type":"confirmation.resolve","confirmationId","approved","client"?}` | confirmationId 非空字符串、approved 布尔、client 可选 `"cli"|"web"`（缺省按 cli） | `{"type":"confirmation.resolved_ack","confirmationId","ok":true}` | `unknown confirmation`（未知/已裁决/已过期）；`confirmation gateway unavailable`（app 未接 RunManager）；字段不合法的具体提示 |
| `{"type":"send_message","sessionId","text"}` | 两者非空字符串 | `{"type":"send_message_ack","sessionId"}`——**立即**返回，不等 run | `session not found`；`run manager not available`；字段不合法提示。ack 之后 enqueue 才失败（存储错误）时，error 帧只发到这条 socket |
| `{"type":"run.cancel","sessionId"}` | sessionId 非空字符串 | `{"type":"run_cancel_ack","sessionId"}` | `no active run`（该会话当前无正在执行的 run）；`run manager not available` |

收到未知 `type` 返回 `{"type":"error","message":"unknown command: <type>"}`，连接保持打开；非法 JSON / 非 JSON 对象返回 error 帧（`frame is not valid JSON` / `frame must be a JSON object`），连接同样保持。**认证之前**发来的任何帧（含坏 JSON）都按未授权处理：error 帧 + 关闭码 4001。重复 auth 回 `already authenticated`。v1 没有认证超时——连接保持未认证状态也不会被主动断开。

### 服务端 → 客户端

两类：

1. **命令 ack / error 帧**：见上表，无 `id/ts/payload`。
2. **事件帧**：完整 `AgentEvent` 信封：

```ts
{ id: string           // evt_<ULID>
, ts: string           // ISO-8601
, type: EventType
, sessionId?: string   // 缺失 == 广播（job.*）
, runId?: string
, payload: …           // 按 type 不同，见 core/protocol.md
}
```

`EventType` 共 **28 种**（`packages/core/src/protocol/events.ts`），按投递方式分两组：

| 分组 | 事件 | 投递 |
|------|------|------|
| 会话事件（带 sessionId，发订阅者） | `run.started` `run.completed` `run.failed`；`message.created` `message.completed`；`text/thinking/tool_call/tool_result` 的 `created/delta/completed`（12 个）；`attachment.created` `attachment.completed`；`llm.started` `llm.completed` `llm.failed`；`confirmation.requested` `confirmation.resolved`；`note.emitted` | `EventBus.emit` 查 `sessions.get(sessionId)`，发给该集合内的 socket |
| 广播事件（无 sessionId，发全体连接） | `job.started` `job.completed` `job.failed` | `EventBus.emit` 遍历全部已 connect 的 socket |

发射方分布：25 种会话事件由 agent 循环产生、经 `RunManager` 的 `onEvent` 钩子发送到总线（见 [run-manager](./run-manager.md)）；3 种 `job.*` 由 `scheduler-tick.ts` 的 `makeEvent(...)` **不带 ctx** 调用产生（`makeEvent` 只在传了 `ctx.sessionId` 时才写字段）。`attachment.*` 已定义但当前无发射方。

## 订阅模型（EventBus）

```ts
// packages/server/src/bus.ts
export class EventBus {
  connect(socket: BusSocket): void            // 注册已认证连接：开始接收广播（job.*）
  subscribe(sessionId: string, socket: BusSocket): void   // 该 socket 订阅此会话；重复订阅幂等（重复执行结果不变）
  unsubscribe(socket: BusSocket): void        // 断开：清掉该 socket 的全部订阅状态
  unsubscribe(sessionId: string, socket: BusSocket): void // 只退订单个会话
  emit(e: AgentEvent): void                   // 按 e.sessionId 分发；无 sessionId 广播全体
  subscriberCount(sessionId: string): number  // 当前订阅数（测试用）
}
```

两张索引表：`sockets: Map<socket, Set<sessionId>>`（一个连接订阅多个会话）与 `sessions: Map<sessionId, Set<socket>>`（一个会话多个观察者）。`emit` 只做一次 `JSON.stringify`，然后逐 socket `deliver`——每次投递独立 try/catch，坏 socket 被跳过但**留在注册表里**（移除由 ws 层的 close 处理器完成：`socket.on("close") → bus.unsubscribe(socket)`）。

单连接有序的来源：`emit` 同步串行循环，同一事件循环 tick 内发出的帧按 emit 顺序写进同一条 socket，TCP 保证到达顺序。

## 连接与认证时序

```
客户端                                    服务端 (ws.ts handleConnection)
  │── HTTP GET /ws 升级（无 Authorization）──▶ preHandler 豁免（routeUrl === "/ws"）
  │                                          query ?token= 命中 tokenEquals？→ 已认证 + bus.connect
  │── {"type":"auth","token"} ────────────▶ 首帧非 auth / token 错 → error 帧 + close 4001
  │                                          认证通过 → authenticated = true + bus.connect
  │── {"type":"subscribe","sessionId"} ───▶ bus.subscribe
  │◀── {"type":"subscribed","sessionId"} ── ack
  │◀── 事件帧（仅该 sessionId 的 + 广播的 job.*）
  │── send_message / run.cancel / confirmation.resolve / unsubscribe …
  │◀── 对应 ack / error 帧
  │── close ────────────────────────────▶ socket.on("close") → bus.unsubscribe(socket)
```

关闭码只有一个自定义值：`CLOSE_UNAUTHORIZED = 4001`。客户端将其作为"token 失效"专门处理（见下），其余关闭码一律视为意外断线并重连。

## 断线恢复：拉取全量 + 只订阅新事件，无回放

事件不持久化，服务端没有任何回放机制。恢复协议（两个客户端实现一致，策略在 spec §5.3 rule 3 固定）：

```
意外断线（非 4001）
  → 建新连接（web: createWs()；CLI: KclawClient.connect，daemon 已终止时重新启动一个）
  → 重新 auth + subscribe（CLI 等 subscribed ack，预算 5s：SUBSCRIBE_ACK_MS）
  → GET /sessions/:id/messages 拉取全量消息
  → 客户端把全量消息与已有视图合并（web: mergeMessages；CLI v1 不重新渲染）
  → 此后只处理新到达的事件帧
```

- **web**（`packages/web/src/chat/ChatPanel.tsx`）：连续失败重连上限 `MAX_RECONNECT_ATTEMPTS = 3`（成功一次即重置预算），超过则提示"重连失败，请刷新页面"停止；4001 关闭不重连，提示重新输入 token。合并语义在 `packages/web/src/chat/model.ts` 的 `mergeMessages`：新拉的消息列表是权威状态，覆盖本地流式中的未完成版本。
- **CLI**（`packages/cli/src/chat.ts`）：重连后观察到的事件带 120s 静默超时（`POST_RECONNECT_SILENCE_MS = 120_000`，超时内一帧未到就认定 run 已终止、放弃等待）——daemon 已终止的 run 永远不会完成，REPL 不可无限等待。**重发规则**：发送中的消息仅当观察到**零帧**（连 `send_message_ack` 都没有）才重发——零帧证明消息从未到达存活的 daemon；一旦观察到任何帧（ack 即证明服务端已入队）就绝不重发，宁可等待静默超时，避免同一消息被执行两次。
- **为什么无回放可行**：持久化的块永远是完整终稿（见 [protocol](../core/protocol.md)），`GET /sessions/:id/messages` 拉取到的每条消息自洽；事件流只是"正在发生"的增量视图，丢失即丢弃，下一次全量拉取自然对齐。

## 边界与出错

- **无认证超时**：连接后不认证也持续保持（占用一个 EventBus 注册表条目，能接收广播事件）。
- **错过的 confirmation.requested 不可恢复**：确认等待有时限（120s 默认），断线期间超时的确认按拒绝处理；重连拉取全量只能看到结果（note 块），不能补答。
- **广播事件可能漏**：只 `connect` 未 `subscribe` 的连接收得到 `job.*`，但连接尚在认证前时收不到任何事件。
- **同 token 多连接无互斥**：两个连接订阅同一会话各自收到全部分片事件；`send_message` 会各自入队（会话内仍串行，见 [run-manager](./run-manager.md)）。
- **帧大小无限制**：v1 不校验单帧长度，依赖 ws 库默认行为。

## 关联

- [protocol](../core/protocol.md)：28 种事件与 payload 全表、信封字段
- [run-manager](./run-manager.md)：命令帧在服务端的后续（入队/取消/确认网关）
- [http-api](./http-api.md)：断线恢复依赖的 `GET /sessions/:id/messages`
- [daemon](./daemon.md)：/ws 为何豁免 HTTP 鉴权
