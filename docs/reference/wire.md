# wire — WS 指令帧与应答帧清单

> 真相源：`packages/core/src/protocol/wire.ts`。字段校验规则与报错文案见 [realtime](../server/realtime.md)（server 的 `command-check.ts`）。

WS 连接上双向传输的帧。客户端 → daemon 是指令帧（`ClientCommand`），daemon → 客户端是应答帧（`ServerAck`）、总线[事件](./events.md)或 error 帧，合并为 `ServerFrame`。

## 核心源码

```ts
/** How a send_message rides the queue: steer injects, wait queues, interrupt preempts. */
export type SendDisposition = "steer" | "wait" | "interrupt"

export interface AttachmentRef { path: string; name: string; size: number; mimeType: string }

/** 机器来源说明：随队列条目落成用户消息上的 note 块（kind 见 blocks.md NoteKind）。 */
export interface QueueNote { kind: NoteKind; text: string }

/** One persisted queue entry in queue.jsonl. */
export interface QueueEntry {
  messageId: string
  disposition: SendDisposition
  text: string
  trigger: "user" | "job" | "agent" | "team"
  attachments?: AttachmentRef[]
  note?: QueueNote
  enqueuedAt: string
}

export type ClientCommand =
  | AuthFrame | SubscribeFrame | UnsubscribeFrame
  | ConfirmationResolveFrame | QuestionResolveFrame
  | SendMessageFrame | MessageRetryFrame
  | QueueCancelFrame | RunCancelFrame | CompactionCancelFrame

export type ServerFrame = AgentEvent | ServerAck | ErrorFrame
```

## 指令帧（客户端 → daemon，10 种）

| 帧 type | 字段 | 说明 |
|---------|------|------|
| `auth` | `token` | 每条连接的第一帧（或用 `?token=` 查询参数代替） |
| `subscribe` | `sessionId` | 订阅该会话的事件 |
| `unsubscribe` | `sessionId` | 取消订阅 |
| `send_message` | `sessionId`、`text`、`disposition?`、`attachments?`、`target?` | 发消息；`target` 是团队组员名（带它时改走组员收信箱投递，不经本会话 run） |
| `message.retry` | `sessionId`、`fromMessageId`、`text`、`attachments?` | 编辑重试/重新生成：从 fromMessageId（须为最后一条 user 消息）截断重跑 |
| `queue.cancel` | `sessionId`、`messageId?` | 取消排队条目；messageId 缺省 = 清空全部可取消条目 |
| `confirmation.resolve` | `confirmationId`、`decision`、`client?` | 人工确认裁决（decision 四值，见下） |
| `question.resolve` | `questionId`、`answers`、`client?` | 回答运行中提问（answers 为 string[][]，按提问顺序） |
| `run.cancel` | `sessionId` | 停止当前 run |
| `compaction.cancel` | `sessionId` | 取消正在进行的压缩 |

`ConfirmationDecision`（`confirmation.resolve` 的 decision）：`once`（仅本次）/ `project`（总是·项目级规则）/ `global`（总是·全局规则）/ `reject`（拒绝）。超时不是客户端发的——resolved 事件里的 `timeout` 由等待方产生。

## 应答帧（daemon → 客户端，9 种 + error）

每条指令帧（auth 除外）对应一个 ack：

| ack type | 字段 |
|----------|------|
| `subscribed` | `sessionId` |
| `unsubscribed` | `sessionId` |
| `send_message_ack` | `sessionId`、`messageId`（入队时预分配）、`queued`（false = 空闲直发） |
| `message.retry_ack` | `sessionId`、`messageId`、`queued` |
| `queue.cancel_ack` | `sessionId`、`cancelled`（实际取消的 messageId 列表） |
| `run_cancel_ack` | `sessionId` |
| `compaction_cancel_ack` | `sessionId`、`active`（是否有正在进行的压缩被取消） |
| `confirmation.resolved_ack` | `confirmationId`、`ok: true` |
| `question.resolved_ack` | `questionId`、`ok: true` |
| `error` | `message`（通用拒绝帧，连接不断开） |

## SendDisposition（3 种）

| 值 | 含义 |
|----|------|
| `steer` | 注入正在回答的模型（本轮纳入考虑，不终止） |
| `wait` | 排进队尾，当前轮结束后作为新问题开跑 |
| `interrupt` | 终止当前轮，本条随即成为下一轮的开始 |
