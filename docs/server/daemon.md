# daemon — 生命周期与鉴权

## 职责

`packages/server/src/daemon.ts` 的 `launchDaemon` 是 daemon 进程的唯一装配入口：把路径、配置、token、各存储、LLM 客户端、RunManager、HTTP/WS 应用、调度心跳按固定顺序组装起来并开始监听；返回的 `Daemon` 句柄提供有界的 `stop()`。配套的 `packages/server/src/auth.ts` 负责 token 的生成与校验。CLI 侧的探测/重启/停止逻辑（pid 校验、健康轮询）在 `packages/cli/src/daemon-ctl.ts`，本文同时说明两侧的契约。

## 设计决策

- **只绑回环地址**：`HOST = "127.0.0.1"`（本机回环地址，外部网络访问不到）。daemon 不做网络隔离，安全完全交给 token；绑回环保证其他机器无法连接。
- **默认临时端口**：`port: 0`（让操作系统分配一个空闲端口），真实端口 listen 成功后从 `app.server.address()` 读出并写入 `daemon.json`。客户端通过文件发现端口，不依赖约定端口。
- **daemon.json 是独占 slot，启动第一步就认领**：装配开始即以 `wx` 原子创建占位 `{port: 0, pid, startedAt, starting: true}`（并发第二个启动者拿到 EEXIST，看到存活 pid 即拒绝"daemon already running"；死 pid 的残留被回收重认领）；listen 成功后回填真实 `{port, pid, startedAt}`（同一 startedAt，`starting` 移除），此时文件才指向可用端口。`launchDaemon` resolve 时 daemon 已在服务并在调度。CLI 侧以"文件出现且 `/health` 可访问"作为就绪判据。
- **token 是 daemon 的稳定身份**：`<home>/token` 首次启动时生成（UUID，文件权限 0600，仅属主可读写），重启复用，stop 不删除；仅 daemon.json 会被删除。因此 CLI/WebUI 保存的 token 在 daemon 重启后仍然有效。
- **鉴权是"每路由必带 Bearer"加白名单豁免**：一个 `preHandler` 钩子拦截全部路由，只有三处豁免——`/health`、`/ws`、静态 WebUI 外壳（见下）。豁免列表是封闭集合，新增路由默认受保护。
- **有界停止**：`stop()` 的每一步（停调度、关服务器）有独立超时（默认 60s）。超时则 `stop()` reject、daemon.json **保留**——进程仍在运行，指向它的文件必须与事实一致；虚报"已停止"会诱发双 daemon、job 双触发。
- **provider 缺失是硬错误**：装配期就抛错终止，不启动一个"半配置"的 daemon。

## 接口

```ts
// packages/server/src/daemon.ts
export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000   // 调度心跳周期
export const DEFAULT_STOP_TIMEOUT_MS = 60_000         // stop() 每步的超时

export interface Daemon {
  port: number        // 实际绑定的端口（0 启动时为临时端口）
  token: string       // app 要求的 Bearer token（<home>/token）
  pid: number         // 本进程 pid，即 daemon.json 里记录的
  stop(): Promise<void>   // 有界拆除：tick → app → 删 daemon.json；幂等（重复调用立即 resolve）
}

export interface LaunchDaemonOptions {
  home?: string                    // KCLAW_HOME ?? ~/.kclaw
  config?: KclawConfig             // 默认 loadConfig(resolvePaths(home))
  llmFactory?: (cfg: KclawConfig) => LlmClient   // 默认按 provider 解析规则构造
  port?: number                    // 默认 0（临时端口）
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

入口链：`packages/server/bin/kclaw-server.mjs`（package.json 的 `bin` 入口）→ `import { launchDaemon } from "../dist/index.js"` → `launchDaemon({ home })`。home 解析：`--home <dir>`（或 `--home=<dir>`）优先，否则 `resolvePaths` 内部使用 `KCLAW_HOME` env ?? `~/.kclaw`。bin 脚本就绪后向 stdout 输出一行 `{"port":<port>}`，CLI 与测试以此行为就绪信号。

`launchDaemon` 的装配序（每步失败都让整个启动 reject，daemon 不会半启动）：

```
resolvePaths(home)                  建目录树（core/storage/paths.ts）
acquireDaemonSlot                   wx 独占认领 <home>/daemon.json：占位 {port:0, pid, startedAt, starting:true}
loadConfig(paths)                   config.yaml 深合并默认值
loadOrCreateToken(paths.home)       读/生成 <home>/token
new SessionStore / MemoryStore      MemoryStore 构造后立即 reconcile()：
                                    notes/*.md 是事实来源，SQLite 索引是派生物，
                                    启动时对账（手改/删除的笔记在启动时被感知）
new JobScheduler(paths.jobsDb)
defaultLlmFactory(config) + resolveModel(config)   见"provider 解析"
new EventBus()
new RunManager({...})               会话串行 run 执行器（见 run-manager）
createApp({home, token, stores, bus, run, webDist})  Fastify 应用（见 http-api）
await app.listen({ port: 0, host: "127.0.0.1" })
port = app.server.address().port
writeFileSync(<home>/daemon.json, {port, pid, startedAt})   ← 回填占位（同 startedAt、starting 移除）；listen 之后、tick 之前
startSchedulerTick({...})           立即一次检查 + 每 30s 一次
return { port, token, pid, stop }
```

### provider 解析（缺失时的行为）

`resolveProviderEndpoint(cfg)` / `resolveModel(cfg)`（`daemon.ts` 导出）按同一优先级取值：

1. `config.providers.entries[config.providers.default]` 条目里的 `baseUrl` / `apiKey` / `model` 优先；
2. 条目留空的字段由环境变量补：`KCLAW_LLM_BASE_URL`、`KCLAW_LLM_API_KEY`、`KCLAW_LLM_MODEL`（`valueOrEnv`：配置值非空则用配置，否则用环境变量，再否则空串）；
3. `baseUrl` 或 `apiKey` 仍为空 → 抛 `no llm provider configured: set providers in config.yaml or KCLAW_LLM_* env`；`model` 为空 → 抛 `no llm model configured: …`。

抛错发生在 `launchDaemon` 内部，daemon 从未 listen；第一步认领的占位 daemon.json 留在原处（pid 存活时挡住后续启动，pid 退出后被回收重认领）——CLI 的 `ensureDaemon` 轮询 5s 后报"daemon did not become healthy"。`defaultLlmFactory` 用解析出的端点构造 `createOpenAiCompatClient({baseUrl, apiKey, timeoutMs: cfg.providers.timeoutMs})`（单请求超时默认 120s）再包一层 `withRetry`（瞬时错误重试，最多 3 次尝试）。

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

- **`/health`**：CLI 的存活探测（`probeHealth`，单次 1s 超时）不带 token——探测只回答 daemon 是否存活，此时客户端可能还没有 token。
- **`/ws`**：WebSocket 升级请求常无法携带自定义 header，鉴权移到连接内部进行——首帧 `{type:"auth", token}` 或 `?token=` 查询参数，失败发 error 帧并以 4001 关闭（见 [realtime](./realtime.md)）。豁免的是升级路由，不是连接本身。
- **静态 WebUI 外壳**（仅 `webDist` 已配置时）：浏览器加载页面前无法获得 token，`GET /`、`GET /index.html`、`GET /assets/*` 必须先放行；页面加载后由 JS 携带 token 调用 API。

**外壳豁免的防绕过措施**（`isWebShellExempt`）：

- 只放行 `GET`；其他方法一律走鉴权。
- 匹配的是**原始请求路径**（`request.url.split("?")[0]`，去掉查询串），不是 `request.routeOptions.url`——`@fastify/static` 用一条 `/*` catch-all 路由服务一切文件，匹配到的路由 url 不含路径信息，依据它判断等于全部放行。
- 路径白名单是精确的三种：`/`、`/index.html`、`/assets/` 前缀。`/sessions`、`/jobs`、`/config` 等 API 路由先注册、各自有真实 route url，不落在静态 catch-all 的放行逻辑里。
- 反向防线：`resolveWebDist` 在目录不存在时返回 `undefined`（不注册任何静态路由，`GET /` 保持 404），而不是注册一个半配置的静态服务器，使外壳豁免空设在鉴权之前。

## 停止流程

bin 脚本注册信号处理：SIGTERM/SIGINT → `shutdown()`（`stopping` 标志防重入）→ `daemon.stop()` → 正常停止，exit 0；`stop()` 抛错（某步超时）则记录 stderr，exit 1。

`stop()` 的拆除序与启动相反，每步有界：

```
withStopTimeout(tick.stop(), 60s)   // 停心跳；tick.stop 会 await 所有进行中的 job run
withStopTimeout(app.close(), 60s)   // 关服务器；app.close 会 await 所有连接
rmSync(<home>/daemon.json)          // 只有全部成功才删
```

`withStopTimeout(p, timeoutMs, step)` 用 `Promise.race([p, deadline])` 给每步设限。超时的一步**不会被取消**（它可能稍后自行完成，迟到的失败被丢弃——超时已经报告过失败，不能再以未处理 rejection 的形式抛出）。设限的原因：挂死的 provider 流会阻塞 tracked job run，卡住的客户端会阻塞 `app.close`，没有超时上限的 `stop()` 会永远不返回。

**超时路径**：`stop()` reject → bin exit 1 → **daemon.json 保留**（进程仍在运行）。进行中的 job run 按 §11 崩溃容忍语义放弃：JSONL 容忍尾部残缺行；该次触发认领时已推进 `next_run_at`，重启后不会重放，job 在下个调度点照常触发。

### CLI 侧的 pid 校验与 stop（daemon-ctl.ts）

- `readDaemonJson(home)`：解析 `{port, pid, startedAt}`；pid 必须是**正整数**（pid 0 会让 `process.kill(0,…)` 信号整个进程组）——不合法视同文件不存在。
- `ensureDaemon`（探测/重启）：daemon.json 健康（`GET /health` 可访问）→ 直接使用；文件在、health 不可访问、pid 已终止（`process.kill(pid, 0)` 抛 ESRCH）→ 判定失效，stderr 提示 "stale daemon.json, respawning" 后 `spawnDaemon` 分叉启动（detached、stdio ignore、unref，目标 `resolveServerBin()` 解析到 `packages/server/bin/kclaw-server.mjs`）；pid 存活但不健康 → 仅在 5s 预算内轮询等待（250ms 间隔），**绝不在 pid 存活时再次启动**（否则第一个进程会被孤儿化）。
- `stopDaemon`：对 daemon.json 的 pid 发 SIGTERM（ESRCH 视为已死，继续清理）→ 轮询直到端口拒绝连接（预算 5s）→ 预算耗尽而 `/health` 仍应答 → 抛 `stop failed: daemon still responding…` 且**不删除 daemon.json**；否则删除文件并返回 "stopped"。

## 边界与出错

- **stop 后 token 仍在**：`<home>/token` 是 daemon 的身份，不是某次运行的临时凭证；重装/换 token 需手动删文件。
- **stale daemon.json 在启动时自愈**：`acquireDaemonSlot` 见到死 pid 的残留文件即删除并重新 `wx` 认领；存活 pid 则拒绝启动。运行中失效的发现（health 探测、respawn 决策）仍在 CLI 侧（见上文 ensureDaemon/stopDaemon）。
- **`/health` 无鉴权，因此也没有信息泄露控制**：它只返回 `{ok:true}`，不暴露版本/端口/pid；`/status`（version、uptimeSec）受鉴权保护。
- **配置文件损坏即启动失败**：`loadConfig` 对无法解析的 YAML 直接抛错（静默退回默认值会丢掉用户的权限规则），daemon 不启动。
- **bin 假定构建产物存在**：`kclaw-server.mjs` import 的是 `../dist/index.js`，packages/server 未构建时启动直接失败（CLI 的错误信息里提示 `pnpm -C packages/server build`）。

## 关联

- [http-api](./http-api.md)：鉴权钩子之下的全部路由
- [realtime](./realtime.md)：/ws 的连接鉴权与事件广播
- [run-manager](./run-manager.md)：launchDaemon 装配出的 RunManager 与调度心跳
- [storage](../core/storage.md)：`<home>` 目录布局与 config 加载
- [architecture](../architecture.md)：daemon 在进程模型中的位置
