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
  state: "connected" | "connecting" | "disabled" | "failed"
  tools: McpToolEntry[]
  lastError?: string
}

export interface McpManagerOptions {
  servers: Record<string, McpServerConfig>
  /** Test seam: build a transport for a server (defaults to stdio/http by config type). */
  transportFactory?: (name: string, cfg: McpServerConfig) => Transport
  /** Backoff base/cap ms for reconnect (tests inject small values). Defaults 1000/60000. */
  backoffBaseMs?: number
  backoffCapMs?: number
  connectTimeoutMs?: number // default 10000
  onError?: (name: string, error: string) => void
  /**
   * Persist config changes made through the hot methods (add/update/remove/
   * setEnabled). The daemon wires this to the mcp.json consolidation; the
   * manager itself stays storage-agnostic. A throwing persist is logged,
   * never propagated — the in-memory change already happened.
   */
  persist?: (servers: Record<string, McpServerConfig>) => void
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
 */
export class McpManager {
  private readonly servers = new Map<string, ServerState>()
  private readonly backoffBaseMs: number
  private readonly backoffCapMs: number
  private readonly connectTimeoutMs: number
  /** Connect attempts in flight, for flush(). */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(private readonly opts: McpManagerOptions) {
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000
    this.backoffCapMs = opts.backoffCapMs ?? 60_000
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000
    for (const [name, config] of Object.entries(opts.servers)) {
      this.servers.set(name, this.freshState(name, config))
    }
  }

  private freshState(name: string, config: McpServerConfig): ServerState {
    return {
      name,
      config,
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
   * Add a server and connect it in the background (immediate return; the
   * snapshot picks the outcome up on the next read). Throws on a blank or
   * duplicate name.
   */
  addServer(name: string, config: McpServerConfig): void {
    if (name.trim() === "") throw new Error("MCP server name must not be empty")
    if (this.servers.has(name)) throw new Error(`MCP server already exists: ${name}`)
    const state = this.freshState(name, config)
    this.servers.set(name, state)
    this.persist()
    if (state.state !== "disabled") void this.connect(state, false)
  }

  /**
   * Replace a server's config: the old connection is retired and, when
   * enabled, a fresh one is started in the background. Throws for an unknown
   * name.
   */
  updateServer(name: string, config: McpServerConfig): void {
    const old = this.mustGet(name)
    this.retire(old)
    const state = this.freshState(name, config)
    this.servers.set(name, state)
    this.persist()
    if (state.state !== "disabled") void this.connect(state, false)
  }

  /** Drop a server entirely: disconnect, cancel its reconnect loop, forget it. */
  removeServer(name: string): void {
    const state = this.mustGet(name)
    this.retire(state)
    this.servers.delete(name)
    this.persist()
  }

  /**
   * Flip the persistent enabled flag with a hot transition. Disabling
   * retires the live connection; enabling starts a single connect attempt.
   * Same-value calls are no-ops (no reconnect churn).
   */
  setEnabled(name: string, enabled: boolean): void {
    const old = this.mustGet(name)
    if (enabled === (old.config.enabled !== false)) return
    this.retire(old)
    const state = this.freshState(name, { ...old.config, enabled })
    this.servers.set(name, state)
    this.persist()
    if (enabled) void this.connect(state, false)
  }

  /**
   * One manual connect attempt for a failed/never-connected server. Never
   * schedules the backoff loop behind itself — a server the user just
   * retried settles in connected or failed, and further attempts are the
   * user's call. Throws for unknown names, refuses disabled servers, and
   * no-ops servers already connected or connecting.
   */
  reconnect(name: string): void {
    const state = this.mustGet(name)
    if (state.config.enabled === false) throw new Error(`MCP server ${name} is disabled`)
    if (state.state === "connected" || state.state === "connecting") return
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

  private persist(): void {
    try {
      this.opts.persist?.(Object.fromEntries([...this.servers.values()].map((s) => [s.name, s.config])))
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
    try {
      const transport = this.buildTransport(s)
      const client = new Client({ name: "kclaw", version: clientVersion() }, { capabilities: {} })
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
      // Tear down whatever half-connected client we may hold.
      if (s.client) {
        s.client.onclose = undefined
        await s.client.close().catch(() => {})
        s.client = undefined
        s.transport = undefined
      }
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
