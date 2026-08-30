# provider — OpenAI 兼容的 LLM 接入层

## 职责

`packages/core/src/provider/` 把"调用一个大语言模型"收敛为一个最小接口 `LlmClient`：输入一次对话请求，输出一串流式事件。它只做四件事：

1. 把内部请求转成 OpenAI 兼容的 `/chat/completions` 调用
2. 解析流式响应
3. 给整个请求加超时
4. 对临时性失败做带退避的重试

不读配置、不感知进程模型：baseUrl/apiKey/model 的来源由 daemon 侧负责（见下文"端点解析"）。

---

## 设计决策

- **仅支持一种线上协议**：任何提供 OpenAI 兼容 `/chat/completions` 端点的服务（OpenAI、各类中转、本地模型网关）都无需单独适配；差异全部留在 baseUrl 指向的端点上。
- **core 与传输解耦**：`agent/loop.ts` 只依赖 `LlmClient` 这个 async iterable 接口，不知道 fetch、SSE（Server-Sent Events：服务器通过 HTTP 持续推送文本行的流式格式）的存在；测试注入假 client 即可完整运行整个循环。
- **超时覆盖整个请求**：`AbortSignal.timeout` 同时约束"等响应头"和"读流式响应体"两个阶段——停滞的 provider 流（无响应头、或响应体中途停止）不可能使一个 run 永久停滞。
- **超时与 HTTP 错误共用一套消息格式**：失败统一抛成 `llm http <status>` 或 `llm http timeout after <n>ms` 字符串，`retry.ts` 用正则识别——分类方（openai-compat）与消费方（retry）靠这个消息约定耦合，改任何一侧都要保持同步。
- **重试封装在 client 内部，不在循环层**：`runAgent` 调一次 `stream()` 就是完整的一次"可能含内部重试"的调用；循环层再重试会形成双重重试。重试经 `withRetry` 的 `onRetry` 回调对外可见——daemon 把它接到循环的 `onLlmRetry` 钩子，转成 `llm.failed {willRetry:true}` 事件（见 [agent-loop](./agent-loop.md)）。
- **已产出事件绝不重试**：流已产出过事件即说明消费方可能已收到，重试会造成输出重复——此时错误直接抛出。
- **参数原文不动**：工具调用的参数以原始 JSON 字符串（`argsJson`）透传，不在 provider 层解析；解析失败的处理属于循环层。
- **多模态只透传不解释**：user 消息的 `content` 允许是 OpenAI 多模态数组（文本段 + `image_url` 图片段），provider 原样放进请求体——是否真能"看懂"图片由模型决定，协议层不感知。

---

## 接口

```ts
// packages/core/src/provider/types.ts
// user 消息的多模态内容段：图片以 data: URL 内联（见 agent/context.ts 的附件挂载）
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

export interface LlmClient {
  stream(req: LlmRequest): AsyncIterable<LlmStreamEvent>
}

export interface LlmRequest {
  model: string
  system: string
  messages: ProviderMessage[]
  // ProviderMessage 三种：
  //   user       → { role:"user", content: string | ContentPart[] }
  //   assistant  → { role:"assistant", content: string|null, toolCalls? }
  //   tool       → { role:"tool", toolCallId, content }
  tools: ToolDefinition[]       // {name, description, parameters(JSON Schema)}
  maxTokens?: number
}

export type LlmStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_started"; index: number; callId: string; name: string }
  | { type: "tool_call_delta"; index: number; delta: string }
  | { type: "message_done"; stopReason: StopReason; usage: Usage }
```

两个实现/包装（组合使用）：

```ts
// packages/core/src/provider/openai-compat.ts
export const DEFAULT_LLM_TIMEOUT_MS = 120_000
export function createOpenAiCompatClient(opts: {
  baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number
}): LlmClient

// packages/core/src/provider/retry.ts
export function withRetry(client: LlmClient, opts?: {
  maxAttempts?: number      // 默认 3
  baseDelayMs?: number      // 默认 500
  jitter?: () => number
  onRetry?: (info: { attempt: number; error: unknown }) => void
}): LlmClient
```

daemon 侧的装配（`packages/server/src/daemon.ts`）：

```ts
export function resolveProviderEndpoint(cfg: KclawConfig): { baseUrl: string; apiKey: string }
export function resolveModel(cfg: KclawConfig): string
export function defaultLlmFactory(cfg: KclawConfig, onRetry?): LlmClient
// defaultLlmFactory = withRetry(createOpenAiCompatClient({baseUrl, apiKey,
//   timeoutMs: cfg.providers.timeoutMs}), {onRetry})
```

---

## 核心流程

### 1. 请求归一化（`toApiMessages`）

内部消息转成 OpenAI 格式，规则：

- `system` 提示词放第一条 `{role:"system", content}`；maxTokens 有值时才带 `max_tokens`。
- user 的 `content` 原样透传：字符串就是纯文本，`ContentPart[]` 数组（文本段 + `image_url` 图片段）即 OpenAI 多模态格式——provider 不重排、不校验。
- assistant 的 `content === null` 时字段整个省略；`toolCalls` 转成 `tool_calls: [{id: callId, type:"function", function:{name, arguments: argsJson}}]`——`argsJson` 原样作为 `arguments` 传回。
- tool 消息转成 `{role:"tool", tool_call_id: callId, content}`。
- 请求体固定 `stream: true` 与 `stream_options: {include_usage: true}`（最后一个 chunk 会带 token 用量）；URL 为 `baseUrl` 去掉一个尾部 `/` 后拼 `/chat/completions`；鉴权用 `Authorization: Bearer <apiKey>` 头（Bearer 是 HTTP 标准认证方案，格式为令牌置于 Bearer 关键字之后）。

### 2. 流式解析（SSE 循环）

`sseDataLines` 按行读响应体，只取 `data:` 前缀后的内容；收到 `data: [DONE]` 结束。每个 chunk 的映射：

- `delta.reasoning_content` → `thinking_delta`（推理文本）；
- `delta.content` → `text_delta`；
- `chunk.usage` → 记为 `{inputTokens: prompt_tokens, outputTokens: completion_tokens}`，缺省按 0；
- `choices[0].finish_reason` → 记下，流结束时装进 `message_done`；
- `delta.tool_calls[]`：一个 index 的**第一帧**（带 `id` 或 `function.name` 的那个）发 `tool_call_started`（无 id 时用 `call_idx_${index}` 代替 callId，name 缺省空串）；后续帧的 `function.arguments` 片段逐个发 `tool_call_delta`。

undefined、null、`""` 三种"无内容"情况统一跳过——这保证"完全没有参数流的调用"（arguments 从未出现）也能存活，循环层将其按 `{}` 解析。

### 3. 超时终止

`AbortSignal.timeout(timeoutMs)`（默认 `DEFAULT_LLM_TIMEOUT_MS = 120_000`，也是 `config.yaml` 里 `providers.timeoutMs` 的默认值）在三个位置生效，任何一处因超时中断（以"信号是否已触发"判断，不看错误形状）都改抛成同一条消息：

| 阶段 | 位置 | 超时后的行为 |
|------|------|--------------|
| 等响应头 | `fetch` 抛错 | 抛 `llm http timeout after <n>ms` |
| 非 2xx 读错误体 | `res.text()` 抛错 | 超时优先抛超时；**超时前**的读失败则吞掉、text 记为空——状态行 `llm http <status>` 仍能完成分类 |
| 读流式响应体 | SSE 循环抛错 | 抛 `llm http timeout after <n>ms` |

非 2xx 且响应体读成功时抛 `llm http <status>: <body文本>`——错误体的读取同样受超时约束，不会把一种无限等待换成另一种。

### 4. 重试（`withRetry`）

- **可重试的判定 `isTransient`**：`TypeError`（fetch 网络层失败的典型形态）；或错误消息匹配 `/llm http (429|5\d\d|timeout)/`——即限流（429）、服务端错误（5xx）、provider 超时。其余（如 401 密钥错误、400 请求格式错误）直接抛出。
- **次数与退避**：默认 `maxAttempts = 3`，第 n 次失败后等待 `baseDelayMs * 2^(n-1) + jitter()*100`（默认基数 500ms：首次重试前约 500–600ms，第二次约 1000–1100ms），指数退避即每次失败后等待时间翻倍，附加随机抖动（jitter，避免固定节奏）。
- **`yielded` 守卫**：一旦本次尝试已产出过事件，任何错误都不再重试（防重复输出，见设计决策）。
- **`onRetry`**：每次即将重试前回调 `{attempt, error}`；daemon 把它接到事件总线上变成 `llm.failed {willRetry:true}`。

### 5. stopReason 归一化（`normalize.ts`）

provider 的 `finish_reason` 字符串映射为协议的 7 个 `StopReason`（定义在 `packages/core/src/protocol/messages.ts`）之一：

```
stop          → end_turn        length          → max_tokens
tool_calls    → tool_use        function_call   → tool_use
content_filter→ content_filter  stop_sequence   → stop_sequence
null / 未知名 → end_turn
```

7 个值中的 `aborted` 与 `error` 永远不来自 provider：前者由循环在各取消检查点打上，后者标记流彻底失败的消息。归一化让 `runAgent` 的分派逻辑只认这 7 个值，与具体 provider 的用词解耦。

### 6. 端点与模型解析（daemon 侧，config 优先于环境变量）

`resolveProviderEndpoint` / `resolveModel`（`packages/server/src/daemon.ts`）按同一优先级取值，经 `valueOrEnv` 实现——**config 条目的值非空就用它；为空再看环境变量；两处都空就报错**：

| 项 | config 来源 | 环境变量 |
|----|-------------|----------|
| baseUrl | `providers.entries[providers.default].baseUrl` | `KCLAW_LLM_BASE_URL` |
| apiKey | 同上 `.apiKey` | `KCLAW_LLM_API_KEY` |
| model | 同上 `.model` | `KCLAW_LLM_MODEL` |

- baseUrl 或 apiKey 仍为空 → 启动即抛 `no llm provider configured: set providers in config.yaml or KCLAW_LLM_* env`，不做半配置的静默启动。
- model 单独解析（`resolveModel`）：RunManager 每次请求都要带 model，纯环境变量配置 provider 时 model 也必须有来源；缺失同样抛错。
- CLI 首次运行判定（`packages/cli/src/provider-check.ts` 的 `detectProviderStatus`）用同一套优先级输出三态：`config`（default 指向存在的条目）/ `env`（任一 `KCLAW_LLM_*` 非空）/ `missing`。
- `providers.timeoutMs` 未配置时由 `loadConfig` 的默认值补齐为 `DEFAULT_LLM_TIMEOUT_MS`（120s）。

---

## 边界与出错

- **重试耗尽**：`stream()` 抛出最后一个错误 → 循环把部分内容以 `stopReason:"error"` 持久化并发 `run.failed`；`runAgent` 对 provider 错误永不 reject（见 [agent-loop](./agent-loop.md)）。
- **流中断在工具调用中间**：已发过 `tool_call_started` 但流中断 → 循环为悬空调用合成 error result，保证历史里 tool_call 永远有配对结果（OpenAI 兼容 API 对无配对 tool_call 的下轮请求回 400）。
- **错误体读失败的双重处理**：超时后的读失败按超时报告；超时前的读失败吞掉以保住状态行分类（见上表）。
- **已知限制**：SSE 只处理 `data:` 行（注释行、事件名行忽略）；`finish_reason` 出现在非末 chunk 时以最后见到的一次为准；重试不重放 HTTP 请求体（每次都是全新请求）。

---

## 关联

- [agent-loop](./agent-loop.md)：消费 `LlmStreamEvent` 的一侧
- [tools](./tools.md)：`ToolDefinition` 的生产方与 `argsJson` 的最终解析方
- [protocol](./protocol.md)：`StopReason` / `Usage` 的定义
- [../server/daemon.md](../server/daemon.md)：`resolveProviderEndpoint` / `defaultLlmFactory` 所在的装配现场
