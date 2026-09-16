# messages — 消息 / 角色 / 停止原因 / 放行原因

> 真相源：`packages/core/src/protocol/messages.ts`（停止原因的归一化映射另在 `core/src/provider/normalize.ts`）。机制见 [protocol](../core/protocol.md)。

## 核心源码

```ts
export type Role = "user" | "assistant" | "tool"

export type StopReason =
  | "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
  | "content_filter" | "aborted" | "error"

export interface Usage { inputTokens: number; outputTokens: number }

export interface Message {
  id: string
  sessionId: string
  role: Role
  blocks: Block[]
  createdAt: string // ISO-8601
}

export interface AssistantMessage extends Message {
  role: "assistant"
  model: string
  usage: Usage
  stopReason: StopReason
  latencyMs?: number   // LLM 生成耗时（毫秒）；仅流成功完成时存在
}

/** Why a tool call was allowed to run. */
export type GrantedBy =
  | "safe" | "whitelist" | "session_grant" | "confirmed"
  | "accept_edits" | "learned" | "sandboxed" | "trusted"

export interface ToolMessage extends Message {
  role: "tool"
  grantedBy?: Record<string, GrantedBy>   // callId → 放行原因
}
```

构造函数：`newMessage(sessionId, role, blocks)`、`newToolMessage(sessionId, blocks, grantedBy?)`、`newAssistantMessage(sessionId, model, blocks, usage?, stopReason?)`。

## Role（3 种）

| 值 | 含义 |
|----|------|
| `user` | 人（或 job、投递路径）发给模型的消息 |
| `assistant` | 模型产出（thinking / 文本 / 工具调用） |
| `tool` | 工具执行结果回填 |

## StopReason（7 种）

| 值 | 含义 |
|----|------|
| `end_turn` | 模型正常说完，一轮结束 |
| `tool_use` | 模型要求调用工具，轮次继续 |
| `max_tokens` | 输出长度到达上限被截断 |
| `stop_sequence` | 命中模型侧的停止序列 |
| `content_filter` | 内容过滤拦截 |
| `aborted` | 用户主动停止（本地产生，不来自 provider） |
| `error` | 运行失败（本地产生，不来自 provider） |

provider 归一化（`normalizeFinishReason`，OpenAI 风格 finish_reason → StopReason）：

| provider 原值 | 归一化为 |
|---------------|----------|
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| `function_call` | `tool_use` |
| `content_filter` | `content_filter` |
| `stop_sequence` | `stop_sequence` |
| `null` / 其他未知值 | `end_turn` |

## GrantedBy（8 种）

工具调用被放行的原因，记在 tool 消息的 `grantedBy`（按 `callId` 逐调用记录）。判定链见 [permissions](../core/permissions.md)。

| 值 | 含义 |
|----|------|
| `safe` | 只读安全工具，直接放行 |
| `whitelist` | 命中 allow 规则（deny 优先于 allow） |
| `session_grant` | 本 run 内此前人工授权过同一操作 |
| `confirmed` | 人工在确认卡上批准 |
| `accept_edits` | acceptEdits 模式下工作区内的写操作 |
| `learned` | 命中沉淀规则（auto 模式归纳写下的 learned 规则） |
| `sandboxed` | exec 沙箱可用，沙箱内放行 |
| `trusted` | trusted 模式下沙箱可用的操作 |
