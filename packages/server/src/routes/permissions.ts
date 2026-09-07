/**
 * Decided-rules management routes: list (both scopes, with the git-tracked
 * state the gate acts on) and delete. The files themselves remain the
 * hand-editable surface; these routes power the WebUI management view.
 */
import type { FastifyInstance } from "fastify"
import {
  deleteDecidedRule,
  globalDecidedRulesPath,
  isGitTracked,
  loadDecidedRules,
  projectDecidedRulesPath,
  PROJECT_RULES_REL,
  type KclawPaths,
} from "@kclaw/core"

const NOT_FOUND = { error: "not found" }

/** Dependencies for the decided-rules routes (injected by createApp). */
export interface PermissionsStores {
  paths: KclawPaths
  /** Daemon default workspace: the project scope when a request names none. */
  workspaceFallback: string
}

export function registerPermissionsRoutes(app: FastifyInstance, stores: PermissionsStores): void {
  // Snapshot of both scopes: entries plus the per-scope on-disk state the
  // gate would see (an ignored project file is listed with ignored=true so
  // the UI can explain why its rules are not in force).
  app.get("/permissions/rules", async (request) => {
    const query = request.query as { workspace?: string } | undefined
    const workspace = query?.workspace ?? stores.workspaceFallback
    const projectPath = projectDecidedRulesPath(workspace)
    const tracked = isGitTracked(workspace, PROJECT_RULES_REL)
    return {
      global: {
        path: globalDecidedRulesPath(stores.paths.home),
        rules: loadDecidedRules(globalDecidedRulesPath(stores.paths.home)),
      },
      project: {
        path: projectPath,
        tracked,
        ignored: tracked,
        rules: tracked ? [] : loadDecidedRules(projectPath),
      },
    }
  })

  app.delete("/permissions/rules", async (request, reply) => {
    const body = request.body as { scope?: unknown; index?: unknown; workspace?: unknown } | null | undefined
    if (body?.scope !== "global" && body?.scope !== "project") {
      return reply.code(400).send({ error: 'scope must be "global" or "project"' })
    }
    if (typeof body.index !== "number" || !Number.isInteger(body.index) || body.index < 0) {
      return reply.code(400).send({ error: "index must be a non-negative integer" })
    }
    const target =
      body.scope === "global"
        ? globalDecidedRulesPath(stores.paths.home)
        : projectDecidedRulesPath(typeof body.workspace === "string" && body.workspace !== "" ? body.workspace : stores.workspaceFallback)
    const removed = deleteDecidedRule(target, body.index)
    if (removed === undefined) return reply.code(404).send(NOT_FOUND)
    return { ok: true, removed }
  })
}
