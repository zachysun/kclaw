# CLI — 命令、REPL 与 slash 命令

## 职责

`packages/cli` 是 daemon 的终端客户端。`src/index.ts` 用 commander 组命令树并做入口分发；`src/chat.ts` 的 `runChat` 是交互式对话 REPL（REPL：read-eval-print loop，逐行读取输入、处理、打印结果、再等待下一行的交互循环）；`src/slash.ts` 是 REPL 内 `/` 命令的注册表机制；`src/client.ts` 的 `KclawClient` 封装对 daemon 的 HTTP 与 WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）两种调用。首次运行判定、配置向导与 `kclaw web` 见 [onboarding](./onboarding.md)。CLI 不持有业务状态，随时退出，daemon 不受影响。

## 设计决策

- **`kclaw` 不带子命令即 chat**：不指定子命令时默认动作即 `chatAction`。chat 的选项（`--session`/`--think`/隐藏的 `--yes`/`--no`）挂在 program 层而非 `chat` 子命令上，`optsWithGlobals` 会把 program 选项合并进子命令的选项里，因此 `kclaw --session X` 与 `kclaw chat --session X` 都能解析到。
- **`--yes`/`--no` 是隐藏选项**：供测试与脚本自动应答确认卡片使用（`new Option(...).hideHelp()`），帮助中不出现；人机交互使用 @clack 确认框。
- **所有 action 走同一个 `run()` 包装**（`src/index.ts`）：从合并选项解析 `--home` 传给实现，任何抛错统一转为 stderr 一行 + 退出码 1——命令实现中不出现 `process.exit`。
- **argv 只在作为入口时解析**：`invokedAsMain` 用 `realpathSync(process.argv[1])` 与 `import.meta.url` 比较（与 ESM 加载器一致的符号链接解析），所以 `import "@kclaw/cli"` 当库引用没有副作用；`KclawClient` 与 `runChat` 同时作为库导出。
- **连接即自动启动 daemon**：`KclawClient.connect` 读 `<home>/daemon.json`、探活 `/health`，不健康就先 `ensureDaemon` 再重读——任何命令在冷机器上直接可用，用户不需要先知道 daemon 的存在。
- **Node >= 22 是启动门槛**：解析 argv 之前检查 `process.versions.node` 主版本，不满足则打印一行错误并 `process.exit(1)`，避免旧运行时报出难懂的语法/API 错误（详见 [onboarding](./onboarding.md)）。
- **表格输出零依赖**：`jobs list` 的表格是纯字符串对齐（`renderJobsTable`：按列宽 `padEnd`，两空格列间隔），不引入表格库；列头同时充当空列表时的输出。
- **颜色只在 TTY 下生效**（TTY：终端这类交互式字符设备）：`dim`/`red` 输出 ANSI 转义序列（终端控制字符，用于改颜色/亮度），管道/重定向时输出纯文本，保证脚本经管道消费到纯文本。

## 命令表（packages/cli/src/index.ts）

| 命令 | 行为 |
|------|------|
| `kclaw`（默认动作）/ `kclaw chat` | 进入 chat REPL（首次运行先执行 provider 判定与向导，见 [onboarding](./onboarding.md)） |
| `kclaw --session <id>` | 恢复指定会话；列表中查不到该 id 时报 "session not found" |
| `kclaw --think` | REPL 显示 thinking 增量（暗色 `· ` 前缀，默认隐藏） |
| `kclaw daemon start` | 确保 daemon 在运行（不在则启动），打印 pid 与端口；已在运行则打印 "daemon already running" |
| `kclaw daemon stop` | 发 SIGTERM 终止 daemon，轮询至 `/health` 不可访问后删除 `daemon.json`；返回 "stopped" 或 "daemon not running" |
| `kclaw daemon status` / `kclaw status` | 报告状态：`not running`，或 `running (pid <pid>, port <port>, uptime <n>s)` |
| `kclaw jobs list` | 列定时任务（连接过程中自动启动 daemon），五列表格：name/cron/enabled/nextRunAt/lastStatus |
| `kclaw web` | 浏览器打开 WebUI（见 [onboarding](./onboarding.md)） |

程序级选项：`--home <dir>`（默认 `KCLAW_HOME ?? ~/.kclaw`）；`--version` 从 `packages/cli/package.json` 运行时读取。

## 接口

```ts
// packages/cli/src/client.ts
export class KclawClient {
  readonly base: string   // 如 "http://127.0.0.1:52143"（daemon 只绑回环地址）
  readonly token: string  // <home>/token 的 Bearer token
  static connect(home?: string): Promise<KclawClient>
  // 连接（必要时先启动）daemon；失败重探 5s（CONNECT_RETRY_MS，250ms 间隔）
  request(method: string, path: string, body?: unknown): Promise<unknown>
  // HTTP 请求；非 2xx 抛服务端 body.error（无则 "HTTP <status>"）；204/空响应返回 undefined
  ws(): Promise<WsHandle>
  // 打开已认证 WS：首帧发送 {type:"auth", token}；frames 是解析好的异步帧迭代器
}

// packages/cli/src/chat.ts
export interface ChatOptions {
  home?: string        // 传给 KclawClient.connect
  session?: string     // 恢复指定会话；未知 id 报错
  showThinking?: boolean  // 显示 thinking 增量（暗色）
  yes?: boolean        // 隐藏 --yes：自动允许所有确认
  no?: boolean         // 隐藏 --no：自动拒绝所有确认
}
export async function runChat(opts: ChatOptions = {}): Promise<void>
```

```ts
// packages/cli/src/slash.ts
export interface SlashCtx {
  client: KclawClient
  sessionId: string                 // getter：重连/切会话后总是当前值
  switchSession(id: string): Promise<void>
  exit(): void                      // 保留给未来命令；当前 /exit 由输入循环处理
  print(text: string): void
  pauseInput(): void                // 暂停 readline，让 @clack 接管终端
  resumeInput(): void
}
export interface SlashCommand {
  name: string
  usage: string
  description: string
  run(args: string, ctx: SlashCtx): Promise<void>
}
export function dispatch(input: string, _registry: Map<string, SlashCommand>): { command: string; args: string } | null
export async function runOrHint(parsed, registry, ctx): Promise<boolean>
export function createRegistry(ctx: SlashCtx): Map<string, SlashCommand>
```

## REPL 核心流程（packages/cli/src/chat.ts）

一行输入的生命周期：

1. **建连**：`KclawClient.connect` → `resolveSessionId`（无 `--session` 时 `POST /sessions {workdir: cwd}` 新建，否则在 `GET /sessions` 里校验存在）→ `openSubscribed`：开 WS、发 `{type:"subscribe", sessionId}`、等 `subscribed` 确认（5s 内没等到，或收到 error 帧，直接报错关闭）。
2. **读行**：`node:readline` 逐行读（刻意不用 @clack 的文本框：增量需直接 `process.stdout.write`，管道 stdin 也需逐行工作）。每行先过 `dispatch`：`/` 开头是命令，其余是普通消息。
3. **发送与渲染**（`renderRun`）：发 `{type:"send_message", sessionId, text}`，然后按帧渲染直到 run 终态：
   - `text.delta` 原样写出（自带换行控制：`ensureLineStart` 保证块之间换行）；`thinking.delta` 仅 `--think` 时暗色输出。
   - `tool_call.completed` → `⚡ <name> <args>`，args 是紧凑 JSON、截断到 60 字符。
   - `tool_result.completed` → `↳ <status> (<n>ms) <output>`，输出压空白后取前 80 字符；`tool_result.delta` 不做实时渲染（completed 行已带摘要）。
   - `confirmation.requested` → `⚠ <name> <argsJson> · 风险 <risk> · 过期 <expiresAt>`，按 yes/no/ask 三种模式收决定（ask 时暂停 readline、@clack 出确认框、恢复 readline），回发 `{type:"confirmation.resolve", confirmationId, approved}`。
   - `note.emitted` → 暗色 `[note] <text>`；`message.created/completed` 刻意不渲染（readline 已回显用户输入，再渲染会重复）。
   - `run.completed`/`run.failed`/error 帧 → 结束本轮等待。
4. **Ctrl+C**（readline 在待输行为空时把 Ctrl+C 转成 `"SIGINT"` 事件）：第一次在 run 进行中 → 发 `{type:"run.cancel"}`（run 随后经正常渲染路径以 `stopReason:"aborted"` 结束）；第一次空闲 → 只打印退出提示；第二次 → 关闭 socket、关闭 readline、`process.exit(130)`。

### 空闲重连与消息重发

- **重连**（`reconnect`）：socket 意外关闭时重新 `KclawClient.connect`（daemon 已终止时重新启动一个）、重新订阅、`GET /sessions/:id/messages` 全量拉取一次进行对齐（不重放渲染），打印 `[reconnected]`；重连失败打印 `[连接断开，重连失败 — 输入 /exit 退出]` 并放弃。
- **重发规则**：一条发送中的消息只有当**一帧都没观察到**（连 `send_message_ack` 都没有）才会在重连后重发——零帧说明消息从未到达存活的 daemon（ws 库对已关闭的 socket 静默丢帧、只在连接中才同步抛错，两者都等价于"未送达"）。观察到任何一帧即视为已送达，中途断线绝不重发：run 可能已在服务端排队，重发会导致同一消息被执行两次。
- **120s 静默看门狗**：重连后观察到的帧带 `POST_RECONNECT_SILENCE_MS = 120_000` 的不活动超时——daemon 已终止的 run 永远不会完成，REPL 不可无限等待；超时打印提示后回到提示符。重连前的等待不加人为上限（`nextFrame` 对非有限超时直接跳过竞速：node 会把 `setTimeout(fn, Infinity)` 钳到 1ms，反而会截断仍在运行的 run）。

## slash 命令机制（packages/cli/src/slash.ts）

- 注册表是 `createRegistry(ctx)` 返回的 `Map<string, SlashCommand>`；解析（`dispatch`）与查表执行（`runOrHint`）分离，未注册的命令打印一行 `没有这个命令，/help 看看`（miss 路径可单测）。
- `/exit` **刻意不注册**：它是 `chat.ts` 输入循环的控制流（`parsed.command === "exit"` 直接 break），不经过注册表。
- 内置命令：

| 命令 | 行为 |
|------|------|
| `/help` | 遍历注册表，逐条打印 `name usage — description` |
| `/new [标题]` | `POST /sessions`（带可选 title，body 总带 workdir=当前 cwd）→ `switchSession` → 打印确认 |
| `/clear` | 同 `/new` 但不带标题（快速新建一个空白会话） |
| `/sessions` | `GET /sessions` 列表；空则"（还没有会话）"；否则暂停 readline、@clack 单选列表、切换会话 |

- `switchSession` 在**同一 socket** 上发 `unsubscribe`（旧会话）+ `subscribe`（新会话）；`SlashCtx` 的 `client`/`sessionId` 是 getter，命令执行时看到的总是重连/切换后的当前值。

## 边界与出错

- **订阅确认失败即失败**：`openSubscribed` 5s（`SUBSCRIBE_ACK_MS`）等不到 `subscribed` 或收到 error 帧即抛错并关闭 socket，不会把消息发送到总线尚未分发的连接上。
- **确认应答发送失败被忽略**：`confirmation.resolve` 发送抛错只忽略（socket 正在断开），交给重连路径接管。
- **管道 stdin 的 EOF**：stdin 关闭时 readline 触发 close，循环自然退出；`rlClosed` 标志让迟到的 `prompt()` 变成空操作而不是抛 "readline was closed"（缓冲行仍会经异步迭代器到达）。
- **重连后不回放**：重连只拉取全量对齐数据但不渲染，错过的事件不再补偿；持久化消息自洽，下次进入 REPL 重新拉取全量即可（协议规则见 [protocol](../core/protocol.md)）。
- **jobs 表格无分页**：`GET /jobs` 全量返回，任务多时表格整体打印。

## 关联

- [onboarding](./onboarding.md)：首次运行判定、配置向导、`kclaw web`、Node 版本检查
- [daemon](../server/daemon.md)：daemon 探测/启动/停止的另一侧契约（`daemon-ctl.ts` 详解）
- [realtime](../server/realtime.md)：`/ws` 帧协议与订阅语义、断线恢复规则总述
- [run-manager](../server/run-manager.md)：`send_message`/`run.cancel`/确认在服务端的后续
