import type { FastifyError, FastifyInstance } from "fastify"
import type { KclawConfig, SessionStore } from "@kclaw/core"
import type { RunManager } from "../run.js"

/** Store dependencies for the session routes (injected by createApp). */
export interface SessionStores {
  sessions: SessionStore
  /** Providers entries for model-name validation on the model switch route. */
  config?: KclawConfig
  /** RunManager for compaction (injected by createApp). Missing → the compact route answers 503. */
  run?: RunManager
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
      return reply.code(201).send(stores.sessions.create(parsed.title, undefined, workdir))
    })

    scope.get("/sessions", async (request) => {
      const q = (request.query as { deleted?: unknown } | undefined)?.deleted
      return stores.sessions.list({ deleted: q === "true" })
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
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
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
      stores.sessions.purge(id)
      return { ok: true }
    })

    // Session-level readonly switch: write/exec tools deny with "readonly".
    scope.post("/sessions/:id/readonly", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      const body = request.body as { readonly?: unknown } | null | undefined
      if (typeof body?.readonly !== "boolean") {
        return reply.code(400).send({ error: "readonly must be a boolean" })
      }
      return stores.sessions.updateMeta(id, body.readonly ? { readonly: true } : { readonly: undefined })
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

    // Compaction audit log (spec 6A.2): read-only view over compactions.jsonl.
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

    // Manual compaction (spec 6.5): optional { focus } body. compactSession's
    // busy refusal ("会话正在运行") maps to 409, its missing-session error to
    // 404; anything else is a 500 with the error message.
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
        const status = message === "会话正在运行" ? 409 : message === "session not found" ? 404 : 500
        return reply.code(status).send({ error: message })
      }
    })
  })
}
