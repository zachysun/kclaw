# architecture — 全局总纲

## 职责

kclaw 是一个本地常驻的个人 agent：一个 daemon 进程独占全部状态（会话、任务、记忆、配置），CLI 与 WebUI 只是它的客户端。本文给出模块地图、进程模型与一次消息的完整数据流，是其余各篇的入口；每包/每子系统的内部逻辑见 `core/`、`server/`、`cli/`、`web/` 下的分篇。

---

## 设计决策

- **单 daemon 多客户端**：CLI 可以随时退出，daemon 不受影响；定时任务在无客户端时照常执行。daemon 是唯一状态权威，客户端不持久化（写入磁盘长期保存）任何业务状态。
- **core 是纯库**：`@kclaw/core` 不依赖 fastify/ws/commander，不感知 HTTP/WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）的存在。LLM（`deps.llm`）、工具执行、事件出口（`deps.onEvent`）、持久化（`deps.onMessage`）全部注入，整个 agent 循环可用 mock 离线测试。
- **daemon 只绑 loopback（本机回环地址，外部网络访问不到）**：`HOST = "127.0.0.1"`（`packages/server/src/daemon.ts` 与 `packages/cli/src/daemon-ctl.ts` 各自硬编码），默认绑临时端口（`port: 0`），端口与 pid 写入 `<home>/daemon.json`，鉴权靠 `<home>/token` 里的 Bearer token（放在 HTTP `Authorization` 请求头里的访问令牌）。
- **实时事件不持久化，持久化的是 events.jsonl 事件流**：WS 上推送的增量事件（text.delta、message.created 等）不落盘、不重发、不回放；会话的持久化形式是 events.jsonl 事件流（唯一真相，message / compaction / memory / system 等业务事件都在这里）与 meta.json 投影（见 [storage](./core/storage.md)）。客户端断线恢复 = HTTP 拉全量消息 + 只订阅新事件（详见 [protocol](./core/protocol.md)）。
- **WebUI 是独立产物**：`@kclaw/web` 的运行时依赖只有 react/react-dom、`@kclaw/core`（`commands` 共享表——纯数据：slash 命令的 name/usage 元数据，见 [extending](./extending.md)；`protocol` 子路径出口——线上形状的类型正本）以及 react-virtuoso（审计页的虚拟滚动列表库，见 [webui](./web/webui.md)），构建为静态文件后由 daemon 托管（`resolveWebDist` → `packages/web/dist`）。

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

依赖方向唯一：`core ← server`、`core ← cli`。`web` 只依赖 core 的 `commands`/`protocol` 子路径出口（纯数据/纯类型，不含 agent 引擎）与 react-virtuoso，`kclaw` 只在构建期聚合。

### 各包内部结构

| 包 | 入口 | 内容 |
|----|------|------|
| core | `packages/core/src/index.ts` | 入口统一导出 14 个子目录：`protocol/`（消息/块/事件/WS 指令帧/会话事件/ID——线上形状的类型正本，经 `@kclaw/core/protocol` 子路径出口供三端引用）、`provider/`（OpenAI 兼容客户端+重试）、`agent/`（循环+上下文组装+工具契约+单 run 装配 `run-assembly.ts` 的 `executeRun`）、`hooks/`（钩子系统：14 位置网格 + HookChain 注册接口 + 用户文件装载 + 内置钩子，见 [hooks](./core/hooks.md)）、`storage/`（路径/配置/JSONL，即每行一条 JSON 的文本文件；含用量台账 `usage.ts` 与沉淀权限规则文件 `decided-rules.ts`）、`session/`（SessionStore 与上下文压缩：估算/分界/渲染纯函数、事件溯源存储、压缩引擎 `Compactor`、自动命名；`session_search` 直接扫事件流）、`permissions/`（ConfigPermissionGate + 确认网关 ConfirmationBroker）、`memory/`（MemorySystem：L1 项目情节 + L2 全局认知 + FTS5/向量索引，见 [memory](./core/memory.md)）、`text/`（共享中文分词器与 FTS 辅助）、`tools/`（12 个内置工具）、`skills/`（技能包解析/双作用域扫描/点名匹配，见 [skills](./core/skills.md)）、`jobs/`（JobScheduler）、`mcp/`（MCP 客户端管理器）、`notify/`（任务完成通知）；根级 `bus.ts`（EventBus 进程内事件分发）与 `client-http.ts`（CLI/WebUI 共享的 HTTP 请求基座：Bearer 注入、错误体提取、204/空响应处理，经 `@kclaw/core/client-http` 子路径出口；不 import 任何 Node 专属模块，浏览器可直接打包）；另有内部模块 `sandbox/`（exec 的 OS 沙箱：Seatbelt/bwrap 探测与包装，见 [sandbox](./core/sandbox.md)）不经入口导出、由 run 装配直接 import |
| server | `packages/server/src/index.ts` | `app.ts`（createApp 装配）、`daemon.ts`（launchDaemon）、`auth.ts`（token）、`run.ts`（RunManager 队列状态机；单 run 装配在 core 的 `executeRun`）、`subagent.ts`（子代理 spawner：子会话创建、状态行与确认转发，见 [subagents](./core/subagents.md)）、`command-check.ts`（WS 命令帧的唯一校验点）、`ws.ts`（/ws 协议）、`scheduler-tick.ts`、`memory-scheduler.ts`（记忆定时/跟随兜底调度）、`routes/`（sessions/attachments/jobs/config/fs/usage/memory/skills/hooks/permissions） |
| cli | `packages/cli/src/index.ts` | commander 命令树（默认进 chat）；`chat.ts`（REPL+渲染+@引用展开）、`client.ts`（KclawClient）、`daemon-ctl.ts`（探测/启动/停止）、`slash.ts`、`file-refs.ts`、`wizard.ts`、`provider-check.ts`、`web-cmd.ts` |
| web | `packages/web/src/main.tsx` | 视图（chat/sessions/jobs/audit/usage/trash/memory/skills/permissions + DirectoryPicker）、离线外壳（`sw.js`/manifest/OfflineBanner）、`ws.ts`（WS 客户端）、`token.ts`（token 引导） |

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

- **CLI 启动 daemon（respawn，即发现不在时自动重启）**：任何客户端命令经 `KclawClient.connect()` → `ensureDaemon()`（`packages/cli/src/daemon-ctl.ts`），按探测结果分三种情况：
  - daemon.json 健康 → 直接使用。
  - 文件在、`/health` 不通且 pid 已死（ESRCH）→ 判定失效（stale），`spawnDaemon` 分叉启动（detached、stdio ignore、unref，目标脚本由 `resolveServerBin()` 解析到 `packages/server/bin/kclaw-server.mjs`），再轮询健康（预算 5s、间隔 250ms、单次探测超时 1s）。
  - pid 仍在运行但不健康 → 只等待、不重复启动（防孤儿 daemon）。
- **daemon 就绪信号**：`launchDaemon` 第一步即以 `wx` 独占认领 `<home>/daemon.json`（占位 `{port: 0, pid, startedAt, starting: true}`；存活 pid 拒绝二次启动，死 pid 回收重认领），listen 成功后回填 `{port, pid, startedAt}`；bin 脚本向 stdout 打一行 `{"port":<port>}`。
- **停止**：SIGTERM/SIGINT 走有界 stop（每步默认 60s 超时），stop 失败保留 daemon.json（进程仍在运行，pidfile 必须如实反映）。
- **状态全部在 `<home>`**（`KCLAW_HOME` ?? `~/.kclaw`，`resolvePaths` in `packages/core/src/storage/paths.ts`）：`config.yaml`、`AGENTS.md`、`token`、`daemon.json`、`permissions.yaml`（全局沉淀权限规则，见 [permissions](./core/permissions.md)）、`sessions/`、`memory/`（记忆塔：`global/`（persona/wiki/rule 认知文件）+ `projects/<id>/`（主题线文件），各带 `vectors.db` 检索索引；见 [memory](./core/memory.md)）、`skills/`（全局技能包目录，项目级技能在工作区 `.kclaw/skills/`，见 [skills](./core/skills.md)）、`hooks/`（用户钩子目录，每 run 现扫，见 [hooks](./core/hooks.md)）、`jobs.db`、`usage.db`、`attachments/`、`commands/`、`logs/`。

---

## 数据流总览

一次用户消息（含工具与确认）从输入到持久化、广播、渲染的全链路：

```
用户输入（CLI readline / WebUI 输入框）
  → WS 帧 {type:"send_message", sessionId, text, disposition?, attachments?}   packages/server/src/ws.ts
  → 校验 session 存在与附件引用 → 立即回 send_message_ack {messageId, queued}（不等 run）
  → RunManager.submit 三处置决策（空闲直发 / steer 入缓冲 / wait·interrupt 入队）
      packages/server/src/run.ts（每会话显式队列 + 驱动器循环）
      ├─ 空闲直发：立即起 run，queued:false（不广播 message.queued）
      ├─ steer（有活动 run）：入引导缓冲，广播 message.queued，迭代边界注入（见下）
      ├─ wait：排队，广播 message.queued，当前 run 结束后出队执行
      └─ interrupt：abort 当前 run + 插队首，广播 message.queued
      （以下装配在 core 的 executeRun：packages/core/src/agent/run-assembly.ts）
      ├─ 附件引用挂载为 attachment 块（多模态/内联文本/fs_read 提示三态）
      ├─ 模型三级解析 input.model → session meta → 默认（条目名→线上模型名）
      ├─ memory.searchEpisodes(用户文本前 200 字符, top 5) → note 块注入用户消息
      │    另经 cognitionPrompt(workdir) 把 L2 全局认知拼进系统提示（见 memory.md）
      ├─ 技能目录现扫（全局 <home>/skills + 工作区 .kclaw/skills）→ 技能清单追加进
      │    系统提示（AGENTS.md + 认知 + 技能列表，见 skills.md）；trigger:user 时对
      │    用户消息做技能点名检测（任意位置 /技能名）→ 生成模型视图改写文本
      ├─ 读 history（在追加用户消息之前）→ createBuiltinTools（含 skill_read）+ extraTools(MCP)
      │    → ConfigPermissionGate（readRoots=附件目录；mode 与 decidedRules 逐 run 从会话 meta 与磁盘读入）
      └─ runAgent(...)                                     packages/core/src/agent/loop.ts
           ├─ llm.stream(await buildMessages())：toProviderMessages(history, window=200)
           │     ← 上下文组装 agent/context.ts；llm-before 钩子链只改模型看到的输入
           │       （技能点名包装 = 内置 skill-wrap 钩子，经 withLastUserText 锚定最后一条 user 消息）
           ├─ 流式事件 text/thinking/tool_call created→delta→…
           ├─ stopReason=tool_use → 权限检查 check(toolCall)          permissions/engine.ts
           │    confirm → confirmation.requested 事件 → 客户端弹确认
           │            ← WS 帧 {type:"confirmation.resolve", confirmationId, decision}
           │            → ConfirmationBroker.resolve → 循环继续   core/src/permissions/broker.ts
           ├─ 工具执行（parallel 组并发 + serial 组串行）→ tool_result 块
           ├─ turn-boundary 钩子链（内置 steering-drain）取走引导缓冲消息逐条注入
           │    message.created → onMessage 持久化 → message.completed → message.steered
           └─ 回到下一轮 LLM 调用，直到 end_turn
  ├─ 引擎（executeRun）拼装系统提示词后（进入模型循环前）→ SessionStore.appendSystem → sessions/<id>/events.jsonl
  │    （追加 system 事件全量留痕，每 run 恰好一条；不折进投影、不上总线，写入失败即本次 run 失败）
  ├─ deps.onMessage → SessionStore.appendMessage → sessions/<id>/events.jsonl（追加 message 事件 + 折进 meta.json 投影）
  └─ deps.onEvent  → bus.emit → JSON.stringify → 只发订阅了该 sessionId 的 socket
                                                          packages/core/src/bus.ts
  → run 收尾（run-after 钩子链）：usage.db 记一行用量（失败仅日志）；memory.write.idleMinutes>0 时挂一个
    跟随门禁检查（记忆由 memory_save 与定时/跟随调度器沉淀，见 memory.md）；
    黄线水位收尾压缩（fatal）；非 job 首条消息触发 autoname（成功更名广播 session.renamed）
  → 客户端渲染（CLI 写 stdout；WebUI 更新 React 状态）→ run.completed 终态
```

两条不变量贯穿全链：

- **先持久化后广播**：事件反映的是已持久化状态。
- **ack 与 run 解耦**：send_message 的 ack 在 run.started 之前就返回，长任务不阻塞命令通道。

---

## 端到端走读：一条"列出并改写文件"消息

设用户在 CLI 输入：`把 src 里的 TODO 改成 FIXME`。会话 `ses_…` 已存在。

1. **入队**：CLI 经已认证 WS 发 `send_message`；`ws.ts` 查 `sessions.meta(sessionId)` 存在 → `run.submit(sessionId, {userText, trigger:"user"})` 同步决策去向（空闲直发 / 入队 / 入引导缓冲）→ 立即回 `send_message_ack {messageId, queued}`（不 await run）。
2. **装配**（core `executeRun`）：记忆检索命中 0 条 → 读 history → 用户消息以纯 text 骨架（先建空壳消息、块随后补全）传入 `RunInput.userMessage`；run-before 钩子链（内置 memory-inject → user-message-land）补 note 块并 `appendMessage` 持久化；事件序为 `run.started → message.created → note.emitted ×N → message.completed`。
3. **第一轮 LLM**：`llm.started {attempt:1}` → assistant 骨架 `message.created` → 模型流式产出 tool_call：`tool_call.created` → 若干 `tool_call.delta` → 流结束 `llm.completed {stopReason:"tool_use"}` → `tool_call.completed`（此刻才 `JSON.parse(argsJson)`）。
4. **权限检查**：`fs_read` 是 safe 工具直接放行（`grantedBy:"safe"`）；`fs_write` 命中 confirm → 循环发 `confirmation.requested {confirmationId:"conf_…", toolCall, risk:"sensitive", expiresAt}` 并挂起等待，`raceConfirmation` 同时竞速人工裁决、120s 超时、run 的 abort 信号。
5. **人机回合**：CLI 收到事件弹 @clack 四项确认框（允许（仅本次）/总是允许（本项目）/总是允许（全局）/拒绝）；用户选「总是允许（本项目）」→ CLI 回 `confirmation.resolve {confirmationId, decision:"project"}` → ws.ts 先把 toolCall 收窄成规则落进项目档 `.kclaw/permissions.yaml`、再 `broker.resolve` → 循环发 `confirmation.resolved {decision:"project", by:"cli"}`，`grantedBy:"confirmed"`（"总是允许"两档的沉淀机制见 [permissions](./core/permissions.md)）。
6. **执行与结果消息**：`fs_read`（parallel）与 `fs_write`（serial）分组调度——并行组经 `Promise.allSettled` 等待全部完成后，串行组逐个执行；每个结果 `tool_result.created → (delta) → completed`；结果块按模型给定顺序组成一条 `role:"tool"` 消息，`onMessage` 持久化后广播 `message.completed`。
7. **第二轮 LLM**：带上完整工具结果再次调用；模型输出文本总结 → `end_turn` → assistant 消息持久化、`message.completed` → `run.completed {stopReason:"end_turn", usage:{…累计…}}`。
8. **渲染收尾**：CLI 渲染完终态事件后回到 readline 提示符；WebUI 同样只依赖这串事件。daemon 继续常驻，等待下一条消息或 30s 一次的调度 tick。

---

## 边界与出错

- **daemon 崩溃**：JSONL 容忍尾部残缺行（只写了一半的行；`repairTornTail`/`readJsonl`，`packages/core/src/storage/jsonl.ts`）；在途 job 的该次触发已在认领（`claimDue`）时推进 `next_run_at`，被杀死的这一次不会重放，job 在下个调度点照常触发——"认领即推进到 now 之后下一次"的语义保证不重放积压。
- **provider 彻底失败**：`runAgent` 不 reject——部分内容以 `stopReason:"error"` 持久化，`llm.failed {willRetry:false}` + `run.failed` 收尾；瞬时错误由 provider 层 `withRetry`（3 次尝试）内部消化并以 `llm.failed {willRetry:true}` 事件可见。
- **取消**：WS `run.cancel` → `RunManager.cancel` 只中止当前 run（活跃 run 直接 `abort()`，无活跃 run 返回 false）→ 循环在下一个检查点以 `stopReason:"aborted"` 终止；**排队消息不受影响**，排队取消一律走 WS `queue.cancel`（wait 随时可取消、steer 注入前可取消，已注入的进了 JSONL 历史不删）。确认等待中的 abort 不是"超时拒绝"（不发 `confirmation.resolved`）。
- **已知限制**：exec 规则按归一化命令匹配（空白折叠、命令取 basename，`/bin/rm` ≡ `rm`），含接续符（`;` `&&` `||` `|`、换行、命令替换 `$(...)`/反引号）的命令不再命中 allow/会话授权（回退 confirm；exec 沙箱可用时改由沙箱顶替人工放行，见 [permissions](./core/permissions.md) 第 7 节），deny 对每个子命令分别匹配——但 flag 重排（`-r -f` 与 `-rf`）与引号内分隔符仍不识别，规则是尽力而为的防线；真正的运行时兜底是批次 A 起为 exec 套的 OS 沙箱（工作区与临时目录可写、家目录只读且 `~/.kclaw` 遮蔽，见 [sandbox](./core/sandbox.md)）；fs 边界与路径规则已按 realpath 解析（symlink 逃逸落到 confirm，deny 无法经 symlink 绕过）；CLI 的 respawn 目标解析假定 repo checkout（`packages/cli` 与 `packages/server` 相邻）——独立分发包由 `kclaw` 包的 esbuild 产物解决。

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
- [storage](./core/storage.md)：`<home>` 布局、config 与 usage.db 台账
- [webui](./web/webui.md)：WebUI 视图、token 引导与 PWA 外壳
- [cli](./cli/cli.md)：REPL 渲染契约与断线重连
- [client-http](./core/client-http.md)：CLI/WebUI 共享的 HTTP 请求基座（`@kclaw/core/client-http`）
