# kclaw 核心原理：@kclaw/core（P1）

> 本文阐述 `packages/core` 的核心逻辑与设计原理。对应代码为 P1（core-foundation）。
> 项目总体设计见 `docs/superpowers/specs/2026-08-15-kclaw-personal-agent-design.md`（权威 spec）。

## 1. 全局图景

kclaw 是一个本地常驻的个人 agent。目标态架构是"一个 daemon + 多客户端"：

```
kclaw daemon（常驻进程，唯一状态权威）
    │  HTTP + WebSocket（127.0.0.1，token 鉴权）
    ├── kclaw CLI
    ├── WebUI
    └── （v2）Telegram/微信渠道适配器
```

`@kclaw/core` 是 daemon 内部跑的 agent 引擎，被设计为**纯库**：不依赖任何框架、不感知 HTTP/WS 的存在。它通过三个注入点与外界解耦：

| 注入点 | 职责 | 实现位置 |
|--------|------|----------|
| `deps.llm: LlmClient` | 模型调用（流式） | `src/provider/openai-compat.ts` |
| `deps.tools: Map<string, ToolExecutor>` | 工具执行 | `src/agent/tools.ts`（接口）|
| `deps.onEvent / deps.onMessage` | 事件流出 / 消息落盘 | 由宿主（P3 的 server）实现 |

这个设计让 agent 循环可以在无网络、无进程的环境下用 mock 完整测试（P1 的 58 个测试全部如此驱动）。

## 2. 协议层：三个粒度，一条铁律

`src/protocol/` 定义了贯穿全系统的数据模型，三个概念按**生命周期**划分：

```
Event（瞬时，不落盘）──沉淀为──▶ Message（持久化单位）──内含──▶ Block（结构化片段）
```

**铁律：落盘的块永远是完整的。**"写到一半的块"只存在于事件流中。这让持久化格式（P2 的 JSONL）无状态、免校验——每行读出来就是自洽的。

### 2.1 Block：六种类型，按"谁产生"分类

| 类别 | 类型 | 关键点 |
|------|------|--------|
| 生成型 | `text` / `thinking` | 模型输出；thinking 是推理模型的 reasoning_content 归一化结果 |
| 动作型 | `tool_call` | 同时保留 `args`（解析后）与 `argsJson`（原始字符串）——前者给执行器，后者给审计和 provider 回放 |
| 结果型 | `tool_result` | `output` 给模型看，`data`（可选）给客户端渲染——关注点分离 |
| 注入型 | `note` | 系统写入对话的话（job 触发、权限拒绝原因），模型可读，是**对话内容的一部分** |
| 附件型 | `attachment` | `source: base64 | url | file` 三态；超过 64KB 的 base64 落盘前转存为 file 引用，保证 JSONL 可 grep |

### 2.2 Message：role 决定可携带的块

```
user       ← text, note, attachment
assistant  ← thinking, text, tool_call   （+ model/usage/stopReason 专属字段）
tool       ← tool_result, note
```

工具调用与结果通过 `callId` 跨消息配对（OpenAI 风格）。选择独立 `role:"tool"` 消息而非塞回 user 消息，是因为 JSONL 逐行读出即是完整对话史，发给任何 provider 只需一层薄转换（`toProviderMessages`）。

`stopReason` 枚举归一化了各家 provider 的 finish_reason（`stop→end_turn`、`tool_calls→tool_use`…），并补充了 kclaw 自己的控制原因（`aborted`/`error`）。**aborted/error 的消息连同部分内容照常落盘**——回溯"说到一半被取消"是有价值的信息。

### 2.3 Event：28 种，名称与块名一一对应

设计规则：

1. **事件名 = 块名 + 生命周期后缀**：`tool_call.created → tool_call.delta → tool_call.completed`。客户端想知道自己需要处理哪些块，看事件前缀即可。
2. **created 建容器 / delta 拼字符串 / completed 全量校准**：delta 统一为纯字符串增量（文本和 tool args 的 JSON 片段本质相同）；简单客户端可以只监听 `*.completed` 做非流式渲染。
3. **`llm.*` 事件暴露每次真实模型调用**（含 attempt/usage/latency），让"模型在干嘛"对用户透明——这是个人 agent 长期使用中控制成本与调试的基础。
4. **事件不持久化、不回放**。断线恢复 = 拉全量消息（HTTP）+ 只订阅新事件。单 WS 连接天然有序，所以不需要序号——这是有意的简化。

## 3. Provider 层：OpenAI 兼容的流式解析

`src/provider/openai-compat.ts` 是唯一对接外部模型 API 的地方。核心是 `sseDataLines` ——一个手写的 SSE 增量解析器：

```
ReadableStream ──(跨 chunk 行缓冲)──▶ data: 行 ──(JSON.parse)──▶ ChatChunk ──▶ 归一化事件
```

关键细节：

- **跨 chunk 半行缓冲**：网络分块可能在一行中间切开，解析器在 `\n` 处切行、剩余部分留在缓冲区。
- **多字节安全**：`TextDecoder` 带 `{stream: true}`，UTF-8 中文跨 chunk 不会烂。
- **tool_call 按 index 聚合**：OpenAI 流式协议中工具参数是字符串增量，首个带 id/name 的帧发 `tool_call_started`，后续帧的 `function.arguments` 片段发 `tool_call_delta`。聚合与解析放在消费端（agent 循环）而非 provider 层——provider 只做翻译，不做语义。
- **错误消息格式是契约**：`llm http ${status}: ...` 这个前缀被 `withRetry` 的 `isTransient` 正则依赖（429/5xx 可重试，401 等不重试）。有测试钉住这个格式。

`withRetry` 包一层：指数退避 + 注入式 jitter，以及一条容易被忽视的规则——**流已经开始产出后不再重试**（`yielded` 标志）。因为消费者可能已收到部分事件，重试会导致重复输出。

## 4. Agent 循环：kclaw 的心脏

`src/agent/loop.ts` 的 `runAgent` 是整个系统唯一的状态机。一轮执行的骨架：

```
run.started
 └─ for iter in 0..maxIterations(默认25):
     ├─ abort 检查点（预中止：直接 run.completed{aborted}，不落盘空消息）
     ├─ 建 assistant 骨架 → message.created（先于任何块事件，携带真实 messageId）
     ├─ 流式消费 LLM：
     │    text_delta → 块累积 + text.created/delta
     │    tool_call_delta → args 拼接 + tool_call.delta
     │    abort（流中）→ 停止消费，stopReason=aborted
     │    异常 → stopReason=error，走错误终态
     ├─ message_done → 补全消息（usage/stopReason）
     │    空块消息：不落盘、不发 completed（防 provider 拒收空 assistant）
     │    onMessage（先）→ message.completed（后）：事件反映的是已持久化状态
     ├─ end_turn → run.completed，返回
     ├─ provider 异常 → 悬空 tool_call 合成 error result → llm.failed → run.failed
     └─ tool_use → 工具回合：
          每个 call: JSON.parse(argsJson || "{}")   ← 无参调用合法
            解析失败 → tool_call.completed（带原始块）+ error result，不执行
          权限门（§5）→ 调度（§5.1）→ tool 消息落盘 → 回到循环顶部
```

### 4.1 工具调度：并行/串行的结构化保证

一批 tool_call 按声明的 `concurrency` 分两组：

```
[parallel 组] Promise.allSettled 并发（各自独立超时，互不阻塞）
      ↓ 全部 settle（屏障）
[serial 组]   按模型给定顺序逐个 await
```

串行工具的排他性是**结构保证**而非测试约束：并行组被 allSettled 屏障拦住，串行组彼此顺序 await，下一轮 LLM 迭代等整个工具回合结束。任何时刻都不存在与 serial 工具重叠的执行。

无论实际完成顺序如何，`tool_result` 块一律按 `callId` 原序写入 tool 消息——确定性让回放与调试成为可能。

### 4.2 权限门：三级短路 + 确认竞速

每个工具执行前过 `PermissionGate.check`：

```
deny   → error result + note 块（kind: denied/timeout）+ note.emitted，循环继续
         （模型被告知拒绝原因，可以换方案——这是"确认流不中断循环"的关键）
allow  → 直接执行
confirm→ confirmation.requested → 竞速{ resolveConfirmation | 超时 | abort }
         ├─ 用户批准 → 执行
         ├─ 超时     → 按拒绝处理（by:"timeout"）
         └─ abort    → 不发 confirmation.resolved，走 aborted 终态
```

超时竞速用 `Promise.race` + sentinel，abort 与 timeout 语义分离：**用户取消不是"超时拒绝"**。

### 4.3 失败路径的完整性（终审修复波的核心）

修复波之前，provider 失败会让 `runAgent` 直接 reject——`run.started` 永无终态、`message.created` 成为孤儿。现在的不变量是：

> **`run.started` 之后，runAgent 永远以 `run.completed` 或 `run.failed` 结束，且永不 reject（provider 错误）。**

配套处理：部分内容落盘 `stopReason:"error"`；悬空的 tool_call（流中断/abort 时未完成的调用）合成 error result 配对落盘——否则下一轮发给 provider 的历史里会出现无 result 的 tool_calls，OpenAI 兼容接口直接 400。

`toProviderMessages`（`src/agent/context.ts`）还有两道防御：滑动窗口切在 assistant 与 tool 消息之间时丢弃孤儿 tool 消息；assistant 的 toolCalls 若无后续 result 配对则剔除。**历史清理发生在组装视图时，永不修改落盘数据。**

## 5. 上下文组装：协议消息 → provider 消息

`toProviderMessages(history, window)` 是协议格式与 API 格式的唯一翻译点：

- user：text 拼接，note 转为 `[system note] ...` 行（记忆注入对模型可见且可追溯）
- assistant：text 为 content（无则 null），tool_call 块 → toolCalls（复用原始 argsJson）
- tool：每个 tool_result 一条 tool 消息，error 前缀 `[error] `（模型能识别失败并自救）
- thinking/attachment 不进模型视图

## 6. 已知边界与 P2/P3 交接点

- `onLlmRetry` 钩子已定义未接线（withRetry 在 `stream()` 内部拥有重试，loop 层再试会双重重试）；P3 的 daemon 组合层负责把 `withRetry.onRetry` 翻译成 `llm.failed{willRetry:true}` 事件，届时 `llm.started` 的 attempt 才会真实。
- `deps.onMessage` 目前只收集在内存——P2 的 JSONL 会话持久化在这里接入（消息已是完整不可变快照，追加写即安全）。
- 工具执行器的内置实现（exec/fs/web/memory）、权限引擎的具体规则（白黑名单匹配）是 P2 范围；P1 交付的是接口与循环语义。
- token 预算护栏（spec §6④）尚未实现，与测试 helper 去重一起记为 spec 债务。

## 7. 测试策略

P1 的 58 个测试全部是 mock 驱动的行为测试：mock LlmClient 按脚本吐 `LlmStreamEvent` 序列（含挂起流、中途抛错、畸形 JSON），mock 工具带 overlap 检测器验证调度排他性，fake timers 驱动确认超时。断言的是**事件序列、消息内容、终态不变量**，而非实现细节——重构循环内部只要外部行为不变，测试不动。
