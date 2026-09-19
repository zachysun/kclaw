# daemon — 生命周期与鉴权

## 职责

`packages/server/src/daemon.ts` 的 `launchDaemon` 是 daemon 进程的唯一组装入口：把路径、配置、token、各存储、LLM 客户端、MCP 管理器、RunManager、HTTP/WS 应用、调度心跳按固定顺序组装起来并开始监听；返回的 `Daemon` 句柄提供有界的 `stop()`。配套的 `packages/server/src/auth.ts` 负责 token 的生成与校验。CLI 侧的检测/重启/停止逻辑（pid 校验、健康轮询）在 `packages/cli/src/daemon-ctl.ts`，本文同时说明两侧的契约。

## 设计决策

- **只绑回环地址**：`HOST = "127.0.0.1"`（本机回环地址，外部网络访问不到）。daemon 不做网络隔离，安全完全交给 token；绑回环保证其他机器无法连接。
- **端口三级优先级，钉死是显式选择**：listen 端口取 `--port` 旗标 ?? 配置文件 `server.port` ?? `0`（让操作系统分配一个空闲临时端口，历史上的默认行为）。真实端口 listen 成功后从 `app.server.address()` 读出并写入 `daemon.json`，客户端通过文件发现端口。固定端口后 WebUI 地址跨重启稳定；钉住的端口被占用是**硬错误**（退出并报一行原因，绝不静默回退到临时端口——地址悄悄漂移正是固定端口要消灭的东西），listen 失败时同步释放占位 daemon.json，下次启动不会看到僵尸 pid。
- **daemon.json 是独占占位，启动第一步就认领**：组装开始即以 `wx` 原子创建占位 `{port: 0, pid, startedAt, starting: true}`（并发第二个启动者拿到 EEXIST，看到存活 pid 即拒绝"daemon already running"；死 pid 的残留被回收重认领）；listen 成功后回填真实 `{port, pid, startedAt}`（同一 startedAt，`starting` 移除），此时文件才指向可用端口。`launchDaemon` resolve 时 daemon 已在服务并在调度。CLI 侧以"文件出现且 `/health` 可访问"作为就绪判据。
- **token 是 daemon 的稳定身份**：`<home>/token` 首次启动时生成（UUID，文件权限 0600，仅属主可读写），重启复用，stop 不删除；仅 daemon.json 会被删除。因此 CLI/WebUI 保存的 token 在 daemon 重启后仍然有效。
- **鉴权是"每路由必带 Bearer"加白名单豁免**：一个 `preHandler` hook 拦截全部路由，只有三处豁免——`/health`、`/ws`、静态 WebUI 外壳（见下）。豁免列表是封闭集合，新增路由默认受保护。
- **有界停止**：`stop()` 的每一步（停调度、关服务器）有独立超时（默认 60s）。超时则 `stop()` reject、daemon.json **保留**——进程仍在运行，指向它的文件必须与事实一致；虚报"已停止"会诱发双 daemon、job 双触发。
- **provider 缺失是硬错误**：组装期就抛错终止，不启动一个"半配置"的 daemon。
- **MCP 恒定组装，且连接不阻塞启动**：无论配置文件里有没有 server，daemon 都构建一个 `McpManager`（空的管理器没有任何连接、开销为零，管理路由因此永远可用，从 WebUI 添加第一个 server 不需要先改配置）。`mcpManager.start()` 在监听开始之后才调用、并且不等它完成，daemon 照常宣布就绪对外服务，各 server 在后台陆续连上，连上多少就从下一轮 run 起贡献多少工具。连接失败只打一行日志，永远不会拖垮 daemon。

## 接口

```ts
// packages/server/src/daemon.ts
export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000   // 调度心跳周期
export const DEFAULT_STOP_TIMEOUT_MS = 60_000         // stop() 每步的超时

export interface Daemon {
  port: number        // 实际绑定的端口（0 启动时为临时端口）
  token: string       // app 要求的 Bearer token（<home>/token）
  pid: number         // 本进程 pid，即 daemon.json 里记录的
  stop(): Promise<void>   // 有界拆除：tick → 记忆调度器 → 飞书频道（启用时）→ mcp → app → memory → usage.close → 删 daemon.json；幂等（重复调用立即 resolve）
}

export interface LaunchDaemonOptions {
  home?: string                    // KCLAW_HOME ?? ~/.kclaw
  config?: KclawConfig             // 默认 loadConfig(resolvePaths(home))
  llmFactory?: (cfg: KclawConfig) => LlmClient   // 默认按 provider 解析规则构造
  port?: number                    // 显式覆盖（bin 的 --port 旗标）?? 配置 server.port ?? 0（临时端口）
  schedulerIntervalMs?: number     // 默认 30s
  stopTimeoutMs?: number           // 默认 60s；测试注入 50ms
  webDist?: string                 // 静态托管的 WebUI 目录
}

export async function launchDaemon(opts: LaunchDaemonOptions = {}): Promise<Daemon>
```

```ts
// packages/server/src/auth.ts
export function loadOrCreateToken(home: string): string
// 读 <home>/token；缺失/为空则 randomUUID() 生成并写回（mode 0600）。
// token 跨重启复用。

export function tokenEquals(actual: string, expected: string): boolean
// 恒时比较（timingSafeEqual：耗时与内容长度无关、与具体字节无关），
// 防止攻击者靠响应快慢逐字符猜 token。

export function bearerMatches(header: string | undefined, token: string): boolean
// 把 Authorization 头与 `Bearer ${token}` 整体恒时比较。
```

## 启动流程

入口链：`packages/server/bin/kclaw-server.mjs`（package.json 的 `bin` 入口）→ `import { launchDaemon } from "../dist/index.js"` → `launchDaemon({ home, port })`。home 解析：`--home <dir>`（或 `--home=<dir>`）优先，否则 `resolvePaths` 内部使用 `KCLAW_HOME` env ?? `~/.kclaw`。端口解析：`--port <n>`（或 `--port=<n>`）优先，0 是合法值（强制临时端口，压过配置）；旗标缺席时由 `launchDaemon` 读配置 `server.port`，再缺席才用临时端口。`--port` 非整数或越界（0-65535 之外）报一行错退出 1；launch 失败（配置不可解析、钉住的端口被占用等）同样是一行 stderr 加退出 1，不裸抛堆栈。bin 脚本就绪后向 stdout 输出一行 `{"port":<port>}`，CLI 与测试以此行为就绪信号。

`launchDaemon` 的组装序（每步失败都让整个启动 reject，daemon 不会半启动）：

```
resolvePaths(home)                  建目录树（core/storage/paths.ts）
acquireDaemonSlot                   wx 独占认领 <home>/daemon.json：占位 {port:0, pid, startedAt, starting:true}
loadConfig(paths)                   config.json 深合并默认值（旧 config.yaml 在
                                    config.json 缺席时兼容读取）
loadOrCreateToken(paths.home)       读/生成 <home>/token
new EventBus()                      总线先于 store 构造：store 的写入完成通知回调要发
                                    session.appended 总线帧（先写入后广播，审计页等
                                    订阅方据此增量拉取事件流——见 realtime/protocol）
new SessionStore(paths.sessionsDir, onAppended)
                                    store 构造时注入写入完成通知回调：每个事件（含投影）
                                    成功写入 events.jsonl 后发 session.appended
                                    （通知抛错被吞掉，写成功不被通知连累）
embedding 判定链（memory.embedding） model 非空才构造 embedding 客户端（见 memory.md 判定链）；
                                    构造在 EventBus/SessionStore 之后、MemorySystem 之前，赋给下方 memory
new MemorySystem({memoryDir, sessions, config, resolveLlm, embed, emit})
                                    记忆系统统一入口（见 memory.md）；组装后立即三件事：
                                    migrateV1Notes（notes/*.md 三路分流并入 persona/rule/wiki，删 notes/）
                                    rmSync index.db（旧版派生索引直接删）
                                    reconcile()（全部项目库 + 全局库重建索引，向量后台补算）
new JobScheduler(paths.jobsDb)
new UsageStore(paths.usageDb)       token 用量记录（SQLite，stop 时 close）
createEntryLlmFactory(config) + resolveModel(config)   见"provider 解析"；
                                    前者是按条目建连的带缓存工厂，启动客户端
                                    与每 run 的 llmForRun 都出自它
new McpManager({servers, persist})  恒定组装：servers=mcp.json 与配置文件
                                    （config.json 或未迁移的 config.yaml）遗留节的
                                    合并读，persist 接归拢持久化；组装后从内存配置
                                    删除遗留 mcp 节，防止后续保存把已删 server 复活
createSubagentHost({config, sessions, bus, getRun})
                                    subagent 宿主（见 subagents.md）：一次组装返回三件能力——
                                    spawner（派发后端，阻塞与后台 subagent 各有一个并发计数）、collector
                                    （后台 subagent 的结果收集）、cancelBackgroundForParent
                                    （会话删除时级联取消在跑的后台 subagent）。getRun 是晚绑闭包——
                                    spawner 要调 RunManager.cancel/submit，而 RunManager 的 deps
                                    又要 spawner，构造顺序上先建 host、再建 manager、随后回填
new RunManager({...})               注入 usageStore、memory、
                                    extraTools: () => mcpManager.tools()（恒定组装，见上）、
                                    subagents: { spawner, collector, cancelBackgroundForParent }；见 run-manager。
                                    权限模式没有 daemon 级旗标——它是会话级事实（meta.mode），
                                    run 组装每 run 从会话 meta 读出（见 permissions/run-manager）
createApp({home, token, stores, bus, run, mcp, attachmentsDir, usage, webDist, memory})
                                    Fastify 应用（见 http-api）；attachmentsDir/usage 传入时
                                    对应的附件与用量路由才注册，mcp 提供 /mcp 的快照，memory 供 /memory 路由族
await app.listen({ port: listenPort, host: "127.0.0.1" })   ← listenPort = opts.port ?? config.server?.port ?? 0；
                                    钉住的端口被占（EADDRINUSE）是硬错误：释放占位 daemon.json
                                    后抛一行原因，不静默回退到临时端口
port = app.server.address().port
writeFileSync(<home>/daemon.json, {port, pid, startedAt})   ← 回填占位（同 startedAt、starting 移除）；listen 之后、tick 之前
createNotifier(notify.channels)     ← 仅当 notify.channels 非空时创建；空则 undefined，tick 完全不推送
void mcpManager.start()             ← 恒定组装，恒执行；不阻塞就绪，连接随后陆续建立
run.recoverQueues()                 崩溃恢复：queue.jsonl 整体重排，steer/interrupt 降级 wait（见 run-manager）
startSchedulerTick({...})           立即一次检查 + 每 30s 一次（deps 附带 notifier 与 webBase=`http://127.0.0.1:<port>`，用于推送中的 `?session=` 链接）
startMemoryScheduler({...})         记忆调度器：定时 + 跟随保底触发（默认 60s 扫一次，见 memory.md）
feishu 频道启动（opt-in）           ← 仅 ~/.kclaw/feishu.json enabled 时；在两个调度器之后启动，
                                    有 15s 上限（FEISHU_START_TIMEOUT_MS）——挂起的握手不拖累
                                    daemon；失败报一行错误并拆掉半启动状态，daemon 照常服务
                                    （机制见 feishu-channel.md）
return { port, token, pid, stop }
```

### provider 解析（缺失时的行为）

`resolveProviderEndpoint(cfg)` / `resolveModel(cfg)`（`daemon.ts` 导出）按同一优先级取值：

1. `config.providers.entries[config.providers.default]` 条目里的 `baseUrl` / `apiKey` / `model` 优先；
2. 条目留空的字段由环境变量补：`KCLAW_LLM_BASE_URL`、`KCLAW_LLM_API_KEY`、`KCLAW_LLM_MODEL`（`valueOrEnv`：配置值非空则用配置，否则用环境变量，再否则空串）；
3. `baseUrl` 仍为空 → 抛 `no llm provider configured: set providers in config.json or KCLAW_LLM_BASE_URL env`（apiKey 可为空——免密钥端点合法）；`model` 为空 → 抛 `no llm model configured: …`。

抛错发生在 `launchDaemon` 内部，daemon 从未 listen；第一步认领的占位 daemon.json 留在原处（pid 存活时挡住后续启动，pid 退出后被回收重认领）——CLI 的 `ensureDaemon` 轮询 5s 后报"daemon did not become healthy"。

**run 客户端按条目解析**：每个 run 的客户端由 `llmForRun(onRetry, entryKey)` 给出，`entryKey` 来自 `resolveRunModel`（run 组装先解析条目、再建客户端）。`createEntryLlmFactory` 返回的工厂按条目名缓存裸客户端，签名 = `format|baseUrl|apiKey|timeoutMs`——条目缺失回退到默认条目、连默认条目都没有则回退到环境变量端点（openai 格式）。签名变了下个 run 自动重建：Model 页的增删改热生效于下一个 run，无需重启。`withRetry` 由 `llmForRun` 每次现包（重试回调归属当次 run）；`format` 经 `createProviderClient` 选协议（openai → `createOpenAiCompatClient`，anthropic → `createAnthropicClient`，机制见 [provider](../core/provider.md)）。

## 鉴权设计

`createApp`（`packages/server/src/app.ts`）注册一个全局 `preHandler`：

```ts
app.addHook("preHandler", async (request, reply) => {
  const routeUrl = request.routeOptions?.url ?? request.url.split("?")[0]
  if (routeUrl === "/health" || routeUrl === "/ws") return
  if (opts.webDist !== undefined && isWebShellExempt(request)) return
  if (!bearerMatches(request.headers.authorization, opts.token)) {
    return reply.code(401).send({ error: "unauthorized" })
  }
})
```

三处豁免及理由：

- **`/health`**：CLI 的存活检测（`probeHealth`，单次 1s 超时）不带 token——检测只回答 daemon 是否存活，此时客户端可能还没有 token。
- **`/ws`**：WebSocket 升级请求常无法附带自定义 header，鉴权移到连接内部进行——首帧 `{type:"auth", token}` 或 `?token=` 查询参数，失败发 error 帧并以 4001 关闭（见 [realtime](./realtime.md)）。豁免的是升级路由，不是连接本身。
- **静态 WebUI 外壳**（仅 `webDist` 已配置时）：浏览器加载页面前无法获得 token，`GET /`、`GET /index.html`、`GET /assets/*` 必须先放行，PWA 静态文件（`/manifest.webmanifest`、`/sw.js`、`/icon-192.png`、`/icon-512.png`、`/favicon.svg`、`/favicon.ico`）同样放行（`index.html` 声明了 SVG 图标、浏览器默认还会请求 ico，磁盘上没有对应文件时让它们从静态处理器 404 而不是 401）；页面加载后由 JS 附带 token 调用 API。

**外壳豁免的防绕过措施**（`isWebShellExempt`）：

- 只放行 `GET`；其他方法一律走鉴权。
- 匹配的是**原始请求路径**（`request.url.split("?")[0]`，去掉查询串），不是 `request.routeOptions.url`——`@fastify/static` 用一条 `/*` catch-all 路由服务一切文件，匹配到的路由 url 不含路径信息，依据它判断等于全部放行。
- 路径白名单是"三种模式 + 六个精确路径"的封闭集合：模式为 `/`、`/index.html`、`/assets/` 前缀，精确路径为上文那六个 PWA 文件。`/sessions`、`/jobs`、`/config` 等 API 路由先注册、各自有真实 route url，不落在静态 catch-all 的放行逻辑里。
- 反向防线：`resolveWebDist` 在目录不存在时返回 `undefined`（不注册任何静态路由，`GET /` 保持 404），而不是注册一个半配置的静态服务器，使外壳豁免空设在鉴权之前。

## 停止流程

bin 脚本注册信号处理：SIGTERM/SIGINT → `shutdown()`（`stopping` 标志防重入）→ `daemon.stop()` → 正常停止，exit 0；`stop()` 抛错（某步超时）则记录 stderr，exit 1。

`stop()` 的拆除序与启动相反，每步有界：

```
withStopTimeout(tick.stop(), 60s)   // 停心跳；tick.stop 会 await 所有进行中的 job run
withStopTimeout(memoryTick.stop(), 60s)
                                    // 停记忆调度器（定时 + 跟随保底）
withStopTimeout(feishuChannel.stop(), 60s)
                                    // 停飞书频道（仅启用时；断开长连接与总线订阅）
withStopTimeout(mcpManager.stop(), 60s)
                                    // 断开全部 MCP server（恒定组装，恒有此步；幂等）
withStopTimeout(app.close(), 60s)   // 关服务器；app.close 会 await 所有连接
withStopTimeout(memory.stop(), 60s) // 关闭全部 VectorIndex 的 sqlite 连接（防句柄/内存泄漏）
usage.close()                       // 关用量数据库
rmSync(<home>/daemon.json)          // 只有全部成功才删
```

`withStopTimeout(p, timeoutMs, step)` 用 `Promise.race([p, deadline])` 给每步设限。超时的一步**不会被取消**（它可能稍后自行完成，迟到的失败被丢弃——超时已经报告过失败，不能再以未处理 rejection 的形式抛出）。设限的原因：挂死的 provider 流会阻塞 tracked job run，卡住的客户端会阻塞 `app.close`，没有超时上限的 `stop()` 会永远不返回。

**超时路径**：`stop()` reject → bin exit 1 → **daemon.json 保留**（进程仍在运行）。进行中的 job run 按崩溃安全语义放弃（见 [jobs](../core/jobs.md) 的「停机与在途运行」）：JSONL 兼容尾部残缺行；该次触发认领时已推进 `next_run_at`，重启后不会重放，job 在下个调度点照常触发。

### CLI 侧的 pid 校验与 stop（daemon-ctl.ts）

- `readDaemonJson(home)`：解析 `{port, pid, startedAt}`；pid 必须是**正整数**（pid 0 会让 `process.kill(0,…)` 信号整个进程组）——不合法视同文件不存在。
- `ensureDaemon`（检测/重启）：daemon.json 健康（`GET /health` 可访问）→ 直接使用；文件在、health 不可访问、pid 已终止（`process.kill(pid, 0)` 抛 ESRCH）→ 判定失效，stderr 提示 "stale daemon.json, respawning" 后 `spawnDaemon` 分叉启动（detached、stdio ignore、unref，目标 `resolveServerBin()` 解析到 `packages/server/bin/kclaw-server.mjs`）；pid 存活但不健康 → 仅在 5 秒 budget 内轮询等待（250ms 间隔），**绝不在 pid 存活时再次启动**（否则会同时出现两个 daemon）。
- `stopDaemon`：对 daemon.json 的 pid 发 SIGTERM（ESRCH 视为已死，继续清理）→ 轮询直到端口拒绝连接（budget 5 秒）→ budget 耗尽而 `/health` 仍应答 → 抛 `stop failed: daemon still responding…` 且**不删除 daemon.json**；否则删除文件并返回 "stopped"。

## 边界与出错

- **stop 后 token 仍在**：`<home>/token` 是 daemon 的身份，不是某次运行的临时凭证；重装/换 token 需手动删文件。
- **stale daemon.json 在启动时自愈**：`acquireDaemonSlot` 见到死 pid 的残留文件即删除并重新 `wx` 认领；存活 pid 则拒绝启动。运行中失效的发现（health 检测、respawn 决策）仍在 CLI 侧（见上文 ensureDaemon/stopDaemon）。
- **`/health` 无鉴权，因此也没有信息泄露控制**：它只返回 `{ok:true}`，不暴露版本/端口/pid；`/status`（version、uptimeSec）受鉴权保护。
- **配置文件损坏即启动失败**：`loadConfig` 对无法解析的 YAML 直接抛错（静默退回默认值会丢掉用户的权限规则），daemon 不启动。
- **bin 假定构建产物存在**：`kclaw-server.mjs` import 的是 `../dist/index.js`，packages/server 未构建时启动直接失败（CLI 的错误信息里提示 `pnpm -C packages/server build`）。
- **MCP server 挂了不牵连 daemon**：连接/调用失败只进状态与日志（`kclaw mcp <name> error: …`），该 server 的工具从下一次 run 起消失，其余功能不受影响（见 [mcp](../core/mcp.md)）。

## 关联

- [http-api](./http-api.md)：鉴权 hook 之下的全部路由
- [realtime](./realtime.md)：/ws 的连接鉴权与事件广播
- [run-manager](./run-manager.md)：launchDaemon 组装出的 RunManager 与调度心跳
- [mcp](../core/mcp.md)：恒定组装的 McpManager 与 `/mcp` 快照的数据源
- [storage](../core/storage.md)：`<home>` 目录布局、config 加载与 usage.db
- [architecture](../architecture.md)：daemon 在进程模型中的位置
