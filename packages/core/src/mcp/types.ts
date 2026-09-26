/**
 * Shared MCP types and input guards. Leaf module: no SDK imports, so the
 * protocol exit (protocol/mcp.ts) stays a client-safe type-only re-export.
 */

/**
 * Configuration for one MCP server. `stdio` spawns a local process,
 * `http` connects to a streamable HTTP endpoint. `enabled === false`
 * keeps the entry configured but never connects.
 */
export type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; enabled?: boolean }

/**
 * A group is the unified ownership key for entries and connections:
 * `"global"` (the daemon-wide layer, shared by every project) or a project
 * workdir (each directory its own layer). Groups appear in snapshots and
 * action payloads as this exact string.
 */
export const GLOBAL_GROUP = "global"

/**
 * Manager rejections carry a machine-readable class: the routes layer maps
 * not-found → 404, conflict → 409, invalid → 400 instead of sniffing the
 * message text (wording may change freely without moving status codes).
 */
export type McpErrorCode = "not-found" | "conflict" | "invalid"

export class McpError extends Error {
  readonly code: McpErrorCode
  constructor(code: McpErrorCode, message: string) {
    super(message)
    this.name = "McpError"
    this.code = code
  }
}

/**
 * Key-order-insensitive deep equality (hand-edited files rarely keep the
 * key order of an in-memory-constructed object). Arrays compare by index.
 */
export function configsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
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

/**
 * Point-in-time snapshot of one configured entry. `disconnected` is the
 * resting state of the lazy model: configured but holding no connection
 * (never used yet, or reclaimed after idling).
 */
export type McpConnState = "connected" | "connecting" | "disconnected" | "failed" | "disabled"

export interface McpServerStatus {
  name: string
  config: McpServerConfig
  /** Owning group: `"global"` or the project workdir. */
  group: string
  state: McpConnState
  tools: McpToolEntry[]
  lastError?: string
}

/** One group in the status snapshot: the global group or one project. */
export interface McpGroupStatus {
  /** `"global"` or a project workdir. */
  id: string
  servers: McpServerStatus[]
}

/** GET /mcp snapshot shape: global first, then the known projects. */
export interface McpSnapshot {
  groups: McpGroupStatus[]
}

/** Whether a client-supplied group id is well-formed ("global" or a workdir path). */
export function isGroupId(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (value === GLOBAL_GROUP) return true
  // Project groups are directory paths; anything else is a malformed id,
  // not an unknown group (that distinction surfaces as 404 further down).
  return value.startsWith("/") && value.length > 1
}
