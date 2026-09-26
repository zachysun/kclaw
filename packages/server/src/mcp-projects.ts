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
  /** Sync cadence; the timer is owned here and cleared by close(). */
  syncIntervalMs?: number
}

export function createMcpProjects(deps: McpProjectsDeps): {
  mount(workdir: string): void
  sync(): void
  close(): void
} {
  const known = new Set<string>()
  const watches = new Map<string, { ensure: () => void; close: () => void }>()
  let timer: NodeJS.Timeout | undefined

  function mount(workdir: string): void {
    if (known.has(workdir)) return
    known.add(workdir)
    deps.manager.ensureProject(workdir, deps.loadEntries(workdir))
    const watch = createProjectMcpWatch(workdir, () => {
      deps.manager.reconcileProject(workdir, deps.loadEntries(workdir))
    })
    watches.set(workdir, watch)
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
    const wanted = new Set<string>([deps.workspace])
    for (const meta of deps.allMetas()) {
      if (meta.workdir !== undefined) wanted.add(meta.workdir)
    }
    for (const workdir of wanted) {
      if (!known.has(workdir)) mount(workdir)
    }
    for (const workdir of [...known]) {
      if (workdir !== deps.workspace && !wanted.has(workdir)) unmount(workdir)
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
