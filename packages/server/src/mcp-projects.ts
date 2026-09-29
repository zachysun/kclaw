/**
 * Project discovery for the per-project MCP layers: the daemon manages the
 * union of workdirs its sessions record (soft-deleted included — the
 * recycle bin keeps a project's layer alive) plus its own workspace. No
 * filesystem scanning, no persisted list: startup computes the union from
 * the session records; a new session in a new directory mounts that
 * project immediately (the store's append hook calls `mount`); a periodic
 * sync unmounts projects whose sessions are gone (purge) — the project
 * file stays on disk and the project comes back with its next session.
 *
 * Each mounted project gets the two-stage file watch (hand edits hot-
 * reload through reconcile); a watch that cannot start degrades inside
 * createProjectMcpWatch and is never fatal.
 */
import type { McpServerConfig } from "@kclaw/core"
import { projectMcpCollidesWithGlobal, resolveProjectIdentity } from "@kclaw/core"
import { createProjectMcpWatch } from "./project-mcp-watch.js"

export interface McpProjectsDeps {
  /** The daemon's own workspace: always mounted, never dropped. */
  workspace: string
  /** The manager surface the discovery drives (McpManager in practice). */
  manager: {
    ensureProject(workdir: string, entries: Record<string, McpServerConfig>): void
    dropProject(workdir: string): Promise<void>
    reconcileProject(workdir: string, entries: Record<string, McpServerConfig>): void
  }
  /** Session records INCLUDING soft-deleted ones (SessionStore.allMetas). */
  allMetas(): Array<{ workdir?: string }>
  /** Read one project's entries (storage defenses applied inside). */
  loadEntries(workdir: string): Record<string, McpServerConfig>
  /** The daemon home: a project whose config file IS the global mcp.json is skipped. */
  home?: string
  /** Sync cadence; the timer is owned here and cleared by close(). */
  syncIntervalMs?: number
}

/**
 * The project-directory set, shared with the daemon's manager assembly so
 * both sides see the same thing: the workspace plus every session-recorded
 * workdir, minus any directory whose project config file would be the
 * global file itself (daemon home inside the project) — that project layer
 * cannot exist independently and stays unmounted. Every directory comes out
 * as its canonical identity (resolveProjectIdentity), so different spellings
 * of one directory mount one project, and a relative spelling never shows up
 * as a group id the action routes would reject.
 */
export function collectProjectDirs(deps: Pick<McpProjectsDeps, "workspace" | "allMetas" | "home">): string[] {
  const wanted = new Set<string>([resolveProjectIdentity(deps.workspace)])
  for (const meta of deps.allMetas()) {
    if (meta.workdir !== undefined) wanted.add(resolveProjectIdentity(meta.workdir))
  }
  return [...wanted].filter((dir) => deps.home === undefined || !projectMcpCollidesWithGlobal(dir, deps.home))
}

export function createMcpProjects(deps: McpProjectsDeps): {
  mount(workdir: string): void
  sync(): void
  close(): void
} {
  const known = new Set<string>()
  const watches = new Map<string, { ensure: () => void; close: () => void }>()
  /** Canonical identity of the workspace — always mounted, never dropped. */
  const workspaceId = resolveProjectIdentity(deps.workspace)
  let timer: NodeJS.Timeout | undefined

  /** Mount one project; the workdir canonicalizes to the group identity. */
  function mount(workdir: string): void {
    const dir = resolveProjectIdentity(workdir)
    if (deps.home !== undefined && projectMcpCollidesWithGlobal(dir, deps.home)) return
    if (known.has(dir)) return
    known.add(dir)
    deps.manager.ensureProject(dir, deps.loadEntries(dir))
    const watch = createProjectMcpWatch(dir, () => {
      deps.manager.reconcileProject(dir, deps.loadEntries(dir))
    })
    watches.set(dir, watch)
    watch.ensure()
  }

  function unmount(workdir: string): void {
    const watch = watches.get(workdir)
    if (watch === undefined) return
    watch.close()
    watches.delete(workdir)
    known.delete(workdir)
    void deps.manager.dropProject(workdir)
  }

  /** One pass: mount every wanted workdir, unmount projects nobody references. */
  function sync(): void {
    const wanted = new Set(collectProjectDirs(deps))
    for (const workdir of wanted) {
      if (!known.has(workdir)) mount(workdir)
    }
    for (const workdir of [...known]) {
      if (workdir !== workspaceId && !wanted.has(workdir)) unmount(workdir)
    }
  }

  const intervalMs = deps.syncIntervalMs ?? 60_000
  if (intervalMs > 0) {
    timer = setInterval(sync, intervalMs)
  }

  return {
    mount,
    sync,
    close() {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      for (const watch of watches.values()) watch.close()
      watches.clear()
    },
  }
}
