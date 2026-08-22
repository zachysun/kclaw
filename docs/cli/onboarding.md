# onboarding — 首次运行体验

## 职责

`packages/cli` 的首次运行链路包含三个模块：`src/provider-check.ts` 的 `detectProviderStatus` 判定模型配置的来源（决定是否进入向导）；`src/wizard.ts` 的 `runWizard` 是 30 秒配置向导（选模板 → 输入 key → 连通测试 → 写 config.yaml）；`src/web-cmd.ts` 的 `webAction` 实现 `kclaw web`（确保 daemon 在运行、携带 token 打开浏览器）。加上 `src/index.ts` 入口的 Node >= 22 版本检查，共同构成首次执行 `kclaw` 能顺利使用的全部路径。

## 设计决策

- **判定优先级：config > env > missing**：`config.yaml` 里 `providers.default` 指向一个存在的条目即视为已配置；否则任一非空的 `KCLAW_LLM_*` 环境变量视为已配置；两者都缺失才判定为 "missing"（触发向导）。与 daemon 侧 `resolveProviderEndpoint` 的解析规则同向：config 优先、env 补缺。
- **路径解析复用 core**：`detectProviderStatus` 与向导都用 `@kclaw/core` 的 `resolvePaths`/`loadConfig`/`saveConfig`（真实的 `KclawPaths` 形状），不自建替代实现，CLI 侧的路径解析永远不会与 daemon 发生漂移（其 mkdir 副作用只是提前创建 home 目录树，任何 kclaw 调用本来也会创建）。
- **向导是验证环节不是必经之路**：只在 "missing" 且 stdout 是 TTY 时启动；取消（Ctrl+C 等）或"重试？→否"都直接静默退出，**文件系统零改动**——绝不写入不完整的 config.yaml。
- **连通测试用最小请求**：一次 `max_tokens: 1` 的补全请求，验证 key、model、baseUrl 三项组合可用，不浪费 token。
- **key 文件权限 0600**：`saveConfig` 用普通 `writeFileSync`（不能设 mode），向导在保存后立刻 `chmodSync(paths.config, 0o600)`——API key 持久化在这个文件里，仅属主可读写。
- **`kclaw web` 不向用户展示 token**：URL 带 token 只用于浏览器一次交接，终端打印的地址刻意去掉 `?token=` 部分（用户能看见/分享的是不带 token 的 URL）。

## provider 判定（packages/cli/src/provider-check.ts）

```ts
export type ProviderStatus = "config" | "env" | "missing"

export function detectProviderStatus(home: string): ProviderStatus
// 1. loadConfig(resolvePaths(home)) 后：providers.default 非空且
//    providers.entries[default] 存在 → "config"
// 2. 否则 KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY / KCLAW_LLM_MODEL 任一非空 → "env"
// 3. 否则 → "missing"
```

`chatAction`（`src/index.ts`）按结果分流：

- `"config"` / `"env"` → 直接 `runChat`。
- `"missing"` + TTY → `runWizard(home)`；返回 `"aborted"` 时静默返回（不写入任何文件），`"configured"` 时继续进入 chat。
- `"missing"` + 非 TTY（管道/CI）→ 打印一行指引并退出：`no llm provider configured — run 'kclaw chat' in a terminal to run the setup wizard, see README`。

## 向导流程（packages/cli/src/wizard.ts）

四个模板（`PROVIDER_TEMPLATES`）：

| id | label | baseUrl | 默认 model | skipKey |
|----|-------|---------|-----------|---------|
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | |
| `openai` | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | |
| `ollama` | Ollama (local) | `http://127.0.0.1:11434/v1` | | 是（key 固定填 `"ollama"`） |
| `custom` | Custom OpenAI-compatible endpoint | 无（需输入） | | |

步骤机（`step: "template" | "baseurl" | "key" | "model"`）：

1. **template**：@clack 单选四模板；custom（无 baseUrl）进入 baseurl 步，ollama（skipKey）跳过 key 直达 model，其余进入 key。
2. **baseurl**（仅 custom）：文本输入，裁掉末尾斜杠，空值报错并重新输入。
3. **key**：`p.password` 隐藏输入（不回显）；ollama 不经过这步。
4. **model**：文本输入，空则用模板默认；然后构造 `buildProviderEntry(t, apiKey, model)` → `{ baseUrl, apiKey, model }` → 连通测试。
5. **连通测试**（`probe`）：`POST {baseUrl}/chat/completions`，body `{ model, messages: [{role:"user", content:"hi"}], max_tokens: 1, stream: false }`，`AbortSignal.timeout(20_000)`。成功（HTTP < 400）→ 写配置收尾；失败 → 分类报错 + 重试确认。

**失败按三类报错**（`classifyProbeError` → `REASON`）：

| 判定 | 条件 | 文案 | 重试回到的步骤（`retryStepFor`） |
|------|------|------|------|
| `key` | HTTP 401/403 | API key 无效（401/403） | key 输入 |
| `model` | HTTP 404，或 400 且报文含 "model" | 模型名不对（404/400） | model 输入 |
| `network` | 请求根本没到达（status 为 null） | 连不上服务端（网络或 baseUrl 不通） | 模板选择（custom 的 baseUrl 并入这步） |
| `unknown` | 其余 | 未知错误 | 模板选择 |

"重试？→ 是"回到上表对应的步骤，"否"或取消 → `已退出，未做任何修改`，返回 `"aborted"`。

**成功收尾**：`loadConfig` 读旧配置 → `saveConfig` 合并写入 `{providers: {default: tpl.id, entries: {...旧, [tpl.id]: entry}}}`（其余配置原样保留）→ `chmodSync(paths.config, 0o600)` → `已写入 config.yaml，开始对话`，返回 `"configured"`，`chatAction` 继续进入 REPL。

## kclaw web（packages/cli/src/web-cmd.ts）

```ts
export function buildWebUrl(port: number, token: string): string
// "http://127.0.0.1:<port>/?token=<encodeURIComponent(token)>"

export function openCommandFor(platform: NodeJS.Platform): "open" | "xdg-open" | null
// darwin → "open"；linux → "xdg-open"；其余（含 win32）→ null

export async function webAction(home: string): Promise<void>
```

`webAction` 四步：

1. `ensureDaemon(home)` 确保 daemon 在运行（不在则启动，打印 `daemon started`）。
2. 读 `<home>/token`。
3. `buildWebUrl(info.port, token)` 构造 URL（token 经 URL 编码，含保留字符也能完整保留于查询参数）。
4. 有浏览器命令（macOS/Linux）→ `spawn(cmd, [url], {detached: true, stdio: "ignore"}).unref()` 脱离启动（CLI 不等浏览器、浏览器寿命独立于 CLI），打印 `opening <不带 token 的 URL> in your browser`；没有命令 → 直接打印 `open <完整 URL>` 让用户手动打开。

浏览器侧的接收：WebUI 启动时把 `?token=` 存进 localStorage 并从地址栏清除（`bootstrapToken`，见 [webui](../web/webui.md)）。

## Node >= 22 版本检查（packages/cli/src/index.ts)

`invokedAsMain`（作为入口执行）时，在 `program.parseAsync` **之前**检查：

```ts
const [major] = process.versions.node.split(".").map(Number)
if (major < 22) {
  console.error(`kclaw requires Node >= 22 (you are on ${process.versions.node})`)
  process.exit(1)
}
```

放在解析前的目的是让旧版本运行时在报出难懂的语法/API 错误之前就得到一行明确的提示。库引用（`import "@kclaw/cli"`）不经过这段。

## 边界与出错

- **向导不修改 config.yaml 之外的任何文件**：中途任何取消点都返回 `"aborted"` 且无文件写入。
- **非交互终端没有向导**：只打印一行指引，面向脚本/CI 场景（脚本/CI 场景不应出现交互式提问）。
- **连通测试超时 20s**：`AbortSignal.timeout` 中止请求，status 记为 null → 按 network 类报错。
- **`kclaw web` 无浏览器命令的平台**：Windows 等 `openCommandFor` 返回 null 的平台退化为打印 URL（token 完整可见，用户自行打开）。
- **token 文件缺失**：`ensureDaemon` 启动的 launch 会创建 `<home>/token`，所以 `webAction` 读它时必然存在；daemon 已在运行时该文件同样存在（token 跨重启复用，见 [daemon](../server/daemon.md)）。

## 关联

- [cli](./cli.md)：向导之后的 REPL、命令树全貌
- [provider](../core/provider.md)：配置写入后 daemon 如何用它构造 LLM 客户端
- [daemon](../server/daemon.md)：`ensureDaemon` 的探测/启动细节、token 的生成与复用
- [webui](../web/webui.md)：`?token=` 握手在浏览器侧的接收
