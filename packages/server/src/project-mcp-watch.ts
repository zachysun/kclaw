/**
 * Hot-reload watch for the project-layer MCP config
 * (<workspace>/.kclaw/mcp.json). Two-stage attach: the daemon watches the
 * workspace top level until `.kclaw` appears (creating it at startup would
 * drop an empty dir into every workspace), then switches to the `.kclaw`
 * watch; a project-layer persist calls `ensure()` directly (the birth
 * defenses just created the dir). A watch that cannot start (or errors
 * later) logs once and degrades: hand edits then apply on restart, never
 * fatal.
 */
import { existsSync, watch } from "node:fs"
import type { FSWatcher } from "node:fs"
import { join } from "node:path"

const DEBOUNCE_MS = 250

export function createProjectMcpWatch(
  workspace: string,
  /** Fired (debounced) on mcp.json changes; idempotent, may throw — logged, never fatal. */
  reconcile: () => void,
): { ensure: () => void; close: () => void } {
  const projectDir = join(workspace, ".kclaw")
  let inner: FSWatcher | undefined
  let outer: FSWatcher | undefined
  let failed = false
  let debounce: NodeJS.Timeout | undefined

  function fire(): void {
    if (debounce !== undefined) return
    debounce = setTimeout(() => {
      debounce = undefined
      try {
        reconcile()
      } catch (e) {
        console.error(`kclaw mcp project config reload failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }, DEBOUNCE_MS)
  }

  function degrade(stage: string, error: unknown): void {
    console.error(
      `kclaw mcp project config watch ${stage} (${error instanceof Error ? error.message : String(error)}); hand edits apply on restart`,
    )
    inner?.close()
    inner = undefined
    outer?.close()
    outer = undefined
    failed = true
  }

  /** Watch <workspace>/.kclaw itself (the dir must exist); idempotent. */
  function attachInner(): void {
    if (failed || inner !== undefined) return
    try {
      inner = watch(projectDir, (_event, filename) => {
        // Atomic writes fire rename events for both mcp.json.tmp and
        // mcp.json; a null filename (some platforms) also re-reads — cheap,
        // reconcile is idempotent.
        if (filename !== null && filename !== "mcp.json") return
        fire()
      })
      inner.on("error", (e) => degrade("failed", e))
      // the inner watch covers everything the outer one was waiting for
      outer?.close()
      outer = undefined
    } catch (e) {
      degrade("unavailable", e)
    }
  }

  return {
    ensure() {
      if (failed) return
      if (existsSync(projectDir)) {
        attachInner()
        return
      }
      if (outer !== undefined || inner !== undefined) return
      try {
        // Workspace top level until `.kclaw` shows up (non-recursive: only
        // top-level entries are reported, so the event rate stays trivial).
        outer = watch(workspace, (_event, filename) => {
          if (filename !== ".kclaw") return
          outer?.close()
          outer = undefined
          attachInner()
          // The inner watch registered AFTER the mkdir-to-first-write burst:
          // whatever already landed in mcp.json is invisible to it, so read
          // the file once now (reconcile is idempotent).
          if (inner !== undefined) fire()
        })
        outer.on("error", (e) => degrade("failed", e))
      } catch (e) {
        degrade("unavailable", e)
      }
    },
    /** Stop watching and drop any pending debounced fire (daemon stop path: no reconcile may race the manager teardown). */
    close() {
      inner?.close()
      inner = undefined
      outer?.close()
      outer = undefined
      if (debounce !== undefined) {
        clearTimeout(debounce)
        debounce = undefined
      }
    },
  }
}
