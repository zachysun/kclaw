# architecture — 全局总纲

## 职责

kclaw 是一个本地常驻的个人 agent：一个 daemon 进程独占全部状态（会话、任务、记忆、配置），CLI 与 WebUI 只是它的客户端。本文给出模块地图、进程模型与一次消息的完整数据流，是其余各篇的入口；每包/每子系统的内部逻辑见 `core/`、`server/`、`cli/`、`web/` 下的分篇。

## 设计决策

- **单 daemon 多客户端**：CLI 可以随时退出，daemon 不受影响；定时任务在无客户端时照跑。daemon 是唯一状态权威，客户端不持久化（写入磁盘长期保存）任何业务状态。
- **core 是纯库**：`@kclaw/core` 不依赖 fastify/ws/commander，不感知 HTTP/WS（WebSocket：建立后可双向收发消息的长连接，服务器能主动推送）的存在。LLM（`deps.llm`）、工具执行、事件出口（`deps.onEvent`）、持久化（`deps.onMessage`）全部注入，整个 agent 循环可用 mock 离线测试。
- **daemon 只绑 loopback（本机回环地址，外部网络访问不到）**：`HOST = "127.0.0.1"`（`packages/server/src/daemon.ts` 与 `packages/cli/src/daemon-ctl.ts` 各自硬编码），默认绑临时端口（`port: 0`），端口与 pid 写入 `<home>/daemon.json`，鉴权靠 `<home>/token` 里的 Bearer token（放在 HTTP `Authorization` 请求头里的访问令牌）。
- **事件不持久化、消息才持久化**：客户端断线恢复 = HTTP 拉全量消息 + 只订阅新事件（详见 [protocol](./core/protocol.md)）。
- **WebUI 是独立产物**：`@kclaw/web` 不依赖任何 workspace 包（只依赖 react/react-dom），构建为静态文件后由 daemon 托管（`resolveWebDist` → `packages/web/dist`）。

## 模块地图

```
kclaw（发布包：esbuild 打包 cli+server+web 产物，bin: app/cli/cli.js）
 │
 ├── @kclaw/core     纯库，agent 引擎（server 与 cli 都依赖它）
 ├── @kclaw/server   daemon：Fastify app + RunManager + 事件总线（依赖 core）
 ├── @kclaw/cli      客户端：REPL / daemon 控制（依赖 core 的类型、ws、commander）
 └── @kclaw/web      客户端：React SPA（不依赖 workspace 包，vite 独立构建）
```

依赖方向唯一：`core ← server`、`core ← cli`。`web` 与三者零耦合，`kclaw` 只在构建期聚合。

### 各包内部结构

| 包 | 入口 | 内容 |
|----|------|------|
| core | `packages/core/src/index.ts` | 入口统一导出 9 个子目录：`protocol/`（消息/块/事件/ID）、`provider/`（OpenAI 兼容客户端+重试）、`agent/`（循环+上下文组装+工具契约）、`storage/`（路径/配置/JSONL，即每行一条 JSON 的文本文件）、`session/`（SessionStore）、`permissions/`（ConfigPermissionGate）、`memory/`（MemoryStore）、`tools/`（9 个内置工具）、`jobs/`（JobScheduler） |
| server | `packages/server/src/index.ts` | `app.ts`（createApp 装配）、`daemon.ts`（launchDaemon）、`auth.ts`（token）、`bus.ts`（EventBus）、`run.ts`（RunManager）、`confirm.ts`（ConfirmationBroker）、`ws.ts`（/ws 协议）、`scheduler-tick.ts`、`routes/`（sessions/jobs/config）、`autoname.ts` |
| cli | `packages/cli/src/index.ts` | commander 命令树（默认进 chat）；`chat.ts`（REPL+渲染）、`client.ts`（KclawClient）、`daemon-ctl.ts`（探测/启动/停止）、`slash.ts`、`wizard.ts`、`provider-check.ts`、`web-cmd.ts` |
| web | `packages/web/src/main.tsx` | 视图（chat/sessions/jobs/audit/trash）、`ws.ts`（WS 客户端）、`token.ts`（token 引导） |

## 进程模型

```
┌─ kclaw daemon（常驻进程，唯一状态权威）───────────────────────┐
│  127.0.0.1:<port>  （port 写入 <home>/daemon.json）            │
│  HTTP: /health /status /sessions* /jobs* /config （Bearer）     │
│  WS:   /ws（首帧 auth 或 ?token=；subscribe + 命令 + 事件流）   │
│  常驻: RunManager（会话串行 run）· scheduler tick（默认 30s）   │
└────────────┬────────────────────────┬────────────────────────┘
             │ HTTP+WS                │ HTTP+WS
      ┌──────┴──────┐          ┌──────┴──────┐
      │ kclaw CLI   │          │ 浏览器 WebUI │
      │ (REPL, 可退出)│         │ (daemon 托管)│
      └─────────────┘          └─────────────┘
```

- **CLI 启动 daemon（respawn，即发现不在时自动重启）**：任何客户端命令经 `KclawClient.connect()` → `ensureDaemon()`（`packages/cli/src/daemon-ctl.ts`）——daemon.json 健康 → 直接用；文件在但 `/health` 不通且 pid 已死（ESRCH）→ 判定失效（stale）、`spawnDaemon` 分叉启动（detached、stdio ignore、unref，目标脚本由 `resolveServerBin()` 解析到 `packages/server/bin/kclaw-server.mjs`）再轮询健康（预算 5s、间隔 250ms、单次探测超时 1s）；pid 活着但不健康 → 只等待、不重复启动（防孤儿 daemon）。
- **daemon 就绪信号**：`launchDaemon` 装配完成、listen 成功后写 `<home>/daemon.json` `{port, pid, startedAt}`；bin 脚本向 stdout 打一行 `{"port":<port>}`。SIGTERM/SIGINT 走有界 stop（每步默认 60s 超时），stop 失败保留 daemon.json（进程还活着，pidfile 必须诚实）。
- **状态全部在 `<home>`**（`KCLAW_HOME` ?? `~/.kclaw`，`resolvePaths` in `packages/core/src/storage/paths.ts`）：`config.yaml`、`AGENTS.md`、`token`、`daemon.json`、`sessions/`、`memory/`（`notes/` + `index.db`）、`jobs.db`、`attachments/`、`logs/`。

## 数据流总览

一次用户消息（含工具与确认）从输入到持久化、广播、渲染的全链路：

```
用户输入（CLI readline / WebUI 输入框）
  → WS 帧 {type:"send_message", sessionId, text}          packages/server/src/ws.ts
  → 校验 session 存在 → 立即回 send_message_ack（不等 run）
  → RunManager.enqueue（同会话 promise 链排队；跨会话并发） packages/server/src/run.ts
      ├─ memory.search(用户文本前 200 字符, top 5) → note 块注入用户消息
      ├─ 读 history（在追加用户消息之前）→ createBuiltinTools → ConfigPermissionGate
      └─ runAgent(...)                                     packages/core/src/agent/loop.ts
           ├─ llm.stream(toProviderMessages(history, window=40))   ← 上下文组装 agent/context.ts
           ├─ 流式事件 text/thinking/tool_call created→delta→…
           ├─ stopReason=tool_use → 权限检查 check(toolCall)          permissions/engine.ts
           │    confirm → confirmation.requested 事件 → 客户端弹确认
           │            ← WS 帧 {type:"confirmation.resolve", confirmationId, approved}
           │            → ConfirmationBroker.resolve → 循环继续      server/src/confirm.ts
           ├─ 工具执行（parallel 组并发 + serial 组串行）→ tool_result 块
           └─ 回到下一轮 LLM 调用，直到 end_turn
  ├─ deps.onMessage → SessionStore.appendMessage → sessions/<id>/messages.jsonl
  └─ deps.onEvent  → bus.emit → JSON.stringify → 只发订阅了该 sessionId 的 socket
                                                          packages/server/src/bus.ts
  → 客户端渲染（CLI 写 stdout；WebUI 更新 React 状态）→ run.completed 终态
```

两条不变量贯穿全链：**先持久化后广播**（事件反映的是已持久化状态）；**ack 与 run 解耦**（send_message 的 ack 在 run.started 之前就返回，长任务不阻塞命令通道）。

## 端到端走读：一条"列出并改写文件"消息

设用户在 CLI 输入：`把 src 里的 TODO 改成 FIXME`。会话 `ses_…` 已存在。

1. **入队**：CLI 经已认证 WS 发 `send_message`；`ws.ts` 查 `sessions.meta(sessionId)` 存在 → 回 `send_message_ack` → `run.enqueue(sessionId, {userText, trigger:"user"})`（不 await）。
2. **装配**（`RunManager.#execute`）：记忆检索命中 0 条 → 读 history → 用户消息以纯 text 骨架（先建空壳消息、块随后补全）传入 `RunInput.userMessage`；`onUserMessage` 钩子里补 note 块并 `appendMessage` 持久化；事件序为 `run.started → message.created → note.emitted ×N → message.completed`。
3. **第一轮 LLM**：`llm.started {attempt:1}` → assistant 骨架 `message.created` → 模型流式吐出 tool_call：`tool_call.created` → 若干 `tool_call.delta` → 流结束 `llm.completed {stopReason:"tool_use"}` → `tool_call.completed`（此刻才 `JSON.parse(argsJson)`）。
4. **权限检查**：`fs_read` 是 safe 工具直接放行（`grantedBy:"safe"`）；`fs_write` 命中 confirm → 循环发 `confirmation.requested {confirmationId:"conf_…", toolCall, risk:"sensitive", expiresAt}` 并挂起等待，`raceConfirmation` 同时竞速人工裁决、120s 超时、run 的 abort 信号。
5. **人机回合**：CLI 收到事件弹 @clack 确认框；用户批准 → CLI 回 `confirmation.resolve {confirmationId, approved:true}` → broker settle → 循环发 `confirmation.resolved {approved:true, by:"cli"}`，`grantedBy:"confirmed"`。
6. **执行与结果消息**：`fs_read`（parallel）与 `fs_write`（serial）分组调度——并行组经 `Promise.allSettled` 等待全部完成后，串行组逐个执行；每个结果 `tool_result.created → (delta) → completed`；结果块按模型给定顺序组成一条 `role:"tool"` 消息，`onMessage` 持久化后广播 `message.completed`。
7. **第二轮 LLM**：带上完整工具结果再次调用；模型输出文本总结 → `end_turn` → assistant 消息持久化、`message.completed` → `run.completed {stopReason:"end_turn", usage:{…累计…}}`。
8. **渲染收尾**：CLI 渲染完终态事件后回到 readline 提示符；WebUI 同样只依赖这串事件。daemon 继续常驻，等待下一条消息或 30s 一次的调度 tick。

## 边界与出错

- **daemon 崩溃**：JSONL 容忍尾部残缺行（只写了一半的行；`repairTornTail`/`readJsonl`，`packages/core/src/storage/jsonl.ts`）；进行中（in-flight）任务的防重入记录保存在内存里，重启后到期（due）的 job 重新触发，`markRun` 的"now 之后下一次"语义保证不重放积压。
- **provider 彻底失败**：`runAgent` 不 reject——部分内容以 `stopReason:"error"` 持久化，`llm.failed {willRetry:false}` + `run.failed` 收尾；瞬时错误由 provider 层 `withRetry`（3 次尝试）内部消化并以 `llm.failed {willRetry:true}` 事件可见。
- **取消**：WS `run.cancel` → `RunManager.cancel` → `AbortController.abort()` → 循环在下一个检查点以 `stopReason:"aborted"` 终止；确认等待中的 abort 不是"超时拒绝"（不发 `confirmation.resolved`）。
- **已知限制**：glob 白名单不防御 shell 注入（`exec:git diff*` 也匹配 `git diff; curl evil`，敏感场景靠 confirm 人工确认保底）；fs 工具软沙箱是字面（lexical）路径检查、不追 symlink；CLI 的 respawn 目标解析假定 repo checkout（`packages/cli` 与 `packages/server` 相邻）——独立分发包由 `kclaw` 包的 esbuild 产物解决。

## 关联

- [protocol](./core/protocol.md)：Message/Block/Event 三层协议与 ID 体系
- [agent-loop](./core/agent-loop.md)：run 生命周期状态机与工具回合
- [daemon](./server/daemon.md)：daemon 装配序、有界 stop、pidfile 语义
- [run-manager](./server/run-manager.md)：服务端侧的会话串行与确认网关
- [cli](./cli/cli.md)：REPL 渲染契约与断线重连
