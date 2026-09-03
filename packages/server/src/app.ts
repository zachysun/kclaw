import { readFileSync } from "node:fs"
import Fastify from "fastify"
import fastifyStatic from "@fastify/static"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { JobScheduler, SessionStore, loadConfig, resolvePaths } from "@kclaw/core"
import type { KclawConfig, KclawPaths, MemorySystem, UsageStore } from "@kclaw/core"
import { bearerMatches } from "./auth.js"
import { EventBus } from "./bus.js"
import type { RunManager } from "./run.js"
import { registerWsRoutes } from "./ws.js"
import { registerSessionRoutes } from "./routes/sessions.js"
import { registerMemoryRoutes } from "./routes/memory.js"
import { registerSkillRoutes } from "./routes/skills.js"
import { registerAttachmentRoutes } from "./routes/attachments.js"
import { registerJobRoutes } from "./routes/jobs.js"
import { registerConfigRoutes } from "./routes/config.js"
import { registerFsRoutes } from "./routes/fs.js"
import { registerUsageRoutes } from "./routes/usage.js"

export interface AppOptions {
  /** kclaw home directory; the default SessionStore lives at <home>/sessions. */
  home: string
  /** Bearer token required on every route except /health. */
  token: string
  /** Optional store overrides for tests and composition. */
  stores?: {
    sessions?: SessionStore
    jobs?: JobScheduler
    config?: KclawConfig
    paths?: KclawPaths
  }
  /**
   * Directory of the built web UI to serve statically (its index.html at
   * `GET /`). Explicit opt-in: when omitted (the default), no static routes
   * are registered and `GET /` stays a 404.
   */
  webDist?: string
  /**
   * Event bus broadcast over the `GET /ws` websocket route; defaults to a
   * fresh EventBus. The instance is decorated onto the returned app as
   * `app.bus` so the daemon can emit AgentEvents into every connection.
   */
  bus?: EventBus
  /**
   * The daemon's RunManager: when provided, its confirmation broker answers
   * `confirmation.resolve` frames on /ws, while `send_message` rides
   * `run.enqueue` and `run.cancel` rides `run.cancel`. Without it those
   * commands answer error frames instead.
   */
  run?: RunManager
  /**
   * MCP server status snapshot, exposed at `GET /mcp` (bearer-protected,
   * consumed by `kclaw mcp list`). Absent → the route returns an empty
   * server list.
   */
  mcp?: { status(): { name: string; state: string; tools: { name: string }[]; lastError?: string }[] }
  /**
   * The daemon's attachments dir (`<home>/attachments`): when set, the
   * session attachment routes are registered and the /ws send_message
   * command accepts attachment references under it.
   */
  attachmentsDir?: string
  /** Token ledger for `GET /usage`; absent → the route returns empty buckets. */
  usage?: UsageStore
  /**
   * The daemon's MemorySystem facade, injected for the memory management
   * routes (Task 14 consumes it). Task 13 only leaves the seam — no routes
   * are registered against it here yet.
   */
  memory?: MemorySystem
  /**
   * Test-injection seam for the /ws pre-auth timeout (maps to WsOptions
   * `authTimeoutMs`); production defaults live in ws.ts.
   */
  wsAuthTimeoutMs?: number
  /**
   * Test-injection seam for the /ws heartbeat interval (maps to WsOptions
   * `heartbeatMs`); production defaults live in ws.ts.
   */
  wsHeartbeatMs?: number
}

/**
 * Read the @kclaw/server version from package.json at runtime.
 * `../package.json` resolves correctly both from src/ (vitest, tsx) and dist/.
 */
function readVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8")
  const version = (JSON.parse(raw) as { version?: string }).version
  return version ?? "0.0.0"
}

/**
 * True when the request targets the static web shell and must load BEFORE the
 * client holds a token: the shell document (`GET /`, `GET /index.html`), the
 * `/assets/*` bundle tree, and the PWA static files that live in the dist root
 * (manifest, service worker, icons; `/favicon.ico` too — the browser requests
 * it by default and there is no file on disk, so it should 404 from the static
 * handler rather than 401). Only GET is exempt; every other method and path
 * (sessions/jobs/config/ws included) stays bearer-protected.
 *
 * The check runs on the raw request path with the query string stripped, NOT
 * `request.routeOptions.url`: @fastify/static serves everything through one
 * `/*` catch-all route, so the matched-route url carries no path information.
 * (Note `GET /assets/x.js?token=…` must still be exempt — the query is the
 * client's concern, not the auth gate's.)
 */
const PWA_STATIC_PATHS = new Set(["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png", "/favicon.ico"])

function isWebShellExempt(request: FastifyRequest): boolean {
  if (request.method !== "GET") return false
  const path = request.url.split("?")[0]
  return path === "/" || path === "/index.html" || path.startsWith("/assets/") || PWA_STATIC_PATHS.has(path)
}

/**
 * Build the kclaw daemon Fastify app: bearer-token auth on every route
 * except /health and /ws (websockets authenticate per connection via the
 * first frame), plus GET /health and GET /status, the session/job/config
 * routes, the GET /ws subscription endpoint, and (only when `webDist`
 * is given) static hosting of the web UI with its shell/assets exempted.
 */
export async function createApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const startedAt = Date.now()
  const version = readVersion()

  app.addHook("preHandler", async (request, reply) => {
    const routeUrl = request.routeOptions?.url ?? request.url.split("?")[0]
    // /ws carries no Authorization header: it authenticates per connection
    // inside the websocket handler (first frame or ?token=).
    if (routeUrl === "/health" || routeUrl === "/ws") return
    // Static web shell (only when webDist is configured): the shell and its
    // /assets/* bundles load in the browser before it has a token.
    if (opts.webDist !== undefined && isWebShellExempt(request)) return
    if (!bearerMatches(request.headers.authorization, opts.token)) {
      return reply.code(401).send({ error: "unauthorized" })
    }
  })

  app.get("/health", async () => ({ ok: true }))

  app.get("/status", async () => ({
    version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  }))

  const paths = opts.stores?.paths ?? resolvePaths(opts.home)
  const sessions = opts.stores?.sessions ?? new SessionStore(paths.sessionsDir)
  const config = opts.stores?.config ?? loadConfig(paths)
  // opts.run is the daemon's RunManager (same instance the ws routes use);
  // the session routes only need it for POST /sessions/:id/compact.
  // spec 9.2 的 /memory 路由族：无 memory 装配时全部 503，不影响既有路由。
  registerMemoryRoutes(app, { memory: opts.memory, config })
  // /skills 路由族：只读技能管理面（CLI /skill 与 Web 技能页共用），无装配依赖。
  registerSkillRoutes(app, { paths })
  // 切会话写入：POST /sessions 是 CLI /clear、/new 与 web 新建会话的共同底层，
  // 记忆系统在装配时才挂 clear 触发（缺省不触发，行为与未装配记忆时一致）。
  registerSessionRoutes(app, { sessions, config, run: opts.run, memory: opts.memory })
  if (opts.attachmentsDir !== undefined) {
    registerAttachmentRoutes(app, { sessions, attachmentsDir: opts.attachmentsDir })
  }

  const jobs = opts.stores?.jobs ?? new JobScheduler(paths.jobsDb)
  registerJobRoutes(app, { jobs })

  registerConfigRoutes(app, { config })
  registerFsRoutes(app, { workspace: config.workspace })

  if (opts.usage !== undefined) {
    registerUsageRoutes(app, { usage: opts.usage, config })
  }

  app.get("/mcp", async () => ({ servers: opts.mcp?.status() ?? [] }))

  const bus = opts.bus ?? new EventBus()
  app.decorate("bus", bus)
  await registerWsRoutes(app, {
    bus,
    token: opts.token,
    sessions,
    run: opts.run,
    attachmentsDir: opts.attachmentsDir,
    authTimeoutMs: opts.wsAuthTimeoutMs,
    heartbeatMs: opts.wsHeartbeatMs,
  })

  if (opts.webDist !== undefined) {
    await app.register(fastifyStatic, { root: opts.webDist })
  }

  return app
}
