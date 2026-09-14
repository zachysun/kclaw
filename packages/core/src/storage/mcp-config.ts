/**
 * MCP server configuration storage. The management surface is a dedicated
 * `<home>/mcp.json` (JSON, 0600) — editable by the WebUI without ever
 * rewriting the hand-written config.yaml. The legacy `mcp.servers` section in
 * config.yaml keeps working forever for users who never touch the UI: reads
 * merge both sources by server name (mcp.json wins), and the one-way
 * consolidation — triggered by any UI save — moves everything into mcp.json
 * and strips the section from config.yaml with text-precise edits, so hand
 * written comments and key order elsewhere in the file survive untouched.
 */
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { writeFileAtomic } from "./atomic.js"
import type { KclawPaths } from "./paths.js"
import type { McpServerConfig } from "../mcp/manager.js"

/** <home>/mcp.json — the UI-managed MCP server config file. */
export function mcpConfigPath(home: string): string {
  return join(home, "mcp.json")
}

interface McpConfigFile {
  servers?: Record<string, McpServerConfig>
}

/** Read mcp.json; missing/corrupt file → {} with a warning (never throws). */
export function loadMcpJson(filePath: string): Record<string, McpServerConfig> {
  let raw: string
  try {
    raw = readFileSync(filePath, "utf8")
  } catch {
    return {}
  }
  try {
    const file = JSON.parse(raw) as McpConfigFile | null
    if (file === null || typeof file !== "object" || file.servers === undefined) return {}
    if (typeof file.servers !== "object" || Array.isArray(file.servers)) return {}
    return file.servers
  } catch (e) {
    console.error(`kclaw mcp.json unreadable, ignoring: ${filePath} (${e instanceof Error ? e.message : String(e)})`)
    return {}
  }
}

/** Write mcp.json (atomic replace, 0600 — env/headers may hold secrets). */
export function saveMcpJson(filePath: string, servers: Record<string, McpServerConfig>): void {
  writeFileAtomic(filePath, JSON.stringify({ servers }, null, 2) + "\n", 0o600)
}

/**
 * Merged read across both sources: config.yaml `mcp.servers` (legacy) and
 * mcp.json. Same-name entries resolve to the mcp.json form. config.yaml that
 * cannot be parsed throws here just as it does for the daemon at startup —
 * silently dropping a broken config could silently drop MCP tools.
 */
export function loadMcpServers(paths: KclawPaths): Record<string, McpServerConfig> {
  let raw: string
  try {
    raw = readFileSync(paths.config, "utf8")
  } catch {
    raw = "" // no config.yaml — the legacy source is empty
  }
  let legacy: Record<string, McpServerConfig> = {}
  if (raw !== "") {
    let file: { mcp?: { servers?: Record<string, McpServerConfig> } } | null
    try {
      file = parse(raw)
    } catch (err) {
      throw new Error(`invalid yaml in ${paths.config}: ${(err as Error).message}`)
    }
    legacy = file?.mcp?.servers ?? {}
  }
  const managed = loadMcpJson(mcpConfigPath(paths.home))
  return { ...legacy, ...managed }
}

/**
 * Persist the full server set as the managed source of truth: everything is
 * written into mcp.json and the legacy config.yaml section is stripped (a
 * no-op once it is gone). Idempotent — every UI save runs through here.
 */
export function consolidateMcpConfig(paths: KclawPaths, servers: Record<string, McpServerConfig>): void {
  saveMcpJson(mcpConfigPath(paths.home), servers)
  removeLegacyMcpSection(paths.config)
}

/**
 * A top-level `mcp:` line: bare mapping header (with optional trailing
 * comment), or a whole flow-style section on one line. Indented keys under
 * other sections never match (the regex anchors at column zero).
 */
const TOP_MCP_LINE = /^mcp\s*:(\s*\{.*\})?\s*(#.*)?$/

/**
 * Remove the top-level `mcp` section from config.yaml with line-precise
 * edits: the section's lines are dropped, everything else — comments, blank
 * lines, key order — is preserved byte-for-byte. Returns "removed" or
 * "absent" (no top-level mcp line, or no file).
 */
export function removeLegacyMcpSection(configPath: string): "removed" | "absent" {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch {
    return "absent"
  }
  const lines = raw.split("\n")
  const out: string[] = []
  let removed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (TOP_MCP_LINE.test(line)) {
      removed = true
      i++
      // Swallow indented lines (section body). A blank line belongs to the
      // section only while more indented lines follow; otherwise it is the
      // separator before the next top-level key and stays.
      while (i < lines.length) {
        const l = lines[i]
        if (l.trim() === "") {
          let j = i
          while (j < lines.length && lines[j].trim() === "") j++
          if (j < lines.length && /^[ \t]/.test(lines[j])) {
            i = j
            continue
          }
          break
        }
        if (/^[ \t]/.test(l)) {
          i++
          continue
        }
        break
      }
      continue
    }
    out.push(line)
    i++
  }
  if (!removed) return "absent"
  writeFileAtomic(configPath, out.join("\n"), statSync(configPath).mode & 0o777)
  return "removed"
}
