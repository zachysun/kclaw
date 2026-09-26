/**
 * Grouped MCP entry storage: group → name → config. Pure bookkeeping —
 * persistence, connection state and file watching live in the manager and
 * the daemon. Same names may repeat ACROSS groups (each project its own
 * namespace); within one group a name is unique.
 */
import { GLOBAL_GROUP } from "./types.js"
import type { McpServerConfig } from "./types.js"

/** One entry as the use-view sees it: the config plus the group owning it. */
export interface ViewEntry {
  name: string
  config: McpServerConfig
  /** The group whose entry won (project beats global on a same-name tie). */
  group: string
}

export class McpGroupStore {
  /** "global" first, then one map per project workdir. */
  readonly #groups = new Map<string, Map<string, McpServerConfig>>()

  constructor(initial: { global: Record<string, McpServerConfig>; projects?: Record<string, Record<string, McpServerConfig>> }) {
    this.#groups.set(GLOBAL_GROUP, new Map(Object.entries(initial.global)))
    for (const [workdir, entries] of Object.entries(initial.projects ?? {})) {
      this.#groups.set(workdir, new Map(Object.entries(entries)))
    }
  }

  has(group: string): boolean {
    return this.#groups.has(group)
  }

  /** All group ids: "global" first, projects sorted by path (stable snapshots). */
  groups(): string[] {
    const projects = [...this.#groups.keys()].filter((g) => g !== GLOBAL_GROUP).sort()
    return [GLOBAL_GROUP, ...projects]
  }

  entries(group: string): Record<string, McpServerConfig> {
    return Object.fromEntries(this.#groups.get(group) ?? [])
  }

  /** Requires an existing group; overwrites silently (callers check conflicts). */
  setEntry(group: string, name: string, config: McpServerConfig): void {
    this.#mustGet(group).set(name, config)
  }

  removeEntry(group: string, name: string): McpServerConfig | undefined {
    const layer = this.#mustGet(group)
    const config = layer.get(name)
    layer.delete(name)
    return config
  }

  /** Mount a project group (idempotent: an existing group keeps its entries). */
  addProject(workdir: string, entries: Record<string, McpServerConfig>): void {
    if (this.#groups.has(workdir)) return
    this.#groups.set(workdir, new Map(Object.entries(entries)))
  }

  /** Unmount a project group; the global group and unknown groups are no-ops. */
  dropProject(workdir: string): void {
    if (workdir === GLOBAL_GROUP) return
    this.#groups.delete(workdir)
  }

  /**
   * The use-view for one project: the union of the global and the project
   * entry sets, a same-name project entry winning wholesale. Shadowing
   * happens ONLY here — both groups keep (and connect) their own entries.
   * An unknown workdir degrades to the global view alone.
   */
  viewFor(workdir: string): ViewEntry[] {
    const view = new Map<string, ViewEntry>()
    for (const [name, config] of this.#groups.get(GLOBAL_GROUP) ?? []) {
      view.set(name, { name, config, group: GLOBAL_GROUP })
    }
    for (const [name, config] of this.#groups.get(workdir) ?? []) {
      view.set(name, { name, config, group: workdir })
    }
    return [...view.values()]
  }

  #mustGet(group: string): Map<string, McpServerConfig> {
    const layer = this.#groups.get(group)
    if (layer === undefined) throw new Error(`unknown group: ${group}`)
    return layer
  }
}
