# CLI — 命令、REPL 与 slash 命令

## 职责

`packages/cli` 是 daemon 的终端客户端。`src/index.ts` 用 commander 组命令树并做入口分发；`src/chat.ts` 的 `runChat` 是交互式对话 REPL（REPL：read-eval-print loop，逐行读取输入、处理、打印结果、再等待下一行的交互循环）；`src/slash.ts` 是 REPL 内 `/` 命令的注册表机制（含 `<home>/commands/*.md` 的自定义命令加载与"已装技能即斜杠命令"的动态注册）；`src/file-refs.ts` 把消息里的 `@路径` 引用展开成内联文本或按需读取提示；`src/client.ts` 的 `KclawClient` 封装对 daemon 的 HTTP 与 WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）两种调用。首次运行判定、配置向导与 `kclaw web` 见 [onboarding](./onboarding.md)。CLI 不持有业务状态，随时退出，daemon 不受影响。

## 设计决策

- **`kclaw` 不带子命令即 chat**：不指定子命令时默认动作即 `chatAction`。chat 的选项（`--session`/`--think`/隐藏的 `--yes`/`--no`）挂在 program 层而非 `chat` 子命令上，`optsWithGlobals` 会把 program 选项合并进子命令的选项里，因此 `kclaw --session X` 与 `kclaw chat --session X` 都能解析到。
- **`--yes`/`--no` 是隐藏选项**：供测试与脚本自动应答确认卡片使用（`new Option(...).hideHelp()`），帮助中不出现；人机交互使用 @clack 确认框。
- **所有 action 走同一个 `run()` 包装**（`src/index.ts`）：从合并选项解析 `--home` 传给实现，任何抛错统一转为 stderr 一行 + 退出码 1——命令实现中不出现 `process.exit`。
- **argv 只在作为入口时解析**：`invokedAsMain` 用 `realpathSync(process.argv[1])` 与 `import.meta.url` 比较（与 ESM 加载器一致的符号链接解析），所以 `import "@kclaw/cli"` 当库引用没有副作用；`KclawClient` 与 `runChat` 同时作为库导出。
- **连接即自动启动 daemon**：`KclawClient.connect` 读 `<home>/daemon.json`、探活 `/health`，不健康就先 `ensureDaemon` 再重读——任何命令在冷机器上直接可用，用户不需要先知道 daemon 的存在。
- **Node >= 22 是启动门槛**：解析 argv 之前检查 `process.versions.node` 主版本，不满足则打印一行错误并 `process.exit(1)`，避免旧运行时报出难懂的语法/API 错误（详见 [onboarding](./onboarding.md)）。
- **表格输出零依赖**：`jobs list` 的表格是纯字符串对齐（`renderJobsTable`：按列宽 `padEnd`，两空格列间隔），不引入表格库；列头同时充当空列表时的输出。
- **运行中发送不阻塞输入行，处置随每条发送显式携带**：发送与渲染由常驻帧泵（`startPump`——一个持续读取 socket 帧并分发给当前渲染的后台循环）接管，每次 `startRender` 递增渲染代际、旧渲染静默退场——run 中途照样能继续输入（`/interrupt`、忙时直发都依赖它）。每条 `send_message` 显式带 `disposition`（当前会话处置模式），模式由 `/steer`/`/wait` 切换、存会话级覆盖（与 Web 三选同源）；`interrupt` 是一次性动作，不做成模式（做成模式有"切了忘改回、接连中断 run"的误伤风险）。
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
| `kclaw mcp [list]` | 经 `GET /mcp` 逐行打印 MCP server：`<名字>  <状态>  <N> 个工具[ 错误: <lastError>]`；空列表打印 "未配置 MCP server（config.yaml 的 mcp.servers 为空）" |
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
  // HTTP 请求（经 @kclaw/core/client-http 共享基座，见 [client-http](../core/client-http.md)）；
  // 非 2xx 抛服务端 body.error（无则 "HTTP <status>"）；204/空响应返回 undefined
  uploadAttachment(sessionId, filename, body, mimeType): Promise<{file: {path, name, size}}>
  // 原始字节流 POST /sessions/:id/attachments?filename=…（附件上传，见 /attach 与下文 REPL 流程；
  // 同样经 @kclaw/core/client-http 的 contentType 原样透传）
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
  commandsDir?: string              // 自定义命令目录（<home>/commands，*.md）；缺省不加载
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
2. **读行**：`node:readline` 逐行读（刻意不用 @clack 的文本框：增量需直接 `process.stdout.write`，管道 stdin 也需逐行工作）。每行先过 `dispatch`：`/` 开头的按命令处理；普通消息发送前先做一遍 **`@路径` 引用展开**。展开流程：先调 `GET /sessions/:id` 拿到会话的工作目录（daemon 一时连不上就退回用进程 cwd，别让一次网络失败卡死输入循环）；然后 `expandFileRefs` 找出消息里每个 `@token`，相对 cwd 解析路径并经 realpath 校验，要求必须落在这个工作目录之内。对每个通过检查的文件按大小分两种处理：小的文本文件把正文直接内联进消息（格式为 `[来自 @路径]` + 正文，超过 8192 字符（8 KiB）截断并加 `\n…[已截断]`）；大文件或非文本文件则在消息末尾加一行提示 `[文件 @路径（N 字节）已引用，可用 fs_read 读取 <绝对路径>]`，内容由模型之后自己读。任何一个 token 越界、不存在或不是文件，整条消息就不发送，只打印一行 `引用失败: <原因>`。
3. **发送与渲染**（`renderRun`）：发 `{type:"send_message", sessionId, text, disposition, attachments?}`——`disposition` 必带，取当前会话处置模式（`/steer`/`/wait` 切换，或 `/interrupt` 一次性注入；初始值 = 会话覆盖 `dispositionOverride` > 配置 `sessions.defaultDisposition` > steer）。之前用 `/attach` 上传累积的待发附件随这条帧一起发出，发完立即清空附件队列。发送与渲染**不阻塞输入行**：常驻帧泵（`startPump`）读取 socket 帧并分发给当前渲染，每次发送经 `startRender` 递增 `renderEpoch` 接手后续帧流的渲染，旧渲染静默退场——所以 run 中途还能继续输入（`/interrupt` 和忙时发送都依赖它）。按帧渲染直到 run 终态：
   - `text.delta` 原样写出（自带换行控制：`ensureLineStart` 保证块之间换行）；`thinking.delta` 仅 `--think` 时暗色输出。
   - `tool_call.completed` → `⚡ <name> <args>`，args 是紧凑 JSON、截断到 60 字符。
   - `tool_result.completed` → `↳ <status> (<n>ms) <output>`，输出压空白后取前 80 字符；`tool_result.delta` 不做实时渲染（completed 行已带摘要）。
   - `message.queued`（我的消息）→ 暗色 `已排队（第 N 位）`（`position+1`）或 `已进入引导缓冲`（steer 无 position）；`message.steered`（我的消息）→ 暗色 `已注入`——我的消息身份从 `send_message_ack` 的 `messageId` 学到，终点以"我的消息被看到（`message.created`/`message.steered`）之后的第一个 `run.completed`"判定，前一个 run 的终态不会错收我的渲染。
   - `confirmation.requested` → `⚠ <name> <argsJson> · 风险 <risk> · 过期 <expiresAt>`（带 `noteText` 时紧随一行暗色说明，如 exec 沙箱不可用），按 yes/no/ask 三种模式收集决定（ask 时暂停 readline、@clack 出确认框、恢复 readline）；ask 是**四项选择**——`允许（仅本次）` / `总是允许（本项目）` / `总是允许（全局）` / `拒绝`（`--yes`/`--no` 隐藏选项分别映射 once/reject；取消同样按拒绝），回发 `{type:"confirmation.resolve", confirmationId, decision}`（不带 `client` 字段 → 服务端记 "cli"）。"总是允许"会把一条收紧后的放行规则写入磁盘，之后同形操作不再询问（见 [permissions](../core/permissions.md) 的"沉淀规则"一节）。
   - `note.emitted` → 暗色 `[note] <text>`（记忆注入、job 来源等系统 note 每条一行）；`message.created/completed` 刻意不渲染（readline 已回显用户输入，再渲染会重复）。
   - `compaction.started` → 暗色 `[正在压缩早期对话…]` 一行（收尾压缩发生在 `run.completed` 之后、中途/急救压缩发生在运行中的迭代边界——都有这行提示，摘要调用的数秒不是静默空窗）；`compaction.completed` → 按 `result` 三分支：`ok` 打暗色 `✱ 早期对话已压缩为 N 段，保留最近 M 条原文（早期细节可用 session_search 检索）`、`failed` 打暗色 `✱ 压缩失败，本轮继续（稍后自动重试）`、`cancelled` 打暗色 `✱ 压缩已取消`——事件只在真正发生压缩时发一次，天然是"每次压缩一条"的告知，与 WebUI 的折叠块同一去重语义（见 [compaction](../core/compaction.md)）。
   - `memory.written`（广播，不带 sessionId）→ 暗色一行 `已写入记忆: <path>`，提示记忆已写入；它与 run 生命周期无关，只是轻提示（见 [memory](../core/memory.md)）。
   - `hook.failed` → 暗色一行 `⚠ 钩子 <名字> 失败（<位置>[ 装载]）：<原因>`——用户钩子失败不伤 run，但失败必须可见（机制见 [hooks](../core/hooks.md)）。
   - `run.completed`/`run.failed`/error 帧 → 结束本轮等待。
4. **Ctrl+C 逐级升级**（readline 在待输行为空时把 Ctrl+C 转成 `"SIGINT"` 事件，`sigints` 计数只增不减）：第一次在 run 进行中 → 发 `{type:"run.cancel"}`（run 随后经正常渲染路径以 `stopReason:"aborted"` 结束），并查排队数，非空则提示"还有 N 条排队消息，再按一次 Ctrl+C 清空"；第一次空闲 → 同样查排队数，非空提示清空、为空提示"再按一次 Ctrl+C 退出"；第二次 → 队列非空则发 `{type:"queue.cancel"}` 清空全部可取消条目并提示"队列已清空，再按一次 Ctrl+C 退出"，队列为空直接退出；第三次 → 关闭 socket、关闭 readline、`process.exit(130)`。

### 空闲重连与消息重发

- **重连**（`reconnect`）：socket 意外关闭时重新 `KclawClient.connect`（daemon 已终止时重新启动一个）、重新订阅、`GET /sessions/:id/messages` 全量拉取一次进行对齐（不重放渲染），打印 `[reconnected]`；重连失败打印 `[连接断开，重连失败 — 输入 /exit 退出]` 并放弃。
- **重发规则**：一条发送中的消息只有当**一帧都没观察到**（连 `send_message_ack` 都没有）才会在重连后重发——零帧说明消息从未到达存活的 daemon（ws 库对已关闭的 socket 静默丢帧、只在连接中才同步抛错，两者都等价于"未送达"）。观察到任何一帧即视为已送达，中途断线绝不重发：run 可能已在服务端排队，重发会导致同一消息被执行两次。
- **120s 静默看门狗**：重连后观察到的帧带 `POST_RECONNECT_SILENCE_MS = 120_000` 的不活动超时——daemon 已终止的 run 永远不会完成，REPL 不可无限等待；超时打印提示后回到提示符。重连前的等待不加人为上限（`nextFrame` 对非有限超时直接跳过等待：node 会把 `setTimeout(fn, Infinity)` 钳到 1ms，反而会截断仍在运行的 run）。

### 权限模式：提示符徽章与 Shift+Tab 循环

提示符随会话权限模式变化：`default` 是裸 `> `；非默认模式前缀徽章 `[readonly] > ` / `[acceptEdits] > ` / `[trusted] > ` / `[auto] > `（run 进行中按下时徽章保持旧值，从下一次 run 起生效）。Shift+Tab 按 `PERMISSION_MODES` 顺序（readonly → default → acceptEdits → trusted → auto，严格在前）循环切换：`POST /sessions/:id/mode {mode}` 成功后更新本地镜像与提示符并打印 `权限模式: <模式>（Shift+Tab 继续切换）`，失败静默（徽章保持）。模式在 run 中切换同样落到下一次 run——daemon 的权限 gate 每 run 从会话 meta 读取。

## slash 命令机制（packages/cli/src/slash.ts）

- 注册表是 `createRegistry(ctx)` 返回的 `Map<string, SlashCommand>`；命令的名称/用法/描述读自 `@kclaw/core/commands` 的共享清单 `SLASH_COMMANDS`（WebUI 读同一份，保证两端文案不漂移，见 [webui](../web/webui.md)）；解析（`dispatch`，委托 core 的 `parseSlashInput`）与查表执行（`runOrHint`）分离，未注册的命令打印一行 `没有这个命令，/help 看看`（miss 路径可单测）。
- **Tab 补全**：readline 的 completer 挂在 `createSlashCompleter(() => skillCommandMetas)`（`slash.ts`）上——**输入的最后一段空白分隔块**是以 `/` 开头且还没打空格时按 Tab，按共享清单给出前缀候选：内置命令在前、动态注册的技能命令在后（与内置重名的技能命令被共享补全器排除），唯一命中直接补全命令名，多个命中补全公共前缀并列出清单；普通文本、带参数的输入（`/new 标题` 这种已打空格的）、未知前缀都不动作。自定义命令不参与联想，仍靠 `/help` 发现。
- `/exit` **刻意不注册**：它是 `chat.ts` 输入循环的控制流（`parsed.command === "exit"` 直接 break），不经过注册表。
- 内置命令：

| 命令 | 行为 |
|------|------|
| `/help` | 遍历注册表，逐条打印 `name usage — description` |
| `/new [标题]` | `POST /sessions`（带可选 title，body 总带 workdir=当前 cwd）→ `switchSession` → 打印确认 |
| `/clear` | 同 `/new` 但不带标题（快速新建一个空白会话）；服务端在创建新会话后异步触发一次切会话记忆写入（clear 触发，把旧会话的对话存入记忆，不阻塞切换） |
| `/sessions` | `GET /sessions` 列表；空则"（还没有会话）"；否则暂停 readline、@clack 单选列表、切换会话 |
| `/model [名字]` | 不带参数时列出可用模型（读 `GET /config` 的 provider 条目名）和当前用的模型；带上名字则调 `POST /sessions/:id/model` 切换本会话模型，只影响之后的回复；`/model default` 恢复默认；名字不存在时打印服务端 400 的原文（如 `model not found: …`） |
| `/mode [readonly\|default\|acceptEdits\|trusted\|auto]` | 切换本会话权限模式（无参数显示当前模式与可选项）；通过 `POST /sessions/:id/mode` 生效、下一次 run 起生效——`readonly` 拒绝写文件与执行命令类工具、`acceptEdits` 工作区内文件写入免逐次确认、`trusted` 沙箱与工作区内免确认（边界外拒绝）、`auto` 反复放行的操作自动保存为规则（见 [permissions](../core/permissions.md)） |
| `/attach <路径>` | 读入本地文件、按扩展名粗判 MIME 类型，经 `client.uploadAttachment` 上传并把返回的引用放进待发队列，随你的下一条消息一起发送；不带参数时列出当前待发的附件；失败打印 `附件上传失败: …` |
| `/compact [重点说明]` | 手动压缩当前会话的早期对话（跳过触发线立即执行一次，机制见 [compaction](../core/compaction.md)）：调 `POST /sessions/:id/compact`，参数作为摘要重点说明（focus）进入两次摘要调用；打印 daemon 返回的一句话（`压缩了 N 段…` / `无可压缩内容` / `会话正在运行`）；失败打印 `压缩失败: …` |
| `/steer` | 无参切换命令：`POST /sessions/:id/disposition {disposition:"steer"}` 写会话级覆盖（持续生效，与 Web 三选同一存储），成功后切本地模式并打印"本会话处置模式：引导（steer）…"；失败打印 `切换处置失败: …` 且**不**切本地模式（回车直发维持旧处置） |
| `/wait` | 同 `/steer`，处置为 wait：运行中发送的消息排队，当前 run 结束后执行 |
| `/interrupt <消息>` | 一次性动作（不是模式）：带 interrupt 处置发送这条消息——服务端立即中止当前 run 并把消息插到队首执行；无参数时打印用法提示（纯中断用 Ctrl+C） |
| `/queue [cancel <n\|all>]` | 不带参数时 `GET /sessions/:id/queue` 列出排队消息（`序号. 处置 文本`），空则"（队列为空）"；`cancel <n>` 按序号取消该条（发 `queue.cancel` 帧），`cancel all` 清空全部；读取失败打印 `读取队列失败: …` |
| `/memory [save\|项目 [线]]` | 记忆命令（见 [memory](../core/memory.md)）：`save` 手动触发当前项目的手动写入（`POST /memory/trigger-manual`，工作目录取 CLI 启动目录，处理归属会话（缺省回落项目最近活动会话）自上次提取位置以来的新消息，成功打印 `已触发手动写入…`）；无 save 参数时是只读查看——无参列项目（`GET /memory/projects`）；指定项目列该项目的主题线（`GET /memory/projects/:id`）；再指定一条线打印线文件原文（`GET /memory/threads/:project/:topic`）；各级读取失败打印对应错误 |
| `/skill [名字]` | 技能命令（机制见 [skills](../core/skills.md)）：无参列出已装技能（`名字 · 全局\|项目 · [仅用户] · 描述`，作用域跟会话工作目录，经 `GET /skills?workdir=`）；带名字打印该技能的 `SKILL.md` 完整正文（`GET /skills/:name?workdir=`）；没有技能时提示 `（还没有技能。把技能目录放进 ~/.kclaw/skills/ 或工作区 .kclaw/skills/）`；失败打印 `查看技能失败: …` |

- **技能即斜杠命令**：每个已装且用户可见的技能自动注册成 `/<技能名> [要求]` 命令（`refreshSkillCommands`，启动时与每次切会话后各重拉一次，尽力而为：daemon 不可达则没有技能命令，内置命令——含 `/skill`——照常可用）。命令发送**用户原文**（要求写在命令后面时原样拼接进消息），点名交给 daemon 检测、正文仍经 `skill_read` 加载——`disable-model-invocation` 的技能由此获得手动入口。内置名优先：与内置命令重名的技能命令被丢弃；自定义 `commands/*.md`（先注册）同样优先于技能。命令名不出现在注册表里时 Tab 补全也能提示（见上文 Tab 补全）。
- 自定义命令：`ctx.commandsDir`（daemon 装配为 `<home>/commands`）目录下的每个 `*.md` 文件注册成一个命令——文件名就是命令名，文件内容是一段提示词模板；执行命令时，模板里的 `{{args}}` 替换成命令参数，然后经 `ctx.send(text)` 作为普通消息发出。与内置命令重名的文件不生效，打印一行警告。
- `switchSession` 在**同一 socket** 上发 `unsubscribe`（旧会话）+ `subscribe`（新会话），同时清空待发附件（附件是会话级的，换会话不带走）；`SlashCtx` 的 `client`/`sessionId` 是 getter，命令执行时看到的总是重连/切换后的当前值。

## 边界与出错

- **订阅确认失败即失败**：`openSubscribed` 5s（`SUBSCRIBE_ACK_MS`）等不到 `subscribed` 或收到 error 帧即抛错并关闭 socket，不会把消息发送到总线尚未分发的连接上。
- **确认应答发送失败被忽略**：`confirmation.resolve` 发送抛错只忽略（socket 正在断开），交给重连路径接管。
- **管道 stdin 的 EOF**：stdin 关闭时 readline 触发 close，循环自然退出；`rlClosed` 标志让迟到的 `prompt()` 变成空操作而不是抛 "readline was closed"（缓冲行仍会经异步迭代器到达）。
- **重连后不回放**：重连只拉取全量对齐数据但不渲染，错过的事件不再补偿；持久化消息自洽，下次进入 REPL 重新拉取全量即可（协议规则见 [protocol](../core/protocol.md)）。
- **jobs 表格无分页**：`GET /jobs` 全量返回，任务多时表格整体打印。
- **文件引用宁可整条失败也不靠猜**：`@token` 越界、不存在或不是文件时消息不发出——发出去模型要么读不到要么读到不该读的。文本与二进制的区分只按扩展名和 MIME 粗判，识别不了的类型一律当"非文本"处理，只留一条 fs_read 提示。
- **自定义命令是提示词模板，不是脚本**：它只做一件事——把模板里的 `{{args}}` 替换成命令参数后作为普通消息发送，没有任何 shell 执行面；与内置命令重名的文件直接忽略。

## 关联

- [onboarding](./onboarding.md)：首次运行判定、配置向导、`kclaw web`、Node 版本检查
- [daemon](../server/daemon.md)：daemon 探测/启动/停止的另一侧契约（`daemon-ctl.ts` 详解）
- [realtime](../server/realtime.md)：`/ws` 帧协议与订阅语义、断线恢复规则总述
- [client-http](../core/client-http.md)：`request`/`uploadAttachment` 背后的共享 HTTP 请求基座
- [run-manager](../server/run-manager.md)：`send_message`/`run.cancel`/确认在服务端的后续
- [http-api](../server/http-api.md)：slash 命令、`jobs list`、`mcp list` 背后的 REST 端点
- [mcp](../core/mcp.md)：`kclaw mcp [list]` 展示的状态快照与 `mcp__<server>__<tool>` 命名
- [skills](../core/skills.md)：`/skill` 命令与技能即斜杠命令背后的技能包机制
