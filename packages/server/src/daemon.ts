/**
 * Daemon lifecycle (P3 Task 9) — `launchDaemon` is the one-call assembly of
 * the whole daemon process:
 *
 *   resolvePaths → loadConfig → loadOrCreateToken → stores (SessionStore,
 *   MemoryStore + startup `reconcile()`, JobScheduler) → llm client
 *   → RunManager → createApp (auth + routes + ws) → listen 127.0.0.1 →
 *   `<home>/daemon.json` {port, pid, startedAt} → scheduler tick → Daemon.
 *
 * `stop()` reverses it: tick.stop → app.close → delete daemon.json (the token
 * file is kept — it is the daemon's stable identity across restarts). All of
 * it idempotent: a second stop() resolves immediately. Each step is bounded
 * by a deadline (P4 Task 2, default 60s): a step that misses it makes stop()
 * REJECT, daemon.json is kept (the process is still alive), and in-flight
 * job runs are abandoned per §11 crash-tolerance semantics.
 *
 * Provider resolution (controller ruling 5): the config's default provider
 * entry wins; KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY / KCLAW_LLM_MODEL env
 * vars fill whatever the entry leaves empty; still-missing endpoint or model
 * is a hard launch error.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  JobScheduler,
  MemoryStore,
  SessionStore,
  createOpenAiCompatClient,
  loadConfig,
  resolvePaths,
  withRetry,
} from "@kclaw/core"
import type { KclawConfig, LlmClient } from "@kclaw/core"
import { loadOrCreateToken } from "./auth.js"
import { EventBus } from "./bus.js"
import { RunManager } from "./run.js"
import { startSchedulerTick } from "./scheduler-tick.js"
import { createApp } from "./app.js"

/** The daemon only ever binds loopback (spec §4: 127.0.0.1). */
const HOST = "127.0.0.1"

/** Default scheduler tick cadence (spec: 30s 轮询). */
export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000

/** Default deadline for each `stop()` teardown step (P4 Task 2). */
export const DEFAULT_STOP_TIMEOUT_MS = 60_000

/**
 * Race one daemon-stop step against a deadline (P4 Task 2): `tick.stop()`
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
  /** LlmClient factory; default resolves the provider per ruling 5. */
  llmFactory?: (cfg: KclawConfig) => LlmClient
  /** Port to bind; default 0 (ephemeral). */
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
 * Resolve the web dist the daemon should host (P4 Task 7): an explicit
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
 * `onRetry` (final-review I1) is the injectable retry sink: launchDaemon's
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

/** Assemble and launch the daemon; resolves once it serves and ticks. */
export async function launchDaemon(opts: LaunchDaemonOptions = {}): Promise<Daemon> {
  const paths = resolvePaths(opts.home)
  const config = opts.config ?? loadConfig(paths)
  const token = loadOrCreateToken(paths.home)

  const sessions = new SessionStore(paths.sessionsDir)
  const memory = new MemoryStore({ notesDir: paths.memoryNotesDir, indexDb: paths.memoryIndexDb })
  memory.reconcile() // startup reconciliation: notes/*.md are the truth, the index is derived
  const jobs = new JobScheduler(paths.jobsDb)

  // resolveConfirmation stays undefined: WS/CLI verdicts reach the RunManager's
  // internal ConfirmationBroker exactly as Task 6 wired it.
  const llm = (opts.llmFactory ?? defaultLlmFactory)(config)
  const model = resolveModel(config)
  const bus = new EventBus()
  const run = new RunManager({
    config,
    paths,
    sessions,
    memory,
    bus,
    llm,
    workspace: config.workspace,
    model,
    // Retry visibility (spec §11, final-review I1): with the DEFAULT
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
    webDist: resolveWebDist(opts.webDist),
  })
  await app.listen({ port: opts.port ?? 0, host: HOST })
  const address = app.server.address()
  const port = typeof address === "object" && address !== null ? address.port : (opts.port ?? 0)

  const daemonJson = join(paths.home, "daemon.json")
  writeFileSync(daemonJson, `${JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8")

  const tick = startSchedulerTick({ scheduler: jobs, run, bus, sessions, intervalMs: opts.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS, purgeTtlMs: config.sessions.recycleBinTtlMs })
  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  let stopped = false
  return {
    port,
    token,
    pid: process.pid,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      // Bounded stop (P4 Task 2): each teardown step gets a deadline, or a
      // hung tracked run (tick.stop awaits them) / stuck connection
      // (app.close awaits them) could park stop() forever. On a timeout the
      // error propagates to the caller (bin logs to stderr and exits 1) and
      // daemon.json is KEPT: the process is still alive, so an honest pidfile
      // beats a cleaned one. In-flight job runs are abandoned per §11
      // crash-tolerance semantics — JSONL tolerates partial runs, and since
      // the in-flight guard is in-memory, a daemon that never returns from
      // stop() leaves its jobs "due" and they re-fire on the next start.
      await withStopTimeout(tick.stop(), stopTimeoutMs, "scheduler tick")
      await withStopTimeout(app.close(), stopTimeoutMs, "app close")
      rmSync(daemonJson, { force: true })
    },
  }
}
