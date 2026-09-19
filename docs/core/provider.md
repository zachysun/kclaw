# provider — LLM 接入层（OpenAI 兼容与 Anthropic Messages 两种线上协议）

## 职责

`packages/core/src/provider/` 把"调用一个大语言模型"收敛为一个最小接口 `LlmClient`：输入一次对话请求，输出一串流式事件。它只做这几件事：

1. 把内部请求转成条目声明的线上协议调用——`openai` 格式走 OpenAI 兼容的 `/chat/completions`，`anthropic` 格式走 Anthropic Messages API
2. 解析流式响应
3. 给整个请求加超时
4. 对临时性失败做带退避的重试
5. 提供内置供应商预设目录与模型列表检测（供 WebUI 的 Model 页处理）

不读配置、不感知进程模型：每个 provider 条目（`providers.entries` 的一项 = 一个端点 + 一个模型）的 baseUrl/apiKey/model/格式由 daemon 侧负责（见下文"端点与模型解析"）。

---

## 设计决策

- **每个条目是一种协议 + 一个真实端点**：条目的 `format` 字段（`openai | anthropic`，默认 `openai`）决定请求怎么发；每个条目拥有自己的 baseUrl/apiKey——会话切到某条目就是真正换供应商，而不是把模型名发给默认端点。`createProviderClient`（factory.ts）是唯一的按格式选实现点，新增协议只能在这里接线。
- **openai 格式的适用范围**：任何提供 OpenAI 兼容 `/chat/completions` 端点的服务（OpenAI、DeepSeek、Ollama、各类中转、本地模型网关）都无需单独适配；差异全部留在 baseUrl 指向的端点上。
- **core 与传输解耦**：`agent/loop.ts` 只依赖 `LlmClient` 这个 async iterable 接口，不知道 fetch、SSE（Server-Sent Events：服务器通过 HTTP 持续推送文本行的流式格式）的存在；测试注入假 client 即可完整运行整个循环。
- **超时覆盖整个请求**：`AbortSignal.timeout` 同时约束"等响应头"和"读流式响应体"两个阶段——停滞的 provider 流（无响应头、或响应体中途停止）不可能使一个 run 永久停滞。
- **超时与 HTTP 错误共用一套消息格式**：失败统一抛成 `llm http <status>` 或 `llm http timeout after <n>ms` 字符串，`retry.ts` 用正则识别——分类方（openai-compat）与使用方（retry）靠这个消息约定耦合，改任何一侧都要保持同步。
- **重试封装在 client 内部，不在循环层**：`runAgent` 调一次 `stream()` 就是完整的一次"可能含内部重试"的调用；循环层再重试会形成双重重试。重试经 `withRetry` 的 `onRetry` 回调对外可见，把它接到循环的 `onLlmRetry` hook，转成 `llm.failed {willRetry:true}` 事件（见 [agent-loop](./agent-loop.md)）。
- **已产出事件绝不重试**：流已产出过事件即说明使用方可能已收到，重试会造成输出重复——此时错误直接抛出。
- **参数原文不动**：工具调用的参数以原始 JSON 字符串（`argsJson`）透传，不在 provider 层解析；解析失败的处理属于循环层。（例外：anthropic 格式要把参数变成 Messages API 的 `tool_use.input` 对象，请求侧做一次 `JSON.parse`，解析失败按空对象。）
- **多模态按协议整形**：user 消息的 `content` 允许是数组（文本段 + `image_url` 图片段）。openai 格式原样放进请求体；anthropic 格式把 `data:` URL 解成 base64 source 块、http(s) URL 解成 url source 块——是否真能"看懂"图片由模型决定，协议层不解释。

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

两个协议实现 + 一个按条目选择实现 + 一个检测（组合使用）：

```ts
// packages/core/src/provider/openai-compat.ts
export const DEFAULT_LLM_TIMEOUT_MS = 120_000
export function createOpenAiCompatClient(opts: {
  baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number
}): LlmClient

// packages/core/src/provider/anthropic.ts
export const ANTHROPIC_VERSION = "2023-06-01"          // anthropic-version 头的值
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192      // Messages API 必填 max_tokens 的默认
export function createAnthropicClient(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): LlmClient

// packages/core/src/provider/factory.ts — 按条目 format 选实现（唯一选择点）
export function createProviderClient(opts: { entry: ProviderEntry; timeoutMs?: number; fetchImpl?: typeof fetch }): LlmClient

// packages/core/src/provider/presets.ts — 内置预设目录 + 条目校验
export const PROVIDER_PRESETS: readonly ProviderPreset[]
export function parseProviderEntry(input: unknown): ProviderEntry

// packages/core/src/provider/probe.ts — 模型列表检测（兼作连接验证）
export function fetchProviderModels(opts: { format: ProviderApiFormat; baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<string[]>

// packages/core/src/provider/retry.ts
export function withRetry(client: LlmClient, opts?: {
  maxAttempts?: number      // 默认 3
  baseDelayMs?: number      // 默认 500
  jitter?: () => number
  onRetry?: (info: { attempt: number; error: unknown }) => void
}): LlmClient
```

内置预设（`PROVIDER_PRESETS`，WebUI Model 页的"预设"来源）：`openai`（https://api.openai.com/v1）、`anthropic`（https://api.anthropic.com）、`deepseek`（https://api.deepseek.com/v1，openai 格式）、`ollama`（http://localhost:11434/v1，openai 格式，可免密钥）。预设写死 baseUrl 与格式，用户只填 API key。

条目校验（`parseProviderEntry`）除 format/baseUrl/apiKey/model 外，还要求 `contextWindow`/`maxOutput` 声明时必须是正数，否则抛 `"<key> must be a positive number"`——新增/编辑条目经此校验，WebUI 把它转成表单内的错误。

解析函数在 core（`packages/core/src/provider/resolve.ts`），daemon 组装时建一个共享 resolver 实例（`packages/server/src/daemon.ts`）：

```ts
// core
export function resolveProviderEndpoint(cfg: KclawConfig): { baseUrl: string; apiKey: string }
export function resolveModel(cfg: KclawConfig): string
export function createProviderResolver(cfg: KclawConfig, fetchImpl?: typeof fetch): ProviderResolver
// ProviderResolver：llm(entryKey?) / embed(providerName, model) / invalidate()
// createProviderResolver：按条目建连的带缓存解析器——见"端点与模型解析"一节
```

---

## 核心流程

### 1. 请求归一化（openai 格式，`toApiMessages`）

内部消息转成 OpenAI 格式，规则：

- `system` 提示词放第一条 `{role:"system", content}`；maxTokens 有值时才带 `max_tokens`。
- user 的 `content` 原样透传：字符串就是纯文本，`ContentPart[]` 数组（文本段 + `image_url` 图片段）即 OpenAI 多模态格式——provider 不重排、不校验。
- assistant 的 `content === null` 时字段整个省略；`toolCalls` 转成 `tool_calls: [{id: callId, type:"function", function:{name, arguments: argsJson}}]`——`argsJson` 原样作为 `arguments` 传回。
- tool 消息转成 `{role:"tool", tool_call_id: callId, content}`。
- 请求体固定 `stream: true` 与 `stream_options: {include_usage: true}`（最后一个 chunk 会带 token 用量）；URL 为 `baseUrl` 去掉一个尾部 `/` 后拼 `/chat/completions`；鉴权用 `Authorization: Bearer <apiKey>` 头（Bearer 是 HTTP 标准认证方案，格式为令牌置于 Bearer 关键字之后）——apiKey 为空时不发鉴权头（Ollama 等免密钥端点）。

### 1b. 请求归一化（anthropic 格式，`toAnthropicPayload`）

内部消息转成 Anthropic Messages API 的 content block 形态，规则：

- `system` 提示词折叠进顶层 `system` 字段（请求里遇到的内联 system 消息一并并入，双换行连接）。
- user 的字符串内容包一层 `[{"type":"text","text":…}]`；`ContentPart[]` 的图片段解成 `{"type":"image","source":{…}}`（data: URL → base64 source，http(s) URL → url source）。
- assistant 的 `toolCalls` 转成 `tool_use` 块（`{id: callId, name, input: JSON.parse(argsJson)}`，解析失败按 `{}`）；content 为空且无 toolCalls 的空 assistant 轮整个丢弃（API 拒收空 content）。
- 连续的 tool 结果消息合并成**一条** user 消息里的多个 `{"type":"tool_result","tool_use_id":…,"content":…}` 块（API 规定 tool_result 只能出现在 user 轮）。
- 工具定义转 `{name, description, input_schema: parameters}`；`max_tokens` 必填——条目未声明 `maxOutput` 时用 `ANTHROPIC_DEFAULT_MAX_TOKENS`（8192）。
- 请求体 `stream: true`；URL 规则见 `anthropicEndpoint`：baseUrl 以 `/v1` 结尾则直接拼路径，否则插入 `/v1`（官方裸域与中转带版本两种都支持）；鉴权用 `x-api-key` + `anthropic-version: 2023-06-01` 头，apiKey 为空时不发。

### 2. 流式解析（SSE 循环，两格式各自的映射）

`sseDataLines`（两格式共用）按行读响应体，只取 `data:` 前缀后的内容；openai 格式收到 `data: [DONE]` 结束，anthropic 格式收到 `message_stop` 事件结束。

openai 格式每个 chunk 的映射：

- `delta.reasoning_content` → `thinking_delta`（推理文本）；
- `delta.content` → `text_delta`；
- `chunk.usage` → 记为 `{inputTokens: prompt_tokens, outputTokens: completion_tokens}`，默认按 0；
- `choices[0].finish_reason` → 记下，流结束时装进 `message_done`；
- `delta.tool_calls[]`：一个 index 的**第一帧**（带 `id` 或 `function.name` 的那个）发 `tool_call_started`（无 id 时用 `call_idx_${index}` 代替 callId，name 默认空串）；后续帧的 `function.arguments` 片段逐个发 `tool_call_delta`。

undefined、null、`""` 三种"无内容"情况统一跳过——这保证"完全没有参数流的调用"（arguments 从未出现）也能存活，循环层将其按 `{}` 解析。

anthropic 格式每个 SSE 事件的映射：

- `message_start` → 记下 `message.usage.input_tokens`（含初始 output）；
- `content_block_start`（`tool_use`）→ 发 `tool_call_started`（index 即块序号，无 id 时用 `call_idx_${index}` 代替）；
- `content_block_delta`：`text_delta` → `text_delta`；`thinking_delta` → `thinking_delta`；`input_json_delta` → `tool_call_delta`（`partial_json` 原样透传）；`signature_delta` 忽略；
- `message_delta` → 记下 `stop_reason` 与 `usage.output_tokens`；
- `message_stop` → 结束；`error` 事件 → 抛 `llm anthropic <type>: <message>`；`ping` 忽略。

### 3. 超时终止

`AbortSignal.timeout(timeoutMs)`（默认 `DEFAULT_LLM_TIMEOUT_MS = 120_000`，也是 `config.json` 里 `providers.timeoutMs` 的默认值）在两个协议实现里同样生效于三个位置，任何一处因超时中断（以"信号是否已触发"判断，不看错误形状）都改抛成同一条消息：

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

### 5. stopReason 归一化

provider 的结束原因字符串映射为协议的 7 个 `StopReason`（定义在 `packages/core/src/protocol/messages.ts`）之一。openai 格式的 `finish_reason` 经 `normalize.ts`：

```
stop          → end_turn        length          → max_tokens
tool_calls    → tool_use        function_call   → tool_use
content_filter→ content_filter  stop_sequence   → stop_sequence
null / 未知名 → end_turn
```

anthropic 格式的 `stop_reason` 本就是协议取值（`end_turn` / `max_tokens` / `tool_use` / `stop_sequence` 直通），仅 `refusal` 映射为 `content_filter`，未知值回退到 `end_turn`。

7 个值中的 `aborted` 与 `error` 永远不来自 provider：前者由循环在各取消检查点打上，后者标记流彻底失败的消息。归一化让 `runAgent` 的分派逻辑只认这 7 个值，与具体 provider 的用词解耦。

### 6. 端点与模型解析（config 优先于环境变量）

**启动校验**：`resolveProviderEndpoint` / `resolveModel`（core `provider/resolve.ts`）在 daemon 启动时做一次 fail-fast 校验，经 `valueOrEnv` 实现——config 条目的值非空就用它，为空再看环境变量：

| 项 | config 来源 | 环境变量 |
|----|-------------|----------|
| baseUrl | `providers.entries[providers.default].baseUrl` | `KCLAW_LLM_BASE_URL` |
| apiKey | 同上 `.apiKey`（可为空——免密钥端点合法） | `KCLAW_LLM_API_KEY` |
| model | 同上 `.model` | `KCLAW_LLM_MODEL` |

- baseUrl 仍为空 → 启动即抛 `no llm provider configured: set providers in config.json or KCLAW_LLM_BASE_URL env`，不做半配置的静默启动。
- model 为空 → 抛 `no llm model configured: set providers.<name>.model in config.json or KCLAW_LLM_MODEL env`；RunManager 每次请求都要带 model，纯环境变量配置时 model 也必须有来源。
- CLI 首次运行判定（`packages/cli/src/provider-check.ts` 的 `detectProviderStatus`）用同一套优先级输出三态：`config`（default 指向存在的条目）/ `env`（任一 `KCLAW_LLM_*` 非空）/ `missing`。
- `providers.timeoutMs` 未配置时由 `loadConfig` 的默认值补齐为 `DEFAULT_LLM_TIMEOUT_MS`（120s）。

**按条目建连**（`createProviderResolver`）：daemon 启动时建一个 resolver，run 客户端、记忆提取与向量路都出自它。每个 run 的客户端由 `llmForRun(onRetry, entryKey)` 给出，`entryKey` 来自 `resolveRunModel` 的解析结果（run 组装先解析条目、再建客户端）。取值链：条目命中 → 该条目的 format 决定协议实现（`createProviderClient`）；条目缺失（key 为空或不存在）→ 回退到默认条目；连默认条目都没有 → 回退到环境变量端点（openai 格式）。

- **缓存与热生效**：resolver 按条目名缓存裸客户端，签名 = `format|baseUrl|apiKey|timeoutMs`。Model 页的增删改直接改 daemon 的内存配置并持久化，随后经 ConfigNotifier 发布 `providers` 变更（见 [storage](./storage.md)），resolver 订阅后**整体清空缓存**，下个 run 自动重建，**无需重启**；签名检查保留为优化，两次通知之间的字段改动也能即时重建。
- **每次 run 包一层新重试**：缓存的是裸客户端；`withRetry` 在每次 `llmForRun` 调用时现包，重试回调才归属当次 run（`llm.failed` 事件带对的上文）。
- **记忆提取同语义**：`memory.extractModel` 命中条目名时走该条目自己的客户端与线上模型名；命中不了则按裸模型名发往主模型端点（回退）。daemon 给 MemorySystem 注入 `resolveEntryLlm`，条目客户端与 run 客户端同源（同一 resolver 的缓存与热生效，见 [memory](./memory.md)）。
- **向量路同步热更**：embedding 客户端由 resolver 的 `embed(providerName, model)` 给出（按 `baseUrl|apiKey|timeoutMs` 签名现解），换 key/换地址下条记忆向量就吃到；向量路是否启用（embeddings model 与条目协议判定）仍是启动时一次定死。
- **默认模型行也支持热更**：run 组装与手动压缩路径的默认模型取默认条目**当前**的 `.model`，启动时解析的 `deps.model` 只在"没有配置条目、纯环境变量"的安装里作回退。

### 6b. 模型列表检测（probe，兼作连接验证）

`fetchProviderModels` 向端点要模型清单：openai 格式 `GET {base}/models`（apiKey 非空才带 Bearer 头），anthropic 格式 `GET {base}/v1/models`（x-api-key + anthropic-version，URL 规则与消息端点一致；与消息端点不同，检测这里 apiKey 为空也照发空 x-api-key 头）。返回去重后的模型 id 列表；HTTP 错误抛 `llm http <status>`，响应形状不对抛可读错误。WebUI Model 页用它做两件事：表单里的"拉取模型列表"（填充模型下拉）与条目卡片的"验证"按钮（清单拉到了 = URL 和 key 都对）。

模型名本身的验证走 `probeProviderChat`（1-token 补全探测）：openai 格式 `POST {base}/chat/completions`，anthropic 格式 `POST {base}/v1/messages`，20 秒超时；它不抛异常而是返回 `{status, body}`（status 为 null = 请求根本没到达），调用方按状态码分类失败原因。CLI 首次运行向导用它做连通测试（见 [onboarding](../cli/onboarding.md)）。

### 7. 上下文窗口与输出上限（条目可选字段）

每个 provider 条目还有两个可选数字字段，直接决定请求形状：

| 字段 | 含义 | 默认 |
|------|------|------|
| `contextWindow` | 该模型的上下文窗口（token 数）。有效值（正数）时，有效上下文 budget 取 `min(sessions.contextTokens ?? ∞, contextWindow)`——按更紧的那个算 | 无（回退到 `sessions.contextTokens`，再回退到 128000） |
| `maxOutput` | 单次回复的输出上限（token 数）。声明后随每次请求作为 `max_tokens` 下发，模型单轮最多产出这么多 | 无（不随请求下发） |

有效 budget 的解析集中在 `resolveContextTokens`（`packages/core/src/storage/config.ts`）一处——压缩的触发线、压缩器与组装时的省略 budget 全部经它取值，某个模型窗口更紧时会一起收紧，不会出现"压缩按 128000 算、模型实际只有 8 万"的错位。单次 run 的三级模型解析（`resolveRunModel`，同上文件）返回 `{model, entryKey, budget, maxOutput?}`：`model` 是发往 provider 的线上模型名（条目名 → 条目的 `.model`，匹配不到条目的名字原样通过），`budget` 即上述有效budget，`maxOutput` 有才带；两个调用方（run 组装与手动压缩路径）都走这一个函数，budget 口径不可能分叉。模型条目解析的优先级与回退链见 [architecture](./architecture.md) 的数据流一节。

---

## 边界与出错

- **重试耗尽**：`stream()` 抛出最后一个错误 → 循环把部分内容以 `stopReason:"error"` 持久化并发 `run.failed`；`runAgent` 对 provider 错误永不 reject（见 [agent-loop](./agent-loop.md)）。
- **流中断在工具调用中间**：已发过 `tool_call_started` 但流中断 → 循环为悬空调用合成 error result，保证历史里 tool_call 永远有配对结果（OpenAI 兼容 API 对无配对 tool_call 的下轮请求回 400）。
- **错误体读失败的双重处理**：超时后的读失败按超时报告；超时前的读失败吞掉以保住状态行分类（见上表）。
- **已知限制**：SSE 只处理 `data:` 行（注释行、事件名行忽略）；`finish_reason` 出现在非末 chunk 时以最后见到的一次为准；重试不重放 HTTP 请求体（每次都是全新请求）。

---

## 关联

- [agent-loop](./agent-loop.md)：处理 `LlmStreamEvent` 的一侧
- [tools](./tools.md)：`ToolDefinition` 的生产方与 `argsJson` 的最终解析方
- [protocol](./protocol.md)：`StopReason` / `Usage` 的定义
- [../server/daemon.md](../server/daemon.md)：共享 resolver 的组装现场（创建实例并订阅配置变更通知）
- [../server/http-api.md](../server/http-api.md)：`/providers` 管理路由族（Model 页的处理面）
