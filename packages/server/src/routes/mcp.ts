/**
 * MCP management routes: the status snapshot (GET /mcp, consumed by
 * `kclaw mcp list` and the WebUI MCP tab) plus the hot-config action family
 * (create/update/delete/enable/reconnect) that drives McpManager. Every
 * action persists through the manager's persist hook — the daemon wires
 * that to mcp.json consolidation, so any save also migrates the legacy
 * config.yaml section. Without a manager assembly the actions answer 503
 * (the /memory precedent) while the snapshot stays a plain empty list.
 */
import type { FastifyInstance } from "fastify"
import type { McpServerConfig, McpServerStatus } from "@kclaw/core"
import { parseMcpServerConfig } from "@kclaw/core"

/** What the routes need from the manager (the McpManager surface in practice). */
export interface McpRoutesView {
  status(): McpServerStatus[]
  flush(): Promise<void>
  addServer(name: string, config: McpServerConfig): void
  updateServer(name: string, config: McpServerConfig): void
  removeServer(name: string): void
  setEnabled(name: string, enabled: boolean): void
  reconnect(name: string): void
}

export interface McpRoutesDeps {
  mcp?: McpRoutesView
}

const NOT_FOUND = { error: "not found" }

/**
 * Server names become part of model-facing tool ids (`mcp__<name>__tool`),
 * so a name outside this set would produce tool definitions many providers
 * reject. Entries that predate the UI (config.yaml / mcp.json) are never
 * re-validated — only new names entering through the API are.
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/** Map a manager rejection to its HTTP status by message class. */
function managerError(e: unknown): { code: number; error: string } {
  const message = (e as Error).message
  if (message.startsWith("unknown MCP server")) return { code: 404, error: message }
  if (message.includes("already exists")) return { code: 409, error: message }
  return { code: 400, error: message }
}

interface NameParams {
  name: string
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpRoutesDeps): void {
  app.get("/mcp", async () => ({ servers: deps.mcp?.status() ?? [] }))

  app.post("/mcp/servers", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const body = request.body as { name?: unknown; config?: unknown } | null | undefined
    if (typeof body?.name !== "string" || body.name.trim() === "") {
      return reply.code(400).send({ error: "name is required" })
    }
    const name = body.name.trim()
    if (!NAME_PATTERN.test(name)) {
      return reply.code(400).send({ error: "name may only contain letters, digits, '_' and '-'" })
    }
    let config: McpServerConfig
    try {
      config = parseMcpServerConfig(body.config)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    try {
      deps.mcp.addServer(name, config)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, servers: deps.mcp.status() }
  })

  app.patch("/mcp/servers/:name", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const { name } = request.params as NameParams
    const body = request.body as { config?: unknown } | null | undefined
    let config: McpServerConfig
    try {
      config = parseMcpServerConfig(body?.config)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    try {
      deps.mcp.updateServer(name, config)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, servers: deps.mcp.status() }
  })

  app.delete("/mcp/servers/:name", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const { name } = request.params as NameParams
    try {
      deps.mcp.removeServer(name)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, servers: deps.mcp.status() }
  })

  app.post("/mcp/servers/:name/enable", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const { name } = request.params as NameParams
    const body = request.body as { enabled?: unknown } | null | undefined
    if (typeof body?.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" })
    }
    try {
      deps.mcp.setEnabled(name, body.enabled)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, servers: deps.mcp.status() }
  })

  app.post("/mcp/servers/:name/reconnect", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const { name } = request.params as NameParams
    try {
      deps.mcp.reconnect(name)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, servers: deps.mcp.status() }
  })
}
