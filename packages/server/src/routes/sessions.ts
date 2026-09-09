import type { FastifyError, FastifyInstance } from "fastify"
import { isPermissionMode, PERMISSION_MODES, type KclawConfig, type MemorySystem, type SessionStore } from "@kclaw/core"
import type { RunManager } from "../run.js"

/** Store dependencies for the session routes (injected by createApp). */
export interface SessionStores {
  sessions: SessionStore
  /** Providers entries for model-name validation on the model switch route. */
  config?: KclawConfig
  /** RunManager for compaction (injected by createApp). Missing → the compact route answers 503. */
  run?: RunManager
  /**
   * MemorySystem for the session-switch memory write (injected by createApp).
   * Missing → POST /sessions creates sessions without triggering a memory write
   * (same behavior as a project without memory assembled).
   */
  memory?: MemorySystem
}

const NOT_FOUND = { error: "session not found" } as const

/**
 * Parse a `{title?, workdir?}` request body. Each field must be absent or a
 * non-empty string; anything else is a 400. A missing body counts as absent.
 */
function parseSessionBody(body: unknown): { ok: true; title?: string; workdir?: string } | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" }
  }
  const { title, workdir } = body as { title?: unknown; workdir?: unknown }
  if (title !== undefined && (typeof title !== "string" || title.length === 0)) {
    return { ok: false, error: "title must be a non-empty string" }
  }
  if (workdir !== undefined && (typeof workdir !== "string" || workdir.length === 0)) {
    return { ok: false, error: "workdir must be a non-empty string" }
  }
  return { ok: true, title, workdir }
}

/**
 * Register the session CRUD routes on the app, backed by the injected
 * SessionStore. Routes live in an encapsulated scope whose error handler
 * normalizes body-parse failures (malformed JSON, empty JSON body) into
 * the `{error}` response shape; the parent app's bearer-token auth hook
 * still applies to every route registered here.
 */
export function registerSessionRoutes(app: FastifyInstance, stores: SessionStores): void {
  app.register(async (scope) => {
    scope.setErrorHandler((error: FastifyError, _request, reply) => {
      reply.status(error.statusCode ?? 500).send({ error: error.message })
    })

    scope.post("/sessions", async (request, reply) => {
      const parsed = parseSessionBody(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      // An absent workdir means "the daemon's configured workspace": store the
      // resolved path so every WebUI-created session carries a concrete
      // workdir (the sidebar groups by it).
      const workdir = parsed.workdir ?? stores.config?.workspace
      // 切会话写入（/clear、/new、web 新建会话共用此路由）：创建前取"项目最近活动
      // 会话"作归属——此刻新会话尚未建立，最近活动者必然是用户刚离开的旧会话；
      // 创建后异步触发 clear 提取（范围覆盖到当前时刻），不阻塞建会话响应。失败只
      // 打日志：提取由水位防重复，下次任一触发补上。
      const fromSession = stores.memory !== undefined && workdir !== undefined
        ? stores.memory.recentSessionId(workdir)
        : undefined
      const created = stores.sessions.create(parsed.title, undefined, workdir, stores.config?.permissions.defaultMode)
      if (stores.memory !== undefined && workdir !== undefined) {
        void stores.memory.triggerClear(workdir, fromSession).catch((err) => {
          console.error(`kclaw memory clear failed: ${String(err)}`)
        })
      }
      return reply.code(201).send(created)
    })

    scope.get("/sessions", async (request) => {
      const query = (request.query as { deleted?: unknown; children?: unknown } | undefined) ?? {}
      // Child sessions (subagent dispatches) stay out of the default list —
      // they are ephemeral work units whose full trail lives in the audit
      // view; `children=true` opts in, and by-id access is always open.
      const metas = stores.sessions.list({ deleted: query.deleted === "true" })
      return query.children === "true" ? metas : metas.filter((m) => m.parentSessionId === undefined)
    })

    // Runtime model switch: only affects this session's LATER runs (history
    // untouched). Empty string clears back to the daemon default.
    scope.post("/sessions/:id/model", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      const body = request.body as { model?: unknown } | null | undefined
      const model = body?.model
      if (model !== undefined && typeof model !== "string") {
        return reply.code(400).send({ error: "model must be a string" })
      }
      const name = model ?? ""
      if (name !== "") {
        const entries = stores.config?.providers.entries ?? {}
        if (entries[name] === undefined) {
          return reply.code(400).send({ error: `model not found: ${name}` })
        }
      }
      return stores.sessions.updateMeta(id, name === "" ? { model: undefined } : { model: name })
    })

    scope.delete("/sessions/:id", async (request, reply) => {
      const { id } = request.params as { id: string }
      const meta = stores.sessions.meta(id)
      if (meta === undefined) return reply.code(404).send(NOT_FOUND)
      // Cascade: a parent's children (subagent sessions) are soft-deleted with
      // it — no orphans in the recycle bin.
      for (const child of stores.sessions.list().filter((m) => m.parentSessionId === id)) {
        stores.sessions.delete(child.id)
      }
      return stores.sessions.delete(id)
    })

    scope.post("/sessions/:id/restore", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      return stores.sessions.restore(id)
    })

    scope.post("/sessions/:id/purge", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      // Purge cascade mirrors the delete cascade (children are soft-deleted
      // with their parent, so both die together here).
      for (const child of stores.sessions.listByParent(id)) {
        stores.sessions.purge(child.id)
      }
      stores.sessions.purge(id)
      return { ok: true }
    })

    // Session-level permission mode switch: readonly denies write/exec,
    // acceptEdits auto-approves in-workspace file writes; trusted runs
    // everything sandboxed/no-prompt inside the boundary, auto inducts
    // repeated once-approvals into rules. Takes effect on the next run.
    scope.post("/sessions/:id/mode", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      const body = (request.body ?? {}) as { mode?: unknown }
      if (!isPermissionMode(body.mode)) {
        return reply.code(400).send({ error: `mode must be one of ${PERMISSION_MODES.join(" | ")}` })
      }
      return stores.sessions.updateMeta(id, { mode: body.mode })
    })

    scope.get("/sessions/:id", async (request, reply) => {
      const { id } = request.params as { id: string }
      const meta = stores.sessions.meta(id)
      if (meta === undefined) return reply.code(404).send(NOT_FOUND)
      return meta
    })

    scope.get("/sessions/:id/messages", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      return stores.sessions.readMessages(id)
    })

    // Full event stream (event-sourcing truth): oldest-first, includes
    // session.created, message, and compaction events. `?since=N` returns
    // only events at index >= N (the stream is append-only, so the array
    // index is a stable incremental cursor); omitted or 0 = full stream.
    // The since path reads only the file's tail lines (no parsing of the
    // skipped prefix) — live tails stay cheap as streams grow.
    scope.get("/sessions/:id/events", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      const raw = (request.query as Record<string, unknown>).since
      let since = 0
      if (raw !== undefined) {
        const n = typeof raw === "string" ? Number(raw) : NaN
        if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: "since must be a non-negative integer" })
        since = n
      }
      return stores.sessions.readEventsFrom(id, since)
    })

    // Compaction audit log: read-only view over compaction events.
    scope.get("/sessions/:id/compactions", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      return stores.sessions.readCompactions(id)
    })

    scope.patch("/sessions/:id", async (request, reply) => {
      const parsed = parseSessionBody(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      stores.sessions.updateMeta(id, parsed.title === undefined ? {} : { title: parsed.title })
      return stores.sessions.meta(id)
    })

    // Manual compaction: optional { focus } body. compactSession's
    // two busy refusals (running / non-empty queue) both map to
    // 409, its missing-session error to 404; anything else is a 500 with the
    // error message.
    scope.post("/sessions/:id/compact", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      const body = request.body as { focus?: unknown } | null | undefined
      if (body?.focus !== undefined && (typeof body.focus !== "string" || body.focus.trim() === "")) {
        return reply.code(400).send({ error: "focus must be a non-empty string" })
      }
      if (stores.run === undefined) return reply.code(503).send({ error: "run manager unavailable" })
      const focus = typeof body?.focus === "string" ? body.focus : undefined
      try {
        return await stores.run.compactSession(id, focus)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const isBusy = message === "会话正在运行，等它结束"
        const isQueued = message.startsWith("还有 ") && message.includes("排队消息")
        const status = isBusy || isQueued ? 409 : message === "session not found" ? 404 : 500
        return reply.code(status).send({ error: message })
      }
    })

    // 排队消息快照：重连/刷新的全量纠偏兜底。
    scope.get("/sessions/:id/queue", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      return stores.sessions.readQueue(id)
    })

    // 会话级处置覆盖（/steer /wait 与 Web 三选的 sticky 存储）。
    scope.post("/sessions/:id/disposition", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      const body = request.body as { disposition?: unknown } | null | undefined
      const d = body?.disposition
      if (d !== "steer" && d !== "wait" && d !== "interrupt") {
        return reply.code(400).send({ error: 'disposition must be "steer", "wait" or "interrupt"' })
      }
      return stores.sessions.updateMeta(id, { dispositionOverride: d })
    })
  })
}
