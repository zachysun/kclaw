# kclaw 核心原理：Daemon 与 CLI（P3）

> 本文阐述 `@kclaw/server`（常驻 daemon）与 `@kclaw/cli` 的核心逻辑。承接 `docs/core-internals.md`（P1：引擎）与 `docs/persistence-and-tools.md`（P2：持久化与工具）。

## 1. 进程模型：为什么一个 daemon

P1 的分析结论在这里落地：**"用户在场 + 进程活着"不能总是同时满足**。daemon 是唯一的状态权威——CLI 可以随时断开，定时任务在无客户端时照跑，WebUI（P4）只是又一个订阅者。

```
kclaw CLI ─┐                                        ┌─ 会话/任务/配置（HTTP）
           ├─ 127.0.0.1:port，Bearer token ─────────┤
（WebUI）──┘   WS：subscribe + 事件广播 + 命令        └─ 事件流（28 种 AgentEvent 直通）
```

**鉴权设计**：首启生成 UUID token（0600 存 `<home>/token`），HTTP 走 `Authorization: Bearer`（恒时比较），WS 走首帧 auth。`/health` 是唯一豁免端点——CLI 靠它探测存活。

## 2. 事件总线：协议直通

`EventBus` 是 daemon 的心脏，但实现刻意简单：`Map<sessionId, Set<socket>>`。两条规则：

1. **emit 只发给订阅了该 sessionId 的 socket**；无 sessionId 的事件（`job.*`）广播全体；
2. **信封零变形**——P1 的 `AgentEvent` 对象从 runAgent 的 onEvent 一路 `JSON.stringify` 到线上，daemon 不翻译、不改写、不发明事件。ack/error 帧是命令通道（无 id/ts/payload），与事件流清晰二分。

per-socket 投递有 try/catch 守卫：一个坏 socket 不能阻断其他订阅者，也不能把健康的定时任务误标失败。

## 3. RunManager：装配与并发

`send_message` 之后发生的事（`server/src/run.ts`）：

```
WS send_message → 校验(session 存在) → 立即 ack（不等 run）
  → RunManager.enqueue（同会话 promise 链排队，跨会话并发）
    → memory.search(userText 前200字符, top5) 命中 → user 消息附 note 块
    → sessions.appendMessage(user) → runAgent(userMessage=..., history, deps)
    → onEvent → bus.emit；onMessage → appendMessage；审计经 gate 适配器
```

三个值得记住的细节：

- **ack 即时性是结构性保证**：enqueue 不被 await，测试用受控挂起的 llm 证明 ack 在 run.started 之前到达——长任务不能阻塞命令通道。
- **同会话串行靠 promise 链尾巴**（`tail.then(() => undefined, () => undefined)` 吞两端结果）——一次失败不断链，后续消息照常处理。
- **确认流的审计与 loop 竞速镜像**：loop 内部对 resolver 做 `Promise.race(超时)`，审计适配器内部做**同样的** race——两边同超时时结果一致，迟到的人工裁决被 race 丢弃，审计永远不会把超时拒绝归因于人（或反之）。

## 4. 确认网关：人机协作的异步化

`ConfirmationBroker` 的关键决定：**它不发事件、不管超时，只做桥**。

- loop（P1）已经发 `confirmation.requested`/`resolved` 并自行竞速超时——broker 若再发就是重复事件；
- broker 只维护 `confirmationId → pending promise`，WS 的 `confirmation.resolve` 命令 settle 它；
- gate 签发的 id 贯穿全链（事件里的 id = 客户端要 resolve 的 id）。

于是"分级确认"从同步问答变成了异步消息流：CLI/WebUI 弹卡片 → WS 命令 → loop 继续。这正是 spec §9 的设计意图。

## 5. 调度 tick：定时任务如何变成会话

`startSchedulerTick` 每 30s（默认）查 `due(now)`：

```
due job → in-flight 防重入（同步块内 add，结构性无窗口）
  → sessions.create(job.name, job.id)（每次触发新会话）
  → user 消息 = job.prompt + note 块(kind:"job", 「任务名」触发)
  → run.enqueue(trigger:"job") → settle 后 markRun(ok|error) + job.completed|failed
```

**跳过积压**来自 P2 的 markRun 语义：nextRunAt 推进到 *now 之后* 的下一次——daemon 停机两小时不会重放 24 次。**in-flight 槽在 finally 清除**：失败的 job 下一 tick 还能重试。

## 6. daemon 生命周期与自愈

- `launchDaemon` 装配序固定：paths → config → token → stores（**memory.reconcile() 启动对账**——手改/删除的 markdown 笔记在启动时感知）→ llm → RunManager → app → listen(127.0.0.1) → daemon.json{port,pid} → tick。
- **pidfile 的活性检查在 CLI 侧**（daemon-ctl）：daemon.json 存在但 health 不通且 pid 已死（`process.kill(pid,0)` ESRCH）→ 判定 stale、安全 respawn。pid≤0 被拒——`kill(0)` 会信号整个进程组。
- **stop 的诚实性**：轮询预算耗尽而端口仍应答 → 不删 pidfile、报 "stop failed"、exit 1。宁可失败也不谎报 "stopped"（谎报会诱发双 daemon → job 双触发 → 双倍 LLM 花费）。

## 7. CLI：一个纯客户端的自愈 REPL

`kclaw`（默认进 chat）的核心循环：readline 输入 → WS send_message → 渲染事件流直到 run 终态。

- **渲染契约**：text.delta 直接写 stdout（真流式）；`⚡ tool args` / `↳ status (duration) 摘要` 的工具卡片；confirmation.requested 弹 @clack 确认。
- **断线自愈的 resend-once 规则**：发送后观察到**零帧**（连 ack 都没有）才重发——零帧证明消息从未到达活着的 daemon；一旦看到 ack（服务器已入队）就绝不重发。场景 D 测试用 SIGKILL 杀 daemon 构造确定性断链。
- **SIGINT 双击**：第一次 run.cancel（可恢复），第二次退出。
- **测试策略**：execa 驱动构建产物 + 真 daemon + 本地 mock OpenAI SSE 服务器——CLI 测试跑的是真实产品路径，不是 mock 的替身。

## 8. 已知边界（P4-prep 清单）

- provider 流无超时（黑洞 SSE → 挂死 run → stop 无界）→ 需 AbortSignal 超时与有界 stop（防双 daemon 复合链）
- 用户消息与记忆/job note 无事件发射（CLI 自回显掩盖；web 实时视图需要 `message.created`+`note.emitted` 补发）
- 静态托管在 Bearer 后——浏览器发不了 Authorization 头，P4 需 cookie 引导或豁免 index.html 仅 API 鉴权
- npm 打包：bin 解析假定 repo checkout；job 失败 lastError 无诊断信息；多会话并行上限未实现
