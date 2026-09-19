# blocks — 内容块清单

> 权威来源：`packages/core/src/protocol/blocks.ts`。机制见 [protocol](../core/protocol.md)。

消息（Message）由块（Block）组成；块是消息内最小的结构化单位，每块有独立 `id`（`blk_` 前缀）。

## 核心源码

```ts
export interface TextBlock     { id: BlockId; type: "text"; text: string }
export interface ThinkingBlock { id: BlockId; type: "thinking"; text: string }

export interface ToolCallBlock {
  id: BlockId; type: "tool_call"
  callId: string          // provider 侧的工具调用 id（与 tool_result 配对的键）
  name: string
  args: unknown           // 流结束后 JSON.parse 的结果
  argsJson: string        // 原始参数串（审计与 provider 回放用）
}

export type ToolStatus = "ok" | "error"

export interface ToolResultBlock {
  id: BlockId; type: "tool_result"
  callId: string
  status: ToolStatus
  output: string          // 给模型看
  data?: unknown          // 可选结构化产物，给客户端渲染
  durationMs: number
}

export type NoteKind = "system" | "job" | "memory" | "timeout" | "denied" | "subagent"

export interface NoteBlock { id: BlockId; type: "note"; kind: NoteKind; text: string }

export type AttachmentSource =
  | { type: "base64"; data: string }
  | { type: "url"; url: string }
  | { type: "file"; path: string }

export interface AttachmentBlock {
  id: BlockId; type: "attachment"; mimeType: string
  name?: string           // 原始文件名，给展示层做标签
  text?: string           // 文本类附件的内联正文（挂载时截断封顶）
  source: AttachmentSource
}

export type Block =
  | TextBlock | ThinkingBlock | ToolCallBlock
  | ToolResultBlock | NoteBlock | AttachmentBlock
```

类型守卫 `isBlockType(t, v)` 与 `newBlockId()` 也在此文件。

## 块类型（6 种）

| 值 | 含义 |
|----|------|
| `text` | 普通文本 |
| `thinking` | 模型思考过程（reasoning 输出） |
| `tool_call` | 模型发起的工具调用（args + argsJson 双份） |
| `tool_result` | 工具执行结果（output 给模型、data 给客户端） |
| `note` | 系统写入对话的信息（见下 NoteKind），属于对话内容、模型可读 |
| `attachment` | 附件（图片 / 文件 / URL，大文件只在块里留元数据指向磁盘） |

## ToolStatus（2 种）

| 值 | 含义 |
|----|------|
| `ok` | 工具执行成功 |
| `error` | 工具执行失败（output 里带错误说明） |

## NoteKind（6 种）

| 值 | 含义 | 生产点 |
|----|------|--------|
| `system` | 系统说明（迭代达上限的截断说明、团队转发标记、完成回投的降级通知） | agent 循环、团队投递、subagent 宿主 |
| `job` | 定时任务来源说明（job 触发的 run 在用户消息上追加） | run 组装 |
| `subagent` | 后台 subagent 完成回投的来源声明（投递的用户消息上追加，声明这是机器回投、非用户发言） | run 组装（经队列条目的 note 参数） |
| `memory` | 记忆注入（检索到的相关经历） | 内置 hook `memory-inject` |
| `timeout` | 确认 / 提问等待超时 | agent 循环（确认与提问的等待出口） |
| `denied` | 权限拒绝（拒绝原因写进 text） | agent 循环（权限判定） |

## AttachmentSource（3 种）

| 值 | 含义 |
|----|------|
| `base64` | 内容内联为 base64（小图片等） |
| `url` | 指向外部 URL |
| `file` | 指向 daemon 管理的附件目录内的文件（`<home>/attachments/<session-id>/`） |

## role × 块类型约定

由 agent 循环维护的事实约定，非类型强制：

| role | 出现的块类型 |
|------|--------------|
| `user` | text / note / attachment |
| `assistant` | thinking / text / tool_call / note |
| `tool` | tool_result / note |
