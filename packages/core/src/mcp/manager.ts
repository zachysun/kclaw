/**
 * Multi-project MCP manager: the facade over the group store (who owns
 * which entry) and the connection pool (lazy, capped, idle-reclaimed).
 *
 * The use-view for a run is `toolsFor(workdir)`: the union of the global
 * and that project's entries with a same-name project entry winning. Every
 * connection is established on demand — daemon boot connects nothing; the
 * first run in a project builds its view's missing connections in the
 * background and picks the tools up on the NEXT assembly, while already-
 * live connections contribute immediately. Idle connections are swept
 * back to "disconnected"; failed ones retry a bounded number of times.
 *
 * Management actions (add/update/remove/enable/connect/move) name their
 * group explicitly; the manager never guesses a default group. Persistence
 * is per group through the `persist` hook — the daemon wires "global" to
 * the global file and each workdir to that project's file.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { ToolDefinition } from "../provider/types.js"
import type { ToolExecutor } from "../agent/tools.js"
import { ConnectionPool, freshRecord } from "./connection.js"
import { McpGroupStore } from "./groups.js"
import { GLOBAL_GROUP, McpError, configsEqual } from "./types.js"
import type { McpGroupStatus, McpServerConfig, McpServerStatus, McpSnapshot, McpToolEntry } from "./types.js"

export {
  GLOBAL_GROUP,
  McpError,
  configsEqual,
  isGroupId,
  parseMcpServerConfig,
} from "./types.js"
export type {
  McpConnState,
  McpErrorCode,
  McpGroupStatus,
  McpServerConfig,
  McpServerStatus,
  McpSnapshot,
  McpToolEntry,
} from "./types.js"

export interface McpManagerOptions {
  /** The global layer's entries (already read by the caller, storage defenses applied there). */
  globalServers: Record<string, McpServerConfig>
  /** Initial project layers by workdir (the daemon's session-record union). */
  projects?: Record<string, Record<string, McpServerConfig>>
  /** Test seam: build a transport for a server (defaults to stdio/http by config type). */
  transportFactory?: (name: string, cfg: McpServerConfig) => Transport
  /** Backoff base/cap ms for reconnect (tests inject small values). Defaults 1000/60000. */
  backoffBaseMs?: number
  backoffCapMs?: number
  connectTimeoutMs?: number // default 10000
  /** Idle TTL before a connection is reclaimed (default 10 minutes). */
  idleTtlMs?: number
  /** Background sweep cadence (default 60s; start() owns the timer). */
  sweepIntervalMs?: number
  /** Max live connections; new connects past it fail loudly (default 64). */
  maxConnections?: number
  /** Bounded reconnect attempts before settling in "failed" (default 10). */
  maxReconnectAttempts?: number
  onError?: (group: string, name: string, error: string) => void
  /**
   * Persist one group's FULL entry set after a hot mutation. The daemon
   * wires GLOBAL_GROUP → the global file, a workdir → that project's file
   * (first write creates .kclaw + gitignore there). A throwing persist is
   * logged, never propagated — the in-memory change already happened.
   */
  persist?: (group: string, servers: Record<string, McpServerConfig>) => void
}

export class McpManager {
  readonly #store: McpGroupStore
  readonly #pool: ConnectionPool
  readonly #idleTtlMs: number
  readonly #sweepIntervalMs: number
  readonly #persistHook?: (group: string, servers: Record<string, McpServerConfig>) => void
  #sweepTimer?: NodeJS.Timeout

  constructor(opts: McpManagerOptions) {
    this.#store = new McpGroupStore({ global: opts.globalServers, projects: opts.projects })
    this.#idleTtlMs = opts.idleTtlMs ?? 600_000
    this.#sweepIntervalMs = opts.sweepIntervalMs ?? 60_000
    this.#pool = new ConnectionPool({
      transportFactory: opts.transportFactory,
      backoffBaseMs: opts.backoffBaseMs,
      backoffCapMs: opts.backoffCapMs,
      connectTimeoutMs: opts.connectTimeoutMs,
      maxConnections: opts.maxConnections,
      maxReconnectAttempts: opts.maxReconnectAttempts,
      onError: opts.onError,
    })
    this.#persistHook = opts.persist
  }

  /**
   * Start the idle sweep. Deliberately connects NOTHING — the lazy model's
   * resting state is zero connections.
   */
  start(): void {
    if (this.#sweepTimer !== undefined) return
    this.#sweepTimer = setInterval(() => {
      this.sweep()
    }, this.#sweepIntervalMs)
  }

  /** One idle sweep pass now (the timer's body; a `now` override for tests). */
  sweep(now: number = Date.now()): void {
    this.#pool.sweep(now, this.#idleTtlMs)
  }

  /** Await every in-flight connect attempt (tests). */
  flush(): Promise<void> {
    return this.#pool.flush()
  }

  /** Stop the sweep and retire every connection. Idempotent. */
  async stop(): Promise<void> {
    if (this.#sweepTimer !== undefined) {
      clearInterval(this.#sweepTimer)
      this.#sweepTimer = undefined
    }
    await this.#pool.stopAll()
  }

  // --- project discovery (daemon-driven; the manager never scans) --------

  /** Mount a project group with its initial entries (idempotent). */
  ensureProject(workdir: string, entries: Record<string, McpServerConfig>): void {
    this.#store.addProject(workdir, entries)
  }

  /** Unmount a project group: retire its connections and drop its entries. */
  async dropProject(workdir: string): Promise<void> {
    if (!this.#store.has(workdir)) return
    const closers: Promise<void>[] = []
    for (const name of Object.keys(this.#store.entries(workdir))) {
      const record = this.#pool.get(workdir, name)
      if (record !== undefined && !record.stopped) closers.push(this.#pool.retire(record))
      this.#pool.drop(workdir, name)
    }
    this.#store.dropProject(workdir)
    await Promise.allSettled(closers)
  }

  /**
   * Re-align one project group with a rewritten project file (the watcher's
   * debounced read). The file is the source — never persists. Lazy
   * semantics: entries without a live connection only update the mapping;
   * a LIVE connection on a changed or removed entry is retired now and the
   * next use reconnects under the new config.
   */
  reconcileProject(workdir: string, entries: Record<string, McpServerConfig>): void {
    if (!this.#store.has(workdir)) return
    const current = this.#store.entries(workdir)
    const added: string[] = []
    const changed: string[] = []
    const removed: string[] = []
    for (const [name, config] of Object.entries(entries)) {
      const prev = current[name]
      if (prev !== undefined && configsEqual(prev, config)) continue
      this.#store.setEntry(workdir, name, config)
      ;(prev === undefined ? added : changed).push(name)
      this.#retireRecord(workdir, name)
    }
    for (const name of Object.keys(current)) {
      if (entries[name] !== undefined) continue
      this.#store.removeEntry(workdir, name)
      this.#retireRecord(workdir, name)
      removed.push(name)
    }
    if (added.length + changed.length + removed.length > 0) {
      const parts = [
        ...(added.length > 0 ? [`added: ${added.join(", ")}`] : []),
        ...(changed.length > 0 ? [`changed: ${changed.join(", ")}`] : []),
        ...(removed.length > 0 ? [`removed: ${removed.join(", ")}`] : []),
      ]
      console.error(`kclaw mcp project config reconciled (${workdir}: ${parts.join("; ")})`)
    }
  }

  /** Retire a live record and drop it from the pool (the next use builds a fresh one). */
  #retireRecord(group: string, name: string): void {
    const record = this.#pool.get(group, name)
    if (record === undefined || record.stopped) {
      this.#pool.drop(group, name)
      return
    }
    void this.#pool.retire(record)
    this.#pool.drop(group, name)
  }

  // --- the per-run use-view ----------------------------------------------

  /**
   * The project's tool view: global + project entries, same-name project
   * wins. Missing connections start building in the background; tools from
   * live connections are returned now, the rest join on the next assembly.
   */
  toolsFor(workdir: string): { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] } {
    const executors = new Map<string, ToolExecutor>()
    const defs: ToolDefinition[] = []
    for (const entry of this.#store.viewFor(workdir)) {
      const record = this.#pool.record(entry.group, entry.name, entry.config)
      if (record.config.enabled !== false) {
        this.#pool.touch(record)
        if (record.state === "disconnected" || record.state === "failed") {
          this.#pool.kick(record, { retry: true })
        }
      }
      if (record.state !== "connected") continue
      for (const tool of record.tools) {
        executors.set(tool.name, this.#makeExecutor(entry.group, entry.name, tool))
        defs.push({
          name: tool.name,
          description: tool.description || `MCP tool ${tool.originalName} from server ${entry.name}`,
          parameters: record.toolSchemas.get(tool.originalName) ?? { type: "object", properties: {} },
        })
      }
    }
    return { executors, defs }
  }

  /**
   * The executor resolves its connection AT CALL TIME: a record swapped by
   * a reconcile/retire mid-run fails honestly instead of writing into a
   * dead client, and a reconnect under the same key is picked up as-is.
   * Every call refreshes the idle marker, so a busy run is never reclaimed.
   */
  #makeExecutor(group: string, name: string, tool: McpToolEntry): ToolExecutor {
    return {
      risk: "sensitive",
      concurrency: "serial",
      execute: async (args, ctx) => {
        const record = this.#pool.get(group, name)
        const client = record?.client
        if (record !== undefined) this.#pool.touch(record)
        if (client === undefined) {
          return { status: "error", output: `MCP server ${name} 未连接（下一轮自动重连）` }
        }
        try {
          const result = (await client.callTool(
            {
              name: tool.originalName,
              arguments: (args ?? {}) as Record<string, unknown>,
            },
            undefined,
            ctx.signal ? { signal: ctx.signal } : undefined,
          )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
          const output = (result.content ?? [])
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("\n")
          if (result.isError === true) return { status: "error", output }
          return { status: "ok", output }
        } catch (err) {
          return { status: "error", output: (err as Error).message }
        }
      },
    }
  }

  // --- snapshots and actions ----------------------------------------------

  /** Grouped snapshot: "global" first, then the known projects by path. Read-only — never materializes pool records. */
  status(): McpSnapshot {
    const groups: McpGroupStatus[] = this.#store.groups().map((id) => ({
      id,
      servers: Object.entries(this.#store.entries(id)).map(([name, config]): McpServerStatus => {
        const record = this.#pool.get(id, name) ?? freshRecord(id, name, config)
        return {
          name,
          config,
          group: id,
          state: record.state,
          tools: record.tools,
          ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
        }
      }),
    }))
    return { groups }
  }

  #requireEntry(group: string, name: string): McpServerConfig {
    this.#requireGroup(group)
    const config = this.#store.entries(group)[name]
    if (config === undefined) throw new McpError("not-found", `unknown MCP server: ${name}`)
    return config
  }

  #requireGroup(group: string): void {
    if (!this.#store.has(group)) throw new McpError("not-found", `unknown MCP server group: ${group}`)
  }

  #persist(group: string): void {
    if (this.#persistHook === undefined) return
    try {
      this.#persistHook(group, this.#store.entries(group))
    } catch (e) {
      console.error(`kclaw mcp config persist failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Add an entry to an EXPLICIT group and connect it in the background
   * (immediate return; the snapshot picks the outcome up on the next read).
   * The name must be free within the group — the same name may live in
   * other groups (projects are separate namespaces; shadowing is per view).
   */
  addServer(group: string, name: string, config: McpServerConfig): void {
    if (name.trim() === "") throw new McpError("invalid", "MCP server name must not be empty")
    this.#requireGroup(group)
    if (this.#store.entries(group)[name] !== undefined) {
      throw new McpError("conflict", `MCP server already exists in ${group === GLOBAL_GROUP ? "the global group" : group}: ${name}`)
    }
    this.#store.setEntry(group, name, config)
    this.#persist(group)
    if (config.enabled !== false) this.#pool.kick(this.#pool.record(group, name, config), { retry: false })
  }

  /**
   * Replace an entry's config; with `toGroup` different from `group` the
   * update IS an atomic move (source group loses the entry, target group
   * gains it, a same-name target entry refuses the whole thing up front,
   * both files persist). The old connection retires only when the entry
   * actually changed — a config change reconnects in the background, a pure
   * move stays lazy, and a same-group save with an unchanged config is a
   * no-op that keeps a live connection (same semantics as reconcileProject).
   */
  updateServer(group: string, name: string, config: McpServerConfig, toGroup?: string): void {
    const old = this.#requireEntry(group, name)
    const target = toGroup ?? group
    if (target !== group) {
      this.#requireGroup(target)
      if (this.#store.entries(target)[name] !== undefined) {
        throw new McpError("conflict", `MCP server already exists in ${target === GLOBAL_GROUP ? "the global group" : target}: ${name}`)
      }
    }
    const moved = target !== group
    const configChanged = !configsEqual(old, config)
    if (!moved && !configChanged) return
    this.#store.removeEntry(group, name)
    this.#retireRecord(group, name)
    this.#store.setEntry(target, name, config)
    const fresh = this.#pool.record(target, name, config)
    if (moved) {
      this.#persist(group)
      this.#persist(target)
    } else {
      this.#persist(group)
    }
    if (configChanged && config.enabled !== false) this.#pool.kick(fresh, { retry: false })
  }

  /**
   * Drop an entry from its group: disconnect, forget. The global layer is
   * untouched (a project entry never masked it structurally — shadowing
   * only ever happened inside a use-view).
   */
  removeServer(group: string, name: string): void {
    this.#requireEntry(group, name)
    this.#store.removeEntry(group, name)
    this.#retireRecord(group, name)
    this.#persist(group)
  }

  /**
   * Flip the persistent enabled flag with a hot transition: disabling
   * retires the live connection, enabling starts one in the background.
   * Same-value calls are no-ops (no reconnect churn).
   */
  setEnabled(group: string, name: string, enabled: boolean): void {
    const old = this.#requireEntry(group, name)
    if (enabled === (old.enabled !== false)) return
    const updated = { ...old, enabled } as McpServerConfig
    this.#store.setEntry(group, name, updated)
    this.#retireRecord(group, name)
    this.#persist(group)
    if (enabled) this.#pool.kick(this.#pool.record(group, name, updated), { retry: false })
  }

  /**
   * One manual connect attempt (the "连接/探测" action). Refuses disabled
   * entries, no-ops entries already connected/connecting, cancels a pending
   * backoff attempt first, and never schedules the backoff loop behind
   * itself — the user just retried; further attempts are their call.
   */
  connect(group: string, name: string): void {
    const config = this.#requireEntry(group, name)
    this.#pool.connectNow(this.#pool.record(group, name, config))
  }

  /** Test/inspection seam: a fresh (unused) record shape for a mounted entry. */
  peekRecord(group: string, name: string): ReturnType<typeof freshRecord> | undefined {
    return this.#pool.get(group, name)
  }
}
