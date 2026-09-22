import { createRequire } from "node:module"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { ToolDefinition } from "../provider/types.js"
import type { ToolExecutor } from "../agent/tools.js"

/**
 * Configuration for one MCP server. `stdio` spawns a local process,
 * `http` connects to a streamable HTTP endpoint. `enabled === false`
 * keeps the entry configured but never connects.
 */
export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; enabled?: boolean }

/** Which config layer an entry lives in: the global files or the project file. */
export type McpScope = "global" | "project"

/**
 * Key-order-insensitive deep equality (hand-edited files rarely keep the
 * key order of an in-memory-constructed object). Arrays compare by index.
 */
function configsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  const eq = (x: unknown, y: unknown): boolean => {
    if (x === y) return true
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false
      return x.every((v, i) => eq(v, y[i]))
    }
    const kx = Object.keys(x as Record<string, unknown>)
    const ky = Object.keys(y as Record<string, unknown>)
    if (kx.length !== ky.length) return false
    return kx.every((k) => eq((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]))
  }
  return eq(a, b)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every((v) => typeof v === "string")
}

/**
 * Runtime guard for untrusted McpServerConfig input (HTTP bodies, future
 * importers): validates shape and required fields, returning a normalized
 * config that only carries the fields actually present. Throws with a
 * user-readable message on any violation.
 */
export function parseMcpServerConfig(input: unknown): McpServerConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("config must be an object")
  }
  const raw = input as Record<string, unknown>
  const enabled = raw.enabled
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("enabled must be a boolean")
  if (raw.type === "stdio") {
    if (typeof raw.command !== "string" || raw.command.trim() === "") throw new Error("stdio config requires a command")
    if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string"))) {
      throw new Error("args must be an array of strings")
    }
    if (raw.env !== undefined && !isStringRecord(raw.env)) throw new Error("env must be a map of strings")
    return {
      type: "stdio",
      command: raw.command,
      ...(Array.isArray(raw.args) && raw.args.length > 0 ? { args: raw.args as string[] } : {}),
      ...(isStringRecord(raw.env) && Object.keys(raw.env).length > 0 ? { env: raw.env } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    }
  }
  if (raw.type === "http") {
    if (typeof raw.url !== "string" || raw.url.trim() === "") throw new Error("http config requires a url")
    try {
      new URL(raw.url)
    } catch {
      throw new Error(`invalid url: ${raw.url}`)
    }
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) throw new Error("headers must be a map of strings")
    return {
      type: "http",
      url: raw.url,
      ...(isStringRecord(raw.headers) && Object.keys(raw.headers).length > 0 ? { headers: raw.headers } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    }
  }
  throw new Error('config.type must be "stdio" or "http"')
}

/** One tool exposed by a connected MCP server, under its prefixed name. */
export interface McpToolEntry {
  name: string
  server: string
  originalName: string
  description: string
}

/** Point-in-time snapshot of one configured server. */
export interface McpServerStatus {
  name: string
  config: McpServerConfig
  /** Which layer the effective entry comes from. */
  scope: McpScope
  state: "connected" | "connecting" | "disabled" | "failed"
  tools: McpToolEntry[]
  lastError?: string
}

export interface McpManagerOptions {
  /**
   * The two config layers, already read by the caller (storage defenses
   * applied there): global = `~/.kclaw/mcp.json`; project =
   * `<workspace>/.kclaw/mcp.json`. Expansion order is global < project — a
   * same-name project entry overrides the global one wholesale (whole-entry
   * override, no field-level merge), and the shadowed global entry is
   * RETAINED for persistence (the global file keeps its copy).
   */
  servers: { global: Record<string, McpServerConfig>; project?: Record<string, McpServerConfig> }
  /** Test seam: build a transport for a server (defaults to stdio/http by config type). */
  transportFactory?: (name: string, cfg: McpServerConfig) => Transport
  /** Backoff base/cap ms for reconnect (tests inject small values). Defaults 1000/60000. */
  backoffBaseMs?: number
  backoffCapMs?: number
  connectTimeoutMs?: number // default 10000
  onError?: (name: string, error: string) => void
  /**
   * Persist config changes made through the hot methods (add/update/remove/
   * setEnabled). Carries the scope that changed plus that layer's FULL entry
   * set — including entries currently shadowed by the other layer: the
   * global consolidation is a whole-file rewrite, so a dropped shadowed
   * entry would be erased from the file and could never resurface. The
   * daemon wires global → consolidation, project → the project file; the
   * manager itself stays storage-agnostic. A throwing persist is logged,
   * never propagated — the in-memory change already happened.
   */
  persist?: (scope: McpScope, servers: Record<string, McpServerConfig>) => void
}

/** Client version advertised during MCP initialization (read from package.json, "0.0.0" fallback). */
function clientVersion(): string {
  try {
    // dist/mcp/manager.js -> ../../package.json is packages/core/package.json
    const pkg = createRequire(import.meta.url)("../../package.json") as { version?: string }
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

interface ServerState {
  name: string
  config: McpServerConfig
  /** Which layer the effective entry currently comes from. */
  scope: McpScope
  state: "connected" | "connecting" | "disabled" | "failed"
  client?: Client
  transport?: Transport
  tools: McpToolEntry[]
  toolSchemas: Map<string, Record<string, unknown>> // originalName -> inputSchema
  lastError?: string
  reconnectTimer?: NodeJS.Timeout
  /** Exponential backoff attempt counter (reset on successful connect). */
  attempts: number
  /**
   * True once this server ever connected. Reconnect churn only makes sense
   * for a server that WAS serving — a server that never connected (e.g.
   * spawn ENOENT at startup) settles in "failed" instead of retrying
   * forever.
   */
  hadSession: boolean
  stopped: boolean
}

/**
 * Multi-server MCP client manager. Connects each configured server over a
 * stdio or streamable HTTP transport, adapts its tools to the core
 * ToolExecutor/ToolDefinition contracts (prefixed `mcp__<server>__<tool>`),
 * and keeps servers alive with exponential-backoff reconnects.
 *
 * Two config layers: the per-layer entry maps (globalEntries/projectEntries)
 * are the authoritative layer contents — each keeps its own copy of a
 * same-name entry even while shadowed by the other layer — while `servers`
 * is the effective set, one ServerState per name carrying the scope it
 * currently resolves to. Hot actions mutate the entry's OWN layer and
 * persist that layer whole; reconcile(projectEntries) re-aligns the
 * effective set with a rewritten project file without persisting.
 */
export class McpManager {
  private readonly servers = new Map<string, ServerState>()
  private readonly globalEntries = new Map<string, McpServerConfig>()
  private readonly projectEntries = new Map<string, McpServerConfig>()
  private readonly backoffBaseMs: number
  private readonly backoffCapMs: number
  private readonly connectTimeoutMs: number
  /** Connect attempts in flight, for flush(). */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(private readonly opts: McpManagerOptions) {
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000
    this.backoffCapMs = opts.backoffCapMs ?? 60_000
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000
    for (const [name, config] of Object.entries(opts.servers.global)) {
      this.globalEntries.set(name, config)
      this.servers.set(name, this.freshState(name, config, "global"))
    }
    for (const [name, config] of Object.entries(opts.servers.project ?? {})) {
      this.projectEntries.set(name, config)
      this.servers.set(name, this.freshState(name, config, "project"))
    }
  }

  private layerEntries(scope: McpScope): Map<string, McpServerConfig> {
    return scope === "project" ? this.projectEntries : this.globalEntries
  }

  private freshState(name: string, config: McpServerConfig, scope: McpScope): ServerState {
    return {
      name,
      config,
      scope,
      state: config.enabled === false ? "disabled" : "connecting",
      tools: [],
      toolSchemas: new Map(),
      attempts: 0,
      hadSession: false,
      stopped: false,
    }
  }

  /** Connect all enabled servers (each independent; failures recorded, never throw). */
  async start(): Promise<void> {
    const enabled = [...this.servers.values()].filter((s) => s.state !== "disabled")
    await Promise.allSettled(enabled.map((s) => this.connect(s, false)))
  }

  /** Await every in-flight connect attempt (tests; optional route-side use). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  /**
   * Add a server into the requested layer and connect it in the background
   * (immediate return; the snapshot picks the outcome up on the next read).
   * Throws on a blank name and on a name occupied in EITHER layer (names are
   * unique across the union; the error names the occupying layer/layer+layer
   * for a shadowed occupancy).
   */
  addServer(name: string, config: McpServerConfig, layer: McpScope = "global"): void {
    if (name.trim() === "") throw new Error("MCP server name must not be empty")
    const inGlobal = this.globalEntries.has(name)
    const inProject = this.projectEntries.has(name)
    if (inGlobal || inProject) {
      const held = [inGlobal ? "global" : null, inProject ? "project" : null].filter(Boolean).join(" + ")
      throw new Error(`MCP server already exists (${held} scope): ${name}`)
    }
    const state = this.freshState(name, config, layer)
    this.servers.set(name, state)
    this.layerEntries(layer).set(name, config)
    this.persist(layer)
    if (state.state !== "disabled") void this.connect(state, false)
  }

  /**
   * Replace a server's config: the old connection is retired and, when
   * enabled, a fresh one is started in the background. The entry stays in
   * its own layer (the action applies to the effective entry; persistence
   * lands in the file that owns it). Throws for an unknown name.
   */
  updateServer(name: string, config: McpServerConfig): void {
    const old = this.mustGet(name)
    this.retire(old)
    const state = this.freshState(name, config, old.scope)
    this.servers.set(name, state)
    this.layerEntries(old.scope).set(name, config)
    this.persist(old.scope)
    if (state.state !== "disabled") void this.connect(state, false)
  }

  /**
   * Drop a server entirely: disconnect, cancel its reconnect loop, forget
   * it. Removing a PROJECT entry that shadows a global one resurfaces the
   * global entry right here — the file watcher's reconcile cannot see this
   * disappearance (the project map is already updated when it re-reads the
   * file), and the delete must be snapshot-visible without waiting for a
   * watch that may not even be running.
   */
  removeServer(name: string): void {
    const state = this.mustGet(name)
    this.retire(state)
    this.servers.delete(name)
    this.layerEntries(state.scope).delete(name)
    this.persist(state.scope)
    if (state.scope === "project" && this.globalEntries.has(name)) {
      const fresh = this.freshState(name, this.globalEntries.get(name)!, "global")
      this.servers.set(name, fresh)
      if (fresh.state !== "disabled") void this.connect(fresh, false)
    }
  }

  /**
   * Flip the persistent enabled flag with a hot transition. Disabling
   * retires the live connection; enabling starts a single connect attempt.
   * Same-value calls are no-ops (no reconnect churn). The entry stays in its
   * own layer.
   */
  setEnabled(name: string, enabled: boolean): void {
    const old = this.mustGet(name)
    if (enabled === (old.config.enabled !== false)) return
    this.retire(old)
    const state = this.freshState(name, { ...old.config, enabled }, old.scope)
    this.servers.set(name, state)
    this.layerEntries(old.scope).set(name, state.config)
    this.persist(old.scope)
    if (enabled) void this.connect(state, false)
  }

  /**
   * Re-align the effective set with a rewritten project file (the watcher's
   * debounced read). The files are the source — this never persists.
   * Differences handled: a new project entry (added and connected; if the
   * name also sits in the global layer, the file semantics shadow it); a
   * changed project config (retire + reconnect); a disappeared project entry
   * (restored from the global layer — scope flips back, reconnecting only
   * when the config actually differs, or removed when no global entry
   * exists). An unchanged or deep-equal entry is a no-op.
   */
  reconcile(project: Record<string, McpServerConfig>): void {
    const added: string[] = []
    const changed: string[] = []
    const restored: string[] = []
    const removed: string[] = []
    for (const [name, config] of Object.entries(project)) {
      const prevEntry = this.projectEntries.get(name)
      if (prevEntry === undefined) {
        const prev = this.servers.get(name)
        if (prev !== undefined) this.retire(prev) // shadowing a global entry via the file
        const state = this.freshState(name, config, "project")
        this.projectEntries.set(name, config)
        this.servers.set(name, state)
        added.push(name)
        if (state.state !== "disabled") void this.connect(state, false)
      } else if (!configsEqual(prevEntry, config)) {
        this.retire(this.servers.get(name)!)
        const state = this.freshState(name, config, "project")
        this.projectEntries.set(name, config)
        this.servers.set(name, state)
        changed.push(name)
        if (state.state !== "disabled") void this.connect(state, false)
      }
    }
    for (const name of [...this.projectEntries.keys()]) {
      if (project[name] !== undefined) continue
      this.projectEntries.delete(name)
      const state = this.servers.get(name)
      if (state === undefined) continue // unreachable: every project entry has a state
      const globalConfig = this.globalEntries.get(name)
      if (globalConfig === undefined) {
        this.retire(state)
        this.servers.delete(name)
        removed.push(name)
        continue
      }
      if (configsEqual(state.config, globalConfig)) {
        state.scope = "global" // identical config: only the owning layer flips, connection stays
      } else {
        this.retire(state)
        const fresh = this.freshState(name, globalConfig, "global")
        this.servers.set(name, fresh)
        if (fresh.state !== "disabled") void this.connect(fresh, false)
      }
      restored.push(name)
    }
    if (added.length + changed.length + restored.length + removed.length > 0) {
      const parts = [
        ...(added.length > 0 ? [`added: ${added.join(", ")}`] : []),
        ...(changed.length > 0 ? [`changed: ${changed.join(", ")}`] : []),
        ...(restored.length > 0 ? [`restored from global: ${restored.join(", ")}`] : []),
        ...(removed.length > 0 ? [`removed: ${removed.join(", ")}`] : []),
      ]
      console.error(`kclaw mcp project config reconciled (${parts.join("; ")})`)
    }
  }

  /**
   * One manual connect attempt for a failed/never-connected server. Never
   * schedules the backoff loop behind itself — a server the user just
   * retried settles in connected or failed, and further attempts are the
   * user's call. A pending backoff timer is cancelled: without this the
   * loop's next try would fire behind the manual one and race the same
   * state object with two concurrent connects (the loser's client leaks,
   * the winner gets clobbered by the loser's transport-close callback).
   * Throws for unknown names, refuses disabled servers, and no-ops servers
   * already connected or connecting.
   */
  reconnect(name: string): void {
    const state = this.mustGet(name)
    if (state.config.enabled === false) throw new Error(`MCP server ${name} is disabled`)
    if (state.state === "connected" || state.state === "connecting") return
    if (state.reconnectTimer !== undefined) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = undefined
    }
    void this.connect(state, false)
  }

  private mustGet(name: string): ServerState {
    const state = this.servers.get(name)
    if (!state) throw new Error(`unknown MCP server: ${name}`)
    return state
  }

  /**
   * Retire a state object: every async path out of it (transport close,
   * backoff timer, in-flight connect) short-circuits on `stopped`, so an
   * update/remove/disable can safely swap in a fresh state under the same
   * name without the old object's callbacks landing on the new one.
   */
  private retire(state: ServerState): void {
    state.stopped = true
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = undefined
    }
    if (state.client) {
      state.client.onclose = undefined
      void state.client.close().catch(() => {})
      state.client = undefined
      state.transport = undefined
    }
  }

  /** Persist one layer whole (shadowed entries included); failures log, never throw. */
  private persist(scope: McpScope): void {
    try {
      this.opts.persist?.(scope, Object.fromEntries(this.layerEntries(scope)))
    } catch (e) {
      console.error(`kclaw mcp config persist failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Track a connect attempt so flush() can await it. */
  private connect(state: ServerState, retry: boolean): Promise<void> {
    const p = this.connectServer(state, retry).finally(() => {
      this.inFlight.delete(p)
    })
    this.inFlight.add(p)
    return p
  }

  /** Current snapshot (for GET /mcp and kclaw mcp list). */
  status(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      config: s.config,
      scope: s.scope,
      state: s.state,
      tools: s.tools,
      ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
    }))
  }

  /** Adapter tools keyed mcp__<server>__<tool>, plus defs for the model. */
  tools(): { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] } {
    const executors = new Map<string, ToolExecutor>()
    const defs: ToolDefinition[] = []
    for (const s of this.servers.values()) {
      if (s.state !== "connected" || !s.client) continue
      for (const tool of s.tools) {
        const client = s.client
        executors.set(tool.name, {
          risk: "sensitive",
          concurrency: "serial",
          execute: async (args, ctx) => {
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
        })
        defs.push({
          name: tool.name,
          description: tool.description || `MCP tool ${tool.originalName} from server ${s.name}`,
          parameters: s.toolSchemas.get(tool.originalName) ?? { type: "object", properties: {} },
        })
      }
    }
    return { executors, defs }
  }

  /** Stop reconnect loops and close all transports. Idempotent. */
  async stop(): Promise<void> {
    const closers: Promise<unknown>[] = []
    for (const s of this.servers.values()) {
      s.stopped = true
      if (s.reconnectTimer) {
        clearTimeout(s.reconnectTimer)
        s.reconnectTimer = undefined
      }
      if (s.client) {
        s.client.onclose = undefined
        closers.push(s.client.close().catch(() => {}))
        s.client = undefined
        s.transport = undefined
      }
    }
    await Promise.allSettled(closers)
  }

  private buildTransport(s: ServerState): Transport {
    if (this.opts.transportFactory) return this.opts.transportFactory(s.name, s.config)
    if (s.config.type === "stdio") {
      return new StdioClientTransport({ command: s.config.command, args: s.config.args, env: s.config.env })
    }
    return new StreamableHTTPClientTransport(new URL(s.config.url), {
      requestInit: { headers: s.config.headers },
    })
  }

  /**
   * Connect (or reconnect) one server. `retry` controls whether a failure
   * schedules another backoff attempt (true inside the reconnect loop) or
   * just records the failure (initial start()).
   */
  private async connectServer(s: ServerState, retry: boolean): Promise<void> {
    if (s.stopped) return
    s.state = "connecting"
    let client: InstanceType<typeof Client> | undefined
    let transport: ReturnType<typeof this.buildTransport> | undefined
    try {
      transport = this.buildTransport(s)
      client = new Client({ name: "kclaw", version: clientVersion() }, { capabilities: {} })
      transport.onclose = () => this.handleTransportClose(s)
      await this.raceTimeout(client.connect(transport))
      if (s.stopped) {
        // stop() raced this connect: never leave a live client behind.
        await client.close().catch(() => {})
        return
      }
      s.client = client
      s.transport = transport
      const listed = await this.raceTimeout(client.listTools())
      const toolSchemas = new Map<string, Record<string, unknown>>()
      s.tools = listed.tools.map((t) => {
        toolSchemas.set(t.name, t.inputSchema as Record<string, unknown>)
        return {
          name: `mcp__${s.name}__${t.name}`,
          server: s.name,
          originalName: t.name,
          description: t.description ?? "",
        }
      })
      s.toolSchemas = toolSchemas
      s.state = "connected"
      s.attempts = 0
      s.hadSession = true
      s.lastError = undefined
    } catch (err) {
      // Tear down whatever half-connected client this attempt may hold —
      // including one the timeout race left unassigned: a connect that
      // timed out keeps running underneath, so its close callback must be
      // detached (it would otherwise clobber the NEXT attempt's connection
      // when the abandoned transport eventually dies) and the client closed
      // (a stdio child process would leak per timed-out attempt).
      if (transport !== undefined) transport.onclose = undefined
      if (client !== undefined) {
        client.onclose = undefined
        await client.close().catch(() => {})
      }
      s.client = undefined
      s.transport = undefined
      const message = (err as Error).message
      s.state = "failed"
      s.lastError = message
      s.tools = []
      s.toolSchemas = new Map()
      this.opts.onError?.(s.name, message)
      if (retry && !s.stopped) this.scheduleReconnect(s)
    }
  }

  private handleTransportClose(s: ServerState): void {
    // A close from a server that never connected (spawn/connect failure)
    // means "initial failure", not "disconnect": the failed connect's catch
    // already recorded "failed", and retrying would churn forever on a
    // permanently-broken server.
    if (s.stopped || !s.hadSession) return
    s.state = "connecting"
    s.tools = []
    s.toolSchemas = new Map()
    s.client = undefined
    s.transport = undefined
    this.scheduleReconnect(s)
  }

  private scheduleReconnect(s: ServerState): void {
    if (s.stopped || s.reconnectTimer) return
    const delay = Math.min(this.backoffBaseMs * 2 ** s.attempts, this.backoffCapMs)
    s.attempts += 1
    s.reconnectTimer = setTimeout(() => {
      s.reconnectTimer = undefined
      void this.connect(s, true)
    }, delay)
  }

  private raceTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP connect timeout after ${this.connectTimeoutMs}ms`)), this.connectTimeoutMs)
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }
}
