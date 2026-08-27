# agent-loop — run 的运行循环

## 职责

`packages/core/src/agent/loop.ts` 的 `runAgent` 是整个系统唯一的状态机：它消费一次用户消息，循环调用 LLM、执行工具、通过权限检查，直到得到一个终态 stopReason。它不做持久化（写入磁盘长期保存，经 `onMessage` 注入）、不做网络（`llm` 注入）、不感知客户端（`onEvent` 注入）。

---

## 设计决策

- **终态不变量**：`run.started` 发出后，`runAgent` 一定以 `run.completed` 或 `run.failed` 结束，且对 provider 错误**永不 reject**——调用方（daemon）无需 try/catch 处理没有终态的 run。
- **先持久化后广播**：每条消息先经 `deps.onMessage` 持久化，再发 `message.completed`；事件流反映的是已持久化状态。
- **持久化的块永远完整**：流式增量只存在于事件里，`onMessage` 收到的 `Message.blocks` 一定是终稿。
- **历史永不修改**：窗口截断、孤儿清理都发生在组装 provider 视图时（`toProviderMessages`），JSONL（每行一条 JSON 的文本文件）里的原始消息逐字节不变。
- **确认流不中断循环**：拒绝/超时变成 error result + note 块传回模型，模型可以换方案继续；只有 abort 才真正终止。
- **重试所有权在 provider 层**：循环自己从不重试 LLM 调用（会与 `withRetry` 双重重试）；重试经 `onLlmRetry` 钩子以 `llm.failed {willRetry:true}` 事件对外可见。

---

## 接口

```ts
// packages/core/src/agent/loop.ts
export async function runAgent(input: RunInput, deps: AgentDeps): Promise<RunOutcome>

export interface RunInput {
  sessionId: string
  history: Message[]          // 不含本次用户消息
  system: string
  userText: string
  trigger?: "user" | "job"
  userMessage?: Message       // 宿主预制时循环原样使用且不再经 onMessage 持久化
}

export interface AgentDeps {
  llm: LlmClient
  model: string
  window?: number             // 默认 40（条消息）
  maxIterations?: number      // 默认 25
  tools?: Map<string, ToolExecutor>
  toolDefs?: ToolDefinition[]
  permissions?: PermissionGate          // 缺失 == 全放行
  resolveConfirmation?(confirmationId: string): Promise<{ approved: boolean; by: "cli" | "web" | "timeout" }>
  confirmTimeoutMs?: number             // 默认 120_000
  signal?: AbortSignal                  // 取消信号，见"取消路径"
  onLlmRetry?(info: { attempt: number; error: unknown }): void
  llmAttempt?(): number
  onUserMessage?(message: Message): Message   // 用户消息增强（note 注入）；抛错 → run.failed
  onEvent(e: AgentEvent): void
  onMessage(m: Message): void
}

export interface RunOutcome { stopReason: StopReason; totalUsage: Usage; messages: Message[] }
```

权限检查契约（循环的视角）：

```ts
export type PermissionDecision =
  | { type: "allow"; reason: "safe" | "whitelist" | "session_grant" }
  | { type: "deny"; reason: "blacklist" | "user_denied" | "timeout" | "readonly"; noteText: string }
  | { type: "confirm"; confirmationId: string }
```

---

## run 生命周期状态机

```
run.started {trigger}
  → message.created（用户消息骨架：先建空壳，内容随后补全）
  → [onUserMessage 钩子：注入 note] → onMessage 持久化 → message.completed
  → for iter = 0 .. maxIterations-1:
      ① abort 检查点（预中止：直接 run.completed{aborted}）
      ② llm.started {model, attempt}
      ③ message.created（assistant 骨架，先于任何块事件，携带真实 messageId）
      ④ 流式消费 llm.stream（见下）
      ⑤ llm.completed {usage, stopReason, latencyMs}     ← 流失败则跳过，改发 llm.failed
      ⑥ tool_call.completed ×N（流结束后才 parse argsJson）
      ⑦ assistant 补全：块为空 → 整条丢弃（不持久化、无 completed）
        否则 text/thinking.completed → onMessage → message.completed
      ⑧ stopReason 分派：
         end_turn          → run.completed，返回
         error             → 悬空 tool_call（无配对结果的调用）合成 error result 配对持久化 → llm.failed{willRetry:false} → run.failed，返回
         tool_use 且有调用 → 工具回合（见下）→ continue
         其余（max_tokens/stop_sequence/content_filter/aborted/空 tool_use）→ run.completed，返回
  → 循环耗尽：截断 note 已随最后一条 assistant 持久化 → run.failed {code:"max_iterations"}，返回 stopReason "error"
```

`run.failed` 的三个错误码：`user_message_failed`（onUserMessage/持久化钩子抛错）、`llm_error`（provider 彻底失败）、`max_iterations`。

用户消息路径有两条：默认由 `userText` 合成（循环自行 `onMessage` 持久化）；宿主传入 `RunInput.userMessage` 时循环原样使用、**不重复持久化**（持久化责任在宿主，daemon 在 `onUserMessage` 钩子里做）。两条路径都会发 `message.created`/`message.completed`，钩子都执行。

### 工具回合（`runToolTurn`）

1. 建 `role:"tool"` 消息骨架 → `message.created`（先于执行，使 delta 事件可携带真实 messageId）。
2. **权限检查**：每个可执行调用按模型顺序过 `check`——`deny` → error result + note 块（`kind:"denied"|"timeout"`）；`allow` → 记 `grantedBy`；`confirm` → 发 `confirmation.requested {confirmationId, toolCall, risk, expiresAt}`，`raceConfirmation` 三方竞速（人工裁决 | confirmTimeoutMs 超时 | abort 信号）。拒绝/超时的文案固定："用户拒绝了该操作" / "确认超时，操作未执行"。
3. **调度**：`concurrency:"parallel"` 的调用 `Promise.allSettled` 并发；`"serial"` 的在并行组全部 settle 后逐个 `await`——串行排他是结构保证（屏障 + 顺序 await：先等并行组全部结束，再逐个顺序执行），不是测试约束。
4. **结果**：每个执行中的结果发 `tool_result.created → tool_result.delta（executor 的 onOutput）→ tool_result.completed`；未执行（参数解析失败/未知工具/abort 拦截）的结果只补 created+completed。结果块一律按模型给定顺序写入；拒绝 note 排在结果之后；`grantedBy` 记为 `Record<callId, GrantedBy>` 挂在 tool 消息上。
5. `onMessage` 持久化 → `message.completed` → 回到循环顶部。

---

## 消息编排（上下文组装）

`toProviderMessages(history, window)`（`packages/core/src/agent/context.ts`）是协议消息 → provider 请求的唯一翻译点：

- **滑动窗口**（只保留最近 N 条历史、随新消息整体前移）：`history.slice(-window)`（window 默认 40），system prompt 不占窗口。服务端（RunManager）的长会话会先做滚动压缩——超阈值时把最老一段压成摘要并传入切片后的 history，窗口截断仅作为未压缩/压缩失败时的兜底。
- **孤儿 tool 消息丢弃**：窗口切在 assistant 与 tool 消息之间时，开头的连续 `role:"tool"` 消息被 `shift` 丢弃——OpenAI 兼容 API 拒收无配对调用的 tool 结果。
- **无配对的 tool_call 剔除**：assistant 的 `tool_call` 块只有当其后（窗口内）存在配对的 `tool_result` 才转成 `toolCalls` 发送；悬空调用会被 400。
- **块级转换**：user/assistant 的 text 拼接为 content；note 转 `[system note] <text>` 行（对模型可见、可追溯）；tool 消息的每个 `tool_result` 转成一条消息，error 结果加 `[error] ` 前缀；assistant 没有 text 时 content 置 null、只带 toolCalls；thinking 不转换，模型看不到自己之前的思考内容。attachment 块按携带的内容分三种转法：带 `base64` 数据且 MIME 是 `image/*` 的转成一个多模态 `image_url` 内容段（data: URL 形式，与文本段并列为 content 数组的元素）；带内联 `text` 正文的转成 `[附件 <名称>]` 加正文；两者都不满足的只转一行元数据提示（`[附件 <名称>（<mime>，仅元数据）已保存，路径 <path>，可用 fs_read 读取]`），需要内容时由模型自己调 fs_read。
- 下一轮的 history：`[...input.history, userMsg, assistant?, toolMsg?, …]`，由循环内逐步 `all.push` 累积。

---

## 流式三段事件：created → delta → completed

循环消费 `LlmStreamEvent`（`text_delta` / `thinking_delta` / `tool_call_started` / `tool_call_delta` / `message_done`，定义在 `packages/core/src/provider/types.ts`），转成块级三段：

- **created**：块的容器事件，携带 `{messageId, block}`。text/thinking 在首个 delta 到达时建块；tool_call 在 `tool_call_started`（首个带 callId/name 的帧）建块。
- **delta**：纯字符串增量 `{messageId, blockId, delta}`——文本增量与 tool args 的 JSON 片段本质相同，客户端按同一套拼接逻辑处理。
- **completed**：全量块校准 `{messageId, block}`。text/thinking 在流结束后逐块发；tool_call 在流结束后 parse `argsJson` 时发——**解析失败也发 completed**（携带原始块），随后给 error result，不执行。

退化为两段的情况：无参调用（`argsJson === ""` 按 `{}` 解析）没有 delta；被 abort/error 中断的悬空 tool_call **没有** completed（三段事件未完整发出）。

---

## 停止原因归一化

`StopReason`（`packages/core/src/protocol/messages.ts`）共 7 个值。provider 侧映射在 `packages/core/src/provider/normalize.ts`：

```
finish_reason: stop → end_turn    length → max_tokens    tool_calls → tool_use
               function_call → tool_use    content_filter → content_filter
               stop_sequence → stop_sequence    null/未知 → end_turn
```

`aborted` 与 `error` 不会来自 provider——前者由循环在各 abort 检查点打上标记，后者标记在流抛错/宿主钩子失败的消息上。归一化后，`runAgent` 的分派逻辑只认 7 个值，与具体 provider 解耦。aborted/error 的 assistant 消息连同部分内容照常持久化（对应"生成中途被取消"的场景）。

---

## 取消路径：run.cancel → aborted

daemon 侧 `RunManager.cancel(sessionId)` 调 `AbortController.abort()`，循环在 **6 个检查点** 响应 `deps.signal`：

1. 迭代开始前——无任何产出，直接 `run.completed {stopReason:"aborted"}`，不合成空 assistant（空消息会被部分 provider 拒收）。
2. 流中（`streamWithAbort` 包装）——`Promise.race(stream.next(), abort)` 立即停止消费，不再等待可能永久停滞的流。
3. 流后——无 `message_done`，就地打上 `stopReason = "aborted"`，部分内容照常持久化。
4. 权限检查中——不再进行 gate 的后续调用；确认等待中 abort 经 `raceConfirmation` 以 `"aborted"` 哨兵值（sentinel：用于区分结果来源的特殊返回值）胜出，**不发** `confirmation.resolved`（用户取消 ≠ 超时拒绝）。
5. 调度中——不再启动新工具；已启动的允许 settle（不强行终止进行中的执行）。
6. 未及执行的工具——统一补 `errorResult(callId, "run aborted before execution")`，tool 消息保持完整。

终态统一为 `run.completed {stopReason:"aborted"}`（不是 run.failed）；客户端把它当正常终态渲染。

---

## 边界与出错

- **provider 彻底失败**：`withRetry` 耗尽后 `stream()` 抛错 → 部分内容以 `stopReason:"error"` 持久化 → 悬空 tool_call 合成 `"llm call failed before execution"` 结果配对持久化（防下轮 400）→ `llm.failed` + `run.failed` → resolve（不 reject）。
- **参数解析失败 / 未知工具**：不执行、不进入权限检查；error result（`"invalid tool args json"` / `"unknown tool: <name>"`）随 tool 消息持久化，循环继续。
- **迭代耗尽**：最后一次迭代若仍是 `tool_use`，先在该 assistant 消息上附加 `kind:"system"` 截断 note（"已达最大迭代次数（25）…"）再持久化，然后 `run.failed {code:"max_iterations"}`——用户和下一轮模型均可看到中断原因。
- **钩子失败**：`onUserMessage` 或持久化抛错 → `run.failed {code:"user_message_failed"}`，resolve `stopReason:"error"`。
- **工具执行器契约**：`ToolExecutor.execute` 应吞掉一切异常返回 `{status:"error", output}`（内置工具由 `shared.ts` 的包装保证）；循环对 settle 失败也统一转为 error result（保证异常也产出结果）。

---

## 关联

- [protocol](./protocol.md)：Message/Block/Event 的字段与事件全表
- [provider](./provider.md)：OpenAI 兼容流解析与 withRetry
- [permissions](./permissions.md)：判定链与规则语法（allow/deny 的来源）
- [run-manager](../server/run-manager.md)：daemon 侧如何装配这些依赖
