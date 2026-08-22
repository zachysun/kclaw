import type { FastifyError, FastifyInstance } from "fastify"
import type { SessionStore } from "@kclaw/core"

/** Store dependencies for the session routes (injected by createApp). */
export interface SessionStores {
  sessions: SessionStore
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
      return reply.code(201).send(stores.sessions.create(parsed.title, undefined, parsed.workdir))
    })

    scope.get("/sessions", async (request) => {
      const q = (request.query as { deleted?: unknown } | undefined)?.deleted
      return stores.sessions.list({ deleted: q === "true" })
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

    scope.get("/sessions/:id/messages", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      return stores.sessions.readMessages(id)
    })

    scope.patch("/sessions/:id", async (request, reply) => {
      const parsed = parseSessionBody(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      const { id } = request.params as { id: string }
      if (stores.sessions.meta(id) === undefined) return reply.code(404).send(NOT_FOUND)
      stores.sessions.updateMeta(id, parsed.title === undefined ? {} : { title: parsed.title })
      return stores.sessions.meta(id)
    })
  })
}
