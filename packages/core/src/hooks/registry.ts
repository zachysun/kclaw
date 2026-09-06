/**
 * HookRegistry — the durable user-hook bookkeeping.
 *
 * Lives at daemon scope (one per process), refreshed per run by the run
 * assembly ("放文件，下轮生效" — same mental model as the per-run skill
 * rescan). Responsibilities, deliberately narrow:
 * - `refresh()` rescans the user hooks dir and rebuilds the bookkeeping:
 *   healthy files contribute entries, broken files contribute failures.
 * - Load failures are deduplicated: a hook.failed(load) event fires ONCE per
 *   file version (name+mtime+error), not once per run — the管理面 keeps
 *   showing the failure, the event stream doesn't drown.
 * - `snapshot()` hands the run assembly the current healthy+enabled entries.
 * - `list()` is the management-plane view (user side); the route merges it
 *   with the static builtin spec list. Builtin hooks are NOT registered here
 *   — they are per-run closures over run resources (hooks/builtin.ts).
 */
import type { AgentEvent } from "../protocol/index.js"
import { makeEvent } from "../protocol/index.js"
import { scanUserHooks } from "./loader.js"
import type { HookEntry } from "./types.js"

/** Management-plane row: position degrades to string (a load-failed file's position is unknowable). */
export interface HookView {
  name: string
  position: string
  description?: string
  enabled: boolean
  order: number
  failure: "fatal" | "skip" | "deny"
  origin: "builtin" | "user"
  error?: string
}

export interface HookRegistryOptions {
  /** ~/.kclaw/hooks (paths.hooksDir); missing → empty registry. */
  userDir?: string
  /** Receives deduplicated hook.failed(load) events (daemon: bus.emit). */
  onEvent?: (e: AgentEvent<"hook.failed">) => void
}

export class HookRegistry {
  readonly #userDir?: string
  readonly #onEvent?: (e: AgentEvent<"hook.failed">) => void
  /** name → current entries (healthy files only). */
  readonly #entries = new Map<string, HookEntry[]>()
  /** name → last load-failure reason (failed files only). */
  readonly #failures = new Map<string, string>()
  /** (name+mtime+error) versions whose load failure already fired an event. */
  readonly #reportedFailures = new Set<string>()

  constructor(opts: HookRegistryOptions = {}) {
    this.#userDir = opts.userDir
    this.#onEvent = opts.onEvent
  }

  /**
   * Rescan the user dir. Awaited by the run assembly before it builds the
   * run's HookChain — the first run after a file change picks it up.
   */
  async refresh(): Promise<void> {
    if (this.#userDir === undefined) return
    const { entries, failures } = await scanUserHooks(this.#userDir)
    this.#entries.clear()
    this.#failures.clear()
    for (const e of entries) {
      const list = this.#entries.get(e.meta.name) ?? []
      list.push(e)
      this.#entries.set(e.meta.name, list)
    }
    for (const f of failures) {
      this.#failures.set(f.name, f.error)
      const versionKey = `${f.name}@${f.mtimeMs}:${f.error}`
      if (this.#reportedFailures.has(versionKey)) continue
      this.#reportedFailures.add(versionKey)
      console.error(`kclaw hook load failed (${f.name}):`, f.error)
      this.#onEvent?.(makeEvent("hook.failed", {
        hook: f.name,
        position: "load",
        error: f.error,
        phase: "load",
      }))
    }
  }

  /** Healthy, enabled user entries for the next run's chain (the chain re-checks enabled). */
  snapshot(): HookEntry[] {
    return [...this.#entries.values()].flat()
  }

  /** Management view: every user hook (healthy, disabled, load-failed). */
  list(): HookView[] {
    const views: HookView[] = []
    for (const list of this.#entries.values()) {
      for (const e of list) {
        views.push({
          name: e.meta.name,
          position: e.meta.position,
          ...(e.meta.description !== undefined ? { description: e.meta.description } : {}),
          enabled: e.meta.enabled,
          order: e.meta.order,
          failure: e.meta.failure,
          origin: "user",
        })
      }
    }
    for (const [name, error] of this.#failures) {
      views.push({
        name,
        position: "?",
        enabled: false,
        order: Number.MAX_SAFE_INTEGER,
        failure: "skip",
        origin: "user",
        error,
      })
    }
    return views
  }
}
