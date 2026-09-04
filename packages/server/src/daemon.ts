/**
 * Daemon lifecycle — `launchDaemon` is the one-call assembly of
 * the whole daemon process:
 *
 *   resolvePaths → acquireDaemonSlot (exclusive `wx` claim of
 *   `<home>/daemon.json` with a placeholder {port: 0, pid, startedAt,
 *   starting}) → loadConfig → loadOrCreateToken → stores (SessionStore,
 *   MemorySystem（记忆 v2 门面；迁移/对账在 Task 13）, JobScheduler) → llm client
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
  createEmbeddingClient,
  createOpenAiCompatClient,
  loadConfig,
  createNotifier,
  makeEvent,
  McpManager,
  resolvePaths,
  UsageStore,
  withRetry,
} from "@kclaw/core"
import type { KclawConfig, LlmClient } from "@kclaw/core"
import { loadOrCreateToken } from "./auth.js"
import { EventBus } from "@kclaw/core"
import { RunManager } from "./run.js"
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
  /** The port actually bound (an ephemeral port when launched with 0). */
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
  /** Port to bind; default 0 (ephemeral). */
  port?: number
  /** Scheduler tick cadence; default 30s. */
  schedulerIntervalMs?: number
  /** Deadline for each stop() teardown step (tick, app close); default 60s. Tests inject 50ms. */
  stopTimeoutMs?: number
  /** Directory of the built web UI to serve statically (see createApp). */
  webDist?: string
  /** Readonly mode: fs_write/fs_edit/exec denied in every session. */
  readonly?: boolean
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
 * leaves empty. A still-missing endpoint is a launch error, not a silent
 * half-configured daemon.
 */
export function resolveProviderEndpoint(cfg: KclawConfig): { baseUrl: string; apiKey: string } {
  const entry = cfg.providers.entries[cfg.providers.default]
  const baseUrl = valueOrEnv(entry?.baseUrl, "KCLAW_LLM_BASE_URL")
  const apiKey = valueOrEnv(entry?.apiKey, "KCLAW_LLM_API_KEY")
  if (baseUrl === "" || apiKey === "") {
    throw new Error("no llm provider configured: set providers in config.yaml or KCLAW_LLM_* env")
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
    throw new Error("no llm model configured: set providers.<name>.model in config.yaml or KCLAW_LLM_MODEL env")
  }
  return model
}

/**
 * Default llmFactory: an OpenAI-compatible streaming client with transient-
 * error retry (3 attempts), built from the resolved provider endpoint. The
 * model is resolved separately by the caller — see {@link resolveModel}.
 *
 * `onRetry` is the injectable retry sink: launchDaemon's
 * default composition passes each run's sink here, so provider retries
 * surface as `llm.failed {willRetry:true}` events with that run's context.
 */
export function defaultLlmFactory(
  cfg: KclawConfig,
  onRetry?: (info: { attempt: number; error: unknown }) => void,
): LlmClient {
  const { baseUrl, apiKey } = resolveProviderEndpoint(cfg)
  return withRetry(
    createOpenAiCompatClient({ baseUrl, apiKey, timeoutMs: cfg.providers.timeoutMs }),
    onRetry === undefined ? {} : { onRetry },
  )
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

  const sessions = new SessionStore(paths.sessionsDir)
  // embedding 判定链（spec 7.2）：model 空 → 不构造客户端（向量路关闭）；provider 名
  // 缺省取 default provider entry；entry 不存在则向量路关闭并告警（不致命）。
  const embedCfg = config.memory.embedding
  let embed: ReturnType<typeof createEmbeddingClient> | undefined
  if (embedCfg.model !== "") {
    const entry = embedCfg.provider !== ""
      ? config.providers.entries[embedCfg.provider]
      : config.providers.entries[config.providers.default]
    if (entry !== undefined) {
      embed = createEmbeddingClient({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: embedCfg.model, timeoutMs: config.providers.timeoutMs })
    } else {
      console.error("kclaw memory: embedding provider not found, vector path disabled")
    }
  }
  const bus = new EventBus()
  // 记忆系统 v2 唯一门面：embed/emit/迁移/对账在此一次性装配（Task 13）。
  // resolveLlm 惰性引用下方 llm/model（触发发生在 launch 后，TDZ 无碍）。
  const memory = new MemorySystem({
    memoryDir: paths.memoryDir,
    sessions,
    config,
    resolveLlm: () => ({ llm, model }),
    embed,
    emit: (e) => bus.emit(makeEvent("memory.written", { path: e.path, kind: e.kind, ...(e.topic !== undefined ? { topic: e.topic } : {}), ...(e.scope !== undefined ? { scope: e.scope } : {}) })),
  })
  // v1 一次性迁移（spec 2.6）+ 对账 + v1 派生物 index.db 删除（v2 结构直接重建，spec 11）。
  if (existsSync(paths.memoryNotesDir)) memory.migrateV1Notes(paths.memoryNotesDir)
  rmSync(join(paths.memoryDir, "index.db"), { force: true })
  memory.reconcile()
  const jobs = new JobScheduler(paths.jobsDb)
  const usage = new UsageStore(paths.usageDb)

  // resolveConfirmation stays undefined: WS/CLI verdicts reach the RunManager's
  // internal ConfirmationBroker (createApp routes confirmation.resolve frames
  // from /ws to it).
  const llm = (opts.llmFactory ?? defaultLlmFactory)(config)
  const model = resolveModel(config)
  // MCP servers: a manager is built only when the config lists any; the
  // per-run tools() read is live (reconnect recovery included). Connection
  // failures are logged and never fatal — a broken server just yields no tools.
  const mcpManager =
    config.mcp !== undefined && Object.keys(config.mcp.servers ?? {}).length > 0
      ? new McpManager({
          servers: config.mcp.servers ?? {},
          onError: (name, error) => console.error(`kclaw mcp ${name} error: ${error}`),
        })
      : undefined
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
    ...(opts.readonly === true && { readonly: true }),
    ...(mcpManager !== undefined && { extraTools: () => mcpManager.tools() }),
    // Retry visibility: with the DEFAULT
    // composition every run builds its own retry-wrapped client carrying
    // that run's onRetry sink — retry events then carry the run's own
    // sessionId/runId even while sessions run concurrently on the shared
    // endpoint. An injected llmFactory (tests) keeps full control: it is
    // used as the plain shared `llm`, with no retry wiring of its own.
    ...(opts.llmFactory === undefined && {
      llmForRun: (onRetry: (info: { attempt: number; error: unknown }) => void) =>
        defaultLlmFactory(config, onRetry),
    }),
  })

  const app = await createApp({
    home: paths.home,
    token,
    stores: { sessions, jobs, config, paths },
    bus,
    run,
    mcp: mcpManager !== undefined ? { status: () => mcpManager.status() } : undefined,
    attachmentsDir: paths.attachmentsDir,
    usage,
    webDist: resolveWebDist(opts.webDist),
    memory, // Task 14 的 /memory 路由消费（spec 9.2 管理界面）
  })
  await app.listen({ port: opts.port ?? 0, host: HOST })
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

  // Crash recovery (spec §5.5): re-enqueue persisted queues (steer/interrupt
  // demoted to wait) before the scheduler starts. The app is already
  // listening, so the message.queued broadcasts reach connected clients;
  // reconnecting clients are corrected wholesale by GET /queue.
  run.recoverQueues()

  const tick = startSchedulerTick({ scheduler: jobs, run, bus, sessions, intervalMs: opts.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS, purgeTtlMs: config.sessions.recycleBinTtlMs, notifier, webBase: `http://${HOST}:${port}` })
  // 记忆调度器（Task 13，spec 4.2）：定时 + 跟随补查。workdirs = 全部有会话的
  // 项目（去重）；daemon 重启后首次 sweep 会补查落盘的挂起跟随检查（spec 11）。
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
