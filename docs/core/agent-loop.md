# agent-loop — run 的运行循环

## 职责

`packages/core/src/agent/loop.ts` 的 `runAgent` 是整个系统唯一的状态机：它消费一次用户消息，循环调用 LLM、执行工具、通过权限检查，直到得到一个终态 stopReason。它不做持久化（写入磁盘长期保存，经 `onMessage` 注入）、不做网络（`llm` 注入）、不感知客户端（`onEvent` 注入）。下文把装配并驱动循环的一方称为宿主（daemon 侧就是 RunManager，见 [run-manager](../server/run-manager.md)）。

---

## 设计决策

- **终态不变量**：`run.started` 发出后，`runAgent` 一定以 `run.completed` 或 `run.failed` 结束，且对 provider 错误**永不 reject**——调用方（daemon）无需 try/catch 处理没有终态的 run。
- **先持久化后广播**：每条消息先经 `deps.onMessage` 持久化，再发 `message.completed`；事件流反映的是已持久化状态。
- **持久化的块永远完整**：流式增量只存在于事件里，`onMessage` 收到的 `Message.blocks` 一定是终稿。
- **历史永不修改**：窗口截断、孤儿清理都发生在组装 provider 视图时（`toProviderMessages`），JSONL（每行一条 JSON 的文本文件）里的原始消息逐字节不变。
- **确认流不中断循环**：拒绝/超时变成 error result + note 块传回模型，模型可以换方案继续；只有 abort 才真正终止。
- **重试所有权在 provider 层**：循环自己从不重试 LLM 调用（会与 `withRetry` 双重重试）；provider 层的重试经 `llm-retry` 位置的钩子链以 `llm.failed {willRetry:true}` 事件对外可见。
- **循环只认位置，不认行为**：用户消息增强、引导注入、压缩判定、模型视图改写……这些原本身份各异的"钩子字段"统一收进 `deps.hooks`（一个 `HookRunner`）的 14 个命名位置；行为以钩子条目在装配时注册（内置闭包与用户文件同一条链，见 [hooks](./hooks.md)）。循环在每个位置调用 `hooks.run(位置, ctx)` 并按该位置的契约消费结果。

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
  trigger?: "user" | "job" | "agent"   // agent = 子代理 run（模型经 subagent_run 派出，见 subagents.md）
  userMessage?: Message       // 宿主预制时循环原样使用且不再经 onMessage 持久化
  compaction?: ActiveSummary  // 运行起点的压缩视图（来自会话 meta）：生效时 upto（含）之前的原文不再发给模型，脉络项由 toProviderMessages 垫在 messages[0]
}

export interface AgentDeps {
  llm: LlmClient
  model: string
  window?: number             // 默认 200（条消息；极端保险，见 compaction.md）
  maxIterations?: number      // 默认 25
  tools?: Map<string, ToolExecutor>
  toolDefs?: ToolDefinition[]
  permissions?: PermissionGate          // 缺失 == 全放行
  toolResultKeep?: number               // 发送时保留最近 N 个工具结果原文（缺省全保留），见 compaction.md
  resolveConfirmation?(confirmationId: string): Promise<{ decision: "once" | "project" | "global" | "reject" | "timeout"; by: "cli" | "web" | "timeout" }>
  confirmTimeoutMs?: number             // 默认 120_000
  signal?: AbortSignal                  // 取消信号，见"取消路径"
  llmAttempt?(): number                 // llm.started 报告的尝试号；provider 层重试经 withRetry 在
                                        // stream() 内部完成后，由装配把这个计数反馈进来（默认恒 1）
  tokenBudget?: number                // 请求预算（token 数）：驱动工具输出省略/历史逐出（见 compaction.md 机制二）
  hooks: HookRunner                   // 钩子链：循环的行为挂载点全部以此为准（见 hooks.md）。
                                      // 各位置的 fatal 抛错沿 hooks.run 传播，由循环既有的 catch 路径接管，
                                      // 错误码与迁移前一致（user_message_failed / steering_failed / …）
  onEvent(e: AgentEvent): void
  onMessage(m: Message): void
}

export interface RunOutcome { stopReason: StopReason; totalUsage: Usage; messages: Message[] }
```

权限检查契约（循环的视角）：

```ts
export type PermissionDecision =
  | { type: "allow"; reason: "safe" | "whitelist" | "session_grant" | "accept_edits" | "learned" | "sandboxed" | "trusted" }
  | { type: "deny"; reason: "blacklist" | "user_denied" | "timeout" | "readonly" | "mode"; noteText: string }
  | { type: "confirm"; confirmationId: string; noteText?: string }
```

---

## run 生命周期状态机

```
run.started {trigger}
  → message.created（用户消息骨架：先建空壳，内容随后补全）
  → [run-before 钩子链：改写/注入 note/持久化/自动命名，见 hooks.md]
    → onMessage 持久化（非注入路径）→ message.completed
  → for iter = 0 .. maxIterations-1:
      ① abort 检查点（预中止：直接 run.completed{aborted}）
      ② llm.started {model, attempt}
      ③ message.created（assistant 骨架，先于任何块事件，携带真实 messageId）
      ④ 流式消费 llm.stream（视图经 llm-before 钩子链改写，见下）
      ⑤ llm.completed {usage, stopReason, latencyMs}     ← 流失败则跳过，改发 llm.failed
      ⑥ tool_call.completed ×N（流结束后才 parse argsJson）
      ⑦ assistant 补全：块为空 → 整条丢弃（不持久化、无 completed）
        否则 text/thinking.completed → onMessage → message.completed
        （assistant 消息随 llm.completed 的 latencyMs 一并写入磁盘——流成功完成才有，失败流缺省）
      ⑧ stopReason 分派：
         end_turn          → run.completed，返回
         error             → 悬空 tool_call（无配对结果的调用）合成 error result 配对持久化 → llm.failed{willRetry:false} → run.failed，返回
         tool_use 且有调用 → 工具回合（见下）→ turn-boundary 钩子链（见下）→ continue
         其余（max_tokens/stop_sequence/content_filter/aborted/空 tool_use）→ run.completed，返回
  → 循环耗尽：截断 note 已随最后一条 assistant 持久化 → run.failed {code:"max_iterations"}，返回 stopReason "error"
```

`run.failed` 的四个错误码：`user_message_failed`（run-before 链的 fatal 抛错或持久化抛错）、`llm_error`（provider 彻底失败）、`max_iterations`、`steering_failed`（turn-boundary 链的 fatal 抛错或注入写入抛错）。

用户消息路径有两条：默认由 `userText` 合成（循环自行 `onMessage` 持久化）；宿主传入 `RunInput.userMessage` 时循环原样使用、**不重复持久化**（持久化责任在宿主，daemon 侧由 run-before 链的内置 `user-message-land` 钩子做，见 [hooks](./hooks.md)）。两条路径都会发 `message.created`/`message.completed`，钩子链都执行。

### 工具回合（`runToolTurn`）

1. 建 `role:"tool"` 消息骨架 → `message.created`（先于执行，使 delta 事件可携带真实 messageId）。
2. **钩子闸门**：每个可执行调用先过 `hooks.runGate("tool-before", {toolCall})`（观察 + 失败否决权）——声明 `failure:"deny"` 的钩子失败时该调用被拒绝：error result（文案 `钩子 <名> 失败，操作未执行：<原因>`）+ `kind:"denied"` note，不进权限检查、不执行，run 继续；其余失败照旧跳过。
3. **权限检查**：每个可执行调用按模型顺序过 `check`——`deny` → error result + note 块（`kind:"denied"|"timeout"`）；`allow` → 记 `grantedBy`（`sandboxed` 即命令类工具由 exec 沙箱顶替人工的放行，见 [permissions](./permissions.md) 第 7 节）；`confirm` → 发 `confirmation.requested {confirmationId, toolCall, risk, expiresAt}`（沙箱启用但不可用的回落确认带 `noteText`），`raceConfirmation` 同时等待三个来源：人工裁决 | confirmTimeoutMs 超时 | abort 信号，谁先到算谁。人工裁决是四选一（`once` / `project` / `global` / `reject`，来自 `confirmation.resolve` 帧）：`once`/`project`/`global` 都放行并记 `grantedBy:"confirmed"`（project/global 的规则保存在 server 侧 WS 入口，见 [permissions](./permissions.md)）；`reject`/超时的文案固定："用户拒绝了该操作" / "确认超时，操作未执行"。
4. **调度**：`concurrency:"parallel"` 的调用 `Promise.allSettled` 并发；`"serial"` 的在并行组全部结束后逐个 `await`——串行排他是结构保证（先等并行组全部结束，再逐个顺序执行），不是测试约束。执行器收到 `ctx.signal`（即 `deps.signal`）：长时间运行的工具（如 `subagent_run`）靠它感知父 run 的中止，实现"父停子停"（见 [subagents](./subagents.md)）。`ask_user_questions` 的等待走与人工确认同一个三方竞速（回答 / 超时 / abort，`permissions/broker.ts` 的 `racePending`）——中止时等待作废、不发 `question.resolved`（见 [tools](./tools.md) 的 ask 工具一节）。
5. **结果**：每个执行中的结果发 `tool_result.created → tool_result.delta（executor 的 onOutput）→ tool_result.completed`；未执行（参数解析失败/未知工具/钩子闸门拒绝/abort 拦截）的结果只补 created+completed。结果块一律按模型给定顺序写入；拒绝 note 排在结果之后；`grantedBy` 记为 `Record<callId, GrantedBy>` 挂在 tool 消息上。
6. **死循环守卫**：执行完成后（completed 发出前）按"工具名 + 参数串"签名做跨回合计数——同一签名连续执行达到 `sessions.toolLoopMaxRepeats`（缺省 5，`0` 关闭）次时，该次结果附加一行 `<system-reminder kind="loop-guard">` 换策略提醒，随结果持久化、审计可见；签名变化即重置计数。守卫只提醒不终止，硬停止留待真实需要时再做。
7. `onMessage` 持久化 → `message.completed` → 回到循环顶部。

### turn-boundary 位置（引导注入）

循环在**每轮工具批次执行完之后、下一次 `llm.stream` 之前**运行 `turn-boundary` 位置的钩子链——即 `stopReason === "tool_use"` 且确有工具调用的分支末尾、`continue` 回循环顶部之前。一轮直接以 `end_turn` 收尾（没有工具调用）时不存在这个边界，缓冲不会被取走，残余消息由宿主的队列驱动器降级处理（见 [run-manager](../server/run-manager.md)）。

返回的消息数组逐条按序注入：`message.created` → `deps.onMessage` 持久化 → `message.completed` → `message.steered {messageId}`（事件级 `runId` 标识注入的 run）→ 消息追加进 history（`all`），模型在下一轮自然看到它。流式输出不打断、不产生新 run，`stopReason` 语义不变。内置使用者是 `steering-drain`（取走 RunManager 的 steer 缓冲，fatal）。

错误语义与用户消息路径一致：链上 fatal 钩子抛错，或注入途中 `onMessage` 持久化抛错，都发 `run.failed {code:"steering_failed"}`、run 以 `stopReason:"error"` 收场（不 reject）。位置上没有钩子时整段跳过（返回 `undefined` = 无注入）。

---

## 消息编排（上下文组装）

`toProviderMessages(history, window, opts?)`（`packages/core/src/agent/context.ts`）是协议消息 → provider 请求的格式翻译点：

- **滑动窗口**（只保留最近 N 条历史、随新消息整体前移）：`history.slice(-window)`（window 默认 200），system prompt 不占窗口。窗口截断仅作为未压缩/压缩失败时的极端保险；长会话的正常收缩靠压缩（见 [compaction](./compaction.md)）：压缩视图（`ActiveSummary { upto, top }`）由宿主从会话 meta 取出放进 `RunInput.compaction`，循环内的 `buildMessages` 据此把 `upto`（含）之前的原文排除在发送窗口外，`toProviderMessages` 再把脉络项垫进待发送数组——循环本身不感知也不改动 JSONL 里的原始消息。运行起点不跑任何压缩（「发送前预压缩」这一做法已删除，压缩只发生在后台预压 / 收尾 / 运行中 / 超限急救四个自动时机加手动 /compact，见 [compaction](./compaction.md)）。
- **工具输出省略**（`opts.toolResultKeep`，server 从 `config.sessions.toolResultKeep` 传入，默认 8）：从最新消息往前数，最多保留最近 N 个工具结果原文（条数上限，之前是固定截断数），更早的把输出文本替换成一行占位符 `[此工具输出已省略：<工具名> <参数摘要>，可重新调用获取]`（调用失败加"（该次调用失败）"）。传了 `opts.tokenBudget` 时在条数上限内再做预算驱动逐出：以"非工具结果内容的估算 token + 被上限挤掉结果的占位行"为基线，从最新到最旧逐条装填工具结果，装不下（含其之后全部）一并省略。两者都只影响发出的请求，JSONL 存储不动；配对关系不变，不产生无效请求。不传任何 opts 时行为完全不变（全部保留）。详见 [compaction](./compaction.md) 机制二/三。
- **脉络摘要注入**（`opts.summary`，类型 `ActiveSummary { upto, top }`）：非空时在结果数组**最前面**注入一条 user 消息：交接声明 + `<compacted-summary>` 标签包裹 `<top>` + 末尾一行 session_search 检索提示（system prompt 保持恒定以保住 KV 缓存前缀，故摘要走 user 通道；检索提示见 [compaction](./compaction.md) 的注入一节）。它排在切片后的对话之前；provider 适配层再在它前面加真正的 system 提示（persona），所以模型看到的最终顺序是 **persona → 脉络 → 对话**。原始 `req.system` 不被覆盖，JSONL 里也没有这条注入（只在发送的请求里）。
- **模型视图改写（`llm-before` 位置）**：上述全部组装完成后、`llm.stream` 之前，循环把最终消息列表交给 `llm-before` 钩子链，链的最终改写值（`undefined` = 原样）就是要发送的内容。它是"只改模型看到的输入"的唯一口子——持久化、事件流与 outcome 一概不动。现成实现是 `withLastUserText(messages, text)`（`agent/context.ts`）：把消息列表里**最后一条 user 消息**的文本整体替换成 `text`（string 内容整体替换；ContentPart 数组只换第一个 text 部分，图片等其余部分保留）。从尾部向前找，工具循环的第二轮起列表末条是 tool 消息——锚定"最后一条 user"才能让改写在每一轮都生效；列表里没有 user 消息时原样返回。技能点名的隐式包装是内置 `skill-wrap` 钩子 + 这个辅助（见 [skills](./skills.md) 与 [hooks](./hooks.md)）。
- **孤儿 tool 消息丢弃**：窗口切在 assistant 与 tool 消息之间时，开头的连续 `role:"tool"` 消息被 `shift` 丢弃——OpenAI 兼容 API 拒收无配对调用的 tool 结果。
- **无配对的 tool_call 剔除**：assistant 的 `tool_call` 块只有当其后（窗口内）存在配对的 `tool_result` 才转成 `toolCalls` 发送；悬空调用会被 400。
- **块级转换**：user/assistant 的 text 拼接为 content；note 转 `<system-reminder kind="<NoteKind>"><text></system-reminder>` 行（对模型可见、可追溯；标签约定由系统提示词末尾的注入约定声明，正文中的闭合标签会被逃逸）；tool 消息的每个 `tool_result` 转成一条消息，error 结果加 `[error] ` 前缀；assistant 没有 text 时 content 置 null、只带 toolCalls；thinking 不转换，模型看不到自己之前的思考内容。attachment 块按携带的内容分三种转法：带 `base64` 数据且 MIME 是 `image/*` 的转成一个多模态 `image_url` 内容段（data: URL 形式，与文本段并列为 content 数组的元素）；带内联 `text` 正文的转成 `[附件 <名称>]` 加正文；两者都不满足的只转一行元数据提示（`[附件 <名称>（<mime>，仅元数据）已保存，路径 <path>，可用 fs_read 读取]`），需要内容时由模型自己调 fs_read。
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
5. 调度中——不再启动新工具；已启动的允许自然结束（不强行终止进行中的执行）。
6. 未及执行的工具——统一补 `errorResult(callId, "run aborted before execution")`，tool 消息保持完整。

终态统一为 `run.completed {stopReason:"aborted"}`（不是 run.failed）；客户端把它当正常终态渲染。

---

## 边界与出错

- **provider 彻底失败**：`withRetry` 耗尽后 `stream()` 抛错 → 部分内容以 `stopReason:"error"` 持久化 → 悬空 tool_call 合成 `"llm call failed before execution"` 结果配对持久化（防下轮 400）→ `llm.failed` + `run.failed` → resolve（不 reject）。
- **参数解析失败 / 未知工具**：不执行、不进入权限检查；error result（`"invalid tool args json"` / `"unknown tool: <name>"`）随 tool 消息持久化，循环继续。
- **迭代耗尽**：最后一次迭代若仍是 `tool_use`，先在该 assistant 消息上附加 `kind:"system"` 截断 note（"已达最大迭代次数（25）…"）再持久化，然后 `run.failed {code:"max_iterations"}`——用户和下一轮模型均可看到中断原因。
- **钩子失败**：run-before 链的 fatal 抛错或持久化抛错 → `run.failed {code:"user_message_failed"}`，resolve `stopReason:"error"`；用户钩子失败时的行为自行声明（skip 跳过 / deny 否决所在闸门），失败只发 `hook.failed` 事件不伤 run（见 [hooks](./hooks.md)）。
- **工具执行器契约**：`ToolExecutor.execute` 应吞掉一切异常返回 `{status:"error", output}`（内置工具由 `shared.ts` 的包装保证）；循环对执行器抛异常（Promise 拒绝）也统一转为 error result（保证异常也产出结果）。执行 ctx 带可选 `signal`（父 run 的中止信号）与 `onOutput`（部分输出的流式回传）。

---

## 关联

- [protocol](./protocol.md)：Message/Block/Event 的字段与事件全表
- [compaction](./compaction.md)：上下文占用与五条水位线（省略/预压/黄/红/目标）、五个触发点（后台预压/收尾/运行中/溢出急救/手动）、预算驱动省略与 window 200 的分工
- [provider](./provider.md)：OpenAI 兼容流解析与 withRetry
- [permissions](./permissions.md)：判定链与规则语法（allow/deny 的来源）
- [skills](./skills.md)：技能点名隐式包装（`skill-wrap` 内置钩子 + `withLastUserText`）
- [hooks](./hooks.md)：位置网格、HookChain 语义、用户文件契约与内置钩子清单
- [run-manager](../server/run-manager.md)：daemon 侧如何装配这些依赖
