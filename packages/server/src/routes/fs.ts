import { readdirSync, realpathSync, statSync, existsSync, type Dirent } from "node:fs"
import { spawnSync } from "node:child_process"
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

/** Listing cap for the mention drawer — keeps the payload and the UI bounded. */
export const FILE_LIST_CAP = 5000

/** Directories the non-git fallback scan never descends into. */
const EXCLUDED_SCAN_DIRS = new Set([".git", ".kclaw", "node_modules"])

/** Wire shape of `GET /fs/files` (the WebUI mention drawer's data source). */
export interface FsFilesResult {
  /** Canonical (symlink-resolved) workspace that was listed. */
  workdir: string
  /** Workspace-relative POSIX paths, files only, sorted case-insensitively. */
  files: string[]
  /** True when the listing was cut off at {@link FILE_LIST_CAP}. */
  truncated: boolean
}

/**
 * Files of one workspace for the mention drawer. A git repo answers with one
 * `git ls-files -co --exclude-standard` — tracked plus untracked-but-not-
 * ignored files, so git-ignored content never appears; the existsSync pass
 * drops index entries whose file was deleted. Outside a git repo (or when
 * git is unavailable) the fallback is a recursive scan collecting regular
 * files only, never descending into .git, .kclaw or node_modules. Either way
 * the result is sorted case-insensitively and capped at FILE_LIST_CAP.
 */
export function listWorkspaceFiles(dir: string): { files: string[]; truncated: boolean } {
  let collected: string[]
  const git = spawnSync("git", ["-C", dir, "ls-files", "-co", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (git.status === 0 && typeof git.stdout === "string") {
    collected = [...new Set(git.stdout.split("\n").filter((line) => line !== ""))].filter((f) => existsSync(path.join(dir, f)))
  } else {
    collected = []
    let overflow = false
    const walk = (rel: string, entries: Dirent[]): void => {
      for (const entry of entries) {
        if (collected.length >= FILE_LIST_CAP) {
          overflow = true
          return
        }
        if (entry.isDirectory()) {
          if (EXCLUDED_SCAN_DIRS.has(entry.name)) continue
          const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`
          try {
            walk(childRel, readdirSync(path.join(dir, childRel), { withFileTypes: true }))
          } catch {
            // unreadable subtree — skip it, the rest still lists
          }
        } else if (entry.isFile()) {
          collected.push(rel === "" ? entry.name : `${rel}/${entry.name}`)
        }
      }
    }
    try {
      walk("", readdirSync(dir, { withFileTypes: true }))
    } catch {
      // unreadable root — an empty listing
    }
    collected.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    return { files: collected.slice(0, FILE_LIST_CAP), truncated: overflow || collected.length > FILE_LIST_CAP }
  }
  collected.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  return { files: collected.slice(0, FILE_LIST_CAP), truncated: collected.length > FILE_LIST_CAP }
}

/**
 * Register `GET /fs/files?workdir=<abs>` — the workspace file listing behind
 * the WebUI mention drawer. Missing `workdir` falls back to the configured
 * workspace; the target must be an existing directory (400 otherwise).
 * Bearer-protected like every other API route.
 */
export function registerFsFilesRoute(app: FastifyInstance, opts: FsStores): void {
  app.get("/fs/files", async (request, reply) => {
    const query = request.query as { workdir?: unknown }
    const raw =
      typeof query.workdir === "string" && query.workdir.trim() !== "" ? query.workdir.trim() : opts.workspace

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

    const result: FsFilesResult = { workdir: resolved, ...listWorkspaceFiles(resolved) }
    return result
  })
}
