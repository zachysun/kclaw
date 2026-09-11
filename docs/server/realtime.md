# realtime — WS 协议与事件总线

## 职责

`packages/server/src/ws.ts` 的 `registerWsRoutes` 提供 `GET /ws` 端点（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送），处理连接认证并分发 8 种客户端命令帧与各自应答（ack）。指令帧/应答帧的**类型的权威定义**在 `@kclaw/core/protocol` 的 `wire.ts`（`ClientCommand` / `ServerFrame`）；每条字段规则与报错文案的**唯一校验实现**在 `packages/server/src/command-check.ts` 的 `checkCommandFrame`（ws.ts 解析 JSON 后调用它，再按返回的合法命令分发——校验顺序与文案集中在一份代码里）。`@kclaw/core` 的 `EventBus`（`packages/core/src/bus.ts`）是进程内的事件分发器：把 agent 循环与服务端流程产生的 39 种事件按会话投递给订阅了它的连接。两者共同构成 daemon 的实时通信层。

## 设计决策

- **事件与命令一条连接、两种帧**：客户端发的命令帧（subscribe/send_message/…）有 ack 无 `payload`；服务端推的事件帧有 `id/ts/type/payload`。客户端以 `"payload" in frame` 区分两类帧，无需状态机。
- **信封零变形**：`AgentEvent` 对象从 agent 循环的 `onEvent` 一路 `JSON.stringify` 到线上，daemon 不翻译、不改写、不新增事件——协议只有一份定义（`packages/core/src/protocol/events.ts`）。
- **鉴权在连接内，不在升级请求上**：浏览器场景常无法携带自定义 header，认证放首帧 `{type:"auth", token}`（或 `?token=` 查询参数），失败时以关闭码 4001 关闭连接。HTTP 层的 Bearer 钩子因此豁免 `/ws` 路由本身。
- **订阅制而非广播制**：带 `sessionId` 的事件只发给订阅了该会话的连接（客户端打开多个标签页时，各标签页订阅各自的会话，互不串流）；无 `sessionId` 的事件（`job.*`、`memory.written`）广播给全体已认证连接——任何客户端都应看到调度与记忆写入活动。
- **单连接天然有序，事件不带序号**：一条 WS 连接内帧顺序即发送顺序，客户端无需核对序号。跨连接/断线不保证——用"拉取全量消息 + 只订阅新事件"恢复，不做实时事件回放（有意简化：实时增量事件不持久化，会话历史以 events.jsonl 事件流为唯一真相，见 [storage](../core/storage.md)）。
- **投递异常不回传发射方**：单个 socket 的 `send` 抛错（连接刚断开）被 try/catch 捕获忽略，不阻断其他订阅者，也不把异常传回正在执行 run 的代码。

## 帧格式

### 客户端 → 服务端

认证首帧（连接后、任何命令前）：

```json
{"type": "auth", "token": "<daemon token>"}
```

8 种命令帧（认证后才受理）：

| 命令帧 | 字段 | 应答（ack） | 失败时的 error 帧 message |
|--------|------|------------|--------------------------|
| `{"type":"subscribe","sessionId"}` | sessionId 非空字符串 | `{"type":"subscribed","sessionId"}` | `subscribe requires a non-empty string sessionId` |
| `{"type":"unsubscribe","sessionId"}` | 同上 | `{"type":"unsubscribed","sessionId"}` | 同上（unsubscribe 版） |
| `{"type":"confirmation.resolve","confirmationId","decision","client"?}` | confirmationId 非空字符串、decision 四值之一 `"once"\|"project"\|"global"\|"reject"`、client 可选 `"cli"\|"web"`（缺省按 cli） | `{"type":"confirmation.resolved_ack","confirmationId","ok":true}` | `unknown confirmation`（未知/已裁决/已过期）；`confirmation gateway unavailable`（app 未接 RunManager）；字段不合法的具体提示（decision 非四值等） |
| `{"type":"send_message","sessionId","text","attachments"?,"disposition"?}` | sessionId/text 非空字符串；`disposition` 可选 `"steer"\|"wait"\|"interrupt"`，缺省 = 会话覆盖（`SessionMeta.dispositionOverride`）?? 配置 `sessions.defaultDisposition` ?? steer；`attachments` 可选，为 `[{path,name,size,mimeType}]` 数组——path 经 realpath 校验必须位于本会话的附件目录（`<attachmentsDir>/<sessionId>/`）内，否则整条拒绝（任意路径会让持 token 者读到 daemon 可达的任意文件） | `{"type":"send_message_ack","sessionId","messageId","queued"}`——**立即**返回，不等 run；`messageId` 是入队时预分配的消息 id（后续事件与 JSONL 都用它，气泡原地升级的锚点）；`queued:false` = 会话空闲直发（不广播 `message.queued`） | 同步失败（无 ack）：`session not found`；`队列已满（10 条）`；`send_message disposition must be "steer", "wait" or "interrupt"`；`send_message attachments are invalid`；`run manager not available`；字段不合法提示。**ack 之后不发迟到 error 帧**（`submit().outcome` 发出后不等待结果）：run 级失败经 `run.failed`、条目级失败经 `run.failed {error.code:"queue_entry_failed"}` 到达订阅者（见下文"消息排队与引导"） |
| `{"type":"queue.cancel","sessionId","messageId"?}` | sessionId 非空字符串；`messageId` 可选（缺省 = 清空全部可取消条目：全部 wait + 未注入 steer） | `{"type":"queue.cancel_ack","sessionId","cancelled":["msg_…"]}`（实际取消的 id 列表） | `已注入`（该条近期已注入，进了 JSONL 机器不删历史）；`not found`；`run manager not available`；字段不合法提示 |
| `{"type":"run.cancel","sessionId"}` | sessionId 非空字符串 | `{"type":"run_cancel_ack","sessionId"}` | `no active run`（该会话当前无正在执行的 run）；`run manager not available` |
`{"type":"compaction.cancel","sessionId"}` | sessionId 非空字符串 | `{"type":"compaction_cancel_ack","sessionId","active"}`（`active` = 取消时是否确有自动压缩正在进行） | `run manager not available`；字段不合法提示。无进行中的压缩时是正常 no-op（`active:false`），不是错误 |
| `{"type":"question.resolve","questionId","answers","client"?}` | questionId 非空字符串、answers 是 `string[][]`（按提问顺序每题一个字符串数组）、client 可选 `"cli"\|"web"`（缺省按 cli） | `{"type":"question.resolved_ack","questionId","ok":true}` | `unknown question`（未知/已过期）；`question gateway unavailable`（app 未接 broker）；字段不合法的具体提示 |

收到未知 `type` 返回 `{"type":"error","message":"unknown command: <type>"}`，连接保持打开；非法 JSON / 非 JSON 对象返回 error 帧（`frame is not valid JSON` / `frame must be a JSON object`），连接同样保持。**认证之前**发来的任何帧（含坏 JSON）都按未授权处理：error 帧 + 关闭码 4001。重复 auth 回 `already authenticated`。认证超时：连接后 `authTimeoutMs`（默认 10s）内未认证即以 4002 关闭。认证通过后有心跳：每 `heartbeatMs`（默认 30s）ping 一次，连续两个周期未收到 pong 即 `terminate` 硬断开（无关闭码）。

### 消息排队与引导（send_message 的队列协议）

`send_message` 的去向由 `disposition` 决定、进度由三个排队事件与 `queue.cancel` 命令承载（服务端机制见 [run-manager](./run-manager.md)）：

- `message.queued {messageId, disposition, position?}`：消息入队/入引导缓冲（ack 的 `queued:true` 必有对应广播；`queued:false` 的空闲直发不发）。`disposition` 按**实际生效**处置报告——无活动 run 的 steer 降级为 wait；`position` 是 wait/interrupt 在可执行队列中的序位（0 起），steer 在缓冲区、不带。
- `message.steered {messageId}`：引导条目在迭代边界注入活动 run（事件级 `runId` 标识注入的 run）——随后该 id 的 `message.created`/`message.completed` 走正常流式，注入即进历史、不可再 `queue.cancel`。
- `message.queue_cancelled {messageId} | {all:true}`：单条或全部排队取消的广播；已注入条目不受 `all:true` 影响（机器不删历史）。
- **条目级失败可见性**：出队持久化失败、条目执行在装配段同步抛出（如降级后的坏附件）这两类失败，循环的 `run.failed` 覆盖不到——驱动器补发 `run.failed {error:{code:"queue_entry_failed", message 含 messageId 与原因}}`（sessionId 级）。已 ack `queued:true` 的消息不会无声消失。

事件在总线广播、ack 在命令通道回包，两条通路各自送达——客户端不应假设 `message.queued` 与 `send_message_ack` 的先后（网络上 queued 可能先于 ack 到达）。

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

`EventType` 共 **39 种**（`packages/core/src/protocol/events.ts`；十一个语义分组的完整表见 [protocol](../core/protocol.md)），按投递方式分两组：

| 分组 | 事件 | 投递 |
|------|------|------|
| 会话事件（带 sessionId，发订阅者） | `run.started` `run.completed` `run.failed`；`message.created` `message.completed`；`text/thinking/tool_call/tool_result` 的 `created/delta/completed`（12 个）；`attachment.created` `attachment.completed`；`llm.started` `llm.completed` `llm.failed`；`confirmation.requested` `confirmation.resolved`；`question.requested` `question.resolved`（`ask_user_questions` 工具的等待生命周期）；`note.emitted`；`message.queued` `message.steered` `message.queue_cancelled`（见上文"消息排队与引导"）；`compaction.started` `compaction.completed`（payload 见 [protocol](../core/protocol.md)：started 带 phase，completed 带 phase/result——`started` 一旦发出 `completed` 必达，成功/失败/取消分别报 `ok`/`failed`/`cancelled`，让客户端可靠地清除"正在压缩"状态）；`session.renamed`；`session.appended`（持久化通知，payload 携带该次写入事件的 `eventType`） | `EventBus.emit` 查 `sessions.get(sessionId)`，发给该集合内的 socket |
| 广播事件（无 sessionId，发全体连接） | `job.started` `job.completed` `job.failed`；`memory.written`（记忆写入，项目级事务不带 sessionId——见下） | `EventBus.emit` 遍历全部已 connect 的 socket |

发射方分布：26 种会话事件由 agent 循环产生、经引擎（core `executeRun`）的 `onEvent` 钩子发送到总线（含 `run.failed {code:"steering_failed"}` 等循环内合成的终态，steering 注入时逐条发出的 `message.steered`，以及 `ask_user_questions` 工具执行器经装配注入的 emit 钩子发出的 `question.requested`/`question.resolved`——执行器运行在循环的工具回合内）。不经 agent 循环的会话事件由服务端流程直接发送：`message.queued`/`message.queue_cancelled` 与条目级失败的 `run.failed {code:"queue_entry_failed"}` 由 `RunManager`（submit / queueCancel / recoverQueues / 驱动器）发出；`compaction.started`/`completed` 由 core 压缩引擎 `Compactor`（收尾/中途/超限三路共用的 `auto`，见 [run-manager](./run-manager.md)）发出；`session.renamed` 不经过 agent 循环：run 入队用户消息后，引擎会异步调度 `scheduleAutoname`（core `session/autoname.ts`）生成会话标题，新标题成功写回 meta 后才经注入的 emit 钩子（`busEmit`）发出这个事件；生成失败则静默放弃（流程细节见 [run-manager](./run-manager.md)）。`session.appended` 由 `SessionStore` 在**每个事件（含投影）成功写入 events.jsonl 之后**经 daemon 装配的回调发出（先写入磁盘后广播，对全部十三种持久化事件生效；web 审计页收到它即按 `?since=` 游标增量拉取——这是唯一一条由存储层而非业务流程发出的事件）。3 种 `job.*` 由 `scheduler-tick.ts` 的 `makeEvent(...)` **不带 ctx** 调用产生（`makeEvent` 只在传了 `ctx.sessionId` 时才写字段）。`memory.written` 由 core 的 `MemoryPipeline` 在每次写入时发出，经 daemon 装配的 emit 钩子（`daemon.ts`）广播——不带 sessionId（项目级事务），订阅端只当"已写入"的轻提示。`attachment.*` 已定义但当前无发射方。

## 订阅模型（EventBus）

```ts
// @kclaw/core — packages/core/src/bus.ts（进程内事件分发器，server 经 @kclaw/core 引用）
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
  │── send_message / run.cancel / queue.cancel / confirmation.resolve / unsubscribe …
  │◀── 对应 ack / error 帧
  │── close ────────────────────────────▶ socket.on("close") → bus.unsubscribe(socket)
```

自定义关闭码三个：`CLOSE_UNAUTHORIZED = 4001`（认证失败）、`CLOSE_AUTH_TIMEOUT = 4002`（认证超时）、`CLOSE_ORIGIN_NOT_ALLOWED = 1008`（带非回环浏览器 Origin 的升级被拒；无 Origin 头放行——CLI 等非浏览器客户端）。客户端仅将 4001 作为"token 失效"专门处理（见下），其余一律视为意外断线并重连——心跳 `terminate` 是无关闭码的硬断开，同样走意外断线路径。

## 断线恢复：拉取全量 + 只订阅新事件，无实时事件回放

实时增量事件不持久化，服务端不做实时事件回放。会话的权威历史在 events.jsonl（唯一真相，见 [storage](../core/storage.md)），恢复协议（两个客户端实现一致的恢复策略）：

```
意外断线（非 4001）
  → 建新连接（web: createWs()；CLI: KclawClient.connect，daemon 已终止时重新启动一个）
  → 重新 auth + subscribe（CLI 等 subscribed ack，限时 5s：SUBSCRIBE_ACK_MS）
  → GET /sessions/:id/messages 拉取全量消息
  → 客户端把全量消息与已有视图合并（web: mergeMessages；CLI 不重新渲染）
  → 此后只处理新到达的事件帧
```

- **web**（`packages/web/src/chat/ChatPanel.tsx`）：连续失败重连上限 `MAX_RECONNECT_ATTEMPTS = 3`（成功一次即清零计数），超过则提示"重连失败，请刷新页面"停止；4001 关闭不重连，提示重新输入 token。合并语义在 `packages/web/src/chat/model.ts` 的 `mergeMessages`：新拉的消息列表是权威状态，覆盖本地流式中的未完成版本。对齐之后还有一个**补发环节**：对齐前快照的未确认发送（`local-` 行/气泡），对齐后在队列快照与消息列表里都找不到同文本的，视为从未送达、按原处置自动补发——判定只认服务端证据（本地即时回显不算），与 CLI 重发规则同一保守方向（宁漏发不双发）。
- **CLI**（`packages/cli/src/chat.ts`）：重连后观察到的事件带 120s 静默超时（`POST_RECONNECT_SILENCE_MS = 120_000`，超时内一帧未到就认定 run 已终止、放弃等待）——daemon 已终止的 run 永远不会完成，REPL 不可无限等待。**重发规则**：发送中的消息仅当观察到**零帧**（连 `send_message_ack` 都没有）才重发——零帧证明消息从未到达存活的 daemon；一旦观察到任何帧（ack 即证明服务端已入队）就绝不重发，宁可等待静默超时，避免同一消息被执行两次。
- **为什么无回放可行**：持久化的块永远是完整终稿（见 [protocol](../core/protocol.md)），`GET /sessions/:id/messages` 拉取到的每条消息自洽；实时事件流只是"正在发生"的增量视图，丢失即丢弃，下一次全量拉取自然对齐（权威历史在 events.jsonl，需要回查可走 `GET /sessions/:id/events`）。

## 边界与出错

- **认证超时**：连接后 `authTimeoutMs`（默认 10s）内未认证即以 4002 关闭，未认证连接不再无限期挂着。
- **错过的 confirmation.requested 不可恢复**：确认等待有时限（120s 默认），断线期间超时的确认按拒绝处理；重连拉取全量只能看到结果（note 块），不能补答。
- **广播事件可能漏**：只 `connect` 未 `subscribe` 的连接收得到 `job.*`，但连接尚在认证前时收不到任何事件。
- **同 token 多连接无互斥**：两个连接订阅同一会话各自收到全部分片事件；`send_message` 会各自入队（会话内仍串行，见 [run-manager](./run-manager.md)）。
- **帧大小无限制**：不校验单帧长度，依赖 ws 库默认行为。

## 关联

- [protocol](../core/protocol.md)：39 种事件与 payload 全表、信封字段
- [run-manager](./run-manager.md)：命令帧在服务端的后续（入队/取消/确认网关）
- [http-api](./http-api.md)：断线恢复依赖的 `GET /sessions/:id/messages`
- [daemon](./daemon.md)：/ws 为何豁免 HTTP 鉴权
