import type { FastifyInstance } from "fastify"
import type { HistorySearchFn } from "@kclaw/core"

export interface SearchRouteDeps {
  /**
   * The history search data face (index + title resolution + trash
   * filtering). Missing (bare apps/tests without an index) → /search
   * answers 503, matching the optional-route convention.
   */
  historySearch?: HistorySearchFn
}

/**
 * GET /search?q=<keywords>&limit=<1-20>&sessionId=<optional> — cross-session
 * full-text search over the raw message history (the human window into the
 * same corpus the history_search tool recalls). Auth + WS coverage are the
 * app defaults; the route is read-only.
 */
export function registerSearchRoutes(app: FastifyInstance, deps: SearchRouteDeps): void {
  app.get("/search", async (req, reply) => {
    if (deps.historySearch === undefined) {
      return reply.code(503).send({ error: "history search unavailable" })
    }
    const { q, limit, sessionId } = (req.query ?? {}) as { q?: unknown; limit?: unknown; sessionId?: unknown }
    if (typeof q !== "string" || q.trim() === "") {
      return reply.code(400).send({ error: "query parameter q is required" })
    }
    if (limit !== undefined && (!/^\d+$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > 20)) {
      return reply.code(400).send({ error: "limit must be an integer in [1, 20]" })
    }
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim() === "")) {
      return reply.code(400).send({ error: "sessionId must be a non-empty string" })
    }
    const hits = await deps.historySearch(q.trim(), {
      limit: limit === undefined ? 10 : Number(limit),
      ...(typeof sessionId === "string" && sessionId.trim() !== "" ? { sessionId: sessionId.trim() } : {}),
    })
    return { hits }
  })
}
