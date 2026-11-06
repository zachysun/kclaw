# CLI — 命令、REPL 与 slash 命令

## 职责

`packages/cli` 是 daemon 的终端客户端。`src/index.ts` 用 commander 组命令树并做入口分发；`src/chat.ts` 的 `runChat` 是交互式对话 REPL（REPL：read-eval-print loop，逐行读取输入、处理、打印结果、再等待下一行的交互循环），它持有全部编排逻辑（建连、订阅、帧泵、重连、slash 注册表、Ctrl+C 升级），把「显示与收键」交给两个终端表面：`src/tui/` 是 ink TUI（stdin 与 stdout 都是终端时，流式追加历史 + 动态区 + 常驻输入框），`src/chat-readline.ts` 是 readline 表面（其余情况，例如 `echo hi | kclaw chat`），两者的公共接口在 `src/chat-surface.ts`；`src/run-cmd.ts` 是一次性的 `kclaw run`（提示词进、本次 run 的输出出、按结局给出退出码，供脚本与 CI 调用），由 `src/run-input.ts`（stdin 的四种状态）、`src/run-lifecycle.ts`（判定哪些帧属于本次 run、何时结束、怎样只停止自己的那一次）与 `src/run-output.ts`（三种输出格式）组成；`src/frame-view.ts` 把每种 daemon 帧归类为一种显示内容，chat 的两个表面与 run 各自按这份归类输出；`src/color.ts` 统一判定是否输出颜色；`src/slash.ts` 是 REPL 内 `/` 命令的注册表机制（含 `<home>/commands/*.md` 的自定义命令加载与"已装技能即斜杠命令"的动态注册）；`src/client.ts` 的 `KclawClient` 封装对 daemon 的 HTTP 与 WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）两种调用。首次运行判定、配置 wizard 与 `kclaw web` 见 [onboarding](./onboarding.md)。消息里的 `@路径` 引用由 daemon 统一处理（见 [file-mentions](../core/file-mentions.md)），CLI 只发送原文。CLI 不持有业务状态，随时退出，daemon 不受影响。

## 设计决策

- **`kclaw` 不带子命令即 chat**：不指定子命令时默认动作即 `chatAction`。`--session`/`--think`/`--yes`/`--no` 注册在 program 层（chat 与 run 共用），`optsWithGlobals` 会把 program 选项合并进子命令的选项里，因此 `kclaw --session X`、`kclaw chat --session X` 与 `kclaw run --session X` 都能解析到。子命令再定义同名选项的话，值会先被 program 层接走，所以 run 不重复定义这四个，`kclaw run --help` 经 `showGlobalOptions` 一并列出。
- **`--yes`/`--no` 自动应答确认卡片**：chat 里供测试与脚本使用；ask 模式下确认卡由当前表面呈现（ink TUI 是同树的 ink 卡片，readline 表面是 @clack 确认框）；run 无人值守，两者都不给时一律拒绝（见下文 [kclaw run](#kclaw-runpackagesclisrcrun-cmdts)）。
- **action 统一包装**（`src/index.ts` 的 `run()`）：从合并选项解析 `--home` 传给实现，任何抛出的错误统一转为 stderr 一行 + 退出码 1。`kclaw run` 自己把每种结局换算成退出码（用法错误为 2），只有第二次收到信号时直接 `process.exit`。commander 的解析错误经 `exitOverride` 一律以退出码 2 退出，显示帮助与版本仍为 0。
- **argv 只在作为入口时解析**：`invokedAsMain` 用 `realpathSync(process.argv[1])` 与 `import.meta.url` 比较（与 ESM 加载器一致的符号链接解析），所以 `import "@kclaw/cli"` 当库引用没有副作用；`KclawClient` 作为库导出。chat、配置向导与 ink TUI 用动态 import 延迟加载：它们加载 @clack/prompts（用 picocolors 上色）或 ink（自带 chalk），颜色库在加载那一刻决定是否输出颜色，必须等颜色模块把结论写进环境变量之后再加载（见下文颜色一条）。管道 chat（stdin 或 stdout 不是终端）不加载 ink/react，启动路径不为 TUI 付出加载成本。
- **连接即自动启动 daemon**：`KclawClient.connect` 读 `<home>/daemon.json`、探活 `/health`，不健康就先 `ensureDaemon` 再重读——任何命令在冷机器上直接可用，用户不需要先知道 daemon 的存在。
- **Node >= 22 是启动门槛**：解析 argv 之前检查 `process.versions.node` 主版本，不满足则打印一行错误并 `process.exit(1)`，避免旧运行时报出难懂的语法/API 错误（详见 [onboarding](./onboarding.md)）。
- **表格按显示宽度对齐**：`cron list` 的表格是纯字符串对齐（`renderCronTable`：按列宽 `padEnd`，两空格列间隔），列头同时充当空列表时的输出。`session list` 的标题多为中文，一个汉字在终端里占两列，按字符个数补空格会让后面的列错位，所以用 `src/text-width.ts`（string-width 计算终端显示宽度）对齐。
- **运行中发送不阻塞输入行，处置随每条发送显式附带**：发送与渲染由常驻帧泵（`startPump`，一个持续读取 socket 帧并分发给当前渲染的后台循环）接管，每次 `startRender` 递增渲染代际、旧渲染静默停止，run 中途照样能继续输入（`/interrupt`、忙时直发都依赖它）。每条 `send_message` 显式带 `disposition`（当前会话处置模式），模式由 `/steer`/`/wait` 切换、存会话级覆盖（与 Web 三选同源）；`interrupt` 是一次性动作，不做成模式（做成模式有"切了忘改回、接连中断 run"的误伤风险）。
- **帧的归类只写一处**：`src/frame-view.ts` 用一个覆盖全部事件类型的 switch 把帧归类为显示内容（文本增量、工具调用行、确认卡、系统行等），新增的核心事件类型没有归类时编译直接失败；chat 与 run 各自决定每类内容怎样输出，系统行等文案只在这里定义一次。
- **颜色统一由 `src/color.ts` 判定**（TTY：终端这类交互式字符设备）：`kclaw run --color always|never` 直接决定；auto 时要求 stdout 是 TTY、`NO_COLOR` 未设置或为空、`TERM` 不是 `dumb`，chat 固定按 auto 判定。结论驱动 `dim`/`red`（输出 ANSI 转义序列：终端控制字符，用于改颜色与亮度），也写进第三方颜色库读取的环境变量：picocolors（@clack 使用）读 `NO_COLOR`，chalk 不读 `NO_COLOR`、只认 `FORCE_COLOR`，而且两者在命令行参数里看到 `--color` 就强制输出颜色（`--color never` 反被当成开启）。所以关闭颜色时写入 `NO_COLOR=1` 与 `FORCE_COLOR=0`，`always` 时清除 `NO_COLOR` 并写入 `FORCE_COLOR=1`，auto 判定为开启时不改动（保留库自己对颜色深度的判断）。这些设置只作用于 CLI 进程：启动 daemon 时传入修改前的环境变量（`originalEnv()`），daemon 及其工具子进程不受影响。聚合包打包时开启代码拆分，动态 import 的模块在发布产物里同样按需加载，这个先后顺序依然成立。

## 命令表（packages/cli/src/index.ts）

| 命令 | 行为 |
|------|------|
| `kclaw`（默认动作）/ `kclaw chat` | 进入 chat REPL（daemon 报告尚未配置 provider 时先进入配置 wizard，见 [onboarding](./onboarding.md)） |
| `kclaw run [prompt...]` | 一次性运行：发送提示词，把本次 run 的输出写到 stdout，按结局给出退出码（见下文 [kclaw run](#kclaw-runpackagesclisrcrun-cmdts)） |
| `kclaw --session <id>` | 恢复指定会话；列表中查不到该 id 时报 "session not found" |
| `kclaw --think` | REPL 显示 thinking 增量（暗色 `· ` 前缀，默认隐藏） |
| `kclaw daemon start` | 确保 daemon 在运行（不在则启动），打印 pid 与端口；已在运行则打印 "daemon already running" |
| `kclaw daemon stop` | 发 SIGTERM 终止 daemon，轮询至 `/health` 不可访问后删除 `daemon.json`；返回 "stopped" 或 "daemon not running" |
| `kclaw daemon status` / `kclaw status` | 报告状态：`not running`，或 `running (pid <pid>, port <port>, v<版本>, uptime <n>s)`；daemon 报出的版本与 CLI 自身不一致时追加一行提示（两者不是同一次构建的产物，重新 `pnpm build` 并重启 daemon） |
| `kclaw cron list` | 列定时任务（连接过程中自动启动 daemon），五列表格：name/cron/enabled/nextRunAt/lastStatus |
| `kclaw mcp [list]` | 经 `GET /mcp` 按组打印 MCP server：每组先一行组头 `【全局】` 或 `【<工作目录路径>】`，组内每行 `  <名字>  <状态>  <N> 个工具[ 错误: <lastError>]`（状态为原始枚举串）；空配置打印 "未配置 MCP server（全局 mcp.json 与各项目 .kclaw/mcp.json 均为空）" |
| `kclaw web` | 浏览器打开 WebUI（见 [onboarding](./onboarding.md)） |
| `kclaw session list [--json]` | 列出会话（`GET /sessions`：最近更新在前，排除 subagent 子会话与已删除的会话）。默认是四列表格 id/title/workdir/updatedAt（时间为本地时区 `YYYY-MM-DD HH:mm`），按显示宽度对齐；标题由模型生成，属于不可信文本，标题与工作目录里的控制字符先替换成空格再输出，避免转义序列进入终端。`--json` 原样输出接口返回的数组。没有会话时打印一行提示，退出码 0 |
| `kclaw session verify --id <id>` / `kclaw session verify --all` | 校验会话事件流的哈希链（机制见 [storage](../core/storage.md) 的「事件流哈希链」）：对每个会话调 `GET /sessions/:id/verify`，`--all` 遍历 `GET /sessions` 返回的全部会话。每会话打印一行结论：`✓ <id>  链完整（N 条）`、`✓ <id>  前 K 条无链（功能上线前写入），自第 M 条起链完整（N 条）`、`· <id>  未起链（功能上线前写入的会话）`、`· <id>  末行不完整（崩溃痕迹，下次追加自动修复）`、`✗ <id>  <原因>（断裂位置：第 X 行）`。退出码：没有任何会话断裂为 0，任一会话断裂为 1；两个选项都不给时把用法打到 stderr、退出码 2 |

程序级选项：`--home <dir>`（默认 `KCLAW_HOME ?? ~/.kclaw`）；`--session <id>`、`--think`、`--yes`、`--no`（chat 与 run 共用）；`--version` 运行时从所在包的 package.json 读取（聚合安装形态即聚合包版本）。

## kclaw run（packages/cli/src/run-cmd.ts）

一次性运行：一条提示词、一次 run、一个退出码，供脚本与 CI 调用。

### 选项

- `[prompt...]`：提示词，多个参数用空格连接。
- `--session <id>` / `--continue` / `--fork <id>`：选择会话，三者只能给一个；都不给时新建会话（`POST /sessions {workdir}`）。`--session` 的 id 必须出现在 `GET /sessions` 里；`--continue` 取工作目录与本次相同、最近更新的会话；`--fork` 调 `POST /sessions/:id/fork` 复制整段会话，本次在新会话上执行，之后的 `--model`、`--mode`、`--attach` 都作用在新会话上。
- `--cwd <dir>`：本次运行的工作目录，默认为进程当前目录。按真实路径（解析符号链接后）参与新建会话的 workdir 与 `--continue` 的匹配；`--session`、`--fork` 使用已有会话自己的工作目录，与 `--cwd` 同时给出属于用法错误。
- `--attach <file>`：附加文件，可重复给出。相对路径按进程当前目录解析（不受 `--cwd` 影响），发送前检查文件存在、是普通文件、非空且不超过 20MB，再经 `POST /sessions/:id/attachments` 上传。
- `--model <name>` / `--mode <mode>`：写进会话元数据，与 chat 的 `/model`、`/mode` 相同，此后这个会话的每次 run 都生效。`--model` 的值是 provider 条目名，新建会话之前先对照 `GET /providers` 检查，不存在时直接以用法错误退出，不会留下一个空会话。
- `--output-format text|json|stream-json`（默认 text）；`--color auto|always|never`（默认 auto）。
- `--yes` / `--no`：确认卡片自动允许（仅本次）或自动拒绝。两者都不给时一律拒绝，第一张确认卡出现时 stderr 警告一行「未指定 --yes：本次运行确认一律拒绝」。问题卡（ask_user_questions）对每道题回答「（无人值守运行，没有人可以回答，请自行判断后继续）」，同样只警告一次。工具能做什么由 `--mode` 与 `--yes`/`--no` 两个选项完全决定。

### stdin 的四种状态（packages/cli/src/run-input.ts）

| stdin | 参数 | 提示词 | 管道内容 |
|------|------|------|------|
| 终端 | 有提示词 | 参数 | 不读取 stdin |
| 终端 | 没有 | 无 | 打印用法，退出码 2 |
| 管道 | 有提示词 | 参数 | 作为附件 `stdin.txt` 上传（含 NUL 字节时按二进制处理，为 `stdin.bin`）；空管道不上传 |
| 管道 | 没有，或只有 `-` | 整个管道内容 | 无 |

管道内容作为附件发送、消息文本只含参数，原因有两个：daemon 只在消息文本里识别 `@路径` 与 `/技能名`，日志或代码里的 `@Component`、`/deploy` 不会被当成文件引用或技能调用；大段内容也不会进入上下文窗口和会话历史——64 KiB 以内的文本附件把内容直接交给模型（超过 8192 字符截断，并在标记里给出附件路径），更大的只给路径，由模型用 fs_read 读取。上限：作为提示词 10 MiB，作为附件 20MB，超出时退出码 2。stdin 是管道但永远不会结束时（例如在 `while read` 循环里调用 `kclaw run`，stdin 继承了循环的输入），run 会一直等待读完：给这次调用显式接上 `< /dev/null`。

### 执行与结束（packages/cli/src/run-lifecycle.ts）

- 发送时显式带 `disposition: "wait"`：会话正在运行时（WebUI 有人在用、定时任务正在执行），本次提示词排在当前 run 之后单独执行，不注入、不打断别人的 run。
- 判定哪些帧属于本次：`send_message_ack` 给出自己的 messageId；`message.created` 的消息 id 与它相同时，事件带的 runId 就是本次 run 的 id，只有 runId 相同的 `run.completed`/`run.failed` 才结束本次。自己的消息开始执行之前到达的帧都属于排在前面的 run，不输出，其中的卡片也不回答；开始执行之后到达的卡片一律按 `--yes`/`--no` 处置，包括 subagent 转发来的卡片（它们带的是子 run 的 runId）。
- 没有 run 的结局有两种：条目级失败（`run.failed{code:"queue_entry_failed"}` 不带 runId，按 `payload.messageId` 认领）；排队期间被其他客户端撤回（WebUI 取消排队、IM 的 `/stop`、会话被删除，`message.queue_cancelled` 的 `messageId` 或 `messageIds` 含自己的消息）。
- 连接断开直接失败退出，不重连也不重发：chat 的重连是为了不让人丢掉会话，脚本由调用方决定是否重试。

### 输出格式（packages/cli/src/run-output.ts）

- **text**：与管道模式的 chat 同一套行格式（⚡/↳ 摘要行、暗色系统行），确认卡与问题卡下方附一行自动处置结论；失败原因只写 stderr。
- **json**：结束后输出一个紧凑 JSON 对象 `{ sessionId, messageId, text, stopReason, usage, durationMs }`。text 取本次最后一条助手消息的文本（中间轮次的叙述不计入）；stopReason 与 usage 取自 `run.completed`，没有收到时省略；durationMs 是客户端从发送到结束的实测值。退出码为 1 时同样输出这个对象并附 `error: { code, message }`，会话建立之前就失败时省略 sessionId 与 messageId。用法错误（退出码 2）只写 stderr，不输出对象。
- **stream-json**：`send_message` 的回复，以及从自己的消息开始执行到本次结束之间的全部事件帧，按到达顺序逐行原样输出（NDJSON：每行一个 JSON）。

json 两种格式在任何情况下都不输出颜色。

`error.code` 的取值：停止原因（`aborted`/`max_tokens`/`content_filter`）、`run.failed` 自带的 code（如 `llm_error`、`queue_entry_failed`）、`rejected`（daemon 拒绝这条消息）、`withdrawn`（排队中被撤回）、`disconnected`（连接断开）、`interrupted`（收到信号）、`provider_not_configured`、`session_not_found`、`no_session_to_continue`、`fork_failed`、`upload_failed`、`daemon_unavailable`（连不上 daemon 或订阅失败）、`daemon_request_failed`（其余接口请求失败）。

### 退出码

| 退出码 | 情形 |
|------|------|
| 0 | `run.completed` 且停止原因为 `end_turn`、`stop_sequence` 或 `tool_use` |
| 1 | 停止原因为 `aborted`（被其他客户端停止，如在 WebUI 点了停止）、`max_tokens`（最后一条回复被输出上限截断）或 `content_filter`（被模型服务商拦截），stderr 写明原因；`run.failed`；daemon 拒绝这条消息；排队中被撤回；连不上 daemon 或连接断开；provider 未配置；`--session` 查无、`--continue` 无匹配、`--fork` 失败；附件上传失败 |
| 2 | 用法错误：选项组合非法（`--session`/`--continue`/`--fork` 同时给出两个以上、`--yes` 与 `--no` 同时给出、`--cwd` 与 `--session`/`--fork` 同时给出）、`-` 后面还有参数、stdin 是终端且没有提示词、提示词为空、选项值不在可选范围、`--cwd` 不是已存在的目录、附件不存在或超限、stdin 超限、`--model` 不是已有的 provider 条目、`--model`/`--mode` 被 daemon 以 400 拒绝；commander 的解析错误 |
| 130 / 143 / 129 | 收到 SIGINT（Ctrl+C）/ SIGTERM / SIGHUP |
| 141 | stdout 的下游管道已关闭（写入得到 EPIPE，例如 `kclaw run … \| head -1`） |

### 信号

收到 SIGINT、SIGTERM、SIGHUP 或 EPIPE 时只停止自己的那一次：消息还在排队时发 `queue.cancel{messageId}` 撤回，没有 run 执行；已经开始执行，或撤回时恰好出队开始执行（daemon 回复 `not found`）时，发 `run.cancel{messageId}`——daemon 只在活动 run 执行的正是这条消息时才中止，取消请求到达时自己的 run 已经结束的话，排在后面的别人的 run 不受影响。回执到达之前收到信号时先记下，回执到达后再按上面处理。等到结束帧、照常输出已积累的内容后，按信号对应的退出码退出，结局本身是什么都不影响退出码；EPIPE 之后不再写 stdout。第二次收到信号立即退出。daemon 不会因为客户端断开而停止 run，SIGKILL 又无法捕获：`kclaw run` 被 SIGKILL 结束时，daemon 里的 run 会继续执行到结束。

## 接口

```ts
// packages/cli/src/client.ts
export class KclawClient {
  readonly base: string   // 如 "http://127.0.0.1:52143"（daemon 只绑回环地址）
  readonly token: string  // <home>/token 的 Bearer token
  static connect(home?: string): Promise<KclawClient>
  // 连接（必要时先启动）daemon；失败重探 5s（CONNECT_RETRY_MS，250ms 间隔）
  request(method: string, path: string, body?: unknown): Promise<unknown>
  // HTTP 请求（经 @kclaw/core/client-http 共享模块，见 [client-http](../core/client-http.md)）；
  // 非 2xx 抛服务端 body.error（无则 "HTTP <status>"）；204/空响应返回 undefined
  uploadAttachment(sessionId, filename, body, mimeType): Promise<{file: {path, name, size}}>
  // 原始字节流 POST /sessions/:id/attachments?filename=…（附件上传，见 /attach 与下文 REPL 流程；
  // 同样经 @kclaw/core/client-http 的 contentType 原样透传）
  ws(): Promise<WsHandle>
  // 打开已认证 WS：首帧发送 {type:"auth", token}；frames 是解析好的异步帧迭代器
}
export function openSubscribed(client: KclawClient, sessionId: string): Promise<WsHandle>
// 开 WS 并订阅会话，等到 subscribed 回执才返回（chat 与 run 共用，见下文边界与出错）

// packages/cli/src/chat.ts
export interface ChatOptions {
  home?: string        // 传给 KclawClient.connect
  session?: string     // 恢复指定会话；未知 id 报错
  showThinking?: boolean  // 显示 thinking 增量（暗色）
  yes?: boolean        // --yes：自动允许所有确认
  no?: boolean         // --no：自动拒绝所有确认
}
export async function runChat(opts: ChatOptions = {}): Promise<void>

// packages/cli/src/run-cmd.ts
export async function runCommand(opts: RunCommandOptions, io: { help(): string }): Promise<number>
// 执行一次 kclaw run，返回退出码；用法错误时 io.help() 提供 run 的用法文本
```

```ts
// packages/cli/src/slash.ts
export interface SlashCtx {
  client: KclawClient
  sessionId: string                 // getter：重连/切会话后总是当前值
  switchSession(id: string): Promise<void>
  exit(): void                      // 保留给未来命令；当前 /exit 由输入循环处理
  print(text: string): void
  choose(message: string, options: ReadonlyArray<{value: string; label: string}>): Promise<string | undefined>
                                    // 单选器（/sessions 的会话选择）：交给当前表面呈现（TUI 菜单 / @clack select），
                                    // 返回 undefined = 用户取消
  pendingAttachments: AttachmentRef[]  // 待发附件队列：随下一条 send_message 发出后清空；
                                       // 切会话时也清空（附件是会话级的）
  send(text: string): void          // 发送普通消息（自定义命令把模板展开成文本走这里）
  setDisposition?(d: "steer" | "wait"): void   // 切换本会话发送处置模式（/steer、/wait 调；POST 成功后才切）
  setMode?(m: "readonly" | "default" | "acceptEdits" | "trusted" | "auto"): void
                                     // 翻转本地权限模式镜像（/mode 与 Shift+Tab 共用；POST /sessions/:id/mode 成功后才调）
  queueCancel(target: string | "all"): Promise<void>  // 发 queue.cancel 帧：messageId 取消单条，"all" 清空全部
  sendInterrupt(text: string): void  // 一次性中断发送：带 interrupt 处置的 send_message（/interrupt 展开成这个）
  queueSnapshot?(): Promise<Array<{ messageId: string; disposition: string; text: string }>>
                                     // 读 GET /queue 的便捷包装（/queue 列表与排队计数用）
  commandsDir?: string              // 自定义命令目录（<home>/commands，*.md）；默认不加载
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

**表面分流**：`runChat` 在建连前判一次 `stdin.isTTY && stdout.isTTY`——两者都是终端时走 ink TUI（`tui/`，ink 要把 stdin 切进 raw mode，管道做不到），否则走 readline 表面。两个表面实现同一对接口（`chat-surface.ts`）：`ChatSurface` 承接编排器的输出（行、确认卡、问题卡、单选器、模式/忙闲变化），`ChatController` 承接输入（提交行、Ctrl+C、Esc 停止、Shift+Tab、补全清单）。帧泵、渲染代际接管、重连、四发送路径终点判定这些帧级逻辑只在编排器里写一份（零改动承诺），表面只做帧的接收与呈现。

一行输入的生命周期：

1. **建连**：`KclawClient.connect` → `resolveSessionId`（无 `--session` 时 `POST /sessions {workdir: cwd}` 新建，否则在 `GET /sessions` 里校验存在）→ `openSubscribed`：开 WS、发 `{type:"subscribe", sessionId}`、等 `subscribed` 确认（5s 内没等到，或收到 error 帧，直接报错关闭）。
2. **收行**：readline 表面由 `node:readline` 逐行读（刻意不用 @clack 的文本框：增量需直接 `process.stdout.write`，管道 stdin 也需逐行工作）；TUI 由 ink 编辑器收键（单行输入 + 方向键移动光标 + ↑↓ 翻输入历史 + Ctrl+R 反向搜索 + 粘贴支持，`?` 在空输入时开快捷键帮助、Ctrl+O 开转录视图）。每行先过 `dispatch`：`/` 开头的按命令处理；普通消息原样发送，其中的 `@路径` 由 daemon 识别并给模型追加读取说明（见 [file-mentions](../core/file-mentions.md)），会话里存的仍是原文。
3. **发送与渲染**（`renderRun`）：发 `{type:"send_message", sessionId, text, disposition, attachments?}`——`disposition` 必带，取当前会话处置模式（`/steer`/`/wait` 切换，或 `/interrupt` 一次性注入；初始值 = 会话覆盖 `dispositionOverride` > 配置 `sessions.defaultDisposition` > steer）。之前用 `/attach` 上传累积的待发附件随这条帧一起发出，发完立即清空附件队列。发送与渲染**不阻塞输入行**：常驻帧泵（`startPump`）读取 socket 帧并分发给当前渲染，每次发送经 `startRender` 递增 `renderEpoch` 接手后续帧流的渲染，旧渲染静默停止，run 中途还能继续输入（`/interrupt` 和忙时发送都依赖它）。按帧渲染直到 run 终态（每种帧归为哪类显示内容由 `frame-view.ts` 决定，与 `kclaw run` 的文本输出共用）：
   - `text.delta` 交表面流式写出（readline 表面自带换行控制：`ensureLineStart` 保证块之间换行；TUI 进动态区，块完成移入历史区）；`thinking.delta` 仅 `--think` 时显示（readline 表面暗色 `· ` 前缀；TUI 折叠成 `✻ 思考 Ns` 一行，`--think` 时展开流式文本）。
   - `tool_call.completed` → readline 表面 `⚡ <name> <args>`，args 是紧凑 JSON、截断到 60 字符；TUI 是 `⏺ <name> <一行摘要>`，摘要按工具名注册（bash 显示命令文本、fs_* 显示目标路径、grep/glob 显示模式、检索类显示关键词，未注册工具回退紧凑 JSON）。
   - `tool_result.completed` → readline 表面 `↳ <status> (<n>ms) <output>`，输出压空白后取前 80 字符；TUI 是缩进在调用行下方的 `⎿ <status> (<n>ms) <摘要>` 完成行（摘要被截断时附暗色"完整输出在转录视图，Ctrl+O"标注），进行中的调用行带 spinner 与计时；`tool_result.delta` 不做实时渲染（completed 行已带摘要，全文在转录视图可达）。
   - `message.queued`（我的消息）→ 暗色 `已排队（第 N 位）`（`position+1`）或 `已进入引导缓冲`（steer 无 position）；`message.steered`（我的消息）→ 暗色 `已注入`——我的消息身份从 `send_message_ack` 的 `messageId` 学到，终点以"我的消息被看到（`message.created`/`message.steered`）之后的第一个 `run.completed`"判定，前一个 run 的终态不会错收我的渲染。
   - `confirmation.requested` → `⚠ <name> <argsJson> · 风险 <risk> · 过期 <expiresAt>`（带 `noteText` 时紧随一行暗色说明，如 bash 沙箱不可用），按 yes/no/ask 三种模式收集决定（ask 时交给表面：readline 表面暂停 readline、@clack 出确认框、恢复 readline；TUI 出同树的 ink 卡片，方向键 + Enter 选择、Esc=拒绝）；ask 是**四项选择**——`允许（仅本次）` / `总是允许（本项目）` / `总是允许（全局）` / `拒绝`（`--yes`/`--no` 分别映射 once/reject；取消同样按拒绝），回发 `{type:"confirmation.resolve", confirmationId, decision}`（不带 `client` 字段 → 服务端记 "cli"）。"总是允许"会把一条收紧后的放行规则写入磁盘，之后同形操作不再询问（见 [permissions](../core/permissions.md) 的"沉淀规则"一节）。
   - `question.requested`（ask_user_questions 工具）→ `❓ N 个问题待回答`（带 `noteText` 时附一行说明，如"来自 subagent X"），每题按选项（方向键 + 回车单选/多选）或自由文本（输入一行）收集，全部答完回发 `{type:"question.resolve", questionId, answers}`（每题一个字符串数组，未回答的题为空数组）。等待期间运行暂停，超时（默认 10 分钟）后工具以"用户未在限时内回答"收场（机制见 [tools](../core/tools.md)）。
   - `note.emitted` → 暗色 `[note] <text>`（记忆注入、cron 来源等系统 note 每条一行）；`message.created/completed` 刻意不渲染（两个表面都已回显用户输入——readline 表面由 readline 自带回显、TUI 把提交行存入历史区，再渲染会重复）。
   - `compaction.started` → 暗色 `[正在压缩早期对话…]` 一行（收尾压缩发生在 `run.completed` 之后、中途/急救压缩发生在运行中的迭代边界，都有这行提示，摘要调用的数秒不是静默空窗）；`compaction.completed` → 按 `result` 三分支：`ok` 打暗色 `✱ 早期对话已压缩为 N 段，保留最近 M 条原文（早期细节可用 session_search 检索）`、`failed` 打暗色 `✱ 压缩失败，本轮继续（稍后自动重试）`、`cancelled` 打暗色 `✱ 压缩已取消`。事件只在真正发生压缩时发一次，天然是"每次压缩一条"的告知，与 WebUI 的折叠块同一去重语义（见 [compaction](../core/compaction.md)）。
   - `memory.written`（广播，不带 sessionId）→ 暗色一行 `已写入记忆: <path>`，提示记忆已写入；它与 run 生命周期无关，只是轻提示（见 [memory](../core/memory.md)）。
   - `hook.failed` → 暗色一行 `⚠ hook <名字> 失败（<位置>[ 装载]）：<原因>`，hook 失败不伤 run，但失败必须可见（机制见 [hooks](../core/hooks.md)）。
   - `run.completed`/`run.failed`/error 帧 → 结束本轮等待。
4. **Ctrl+C 逐级升级**（两个表面都把 Ctrl+C 交给编排器的同一处理：readline 表面在终端 stdin 下是 readline 的 `"SIGINT"` 事件（任意行状态，node 不区分空行与非空行）、管道 stdin 下是进程信号，TUI 是 ink 键盘处理；`sigints` 计数只增不减）：第一次在 run 进行中 → 发 `{type:"run.cancel"}`（run 随后经正常渲染路径以 `stopReason:"aborted"` 结束），并查排队数，非空则提示"还有 N 条排队消息，再按一次 Ctrl+C 清空"；第一次空闲 → 同样查排队数，非空提示清空、为空提示"再按一次 Ctrl+C 退出"；第二次 → 队列非空则发 `{type:"queue.cancel"}` 清空全部可取消条目并提示"队列已清空，再按一次 Ctrl+C 退出"，队列为空直接退出；第三次 → 关闭 socket、关闭表面、`process.exit(130)`（TUI 在退出路径上顺带清除自己写过的终端标题，见下文 TUI 一节）。

### 空闲重连与消息重发

- **重连**（`reconnect`）：socket 意外关闭时重新 `KclawClient.connect`（daemon 已终止时重新启动一个）、重新订阅、`GET /sessions/:id/messages` 全量拉取一次以更新本地状态（不重放渲染），打印 `[reconnected]`；重连失败打印 `[连接断开，重连失败 — 输入 /exit 退出]` 并放弃。
- **重发规则**：一条发送中的消息只有当**一帧都没观察到**（连 `send_message_ack` 都没有）才会在重连后重发——零帧说明消息从未到达存活的 daemon（ws 库对已关闭的 socket 静默丢帧、只在连接中才同步抛出错误，两者都等价于"未送达"）。观察到任何一帧即视为已送达，中途断线绝不重发：run 可能已在服务端排队，重发会导致同一消息被执行两次。
- **120s 静默看门狗**：重连后观察到的帧带 `POST_RECONNECT_SILENCE_MS = 120_000` 的不活动超时，已终止的 run 永远不会完成，REPL 不可无限等待；超时打印提示后回到提示符。重连前的等待不加人为上限（`nextFrame` 对非有限超时直接跳过等待：node 会把 `setTimeout(fn, Infinity)` 钳到 1ms，反而会截断仍在运行的 run）。

### 权限模式：徽章与 Shift+Tab 循环

会话权限模式始终可见：readline 表面的提示符随模式变化——`default` 是裸 `> `；非默认模式前缀徽章 `[readonly] > ` / `[acceptEdits] > ` / `[trusted] > ` / `[auto] > `；TUI 的状态行常驻显示 `[<模式>] 模型 · ↑in ↓out tokens（最近 run）· 会话 <短id>`。run 进行中按下 Shift+Tab 时徽章保持旧值，从下一次 run 起生效。Shift+Tab 按 `PERMISSION_MODES` 顺序（readonly → default → acceptEdits → trusted → auto，严格在前）循环切换：`POST /sessions/:id/mode {mode}` 成功后更新本地镜像与徽章并提示 `权限模式: <模式>（Shift+Tab 继续切换）`，失败静默（徽章保持）。模式在 run 中切换同样落到下一次 run，daemon 的权限 gate 每 run 从会话 meta 读取。

### ink TUI 表面（stdin 与 stdout 都是终端时）

- **画面结构**：已完成内容进 ink `<Static>` 历史区（文本完成块、`⏺/⎿` 工具对、折叠 thinking 行、系统行、输入回显）——只追加不重画，终端原生滚动缓冲与复制保留；动态区承载进行中内容（流式文本、排队灰色常驻行——消息入队出现、离队或清队消失，与 WebUI 排队可视面同一语义、thinking 行、带 spinner 与计时的工具行）；底部是常驻输入框与状态行。
- **输入历史**：数据源是当前会话里用户发过的消息，与 WebUI 读取同一份会话数据——接入会话时从 `GET /sessions/:id/messages` 读一次（只取文本），之后每发送一条追加一条，切换会话按新会话重读；CLI 不另存历史文件。定时任务、/goal 续轮、subagent 与团队投递等机器发出的用户消息都带来源说明块（`PROVENANCE_NOTE_KINDS`，见 [blocks](../reference/blocks.md)），历史把它们全部排除。
- **转录视图（Ctrl+O）**：全屏覆盖层，打开时从 `GET /sessions/:id/messages` 拉全量消息（服务器真相替换实时账本，之后的实时帧继续追加）；thinking 全文、工具完整输出在此可达——历史区的任何截断都有去处。↑↓/j/k 滚动、PgUp/PgDn 翻页、g/G 跳头尾、`{`/`}` 跳上一条/下一条用户消息、q/Esc 关闭。
- **快捷键帮助（?）**：输入为空时按 `?` 打开覆盖层，列出当前全部快捷键；文案与实际键位绑定同源于 `tui/keybindings.ts` 一张表。
- **Esc**：覆盖层开着 → 关闭；run 进行中 → 发 `run.cancel` 并提示（保留已完成输出）；空闲 → 无操作。
- **终端标题**：随运行状态变化（空闲 `kclaw · <会话标题>` / 运行中 `kclaw ▶ 运行中 · …`），切窗口可判忙闲。标题内容含会话名与会话标题（可能含模型输出），写入前先消毒：剔除控制字符、剔除双向与不可见格式码点（Trojan Source 注入族）、空白归一、240 字上限；GNU Screen（`STY` 已设）下整体降级为可打印 ASCII。终端没有可移植的方式读取原标题，kclaw 不读取、不恢复，只在每次退出路径（正常关闭与 Ctrl+C 第三段）清除自己写过的标题。
- **视觉**：色板四档——正文默认色、系统事件暗色、错误红、工具行琥珀（与 WebUI amber 主题呼应）；颜色开关由 `color.ts` 统一判定后经 ink 使用的 chalk 生效，组件不各自判断。状态行与转录视图的滚动按 East Asian Width 显示宽度对齐（`text-width.ts`，与 `session list` 共用）。

## slash 命令机制（packages/cli/src/slash.ts）

- 注册表是 `createRegistry(ctx)` 返回的 `Map<string, SlashCommand>`；命令的名称/用法/描述读自 `@kclaw/core/commands` 的共享清单 `SLASH_COMMANDS`（WebUI 读同一份，保证两端文案不漂移，见 [webui](../web/webui.md)）；解析（`dispatch`，委托 core 的 `parseSlashInput`）与查表执行（`runOrHint`）分离，未注册的命令打印一行 `没有这个命令，/help 看看`（miss 路径可单测）。
- **补全**：两个表面共用同一候选清单与插入函数。readline 表面是 readline 的 completer（`createSlashCompleter`，Tab 触发）——**输入的最后一段空白分隔块**以 `/` 开头且还没打空格时，按共享清单给出前缀候选：内置命令在前、动态注册的技能命令在后（与内置重名的技能命令被共享补全器排除），唯一命中直接补全命令名，多个命中补全公共前缀并列出清单；普通文本、带参数的输入（`/new 标题` 这种已打空格的）、未知前缀都不动作。TUI 的菜单自动弹出：`/` 起头的末段开命令菜单、`@` 起头的末段开文件引用菜单（候选排序与插入沿用 WebUI 输入框同一套 `slashCompletions`/`fileMentionCompletions`/replaceTrailing 函数，候选来自 `GET /fs/files`，失败静默隐藏；含空白字符的路径不进候选——键盘菜单无法标灰跳过），↑↓ 选择、Tab/Enter 接受、Esc 关闭。自定义命令不参与联想，仍靠 `/help` 发现。
- `/exit` **刻意不注册**：它是 `chat.ts` 输入循环的控制流（`parsed.command === "exit"` 直接 break），不经过注册表。
- 内置命令：

| 命令 | 行为 |
|------|------|
| `/help` | 遍历注册表，逐条打印 `name usage — description` |
| `/new [标题]` | `POST /sessions`（带可选 title，body 总带 workdir=当前 cwd）→ `switchSession` → 打印确认 |
| `/clear` | 同 `/new` 但不带标题（快速新建一个空白会话）；服务端在创建新会话后异步触发一次切会话记忆写入（clear 触发，把旧会话的对话存入记忆，不阻塞切换） |
| `/sessions` | `GET /sessions` 列表；空则"（还没有会话）"；否则经当前表面出单选器（TUI 菜单 / @clack select）、切换会话 |
| `/model [名字]` | 不带参数时列出可用模型（读 `GET /config` 的 provider 条目名）和当前用的模型；带上名字则调 `POST /sessions/:id/model` 切换本会话模型，只影响之后的回复；`/model default` 恢复默认；名字不存在时打印服务端 400 的原文（如 `model not found: …`） |
| `/mode [readonly\|default\|acceptEdits\|trusted\|auto]` | 切换本会话权限模式（无参数显示当前模式与可选项）；通过 `POST /sessions/:id/mode` 生效、下一次 run 起生效——`readonly` 拒绝写文件与执行命令类工具、`acceptEdits` 工作区内文件写入免逐次确认、`trusted` 沙箱与工作区内免确认（边界外拒绝）、`auto` 反复放行的操作自动保存为规则（见 [permissions](../core/permissions.md)） |
| `/attach <路径>` | 读入本地文件、按扩展名粗略判定 MIME 类型，经 `client.uploadAttachment` 上传并把返回的引用放进待发队列，随你的下一条消息一起发送；不带参数时列出当前待发的附件；失败打印 `附件上传失败: …` |
| `/compact [重点说明]` | 手动压缩当前会话的早期对话（跳过触发线立即执行一次，机制见 [compaction](../core/compaction.md)）：调 `POST /sessions/:id/compact`，参数作为摘要重点说明（focus）进入两次摘要调用；打印 daemon 返回的一句话（`压缩了 N 段…` / `无可压缩内容` / 会话忙时 `已排队：当前运行结束后自动压缩`）；失败打印 `压缩失败: …` |
| `/steer` | 无参切换命令：`POST /sessions/:id/disposition {disposition:"steer"}` 写会话级覆盖（持续生效，与 Web 三选同一存储），成功后切本地模式并打印"本会话处置模式：引导（steer）…"；失败打印 `切换处置失败: …` 且**不**切本地模式（回车直发维持旧处置） |
| `/wait` | 同 `/steer`，处置为 wait：运行中发送的消息排队，当前 run 结束后执行 |
| `/interrupt <消息>` | 一次性动作（不是模式）：带 interrupt 处置发送这条消息——服务端立即中止当前 run 并把消息插到队首执行；无参数时打印用法提示（纯中断用 Ctrl+C） |
| `/queue [cancel <n\|all>]` | 不带参数时 `GET /sessions/:id/queue` 列出排队消息（`序号. 处置 文本`），空则"（队列为空）"；`cancel <n>` 按序号取消该条（发 `queue.cancel` 帧），`cancel all` 清空全部；读取失败打印 `读取队列失败: …` |
| `/memory [save\|项目 [线]]` | 记忆命令（见 [memory](../core/memory.md)）：`save` 手动触发当前项目的手动写入（`POST /memory/trigger-manual`，工作目录取 CLI 启动目录，处理归属会话（默认回退到项目最近活动会话）自上次提取位置以来的新消息，成功打印 `已触发手动写入…`）；无 save 参数时是只读查看——无参列项目（`GET /memory/projects`）；指定项目列该项目的主题线（`GET /memory/projects/:id`）；再指定一条线打印线文件原文（`GET /memory/threads/:project/:topic`）；各级读取失败打印对应错误 |
| `/skill [名字\|proposals\|proposal <id>]` | 技能命令（机制见 [skills](../core/skills.md)）：无参列出已装技能（`名字 · 全局\|项目 · [仅用户] · 描述`，作用域跟会话工作目录，经 `GET /skills?workdir=`）；带名字打印该技能的 `SKILL.md` 完整正文（`GET /skills/:name?workdir=`）；`proposals` 列出技能提案（`GET /skills/proposals`，每行 `id · 状态（待确认/已采纳/已驳回/已回退） · 新增\|修订 名字 · 全局\|项目[ · 被调用 N 次]`，空时提示"还没有技能提案…"）；`proposal <id>` 打印提案详情与完整提案正文（`GET /skills/proposals/:id`）；提案治理操作（采纳/驳回/回退/删除）在 WebUI 技能页，CLI 只读；没有技能时提示 `（还没有技能。把技能目录放进 ~/.kclaw/skills/ 或工作区 .kclaw/skills/）`；失败打印 `查看技能失败: …` |
| `/mcp [服务器名]` | MCP 状态一览（机制见 [mcp](../core/mcp.md)）：无参按组打印（组头 `【全局】`/`【<路径>】`，组内每行 `名字 · 状态 · N 个工具[ · 最近错误]`，读 `GET /mcp` 快照），有失败项时附一行提示（连接与配置管理用 WebUI 的 MCP 页）；带名字打印该 server 的状态行与工具清单（每工具一行 `mcp__<server>__<tool> — 描述`；跨组同名逐条打印，项目组条目带 `<路径> · ` 前缀）；没有接入任何 server、名字未知、请求失败都打印对应提示行 |
| `/goal [目标描述 [verify: 命令]…]` | 目标循环（机制见 [goal](../core/goal.md)）：带描述设定目标并立即开始运行（`POST /sessions/:id/goal`，可选多条 `verify:` 验收命令，沙箱内执行）；无参查看状态（状态、轮数、token、验收命令、停止原因）；动作 `stop`（停止循环并中止活跃 run）、`pause`、`resume`、`clear`（移除目标）各打一行确认；失败打印 `目标操作失败: …` |

- **技能即斜杠命令**：每个已装且用户可见的技能自动注册成 `/<技能名> [要求]` 命令（`refreshSkillCommands`，启动时与每次切会话后各重拉一次，重拉会把已消失的技能（取消复用/提案回退/切项目）从注册表与补全清单同步摘除；Tab 补全时再惰性重拉（2 秒节流）、未注册命令提交时也重拉一次再判定——技能增删改不用重启 REPL 即生效。尽力而为：daemon 不可达则没有技能命令，内置命令（含 `/skill`）照常可用）。命令发送**用户原文**（要求写在命令后面时原样拼接进消息），是否调用技能由 daemon 检测、正文仍经 `skill_read` 加载——`disable-model-invocation` 的技能由此获得手动入口。内置名优先：与内置命令重名的技能命令被丢弃；自定义 `commands/*.md`（先注册）同样优先于技能。命令名不出现在注册表里时 Tab 补全也能提示（见上文 Tab 补全）。
- 自定义命令：`ctx.commandsDir`（daemon 组装为 `<home>/commands`）目录下的每个 `*.md` 文件注册成一个命令——文件名就是命令名，文件内容是一段提示词模板；执行命令时，模板里的 `{{args}}` 替换成命令参数，然后经 `ctx.send(text)` 作为普通消息发出。与内置命令重名的文件不生效，打印一行警告。
- `switchSession` 在**同一 socket** 上发 `unsubscribe`（旧会话）+ `subscribe`（新会话），同时清空待发附件（附件是会话级的，换会话不带走）；`SlashCtx` 的 `client`/`sessionId` 是 getter，命令执行时看到的总是重连/切换后的当前值。

## 边界与出错

- **订阅确认失败即失败**：`openSubscribed`（`client.ts`，chat 与 run 共用）5s（`SUBSCRIBE_ACK_MS`）等不到 `subscribed` 或收到 error 帧即抛出错误并关闭 socket，不会把消息发往一条还没完成订阅（总线尚未登记分发）的连接。
- **确认应答发送失败被忽略**：`confirmation.resolve` 发送抛出错误只忽略（socket 正在断开），交给重连路径接管。
- **管道 stdin 的 EOF**：stdin 关闭时 readline 触发 close，readline 表面循环自然退出；`rlClosed` 标志让迟到的 `prompt()` 变成空操作而不是抛 "readline was closed"（缓冲行仍会经异步迭代器到达）。EOF 属于 readline 表面：TUI 的 stdin 是 raw mode 终端，不存在这条路径。
- **重连后不回放**：重连只拉取全量数据用于更新本地状态但不渲染，错过的事件不再补偿；持久化消息自洽，下次进入 REPL 重新拉取全量即可（协议规则见 [protocol](../core/protocol.md)）。
- **cron 表格无分页**：`GET /cron` 全量返回，任务多时表格整体打印。
- **自定义命令是提示词模板，不是脚本**：它只做一件事——把模板里的 `{{args}}` 替换成命令参数后作为普通消息发送，没有任何 shell 执行面；与内置命令重名的文件直接忽略。

## 关联

- [onboarding](./onboarding.md)：首次运行判定、配置 wizard、`kclaw web`、Node 版本检查
- [file-mentions](../core/file-mentions.md)：`@路径` 引用在 daemon 侧的识别与模型侧说明
- [daemon](../server/daemon.md)：daemon 检测/启动/停止的另一侧契约（`daemon-ctl.ts` 详解）
- [realtime](../server/realtime.md)：`/ws` 帧协议与订阅语义、断线恢复规则总述
- [client-http](../core/client-http.md)：`request`/`uploadAttachment` 背后的共享 HTTP 请求模块
- [run-manager](../server/run-manager.md)：`send_message`/`run.cancel`/确认在服务端的后续
- [http-api](../server/http-api.md)：slash 命令、`cron list`、`mcp list` 背后的 REST 端点
- [mcp](../core/mcp.md)：`kclaw mcp [list]` 展示的状态快照与 `mcp__<server>__<tool>` 命名
- [skills](../core/skills.md)：`/skill` 命令与技能即斜杠命令背后的技能机制
