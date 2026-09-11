# architecture — 架构总纲

## kclaw 是什么，本文讲什么

kclaw 是一个运行在本机的个人 AI 助手（agent）。整套系统只有一个真正干活的进程：daemon（守护进程，常驻后台的程序）。会话、定时任务、记忆、配置全部由 daemon 一手保管；终端里的 CLI 和浏览器里的 WebUI 只是它的两个客户端，负责输入和显示，自己不保存任何业务数据。

本文是全部技术文档的入口：先给出模块地图与进程模型，再沿一条用户消息的完整旅程把数据流走一遍，最后交代边界情况下的行为。各子系统的细节见 `core/`、`server/`、`cli/`、`web/` 下的分篇。

---

## 设计决策

五个决定塑造了整个系统的形状。

**一、单 daemon，多客户端。** CLI 随时可以退出，daemon 不受影响；定时任务在没有客户端连接时照常执行。daemon 是唯一保存状态的地方，客户端不持久化（写入磁盘长期保存）任何业务状态。

**二、core 是纯库。** `@kclaw/core` 不依赖 fastify、ws、commander 中的任何一个框架，也不知道 HTTP 和 WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）的存在。它需要的外部能力全部由调用方注入：模型调用（`deps.llm`）、工具执行、事件出口（`deps.onEvent`）、持久化（`deps.onMessage`）。因此整个 agent 循环可以用假的依赖（mock）离线测试。

**三、daemon 只监听本机回环地址。** 回环地址（loopback）是 127.0.0.1，只有本机进程能连上，外部网络访问不到。监听地址在 `packages/server/src/daemon.ts` 与 `packages/cli/src/daemon-ctl.ts` 里各自写死为 `HOST = "127.0.0.1"`；默认监听临时端口（`port: 0`，由操作系统分配），实际端口与进程号写入 `<home>/daemon.json`。客户端每次请求都带上 `<home>/token` 文件里的 Bearer token（放在 HTTP `Authorization` 请求头里的访问令牌）完成鉴权。

**四、实时事件不持久化，持久化的是事件流。** WS 上推送的增量事件（text.delta、message.created 等）只用于实时刷新界面：不写入磁盘、断线不补发、不回放。会话真正的持久化形式是每个会话目录下的 events.jsonl 事件流（唯一真相，message / compaction / memory / system 等业务事件都记录在这里），以及由它推导出来的 meta.json 摘要（见 [storage](./core/storage.md)）。客户端断线恢复的办法：先用 HTTP 拉一次全量消息，再只订阅新事件（详见 [protocol](./core/protocol.md)）。

**五、WebUI 是独立构建的静态产物。** `@kclaw/web` 的运行时依赖只有 react/react-dom、`@kclaw/core` 的两个纯数据出口，以及 react-virtuoso（审计页用的虚拟滚动列表库，见 [webui](./web/webui.md)）。两个纯数据出口是：`commands` 共享表（slash 命令的 name/usage 元数据，CLI 与 WebUI 读同一份，见 [extending](./extending.md)）和 `protocol` 子路径出口（线上数据形状的类型定义）。构建出的静态文件由 daemon 托管（`resolveWebDist` → `packages/web/dist`），不需要额外的文件服务器。

---

## 模块地图

```
kclaw（发布包：esbuild 打包 cli+server+web 产物，bin: app/cli/cli.js）
 │
 ├── @kclaw/core     纯库，agent 引擎（run 装配/压缩引擎/事件总线/确认网关都在这里；server 与 cli 都依赖它）
 ├── @kclaw/server   daemon：Fastify app + RunManager 队列状态机（依赖 core）
 ├── @kclaw/cli      客户端：REPL / daemon 控制（依赖 core 的类型、ws、commander）
 └── @kclaw/web      客户端：React SPA（依赖 core 的 commands/protocol 子路径出口与 react-virtuoso，vite 独立构建）
```

依赖方向唯一：core ← server、core ← cli。web 只依赖 core 的 `commands`/`protocol` 两个子路径出口（纯数据/纯类型，不含 agent 引擎）与 react-virtuoso；发布包 kclaw 只在构建期把 cli、server、web 的产物打包到一起。

### 各包内部结构

**core**（入口 `packages/core/src/index.ts`）统一导出 14 个子目录：

| 子目录 | 内容 |
|--------|------|
| `protocol/` | 消息、块、事件、WS 指令帧、会话事件、ID 的类型定义——线上数据形状的权威来源，经 `@kclaw/core/protocol` 子路径出口供三端引用 |
| `provider/` | OpenAI 兼容的模型客户端，带重试 |
| `agent/` | agent 循环、上下文组装、工具契约、单次 run 的装配（`run-assembly.ts` 的 `executeRun`） |
| `hooks/` | 钩子系统：14 个挂载位置、HookChain 注册接口、用户文件装载、内置钩子（见 [hooks](./core/hooks.md)） |
| `storage/` | 路径解析、配置读取、JSONL（每行一条 JSON 的文本文件）读写；含用量记录 `usage.ts` 与已保存权限规则 `decided-rules.ts` |
| `session/` | SessionStore 与上下文压缩：token 估算、分界、渲染等纯函数、事件流存储、压缩引擎 `Compactor`、会话自动命名；`session_search` 工具直接扫事件流 |
| `permissions/` | ConfigPermissionGate（权限判定）+ ConfirmationBroker（人工确认网关） |
| `memory/` | MemorySystem：L1 项目情节 + L2 全局认知 + FTS5/向量索引（见 [memory](./core/memory.md)） |
| `text/` | 三端共享的中文分词器与全文检索（FTS）辅助 |
| `tools/` | 14 个内置工具（11 常驻 + 条件注册的子代理派发/取回与运行中提问） |
| `skills/` | 技能包解析、双作用域扫描、点名匹配（见 [skills](./core/skills.md)） |
| `jobs/` | JobScheduler（定时任务调度） |
| `mcp/` | MCP（Model Context Protocol：给模型接入外部工具的开放协议）客户端管理器 |
| `notify/` | 任务完成通知 |

根级另有 `bus.ts`（EventBus，进程内事件分发）与 `client-http.ts`（CLI/WebUI 共享的 HTTP 请求基座：自动附带 Bearer token、提取错误信息、处理 204/空响应，经 `@kclaw/core/client-http` 子路径出口；不 import 任何 Node 专属模块，浏览器可以直接打包）。`sandbox/`（exec 工具的操作系统级沙箱：Seatbelt/bwrap 探测与包装，见 [sandbox](./core/sandbox.md)）是内部模块，不经入口导出，由 run 装配直接 import。

**server**（入口 `packages/server/src/index.ts`）：`app.ts`（createApp 装配）、`daemon.ts`（launchDaemon）、`auth.ts`（token 鉴权）、`run.ts`（RunManager 队列状态机；单次 run 的装配在 core 的 `executeRun`）、`subagent.ts`（子代理派生：子会话创建、状态行与确认转发，见 [subagents](./core/subagents.md)）、`command-check.ts`（WS 命令帧的唯一校验点）、`ws.ts`（/ws 协议）、`scheduler-tick.ts`（定时调度 tick）、`memory-scheduler.ts`（记忆的定时/跟随保底调度）、`routes/`（sessions/attachments/jobs/config/fs/usage/memory/skills/hooks/permissions 十组路由）。

**cli**（入口 `packages/cli/src/index.ts`）：commander 命令树（默认进 chat）；`chat.ts`（REPL 交互循环、渲染、@引用展开）、`client.ts`（KclawClient）、`daemon-ctl.ts`（daemon 探测/启动/停止）、`slash.ts`（slash 命令实现）、`file-refs.ts`（@文件引用）、`wizard.ts`（首次配置向导）、`provider-check.ts`（模型连通测试）、`web-cmd.ts`（`kclaw web` 子命令）。

**web**（入口 `packages/web/src/main.tsx`）：九个视图（chat/sessions/jobs/audit/usage/trash/memory/skills/permissions）加 DirectoryPicker（目录选择器）、离线外壳（`sw.js`/manifest/OfflineBanner）、`ws.ts`（WS 客户端）、`token.ts`（token 引导）。

---

## 进程模型

```
┌─ kclaw daemon（常驻进程，唯一状态权威）───────────────────────┐
│  127.0.0.1:<port>  （port 写入 <home>/daemon.json）            │
│  HTTP: /health /status /sessions* /attachments* /jobs*         │
│        /memory* /permissions /skills /hooks /config            │
│        /fs/browse /usage /mcp （Bearer）                        │
│  WS:   /ws（首帧 auth 或 ?token=；subscribe + 命令 + 事件流）   │
│  常驻: RunManager（会话串行 run）· scheduler tick（默认 30s）   │
│        · 记忆调度器（定时 + 跟随，默认 60s 扫）                 │
│        · McpManager（仅当 mcp.servers 非空时装配，异步连接）    │
└────────────┬────────────────────────┬────────────────────────┘
             │ HTTP+WS                │ HTTP+WS
      ┌──────┴──────┐          ┌──────┴──────┐
      │ kclaw CLI   │          │ 浏览器 WebUI │
      │ (REPL, 可退出)│         │ (daemon 托管)│
      └─────────────┘          └─────────────┘
```

**客户端如何把 daemon 拉起来。** 任何客户端命令都先经 `KclawClient.connect()` → `ensureDaemon()`（`packages/cli/src/daemon-ctl.ts`），按探测结果分三种情况处理：

- `daemon.json` 记录健康 → 直接使用。
- 文件还在、`/health` 不通且进程号对应的进程已死（系统返回 ESRCH）→ 判定记录失效，重新分叉启动一个 daemon（detached、stdio ignore、unref，目标脚本由 `resolveServerBin()` 解析到 `packages/server/bin/kclaw-server.mjs`），然后轮询等它健康（总预算 5 秒、间隔 250 毫秒、单次探测超时 1 秒）。
- 进程还活着但不健康 → 只等待，不重复启动——防止把同一个 daemon 启动出第二份。

**daemon 如何宣告就绪。** `launchDaemon` 第一步以 `wx` 独占模式认领 `<home>/daemon.json`（先写入占位内容 `{port: 0, pid, startedAt, starting: true}`；发现存活 pid 就拒绝二次启动，发现死 pid 则回收文件重新认领），监听成功后回填 `{port, pid, startedAt}`；启动脚本同时向 stdout 打一行 `{"port":<port>}` 供启动方读取。

**如何停止。** 收到 SIGTERM/SIGINT 后走有界 stop（每一步默认 60 秒超时）；stop 失败时保留 daemon.json——进程还在运行，pid 文件必须如实反映。

**状态全部在 `<home>`。** `<home>` 指 `KCLAW_HOME` 环境变量指定的目录，未设置时为 `~/.kclaw`（`resolvePaths`，`packages/core/src/storage/paths.ts`）。里面有：`config.yaml`、`AGENTS.md`、`token`、`daemon.json`、`permissions.yaml`（全局的已保存权限规则，见 [permissions](./core/permissions.md)）、`sessions/`、`memory/`（记忆库：`global/`（persona/wiki/rule 三类认知文件）+ `projects/<id>/`（主题线文件），各带 `vectors.db` 检索索引，见 [memory](./core/memory.md)）、`skills/`（全局技能包目录，项目级技能在工作区 `.kclaw/skills/`，见 [skills](./core/skills.md)）、`hooks/`（用户钩子目录，每个 run 重新扫描，见 [hooks](./core/hooks.md)）、`jobs.db`、`usage.db`、`attachments/`、`commands/`、`logs/`。

---

## 数据流总览

一条用户消息（含工具调用与人工确认）从输入到持久化、广播、渲染，分三步走。

### 第一步：发送与排队（server 侧）

用户在 CLI 或 WebUI 输入文本，客户端经已认证的 WS 连接发一帧 `{type:"send_message", sessionId, text, disposition?, attachments?}`（`packages/server/src/ws.ts`）。服务端先做两件轻活——查这个会话存在、核对附件引用——然后立刻回一帧 `send_message_ack {messageId, queued}`，不等回复生成完，长任务不会堵住命令通道。

随后 `RunManager.submit`（`packages/server/src/run.ts`）决定这条消息的去向，每个会话有一条显式队列和自己的驱动循环：

- **空闲直发**：会话没有正在进行的回复，立即开始一次 run（`queued:false`，不发 message.queued 事件）。
- **steer（引导）**：会话正在回复，消息进引导缓冲，广播 message.queued；到当前回复的一个迭代边界再注入给模型。
- **wait（排队）**：排在队尾，当前 run 结束后出队执行。
- **interrupt（中断）**：先中止当前 run，再把这条消息插到队首。

后三种都会广播 message.queued 事件。

### 第二步：一次 run 的内部（core 侧）

run 的装配在 core 的 `executeRun`（`packages/core/src/agent/run-assembly.ts`），依次做：

1. 附件引用挂载为 attachment 块（多模态、内联文本、fs_read 提示三种形态）。
2. 确定模型：`input.model` → 会话 meta → 默认配置，三级依次回落，条目名翻译成线上模型名。
3. 记忆检索：拿用户文本的前 200 字符搜项目情节，取前 5 条，作为 note 块注入用户消息；另把 L2 全局认知拼进系统提示（见 [memory](./core/memory.md)）。
4. 扫描技能目录（全局 `<home>/skills` + 工作区 `.kclaw/skills`），把可用技能清单追加进系统提示——此时系统提示分两段组装：**stable**（人设基座 + 注入约定，缓存冻结面）在前，**live**（全局认知 + 技能清单，低频变化面）在后；若消息里出现 `/技能名`（任意位置），生成一份改写后的模型视图文本（见 [skills](./core/skills.md)）。
5. 读会话历史（在读之后才追加新用户消息）→ `createBuiltinTools`（含 skill_read）+ extraTools（MCP 工具）→ `ConfigPermissionGate`（readRoots 为附件目录；权限模式与已保存规则每个 run 都从会话 meta 和磁盘现读）。
6. 进入 agent 循环 `runAgent(...)`（`packages/core/src/agent/loop.ts`）：
   - `llm.stream(await buildMessages())`：`toProviderMessages(history, window=200)` 负责把历史组装成发往模型的请求（`agent/context.ts`）；llm-before 钩子链只能修改模型看到的输入（技能点名的包装就是内置的 skill-wrap 钩子，用 `withLastUserText` 锚定最后一条 user 消息）。
   - 模型流式返回 text / thinking / tool_call（各自经历 created → delta → …）。
   - 模型要求调用工具（`stopReason:"tool_use"`）→ 权限检查 `check(toolCall)`（`permissions/engine.ts`）。需要人工确认时，发出 confirmation.requested 事件，客户端弹确认框；用户的选择经 WS 帧 `{type:"confirmation.resolve", confirmationId, decision}` 回来，`ConfirmationBroker.resolve` 收到后循环继续（`core/src/permissions/broker.ts`）。
   - 执行工具：parallel 组并发、serial 组串行，产出 tool_result 块。
   - turn-boundary 钩子链（内置 steering-drain）取走引导缓冲里的消息逐条注入：message.created → onMessage 持久化 → message.completed → message.steered。
   - 回到下一轮模型调用，直到模型输出 end_turn。

系统提示词的全量留痕发生在进入模型循环之前：引擎拼装好系统提示词后调用 `SessionStore.appendSystem`，往 events.jsonl 追加一条 system 事件（按 stable/live 两段记录）——每 run 恰好一条，不并入 meta 投影、不上事件总线，写失败则本次 run 直接失败。run 的边界（`run.started` / `run.ended`）与人工确认的裁决（`permission.decided`）也在此层落进会话档案，三者构成审计页的"每轮发生了什么"（见 [run-manager](./server/run-manager.md) 与 [webui](./web/webui.md)）。

### 第三步：收尾与广播

- 每条消息：`deps.onMessage` → `SessionStore.appendMessage` → events.jsonl 追加一条 message 事件，并汇入 meta.json 投影。
- 每个事件：`deps.onEvent` → `bus.emit` → JSON 序列化 → 只发给订阅了该会话的 socket（`packages/core/src/bus.ts`）。
- run 结束时（run-after 钩子链）：往 usage.db 记一行用量（失败只写日志，不影响 run）；`memory.write.idleMinutes>0` 时挂一个跟随触发的记忆检查（记忆由 memory_save 工具与定时/跟随调度器写入，见 [memory](./core/memory.md)）；上下文占用到达黄线（预算的 80%）时执行一次收尾压缩，压缩失败则本次 run 以失败收场；非定时任务会话的第一条消息触发自动命名，成功后改名并广播 session.renamed。
- 客户端渲染（CLI 写 stdout；WebUI 更新 React 状态），最后 run.completed 终态。

两条不变量贯穿全链：

- **先持久化后广播**：客户端收到的事件，反映的一定是已经写入磁盘的状态。
- **ack 与 run 解耦**：send_message 的确认帧在 run.started 之前就返回。

---

## 端到端示例：一条会改文件的消息

设用户在 CLI 输入：`把 src 里的 TODO 改成 FIXME`。会话 `ses_…` 已存在。

1. **入队**：CLI 经已认证的 WS 发 send_message 帧；`ws.ts` 查 `sessions.meta(sessionId)` 确认会话存在 → 调 `run.submit(sessionId, {userText, trigger:"user"})`，由它同步决定去向（空闲直发/入队/进引导缓冲）→ 立即回 `send_message_ack {messageId, queued}`，不等待 run 完成。
2. **装配**（core 的 `executeRun`）：记忆检索命中 0 条 → 读历史 → 用户消息以纯 text 的空壳形态传入 `RunInput.userMessage`（先建占位消息，内容块随后补全）；run-before 钩子链（内置 memory-inject → user-message-land）补上 note 块并调 `appendMessage` 持久化。事件顺序为 `run.started → message.created → note.emitted ×N → message.completed`。
3. **第一轮模型调用**：`llm.started {attempt:1}` → assistant 空壳 `message.created` → 模型流式产出工具调用：`tool_call.created` → 若干 `tool_call.delta` → 流结束 `llm.completed {stopReason:"tool_use"}` → `tool_call.completed`（到此才 `JSON.parse(argsJson)` 解析参数）。
4. **权限检查**：`fs_read` 是 safe 工具，直接放行（`grantedBy:"safe"`）；`fs_write` 命中 confirm → 循环发出 `confirmation.requested {confirmationId:"conf_…", toolCall, risk:"sensitive", expiresAt}` 并挂起等待。`raceConfirmation` 同时在三件事上竞争：人工裁决、120 秒超时、run 的 abort 信号，谁先到算谁。
5. **人机回合**：CLI 收到事件，弹 @clack 四项确认框（允许（仅本次）/ 总是允许（本项目）/ 总是允许（全局）/ 拒绝）。用户选「总是允许（本项目）」→ CLI 回 `confirmation.resolve {confirmationId, decision:"project"}` → ws.ts 先把这次工具调用收紧成一条具体规则写入项目档 `.kclaw/permissions.yaml`，再调 `broker.resolve` → 循环发出 `confirmation.resolved {decision:"project", by:"cli"}`，工具以 `grantedBy:"confirmed"` 放行（「总是允许」两档的保存机制见 [permissions](./core/permissions.md)）。
6. **执行与结果消息**：`fs_read` 属 parallel 组、`fs_write` 属 serial 组，分组调度——并行组经 `Promise.allSettled` 等全部完成后，串行组逐个执行；每个结果走 `tool_result.created → (delta) → completed`。结果块按模型给定的顺序组成一条 `role:"tool"` 消息，`onMessage` 持久化后广播 message.completed。
7. **第二轮模型调用**：带上完整的工具结果再次调用；模型输出文本总结 → `end_turn` → assistant 消息持久化、message.completed → `run.completed {stopReason:"end_turn", usage:{…累计…}}`。
8. **渲染收尾**：CLI 渲染完终态事件后回到 readline 提示符；WebUI 同样只依赖这一串事件。daemon 继续常驻，等待下一条消息或 30 秒一次的调度 tick。

---

## 边界与出错

**daemon 崩溃。** JSONL 文件容忍尾部残缺行（进程死在写入中途、只写了一半的行：`repairTornTail`/`readJsonl`，`packages/core/src/storage/jsonl.ts`）。崩溃时在途的定时任务触发，其下一次执行时间（`next_run_at`）已在认领（`claimDue`）时推进——被杀死的这一次不会重放，任务在下个调度点照常触发。「认领即把下次执行时间推进到 now 之后」的语义保证了不会重放积压。

**模型服务彻底失败。** `runAgent` 不抛异常——已产出的部分内容以 `stopReason:"error"` 持久化，随后 `llm.failed {willRetry:false}` 与 `run.failed` 收尾。瞬时错误由 provider 层的 `withRetry`（3 次尝试）内部消化，外部只能看到 `llm.failed {willRetry:true}` 事件。

**取消。** WS 帧 `run.cancel` → `RunManager.cancel` 只中止当前 run（有活跃 run 就直接 `abort()`，没有则返回 false）→ 循环在下一个检查点以 `stopReason:"aborted"` 终止。**排队中的消息不受 run.cancel 影响**，取消排队一律走 WS `queue.cancel`：wait 状态随时可取消，steer 在注入前可取消，已注入的进入了 JSONL 历史，不删除。确认等待中收到 abort 不算「超时拒绝」（不发 `confirmation.resolved`）。

**已知限制。** exec 的权限规则按归一化命令匹配（空白折叠、命令取文件名，`/bin/rm` 与 `rm` 视为同一个），含接续符（`;` `&&` `||` `|`、换行、命令替换 `$(...)`/反引号）的命令不再命中 allow 规则会话授权（回落到逐次确认；exec 沙箱可用时改由沙箱接手，见 [permissions](./core/permissions.md) 第 7 节），deny 则对每个子命令分别匹配。但 flag 重排（`-r -f` 与 `-rf`）和引号内的分隔符仍识别不了——规则是尽力而为的防线。真正的运行时保底是 exec 外面套的操作系统级沙箱：工作区与临时目录可写、家目录只读且 `~/.kclaw` 被遮蔽（见 [sandbox](./core/sandbox.md)）。fs 的边界与路径规则已按 realpath（解析符号链接后的真实路径）处理：经 symlink 逃逸出边界的操作落到逐次确认，deny 无法经 symlink 绕过。CLI 的 respawn 目标解析假定源码仓库布局（`packages/cli` 与 `packages/server` 相邻）——独立分发包由 kclaw 包的 esbuild 产物解决。

---

## 关联

- [protocol](./core/protocol.md)：Message/Block/Event 三层协议与 ID 体系
- [agent-loop](./core/agent-loop.md)：run 生命周期状态机与工具回合
- [daemon](./server/daemon.md)：daemon 装配序、有界 stop、pidfile 语义
- [run-manager](./server/run-manager.md)：服务端侧的会话串行与确认网关
- [http-api](./server/http-api.md)：44 条业务路由清单（含附件/用量/目录浏览/MCP 状态/记忆管理/技能/钩子/权限）
- [mcp](./core/mcp.md)：条件装配的 MCP 工具适配器
- [skills](./core/skills.md)：技能包机制（渐进披露、双作用域、点名隐式包装）
- [hooks](./core/hooks.md)：钩子系统（14 位置网格、HookChain 注册接口、用户文件装载、内置钩子清单）
- [storage](./core/storage.md)：`<home>` 布局、config 与 usage.db 用量记录
- [webui](./web/webui.md)：WebUI 视图、token 引导与 PWA 外壳
- [cli](./cli/cli.md)：REPL 渲染契约与断线重连
- [client-http](./core/client-http.md)：CLI/WebUI 共享的 HTTP 请求基座（`@kclaw/core/client-http`）
