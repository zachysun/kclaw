/**
 * MCP management routes: the grouped status snapshot (GET /mcp, consumed by
 * `kclaw mcp list` and the WebUI MCP tab) plus the hot-config action family
 * (create/update+move/delete/enable/connect) that drives McpManager. Every
 * action names its group explicitly — "global" or a project workdir; a
 * missing or malformed group is a 400, an unknown group is a 404 from the
 * manager. Moving entries happens through PATCH with a `toGroup` (atomic
 * on the manager side; a same-name target refuses up front). The old
 * reconnect became connect: a manual one-shot probe for an entry that is
 * resting or failed. Every action persists through the manager's persist
 * hook — the daemon wires "global" to mcp.json and each workdir to that
 * project's file. Without a manager assembly the actions answer 503 (the
 * /memory precedent) while the snapshot stays an empty group list.
 *
 * Secrets never leave unmasked: stdio `env` and http `headers` values are
 * masked on the way out (keys stay visible, the provider apiKey rule), and
 * a blank value on the way in means "keep the stored one" — the client only
 * ever holds the mask, so blank is how an edit preserves a secret. Dropping
 * the row removes the key.
 */
import type { FastifyInstance } from "fastify"
import type { McpServerConfig } from "@kclaw/core"
import { McpError, isGroupId, parseMcpServerConfig } from "@kclaw/core"
import type { McpSnapshot } from "@kclaw/core/protocol"
import { maskSecret } from "./config.js"

/** What the routes need from the manager (the McpManager surface in practice). */
export interface McpRoutesView {
  status(): McpSnapshot
  flush(): Promise<void>
  addServer(group: string, name: string, config: McpServerConfig): void
  updateServer(group: string, name: string, config: McpServerConfig, toGroup?: string): void
  removeServer(group: string, name: string): void
  setEnabled(group: string, name: string, enabled: boolean): void
  connect(group: string, name: string): void
}

export interface McpRoutesDeps {
  mcp?: McpRoutesView
  /** The daemon's own workspace: echoed in the snapshot as the fallback target for new entries. */
  mainWorkspace?: string
}

const NOT_FOUND = { error: "not found" }

const GROUP_REQUIRED = 'group is required ("global" or a project workdir path)'

/**
 * Server names become part of model-facing tool ids (`mcp__<name>__tool`),
 * so a name outside this set would produce tool definitions many providers
 * reject. Entries that predate the UI (config.yaml / mcp.json) are never
 * re-validated — only new names entering through the API are.
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/** Map a manager rejection to its HTTP status by its error code. */
function managerError(e: unknown): { code: number; error: string } {
  const err = e as Error
  if (err instanceof McpError) {
    return { code: err.code === "not-found" ? 404 : err.code === "conflict" ? 409 : 400, error: err.message }
  }
  return { code: 400, error: err.message }
}

interface NameParams {
  name: string
}

/** The two secret-bearing config fields, masked out and merged back the same way. */
const SECRET_FIELDS = ["env", "headers"] as const

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Mask stdio `env` / http `headers` values; keys stay visible. */
function maskConfig(config: McpServerConfig): McpServerConfig {
  const out = { ...config } as Record<string, unknown>
  for (const field of SECRET_FIELDS) {
    const rec = out[field]
    if (!isStringRecord(rec)) continue
    out[field] = Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, maskSecret(v)]))
  }
  return out as McpServerConfig
}

/** The wire snapshot: every group's entries with their secret values masked. */
function wireGroups(deps: McpRoutesDeps): McpSnapshot["groups"] {
  return (deps.mcp?.status().groups ?? []).map((g) => ({
    id: g.id,
    servers: g.servers.map((s) => ({ ...s, config: maskConfig(s.config) })),
  }))
}

/** The stored (unmasked) config of one entry, or undefined. */
function storedConfig(deps: McpRoutesDeps, group: string, name: string): McpServerConfig | undefined {
  return deps.mcp?.status().groups.find((g) => g.id === group)?.servers.find((s) => s.name === name)?.config
}

/**
 * Blank env/header values mean "unchanged": the client holds only the mask,
 * so a blank field keeps the stored secret for that key (the provider
 * apiKey rule). A blank on a key the stored entry doesn't have stays blank
 * as typed; omitting the key drops it.
 */
function mergeStoredSecrets(incoming: McpServerConfig, stored: McpServerConfig | undefined): McpServerConfig {
  const out = { ...incoming } as Record<string, unknown>
  for (const field of SECRET_FIELDS) {
    const rec = out[field]
    if (!isStringRecord(rec)) continue
    const prevRaw = (stored as Record<string, unknown> | undefined)?.[field]
    const prev = isStringRecord(prevRaw) ? prevRaw : undefined
    out[field] = Object.fromEntries(
      Object.entries(rec).map(([k, v]) => [k, v === "" && prev?.[k] !== undefined ? prev[k] : v]),
    )
  }
  return out as McpServerConfig
}

export function registerMcpRoutes(app: FastifyInstance, deps: McpRoutesDeps): void {
  app.get("/mcp", async () => ({
    groups: wireGroups(deps),
    mainWorkspace: deps.mainWorkspace ?? "",
  }))

  app.post("/mcp/servers", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const body = request.body as { name?: unknown; config?: unknown; group?: unknown } | null | undefined
    if (typeof body?.name !== "string" || body.name.trim() === "") {
      return reply.code(400).send({ error: "name is required" })
    }
    const name = body.name.trim()
    if (!NAME_PATTERN.test(name)) {
      return reply.code(400).send({ error: "name may only contain letters, digits, '_' and '-'" })
    }
    if (!isGroupId(body.group)) {
      return reply.code(400).send({ error: GROUP_REQUIRED })
    }
    let config: McpServerConfig
    try {
      config = parseMcpServerConfig(body.config)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    try {
      deps.mcp.addServer(body.group, name, config)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, groups: wireGroups(deps) }
  })

  app.patch("/mcp/servers/:name", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const { name } = request.params as NameParams
    const body = request.body as { config?: unknown; group?: unknown; toGroup?: unknown } | null | undefined
    const group = body?.group
    const toGroup = body?.toGroup
    if (!isGroupId(group)) {
      return reply.code(400).send({ error: GROUP_REQUIRED })
    }
    if (toGroup !== undefined && !isGroupId(toGroup)) {
      return reply.code(400).send({ error: "toGroup must be \"global\" or a project workdir path" })
    }
    let config: McpServerConfig
    try {
      config = parseMcpServerConfig(body?.config)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    try {
      deps.mcp.updateServer(group, name, mergeStoredSecrets(config, storedConfig(deps, group, name)), toGroup)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, groups: wireGroups(deps) }
  })

  app.delete("/mcp/servers/:name", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const { name } = request.params as NameParams
    const group = (request.query as { group?: string } | undefined)?.group
    if (!isGroupId(group)) {
      return reply.code(400).send({ error: GROUP_REQUIRED })
    }
    try {
      deps.mcp.removeServer(group, name)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, groups: wireGroups(deps) }
  })

  app.post("/mcp/servers/:name/enable", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const { name } = request.params as NameParams
    const body = request.body as { enabled?: unknown; group?: unknown } | null | undefined
    if (typeof body?.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean" })
    }
    const group = body.group
    if (!isGroupId(group)) {
      return reply.code(400).send({ error: GROUP_REQUIRED })
    }
    try {
      deps.mcp.setEnabled(group, name, body.enabled)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, groups: wireGroups(deps) }
  })

  app.post("/mcp/servers/:name/connect", async (request, reply) => {
    if (deps.mcp === undefined) return reply.code(503).send({ error: "mcp not assembled" })
    const { name } = request.params as NameParams
    const group = (request.body as { group?: unknown } | null | undefined)?.group
    if (!isGroupId(group)) {
      return reply.code(400).send({ error: GROUP_REQUIRED })
    }
    try {
      deps.mcp.connect(group, name)
    } catch (e) {
      const mapped = managerError(e)
      return reply.code(mapped.code).send({ error: mapped.error })
    }
    return { ok: true, groups: wireGroups(deps) }
  })
}
