/**
 * Daemon lifecycle — `launchDaemon` is the one-call assembly of
 * the whole daemon process:
 *
 *   resolvePaths → acquireDaemonSlot (exclusive `wx` claim of
 *   `<home>/daemon.json` with a placeholder {port: 0, pid, startedAt,
 *   starting}) → loadConfig → loadOrCreateToken → stores (SessionStore,
 *   MemorySystem, JobScheduler) → llm client
 *   → RunManager → createApp (auth + routes + ws) → listen 127.0.0.1 →
 *   backfill daemon.json with the real {port, pid, startedAt}
 *   → scheduler tick → Daemon.
 *
 * `stop()` reverses it: tick.stop → app.close → delete daemon.json (the token
 * file is kept — it is the daemon's stable identity across restarts). All of
 * it idempotent: a second stop() resolves immediately. Each step is bounded
 * by a deadline (default 60s): a step that misses it makes stop() REJECT,
 * daemon.json is kept (the process is still alive), and in-flight job runs
 * are abandoned — JSONL tolerates partial runs; a claimed run's occurrence
 * already advanced next_run_at (at claim time), so it does not re-fire: the
 * job fires again at its next scheduled time.
 *
 * Provider resolution: the config's default provider
 * entry wins; KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY / KCLAW_LLM_MODEL env
 * vars fill whatever the entry leaves empty; still-missing endpoint or model
 * is a hard launch error.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  JobScheduler,
  MemorySystem,
  SessionStore,
  consolidateMcpConfig,
  createEmbeddingClient,
  createOpenAiCompatClient,
  createProviderClient,
  loadConfig,
  loadMcpServers,
  createNotifier,
  makeEvent,
  McpManager,
  resolvePaths,
  resolveProviderFormat,
  UsageStore,
  withRetry,
  HookRegistry,
  AutoLearnCounter,
} from "@kclaw/core"
import type { EmbeddingClient, KclawConfig, LlmClient } from "@kclaw/core"
import { loadOrCreateToken } from "./auth.js"
import { EventBus } from "@kclaw/core"
import { RunManager } from "./run.js"
import { createSubagentHost } from "./subagent.js"
import { createTeamHost } from "./team.js"
import { startSchedulerTick } from "./scheduler-tick.js"
import { startMemoryScheduler } from "./memory-scheduler.js"
import { createApp } from "./app.js"

/** The daemon only ever binds loopback (127.0.0.1). */
const HOST = "127.0.0.1"

/** Default scheduler tick cadence (30s polling). */
export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000

/** Default deadline for each `stop()` teardown step. */
export const DEFAULT_STOP_TIMEOUT_MS = 60_000

/**
 * Race one daemon-stop step against a deadline: `tick.stop()`
 * awaits every tracked job run and `app.close()` awaits every connection, so
 * a hung provider stream (or a stuck client) could park `stop()` forever —
 * an unstoppable daemon that the CLI would then double-spawn. The losing
 * step is never cancelled: it MAY still settle later, and a late rejection
 * is swallowed here (the timeout already surfaced the failure), not thrown
 * as an unhandled rejection long after `stop()` returned.
 */
export function withStopTimeout<T>(p: Promise<T>, timeoutMs: number, step: string): Promise<T> {
  void p.catch(() => undefined) // a late failure of the losing side is not "unhandled"
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`daemon stop timed out: ${step} still pending after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([p, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Handle over one launched daemon. */
export interface Daemon {
  /** The port actually bound (an ephemeral port when nothing pinned one). */
  port: number
  /** Bearer token the app requires (loaded from/created in `<home>/token`). */
  token: string
  /** OS pid of this process, as recorded in daemon.json. */
  pid: number
  /** Tear the daemon down (tick → server → daemon.json). Idempotent. */
  stop(): Promise<void>
}

export interface LaunchDaemonOptions {
  /** kclaw home; default: KCLAW_HOME env ?? ~/.kclaw (resolvePaths semantics). */
  home?: string
  /** Config override; default: loadConfig(resolvePaths(home)). */
  config?: KclawConfig
  /** LlmClient factory; default resolves the config default provider (env fallback). */
  llmFactory?: (cfg: KclawConfig) => LlmClient
  /**
   * Port to bind. Precedence: this explicit override (the server bin's
   * --port flag) ?? config `server.port` ?? 0 (an ephemeral port per
   * launch — the historical behavior).
   */
  port?: number
  /** Scheduler tick cadence; default 30s. */
  schedulerIntervalMs?: number
  /** Deadline for each stop() teardown step (tick, app close); default 60s. Tests inject 50ms. */
  stopTimeoutMs?: number
  /** Directory of the built web UI to serve statically (see createApp). */
  webDist?: string
}

/**
 * The default built-web-UI location: `<repo>/packages/web/dist`. Computed from
 * this module's URL so it resolves identically from src/ (tsx, vitest) and
 * dist/ (the compiled daemon.js): both sit two levels under <repo>/packages,
 * so `../../web/dist` lands on packages/web/dist either way.
 */
export function defaultWebDistPath(): string {
  return fileURLToPath(new URL("../../web/dist", import.meta.url))
}

/**
 * Resolve the web dist the daemon should host: an explicit
 * `opts.webDist` wins (tests inject temp dirs); when omitted, the default
 * `<repo>/packages/web/dist` from {@link defaultWebDistPath} is used. A path
 * that does not exist — a fresh clone without a web build, or a stray
 * explicit path — resolves to `undefined`, i.e. no static hosting: the daemon
 * stays API-only rather than registering a half-configured static server
 * whose shell exemption would otherwise shadow the auth gate on `GET /`.
 */
export function resolveWebDist(optsWebDist: string | undefined): string | undefined {
  const candidate = optsWebDist ?? defaultWebDistPath()
  return existsSync(candidate) ? candidate : undefined
}

/** `value` when non-empty, else the env var, else "" (config wins, env falls back). */
function valueOrEnv(value: string | undefined, envName: string): string {
  if (value !== undefined && value !== "") return value
  const fromEnv = process.env[envName]
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : ""
}

/**
 * The default provider endpoint for the daemon: the config's default provider
 * entry, with KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY filling in what the entry
 * leaves empty. A still-missing baseUrl is a launch error, not a silent
 * half-configured daemon; an empty apiKey is legal (keyless local runtimes
 * get no auth header).
 */
export function resolveProviderEndpoint(cfg: KclawConfig): { baseUrl: string; apiKey: string } {
  const entry = cfg.providers.entries[cfg.providers.default]
  const baseUrl = valueOrEnv(entry?.baseUrl, "KCLAW_LLM_BASE_URL")
  const apiKey = valueOrEnv(entry?.apiKey, "KCLAW_LLM_API_KEY")
  if (baseUrl === "") {
    throw new Error("no llm provider configured: set providers in config.json or KCLAW_LLM_BASE_URL env")
  }
  return { baseUrl, apiKey }
}

/**
 * The model string for the daemon's runs: the provider entry's model, falling
 * back to KCLAW_LLM_MODEL. Separate from {@link resolveProviderEndpoint} so a
 * test llmFactory still needs a model (RunManager sends one on every request)
 * without needing a reachable endpoint.
 */
export function resolveModel(cfg: KclawConfig): string {
  const entry = cfg.providers.entries[cfg.providers.default]
  const model = valueOrEnv(entry?.model, "KCLAW_LLM_MODEL")
  if (model === "") {
    throw new Error("no llm model configured: set providers.<name>.model in config.json or KCLAW_LLM_MODEL env")
  }
  return model
}

/**
 * Per-entry client factory with signature-keyed caching: every provider entry
 * owns its endpoint, so the run's resolved entry key picks the client (raw,
 * un-retried — callers wrap in withRetry per run to carry their own retry
 * sink). The cache holds one slot per entry key; a changed entry (format,
 * baseUrl, apiKey, or the global timeout) changes the signature and rebuilds,
 * which is how Model-tab edits hot-apply to the next run. No configured entry
 * (empty key, nothing set) falls back to the KCLAW_LLM_* env endpoint.
 */
export function createEntryLlmFactory(cfg: KclawConfig): (entryKey?: string) => LlmClient {
  const cache = new Map<string, { sig: string; client: LlmClient }>()
  return (entryKey?: string) => {
    const entry = (entryKey !== undefined ? cfg.providers.entries[entryKey] : undefined)
      ?? cfg.providers.entries[cfg.providers.default]
    if (entry === undefined) {
      const { baseUrl, apiKey } = resolveProviderEndpoint(cfg)
      return createOpenAiCompatClient({ baseUrl, apiKey, timeoutMs: cfg.providers.timeoutMs })
    }
    const sig = `${resolveProviderFormat(entry)}|${entry.baseUrl}|${entry.apiKey}|${cfg.providers.timeoutMs}`
    const key = entryKey ?? ""
    const hit = cache.get(key)
    if (hit !== undefined && hit.sig === sig) return hit.client
    const client = createProviderClient({ entry, timeoutMs: cfg.providers.timeoutMs })
    cache.set(key, { sig, client })
    return client
  }
}

/**
 * One-shot default composition (launch client and tests): the entry-resolved
 * client wrapped in transient-error retry (3 attempts). Per-run retry wiring
 * goes through {@link createEntryLlmFactory} so the cache is shared across
 * runs instead of rebuilt per call.
 */
export function defaultLlmFactory(
  cfg: KclawConfig,
  onRetry?: (info: { attempt: number; error: unknown }) => void,
  entryKey?: string,
): LlmClient {
  return withRetry(
    createEntryLlmFactory(cfg)(entryKey),
    onRetry === undefined ? {} : { onRetry },
  )
}

/**
 * Hot-reloadable embedding client: re-resolves the configured entry per call
 * (signature-checked, so unchanged entries reuse the client) — Model-tab edits
 * reach the vector path without a restart. Whether the vector path exists at
 * all is still decided once at launch (the embeddings model and the entry's
 * protocol are not hot-swappable: an anthropic-format entry has no embeddings
 * API and stays disabled).
 */
function createHotEmbedClient(cfg: KclawConfig, providerName: string, model: string): EmbeddingClient {
  let sig = ""
  let client: EmbeddingClient | undefined
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const entry = (providerName !== "" ? cfg.providers.entries[providerName] : undefined)
        ?? cfg.providers.entries[cfg.providers.default]
      if (entry === undefined) throw new Error("embedding provider entry not found")
      const next = `${entry.baseUrl}|${entry.apiKey}|${cfg.providers.timeoutMs}`
      if (client === undefined || sig !== next) {
        client = createEmbeddingClient({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model, timeoutMs: cfg.providers.timeoutMs })
        sig = next
      }
      return client.embed(texts)
    },
  }
}

/** True when `pid` is a live process (signal 0 probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * Undo a claim this process still owns (the placeholder pidfile carries our
 * pid): used when the listen after the claim fails, so the next launch sees
 * a clean home instead of a live-but-deaf pid. A pidfile rewritten by some
 * other process in between is left alone.
 */
function releaseClaimedSlot(daemonJson: string, pid: number): void {
  try {
    const holder = JSON.parse(readFileSync(daemonJson, "utf8")) as { pid?: unknown }
    if (holder.pid === pid) rmSync(daemonJson, { force: true })
  } catch {
    // unreadable/already gone — nothing of ours to release
  }
}

/**
 * Exclusive claim of the home's daemon slot, BEFORE any resource is built:
 * `wx` creation of daemon.json wins the race atomically — a concurrent
 * second launcher gets EEXIST, sees our live pid, and refuses instead of
 * silently overwriting the pidfile and orphaning the first daemon (which
 * also double-runs the scheduler against the same jobs.db and races the
 * token file). A stale slot (dead pid) is reclaimed. Returns the startedAt
 * timestamp for the post-listen backfill.
 */
function acquireDaemonSlot(daemonJson: string, pid: number): string {
  try {
    const existing = JSON.parse(readFileSync(daemonJson, "utf8")) as { pid?: unknown }
    if (typeof existing.pid === "number" && existing.pid > 0 && pidAlive(existing.pid)) {
      throw new Error(`daemon already running (pid ${existing.pid}) — connect to it or stop it first`)
    }
    rmSync(daemonJson, { force: true })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("daemon already running")) throw error
    // missing/unreadable daemon.json → fall through to the wx claim
  }
  const startedAt = new Date().toISOString()
  const placeholder = `${JSON.stringify({ port: 0, pid, startedAt, starting: true }, null, 2)}\n`
  try {
    writeFileSync(daemonJson, placeholder, { flag: "wx" })
  } catch {
    // Lost the race: re-read and verify the winner is alive before refusing.
    const winner = (() => { try { return JSON.parse(readFileSync(daemonJson, "utf8")) as { pid?: unknown } } catch { return undefined } })()
    if (winner !== undefined && typeof winner.pid === "number" && pidAlive(winner.pid)) {
      throw new Error(`daemon already running (pid ${winner.pid}) — connect to it or stop it first`)
    }
    rmSync(daemonJson, { force: true })
    writeFileSync(daemonJson, placeholder, { flag: "wx" })
  }
  return startedAt
}

/** Assemble and launch the daemon; resolves once it serves and ticks. */
export async function launchDaemon(opts: LaunchDaemonOptions = {}): Promise<Daemon> {
  const paths = resolvePaths(opts.home)
  const startedAt = acquireDaemonSlot(join(paths.home, "daemon.json"), process.pid)
  const config = opts.config ?? loadConfig(paths)
  const token = loadOrCreateToken(paths.home)

  // The bus is built before the store: the store's post-append callback emits
  // the session.appended bus frame (audit-page subscribers use it to refetch
  // the stream incrementally — persisted before announced, no race).
  const bus = new EventBus()
  const sessions = new SessionStore(paths.sessionsDir, (sessionId, event) => {
    bus.emit(makeEvent("session.appended", { eventType: event.type }, { sessionId }))
  })
  // embedding 判定链：model 空 → 不构造客户端（向量路关闭）；provider 名
  // 缺省取 default provider entry；entry 不存在则向量路关闭并告警（不致命）。
  const embedCfg = config.memory.embedding
  let embed: ReturnType<typeof createEmbeddingClient> | undefined
  if (embedCfg.model !== "") {
    const entry = embedCfg.provider !== ""
      ? config.providers.entries[embedCfg.provider]
      : config.providers.entries[config.providers.default]
    if (entry !== undefined && resolveProviderFormat(entry) === "anthropic") {
      // Anthropic has no embeddings endpoint: an anthropic-format entry can
      // serve chat but never the vector path.
      console.error("kclaw memory: embedding provider is an anthropic-format entry (no embeddings API), vector path disabled")
    } else if (entry !== undefined) {
      embed = createHotEmbedClient(config, embedCfg.provider, embedCfg.model)
    } else {
      console.error("kclaw memory: embedding provider not found, vector path disabled")
    }
  }
  // 用户 hook 注册表：daemon 级账本，run 装配每 run 现扫
  // ~/.kclaw/hooks；装载失败经 registry 去重后广播一次 hook.failed(load)。
  const hookRegistry = new HookRegistry({
    userDir: paths.hooksDir,
    onEvent: (e) => {
      try {
        bus.emit(e)
      } catch {
        // one broken subscriber must not kill the daemon
      }
    },
  })
  // 记忆系统唯一门面：embed/emit/迁移/对账在此一次性装配。
  // resolveLlm 惰性引用下方 llmForEntry（触发发生在 launch 后，TDZ 无碍）：
  // 回落客户端每调用现解，签名缓存让未变更的条目零成本复用——Model 页
  // 改动对记忆提取同样热生效。测试注入的 llmFactory 保持原样直用。
  const memory = new MemorySystem({
    memoryDir: paths.memoryDir,
    sessions,
    config,
    resolveLlm: () => ({ llm: opts.llmFactory !== undefined ? llm : withRetry(llmForEntry()), model: resolveModel(config) }),
    embed,
    emit: (e) => bus.emit(makeEvent("memory.written", { path: e.path, kind: e.kind, ...(e.topic !== undefined ? { topic: e.topic } : {}), ...(e.scope !== undefined ? { scope: e.scope } : {}) })),
  })
  // v1 一次性迁移 + 对账 + v1 派生物 index.db 删除（v2 结构直接重建）。
  if (existsSync(paths.memoryNotesDir)) memory.migrateV1Notes(paths.memoryNotesDir)
  rmSync(join(paths.memoryDir, "index.db"), { force: true })
  memory.reconcile()
  const jobs = new JobScheduler(paths.jobsDb)
  const usage = new UsageStore(paths.usageDb)

  // resolveConfirmation stays undefined: WS/CLI verdicts reach the RunManager's
  // internal ConfirmationBroker (createApp routes confirmation.resolve frames
  // from /ws to it).
  // Per-entry clients for runs (each entry owns its endpoint — see
  // createEntryLlmFactory); memory extraction's default path re-resolves
  // through the same factory per call, so entry edits hot-apply there too.
  const llmForEntry = createEntryLlmFactory(config)
  const llm = opts.llmFactory !== undefined ? opts.llmFactory(config) : withRetry(llmForEntry())
  const model = resolveModel(config)
  // MCP: the manager is always assembled (an empty one costs nothing and
  // keeps the management routes — adding the first server from the WebUI —
  // alive). Servers come from the merged read (config.yaml legacy section +
  // mcp.json, mcp.json winning); hot-config changes persist through the
  // consolidation, which also strips the legacy section on first save.
  // Connection failures are logged and never fatal — a broken server just
  // yields no tools.
  const mcpManager = new McpManager({
    servers: loadMcpServers(paths),
    onError: (name, error) => console.error(`kclaw mcp ${name} error: ${error}`),
    persist: (servers) => consolidateMcpConfig(paths, servers),
  })
  // The manager owns MCP state from here (mcp.json is the managed source):
  // drop the legacy section from the in-memory config so a later provider
  // save can never write a deleted server back into config.json.
  delete config.mcp
  // Subagent dispatch: the spawner needs the RunManager (it submits/cancels
  // child runs) while the RunManager's engine deps need the spawner — a
  // late-bound getter breaks the cycle (dispatches only fire mid-run, long
  // after both sides exist).
  let runRef: RunManager | undefined
  const getRun = (): RunManager => {
    if (runRef === undefined) throw new Error("run manager not ready")
    return runRef
  }
  const subagentHost = createSubagentHost({
    config,
    sessions,
    bus,
    getRun,
  })
  // Agent team: the facade needs the RunManager (member dispatch) while the
  // RunManager's engine deps need the facade (identity probe per run) — the
  // same late-bound getter breaks the cycle.
  const teamHost = createTeamHost({ config, sessions, bus, getRun })
  const run = new RunManager({
    config,
    paths,
    sessions,
    memory,
    bus,
    llm,
    workspace: config.workspace,
    model,
    usageStore: usage,
    hooks: hookRegistry,
    subagents: {
      spawner: subagentHost.spawner,
      collector: subagentHost.collector,
    },
    team: { facade: teamHost.facade },
    // Idle edge: a user chat run never passes through startRun, so the team
    // host only learns that a busy lead/member freed up from this hook.
    onSessionIdle: (sessionId) => teamHost.pump(sessionId),
    // auto mode induction (batch C): one per-process streak counter threaded
    // through every run's assembly; threshold 0 disables induction.
    autoLearn: { counter: new AutoLearnCounter(config.permissions.autoLearnThreshold ?? 3) },
    extraTools: () => mcpManager.tools(),    // Retry visibility: with the DEFAULT
    // composition every run builds its own retry-wrapped client carrying
    // that run's onRetry sink — retry events then carry the run's own
    // sessionId/runId even while sessions run concurrently on the shared
    // endpoint. An injected llmFactory (tests) keeps full control: it is
    // used as the plain shared `llm`, with no retry wiring of its own.
    ...(opts.llmFactory === undefined && {
      llmForRun: (onRetry: (info: { attempt: number; error: unknown }) => void, entryKey?: string) =>
        withRetry(llmForEntry(entryKey), { onRetry }),
    }),
  })
  runRef = run

  const app = await createApp({
    home: paths.home,
    token,
    stores: { sessions, jobs, config, paths },
    bus,
    run,
    cancelBackgroundForParent: subagentHost.cancelBackgroundForParent,
    team: teamHost,
    mcp: mcpManager,
    attachmentsDir: paths.attachmentsDir,
    usage,
    webDist: resolveWebDist(opts.webDist),
    memory, // /memory 路由消费（管理界面）
    hooks: hookRegistry, // GET /hooks 管理面
  })
  // Port precedence: explicit override (bin --port) ?? config server.port ??
  // ephemeral. A pinned port that is taken is a hard error — silently falling
  // back to an ephemeral port would change the WebUI URL, the exact drift a
  // pinned port exists to prevent.
  const listenPort = opts.port ?? config.server?.port ?? 0
  try {
    await app.listen({ port: listenPort, host: HOST })
  } catch (err) {
    // The slot was claimed (placeholder daemon.json carrying our pid) before
    // the listen; release it so the next launch sees no live-but-deaf pid.
    releaseClaimedSlot(join(paths.home, "daemon.json"), process.pid)
    if ((err as { code?: string }).code === "EADDRINUSE") {
      throw new Error(
        `port ${listenPort} is already in use — free it or change the configured port (server.port in the config file, or the --port flag)`,
        { cause: err },
      )
    }
    throw err
  }
  const address = app.server.address()
  const port = typeof address === "object" && address !== null ? address.port : (opts.port ?? 0)

  const daemonJson = join(paths.home, "daemon.json")
  // Backfill the placeholder claimed at the top with the real port; the same
  // startedAt keeps the claim's timestamp (no `starting` flag once serving).
  writeFileSync(daemonJson, `${JSON.stringify({ port, pid: process.pid, startedAt }, null, 2)}\n`, "utf8")

  // Job terminal-state notifier: assembled only when channels are configured
  // (none → undefined, the tick skips pushes entirely). Failures are reported
  // here and never propagate — sending never throws inside the notifier.
  const notifier = config.notify.channels.length > 0
    ? createNotifier(config.notify.channels, {
        timeoutMs: config.notify.timeoutMs,
        onError: (c, e) => console.error(`kclaw notify ${c.name ?? c.type} failed: ${e}`),
      })
    : undefined

  // Connect MCP servers without blocking readiness: tools appear per-run as
  // connections come up (a late-connecting server still contributes).
  if (mcpManager !== undefined) void mcpManager.start()

  // Crash recovery: re-enqueue persisted queues (steer/interrupt
  // demoted to wait) before the scheduler starts. The app is already
  // listening, so the message.queued broadcasts reach connected clients;
  // reconnecting clients are corrected wholesale by GET /queue.
  run.recoverQueues()

  const tick = startSchedulerTick({ scheduler: jobs, run, bus, sessions, intervalMs: opts.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS, purgeTtlMs: config.sessions.recycleBinTtlMs, notifier, webBase: `http://${HOST}:${port}`, defaultMode: config.permissions.defaultMode })
  // 记忆调度器：定时 + 跟随补查。workdirs = 全部有会话的
  // 项目（去重）；daemon 重启后首次 sweep 会补查落盘的挂起跟随检查。
  const memoryTick = startMemoryScheduler({
    system: memory, sessions, config,
    workdirs: () => Array.from(new Set(sessions.list().map((m) => m.workdir ?? config.workspace))),
  })
  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  let stopped = false
  return {
    port,
    token,
    pid: process.pid,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      // Bounded stop: each teardown step gets a deadline, or a
      // hung tracked run (tick.stop awaits them) / stuck connection
      // (app.close awaits them) could park stop() forever. On a timeout the
      // error propagates to the caller (bin logs to stderr and exits 1) and
      // daemon.json is KEPT: the process is still alive, so an honest pidfile
      // beats a cleaned one. In-flight job runs are abandoned — JSONL
      // tolerates partial runs; each claimed occurrence already had
      // next_run_at advanced at claim time, so the killed run does not
      // re-fire: the job fires again at its next scheduled time.
      await withStopTimeout(tick.stop(), stopTimeoutMs, "scheduler tick")
      await withStopTimeout(memoryTick.stop(), stopTimeoutMs, "memory scheduler")
      if (mcpManager !== undefined) {
        await withStopTimeout(mcpManager.stop(), stopTimeoutMs, "mcp stop")
      }
      await withStopTimeout(app.close(), stopTimeoutMs, "app close")
      // 记忆系统句柄释放（关闭全部 VectorIndex 的 sqlite 连接，防泄漏）。
      await withStopTimeout(memory.stop(), stopTimeoutMs, "memory stop")
      usage.close()
      rmSync(daemonJson, { force: true })
    },
  }
}
