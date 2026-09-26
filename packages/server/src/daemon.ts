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
  GLOBAL_GROUP,
  JobScheduler,
  MemorySystem,
  SessionStore,
  createConfigNotifier,
  createProviderResolver,
  makeExtractLlmResolver,
  loadConfig,
  loadMcpJson,
  loadProjectMcpServers,
  mcpConfigPath,
  saveMcpJson,
  saveProjectMcpJson,
  createNotifier,
  makeEvent,
  McpManager,
  resolveModel,
  resolvePaths,
  resolveProviderFormat,
  SkillEvolutionSystem,
  UsageStore,
  withRetry,
  HookRegistry,
  AutoLearnCounter,
} from "@kclaw/core"
import type { EmbeddingClient, KclawConfig, LlmClient, McpServerConfig } from "@kclaw/core"
import { loadOrCreateToken } from "./auth.js"
import { createMcpProjects } from "./mcp-projects.js"
import { EventBus } from "@kclaw/core"
import { RunManager } from "./run.js"
import { createSubagentHost } from "./subagent.js"
import type { FeishuChannel } from "./feishu/channel.js"
import { createFeishuManager } from "./feishu/manager.js"
import { createTeamHost } from "./team.js"
import { startSchedulerTick } from "./scheduler-tick.js"
import { startMemoryScheduler } from "./memory-scheduler.js"
import { startSkillScheduler } from "./skill-scheduler.js"
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

/**
 * One-shot default composition (launch client and tests): the entry-resolved
 * client wrapped in transient-error retry (3 attempts). Per-run retry wiring
 * goes through the daemon's shared ProviderResolver (llmForRun) instead, so
 * the client cache is shared across runs instead of rebuilt per call.
 */
export function defaultLlmFactory(
  cfg: KclawConfig,
  onRetry?: (info: { attempt: number; error: unknown }) => void,
  entryKey?: string,
): LlmClient {
  return withRetry(
    createProviderResolver(cfg).llm(entryKey),
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

  // Provider client resolver: one instance per daemon owns the entry client
  // caches (runs, memory extraction, the vector path all resolve through it).
  // The provider routes publish config-section changes through the notifier
  // after persisting; the resolver drops its caches wholesale, and the
  // signature checks remain as an optimization only.
  const configNotifier = createConfigNotifier()
  const providerResolver = createProviderResolver(config)
  configNotifier.subscribe("providers", () => providerResolver.invalidate())
  const llmForEntry = (entryKey?: string): LlmClient => providerResolver.llm(entryKey)

  // The bus is built before the store: the store's post-append callback emits
  // the session.appended bus frame (audit-page subscribers use it to refetch
  // the stream incrementally — persisted before announced, no race).
  // A session.created with a fresh workdir also mounts that project's MCP
  // layer immediately (mcp-projects discovery; late-bound — the manager is
  // assembled further down).
  const bus = new EventBus()
  let mcpProjects: ReturnType<typeof createMcpProjects> | undefined
  const sessions = new SessionStore(paths.sessionsDir, (sessionId, event) => {
    bus.emit(makeEvent("session.appended", { eventType: event.type }, { sessionId }))
    if (event.type === "session.created" && event.workdir !== undefined) {
      mcpProjects?.mount(event.workdir)
    }
  })
  // embedding 判定链：model 空 → 不构造客户端（向量路关闭）；provider 名
  // 缺省取 default provider entry；entry 不存在则向量路关闭并告警（不致命）。
  const embedCfg = config.memory.embedding
  let embed: EmbeddingClient | undefined
  if (embedCfg.model !== "") {
    const entry = embedCfg.provider !== ""
      ? config.providers.entries[embedCfg.provider]
      : config.providers.entries[config.providers.default]
    if (entry !== undefined && resolveProviderFormat(entry) === "anthropic") {
      // Anthropic has no embeddings endpoint: an anthropic-format entry can
      // serve chat but never the vector path.
      console.error("kclaw memory: embedding provider is an anthropic-format entry (no embeddings API), vector path disabled")
    } else if (entry !== undefined) {
      embed = providerResolver.embed(embedCfg.provider, embedCfg.model)
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
  // 记忆系统唯一门面：embed/emit/对账在此一次性装配。
  // resolveLlm 引用上方 llmForEntry：回落走共享 resolver（未变更条目零成本
  // 复用），extractModel 命中条目走 resolveEntryLlm 同源解析——Model 页
  // 改动对记忆提取同样热生效。测试注入的 llmFactory 保持原样直用。
  const memory = new MemorySystem({
    memoryDir: paths.memoryDir,
    sessions,
    config,
    resolveLlm: () => ({ llm: opts.llmFactory !== undefined ? llm : withRetry(llmForEntry()), model: resolveModel(config) }),
    resolveEntryLlm: (entryKey) => llmForEntry(entryKey),
    embed,
    emit: (e) => bus.emit(makeEvent("memory.written", { path: e.path, kind: e.kind, ...(e.topic !== undefined ? { topic: e.topic } : {}), ...(e.scope !== undefined ? { scope: e.scope } : {}) })),
  })
  memory.reconcile()
  const jobs = new JobScheduler(paths.jobsDb)
  const usage = new UsageStore(paths.usageDb)

  // resolveConfirmation stays undefined: WS/CLI verdicts reach the RunManager's
  // internal ConfirmationBroker (createApp routes confirmation.resolve frames
  // from /ws to it).
  // Launch client: the default entry through the shared resolver, wrapped in
  // transient-error retry. An injected llmFactory (tests) replaces it whole.
  const llm = opts.llmFactory !== undefined ? opts.llmFactory(config) : withRetry(llmForEntry())
  const model = resolveModel(config)
  // 技能进化（提案制）：提炼模型与记忆提取走同一条解析链（extractModel 命中
  // 条目走条目端点，Model 页改动同样热生效）。构造交给 RunManager（run 收尾
  // 钩子 + skill_create 工具面）与 skill 调度器（检查消费端）。
  const skillsEvolution = new SkillEvolutionSystem({
    skillsDir: paths.skillsDir,
    sessions,
    config,
    resolveLlm: makeExtractLlmResolver({
      config,
      resolveLlm: () => (opts.llmFactory !== undefined ? { llm, model } : { llm: withRetry(llmForEntry()), model }),
      resolveEntryLlm: (entryKey) => llmForEntry(entryKey),
    }),
    log: (m) => console.error(m),
  })
  // MCP: the manager is always assembled (an empty one costs nothing and
  // keeps the management routes — adding the first server from the WebUI —
  // alive). Lazy model: boot connects nothing. Each project (workdir) gets
  // its own layer from <workdir>/.kclaw/mcp.json; the global layer comes
  // from ~/.kclaw/mcp.json and is shared by every project. The initial
  // project set is the union of workdirs the session records mention
  // (soft-deleted included) plus the daemon workspace — no scanning, no
  // persisted list. Hot-config changes persist per group: global → the
  // global file, a workdir → that project's file (first write creates
  // .kclaw + gitignore there). Connection failures are logged and never
  // fatal — a broken server just yields no tools.
  const workspace = config.workspace
  const initialProjects: Record<string, Record<string, McpServerConfig>> = {}
  const projectDirs = new Set<string>([workspace])
  for (const meta of sessions.allMetas()) {
    if (meta.workdir !== undefined) projectDirs.add(meta.workdir)
  }
  for (const dir of projectDirs) {
    initialProjects[dir] = loadProjectMcpServers(dir)
  }
  const mcpManager = new McpManager({
    globalServers: loadMcpJson(mcpConfigPath(paths.home)),
    projects: initialProjects,
    onError: (group, name, error) =>
      console.error(`kclaw mcp ${group === GLOBAL_GROUP ? name : `${group} · ${name}`} error: ${error}`),
    persist: (group, servers) => {
      if (group === GLOBAL_GROUP) {
        saveMcpJson(mcpConfigPath(paths.home), servers)
      } else {
        saveProjectMcpJson(group, servers)
      }
    },
  })
  // Discovery: mounts the two-stage file watch per known project (hand
  // edits hot-reload through reconcile), mounts projects created later via
  // the session-store hook above, and periodically drops projects whose
  // sessions are all gone (purge) — the file stays, the project returns
  // with its next session.
  mcpProjects = createMcpProjects({
    workspace,
    manager: mcpManager,
    allMetas: () => sessions.allMetas(),
    loadEntries: (dir) => loadProjectMcpServers(dir),
  })
  mcpProjects.sync()
  // Subagent dispatch: the spawner needs the RunManager (it submits/cancels
  // child runs) while the RunManager's engine deps need the spawner — a
  // late-bound getter breaks the cycle (dispatches only fire mid-run, long
  // after both sides exist).
  let runRef: RunManager | undefined
  const getRun = (): RunManager => {
    if (runRef === undefined) throw new Error("run manager not ready")
    return runRef
  }
  // Feishu channel: created after the RunManager exists (it needs run/sessions/
  // bus); the subagent host holds a forwarder so the settle push works either way.
  let feishuChannel: FeishuChannel | undefined
  const subagentHost = createSubagentHost({
    config,
    sessions,
    bus,
    getRun,
    onBackgroundSettled: (info) => feishuChannel?.onBackgroundSettled(info),
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
    skillsEvolution,
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
    extraTools: (workdir) => mcpManager.toolsFor(workdir),    // Retry visibility: with the DEFAULT
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

  // Feishu channel manager (#46): created after the RunManager exists (the
  // channel needs run/sessions/bus), always assembled — with feishu.json
  // disabled it just reports "disabled" and costs nothing. Every channel
  // swap (boot or hot restart) lands here so the subagent forwarder below
  // keeps following the live instance.
  const feishuManager = createFeishuManager({
    home: paths.home,
    run,
    sessions,
    bus,
    wireChannel: (ch) => { feishuChannel = ch },
    log: (line) => console.error(`kclaw feishu: ${line}`),
  })

  const app = await createApp({
    home: paths.home,
    token,
    stores: { sessions, jobs, config, paths },
    configNotifier,
    bus,
    run,
    cancelBackgroundForParent: subagentHost.cancelBackgroundForParent,
    team: teamHost,
    mcp: mcpManager,
    mainWorkspace: workspace,
    channel: feishuManager,
    attachmentsDir: paths.attachmentsDir,
    usage,
    webDist: resolveWebDist(opts.webDist),
    memory, // /memory 路由消费（管理界面）
    hooks: hookRegistry, // GET /hooks 管理面
    skillsEvolution, // /skills/proposals 提案治理面（技能进化）
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
  // 技能调度器：跟随检查消费端（成功才清 + 重试上限）。关闭配置下一个 sweep
  // 直接返回，检查停留在账本里不动（功能重开后继续消费）。
  const skillTick = startSkillScheduler({
    system: skillsEvolution, sessions, config,
    workdirs: () => Array.from(new Set(sessions.list().map((m) => m.workdir ?? config.workspace))),
  })

  // Feishu channel (#45, managed since #46): opt-in via ~/.kclaw/feishu.json
  // (enabled). Started AFTER the schedulers under the manager's own hard
  // bound, so a hanging websocket handshake (bad DNS/proxy) can never delay
  // daemon readiness; a failed start records manager "error" status (visible
  // on the IM Channel page) and never blocks the daemon either.
  await feishuManager.start()
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
      await withStopTimeout(skillTick.stop(), stopTimeoutMs, "skill scheduler")
      await withStopTimeout(feishuManager.stop(), stopTimeoutMs, "feishu channel")
      // project-file watchers first: no reconcile can race the manager teardown
      mcpProjects?.close()
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
