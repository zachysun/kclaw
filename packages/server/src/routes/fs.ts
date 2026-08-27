import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { FastifyInstance } from "fastify"

/** Dependencies for the fs-browse route (injected by createApp). */
export interface FsStores {
  /** Root of the picker when no `path` query is given (config.workspace). */
  workspace: string
}

/** Wire shape of `GET /fs/browse` (mirrored by the WebUI picker). */
export interface FsBrowseResult {
  /** Canonical (symlink-resolved) absolute path that was listed. */
  path: string
  /** Parent directory, or null at the filesystem root. */
  parent: string | null
  /** Subdirectory names only (files excluded), sorted case-insensitively. */
  dirs: string[]
}

/** Expand a leading `~` the same way the permission engine does. */
function expandTilde(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2))
  return p
}

/**
 * Register `GET /fs/browse?path=<abs>` — the directory listing behind the
 * WebUI workdir picker. The browser cannot enumerate the daemon's filesystem
 * on its own, so the picker navigates through this endpoint instead.
 *
 * The route is bearer-protected like every other API route; it lists
 * directories anywhere on the machine (the picker's whole point is choosing
 * an arbitrary workdir). Without `path` it starts at the configured
 * workspace. Entries that vanish or turn unreadable mid-listing are skipped;
 * a missing/non-directory/unreadable target is a 400.
 */
export function registerFsRoutes(app: FastifyInstance, opts: FsStores): void {
  app.get("/fs/browse", async (request, reply) => {
    const query = request.query as { path?: unknown }
    const raw =
      typeof query.path === "string" && query.path.trim() !== "" ? query.path.trim() : opts.workspace

    let resolved: string
    try {
      resolved = realpathSync(path.resolve(expandTilde(raw)))
    } catch {
      return reply.code(400).send({ error: `path does not exist: ${raw}` })
    }
    try {
      if (!statSync(resolved).isDirectory()) {
        return reply.code(400).send({ error: `not a directory: ${resolved}` })
      }
    } catch {
      return reply.code(400).send({ error: `path does not exist: ${resolved}` })
    }

    let entries: Dirent[]
    try {
      entries = readdirSync(resolved, { withFileTypes: true })
    } catch {
      return reply.code(400).send({ error: `cannot read directory: ${resolved}` })
    }

    const dirs: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(entry.name)
        continue
      }
      // A symlink shows up as !isDirectory(); follow it so linked folders
      // (e.g. macOS /tmp -> private/tmp) stay navigable. Broken links skip.
      if (entry.isSymbolicLink()) {
        try {
          if (statSync(path.join(resolved, entry.name)).isDirectory()) dirs.push(entry.name)
        } catch {
          // broken or unreadable link target — skip
        }
      }
    }
    dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))

    const parent = path.dirname(resolved)
    const result: FsBrowseResult = {
      path: resolved,
      parent: parent === resolved ? null : parent,
      dirs,
    }
    return result
  })
}
