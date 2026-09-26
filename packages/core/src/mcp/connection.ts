/**
 * MCP connection pool: one state machine per (group, name) entry, created
 * LAZILY — nothing connects until a run's use-view asks for the entry or a
 * management action kicks it. Connections are bounded (retry cap), capped
 * (max live connections) and reclaimed (idle TTL sweep); a retired record's
 * async strays (transport close, backoff timer, in-flight connect) all
 * short-circuit on its `stopped` flag, and the next kick swaps in a fresh
 * record under the same key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createRequire } from "node:module"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { McpError, configsEqual } from "./types.js"
import type { McpConnState, McpServerConfig, McpToolEntry } from "./types.js"

/** Client version advertised during MCP initialization (read from package.json, "0.0.0" fallback). */
function clientVersion(): string {
  try {
    // dist/mcp/connection.js -> ../../package.json is packages/core/package.json
    const pkg = createRequire(import.meta.url)("../../package.json") as { version?: string }
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

export interface ConnectionRecord {
  group: string
  name: string
  config: McpServerConfig
  state: McpConnState
  client?: Client
  tools: McpToolEntry[]
  toolSchemas: Map<string, Record<string, unknown>> // originalName -> inputSchema
  lastError?: string
  reconnectTimer?: NodeJS.Timeout
  /** Exponential backoff attempt counter (reset on a successful connect). */
  attempts: number
  /**
   * True once this server ever connected. Close-triggered reconnect churn
   * only makes sense for a server that WAS serving — one that never
   * connected (e.g. spawn ENOENT) settles in "failed" instead of retrying.
   */
  hadSession: boolean
  /** Last-use marker for the idle sweep; refreshed by use and by tool calls. */
  lastUsed: number
  stopped: boolean
}

export interface ConnectionPoolOptions {
  transportFactory?: (name: string, config: McpServerConfig) => Transport
  backoffBaseMs?: number // default 1000
  backoffCapMs?: number // default 60000
  connectTimeoutMs?: number // default 10000
  /** Max LIVE connections (connecting + connected); new connects past it fail. */
  maxConnections?: number // default 64
  /** Bounded reconnect attempts before settling in "failed". */
  maxReconnectAttempts?: number // default 10
  onError?: (group: string, name: string, error: string) => void
}

export function freshRecord(group: string, name: string, config: McpServerConfig): ConnectionRecord {
  return {
    group,
    name,
    config,
    state: config.enabled === false ? "disabled" : "disconnected",
    tools: [],
    toolSchemas: new Map(),
    attempts: 0,
    hadSession: false,
    lastUsed: 0,
    stopped: false,
  }
}

export class ConnectionPool {
  readonly #records = new Map<string, Map<string, ConnectionRecord>>()
  readonly #opts: Required<Pick<ConnectionPoolOptions, "backoffBaseMs" | "backoffCapMs" | "connectTimeoutMs" | "maxConnections" | "maxReconnectAttempts">> &
    ConnectionPoolOptions
  /** Connect attempts in flight, for flush(). */
  readonly #inFlight = new Set<Promise<void>>()

  constructor(opts: ConnectionPoolOptions) {
    this.#opts = {
      backoffBaseMs: opts.backoffBaseMs ?? 1000,
      backoffCapMs: opts.backoffCapMs ?? 60_000,
      connectTimeoutMs: opts.connectTimeoutMs ?? 10_000,
      maxConnections: opts.maxConnections ?? 64,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? 10,
      transportFactory: opts.transportFactory,
      onError: opts.onError,
    }
  }

  /** The record for an entry, creating a fresh one when absent or retired. */
  record(group: string, name: string, config: McpServerConfig): ConnectionRecord {
    let layer = this.#records.get(group)
    if (layer === undefined) {
      layer = new Map()
      this.#records.set(group, layer)
    }
    const existing = layer.get(name)
    if (existing !== undefined && !existing.stopped) {
      // Config drift guard: the entry was rewritten while the record sat
      // around (reconcile missed it) — swap in a fresh record so the next
      // kick uses the current config.
      if (!configsEqual(existing.config, config)) {
        const fresh = freshRecord(group, name, config)
        layer.set(name, fresh)
        return fresh
      }
      return existing
    }
    const fresh = freshRecord(group, name, config)
    layer.set(name, fresh)
    return fresh
  }

  get(group: string, name: string): ConnectionRecord | undefined {
    return this.#records.get(group)?.get(name)
  }

  drop(group: string, name: string): void {
    this.#records.get(group)?.delete(name)
  }

  dropGroup(group: string): void {
    this.#records.delete(group)
  }

  /** Live connections (connecting + connected) — the cap's denominator. */
  activeCount(): number {
    let n = 0
    for (const layer of this.#records.values()) {
      for (const r of layer.values()) {
        if (!r.stopped && (r.state === "connected" || r.state === "connecting")) n += 1
      }
    }
    return n
  }

  allRecords(): ConnectionRecord[] {
    const out: ConnectionRecord[] = []
    for (const layer of this.#records.values()) out.push(...layer.values())
    return out
  }

  touch(record: ConnectionRecord): void {
    record.lastUsed = Date.now()
  }

  /**
   * Best-effort connect for a record without a live connection (lazy use,
   * add/update/enable). Never throws: at the cap the failure lands on the
   * record as a visible "failed" state. A lazy kick resets the bounded
   * backoff — wanting the server again is a fresh start.
   */
  kick(record: ConnectionRecord, opts: { retry: boolean }): void {
    if (record.stopped || record.config.enabled === false) return
    if (record.state === "connected" || record.state === "connecting") {
      this.touch(record)
      return
    }
    if (this.activeCount() >= this.#opts.maxConnections) {
      const message = `活连接已达上限（${this.#opts.maxConnections}），未建立新连接`
      record.state = "failed"
      record.lastError = message
      this.#opts.onError?.(record.group, record.name, message)
      return
    }
    record.attempts = 0
    void this.#connect(record, opts.retry)
  }

  /**
   * One manual connect attempt (the "连接/探测" action). Cancels a pending
   * backoff attempt first — the loop's next try would otherwise fire behind
   * the manual one and race the same record with two concurrent connects.
   * Throws for disabled entries; at the cap it refuses with a conflict.
   */
  connectNow(record: ConnectionRecord): void {
    if (record.config.enabled === false) {
      throw new McpError("invalid", `MCP server ${record.name} is disabled`)
    }
    if (record.state === "connected" || record.state === "connecting") return
    if (record.reconnectTimer !== undefined) {
      clearTimeout(record.reconnectTimer)
      record.reconnectTimer = undefined
    }
    if (this.activeCount() >= this.#opts.maxConnections) {
      throw new McpError("conflict", `活连接已达上限（${this.#opts.maxConnections}），未建立新连接`)
    }
    record.attempts = 0
    void this.#connect(record, false)
  }

  /**
   * Retire a record: every async path out of it (transport close, backoff
   * timer, in-flight connect) short-circuits on `stopped`. The caller owns
   * the follow-up state (fresh record / map removal / "disconnected").
   */
  async retire(record: ConnectionRecord, nextState: McpConnState = "disconnected"): Promise<void> {
    record.stopped = true
    if (record.reconnectTimer !== undefined) {
      clearTimeout(record.reconnectTimer)
      record.reconnectTimer = undefined
    }
    const client = record.client
    record.client = undefined
    record.tools = []
    record.toolSchemas = new Map()
    record.state = nextState
    if (client !== undefined) {
      client.onclose = undefined
      await client.close().catch(() => {})
    }
  }

  /**
   * One idle sweep: connected records idle for >= ttlMs are retired to
   * "disconnected" (tools die with the connection; the next use reconnects
   * and re-lists). Connecting and failed records are left alone.
   */
  sweep(now: number, ttlMs: number): string[] {
    const reclaimed: string[] = []
    for (const record of this.allRecords()) {
      if (record.stopped || record.state !== "connected") continue
      if (now - record.lastUsed < ttlMs) continue
      void this.retire(record, "disconnected")
      reclaimed.push(`${record.group}|${record.name}`)
    }
    return reclaimed
  }

  /** Await every in-flight connect attempt (tests). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.#inFlight])
  }

  /** Retire everything (daemon stop). Idempotent. */
  async stopAll(): Promise<void> {
    await Promise.allSettled(this.allRecords().map((r) => this.retire(r)))
  }

  #buildTransport(record: ConnectionRecord): Transport {
    if (this.#opts.transportFactory) return this.#opts.transportFactory(record.name, record.config)
    if (record.config.type === "stdio") {
      return new StdioClientTransport({ command: record.config.command, args: record.config.args, env: record.config.env })
    }
    return new StreamableHTTPClientTransport(new URL(record.config.url), {
      requestInit: { headers: record.config.headers },
    })
  }

  /** Track a connect attempt so flush() can await it. */
  #connect(record: ConnectionRecord, retry: boolean): Promise<void> {
    const p = this.#connectServer(record, retry).finally(() => {
      this.#inFlight.delete(p)
    })
    this.#inFlight.add(p)
    return p
  }

  async #connectServer(record: ConnectionRecord, retry: boolean): Promise<void> {
    if (record.stopped) return
    record.state = "connecting"
    let client: Client | undefined
    let transport: Transport | undefined
    try {
      transport = this.#buildTransport(record)
      client = new Client({ name: "kclaw", version: clientVersion() }, { capabilities: {} })
      transport.onclose = () => this.#handleTransportClose(record)
      await this.#raceTimeout(client.connect(transport))
      if (record.stopped) {
        // stop()/retire raced this connect: never leave a live client behind.
        await client.close().catch(() => {})
        return
      }
      record.client = client
      const listed = await this.#raceTimeout(client.listTools())
      const toolSchemas = new Map<string, Record<string, unknown>>()
      record.tools = listed.tools.map((t) => {
        toolSchemas.set(t.name, t.inputSchema as Record<string, unknown>)
        return {
          name: `mcp__${record.name}__${t.name}`,
          server: record.name,
          originalName: t.name,
          description: t.description ?? "",
        }
      })
      record.toolSchemas = toolSchemas
      record.state = "connected"
      record.attempts = 0
      record.hadSession = true
      record.lastError = undefined
      this.touch(record)
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
      record.client = undefined
      const message = (err as Error).message
      record.state = "failed"
      record.lastError = message
      record.tools = []
      record.toolSchemas = new Map()
      this.#opts.onError?.(record.group, record.name, message)
      if (retry && !record.stopped) this.#scheduleReconnect(record)
    }
  }

  #handleTransportClose(record: ConnectionRecord): void {
    // A close from a server that never connected (spawn/connect failure)
    // means "initial failure", not "disconnect": the failed connect's catch
    // already recorded "failed", and retrying would churn forever on a
    // permanently-broken server.
    if (record.stopped || !record.hadSession) return
    record.state = "connecting"
    record.tools = []
    record.toolSchemas = new Map()
    record.client = undefined
    this.#scheduleReconnect(record)
  }

  /**
   * Bounded exponential backoff: past maxReconnectAttempts the record
   * settles in "failed" and stays there until a use or a manual connect
   * resets the counter.
   */
  #scheduleReconnect(record: ConnectionRecord): void {
    if (record.stopped || record.reconnectTimer !== undefined) return
    if (record.attempts >= this.#opts.maxReconnectAttempts) {
      record.state = "failed"
      record.lastError = `${record.lastError ?? "connection lost"}（自动重试已达 ${this.#opts.maxReconnectAttempts} 次上限）`
      return
    }
    const delay = Math.min(this.#opts.backoffBaseMs * 2 ** record.attempts, this.#opts.backoffCapMs)
    record.attempts += 1
    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = undefined
      void this.#connect(record, true)
    }, delay)
  }

  #raceTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP connect timeout after ${this.#opts.connectTimeoutMs}ms`)), this.#opts.connectTimeoutMs)
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
