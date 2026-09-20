/**
 * MCP server configuration storage. The management surface is a dedicated
 * `<home>/mcp.json` (JSON, 0600) — editable by the WebUI without ever
 * rewriting the config file. The legacy `mcp.servers` section keeps working
 * for users who never touch the UI: reads merge both sources by server name
 * (mcp.json wins), and the one-way consolidation — triggered by any UI save —
 * moves everything into mcp.json and strips the section from the config file
 * (text-precise edits in the yaml layout, a whole-file rewrite in the json
 * one), so a server deleted through the UI can never resurrect from a stale
 * config section.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomic } from "./atomic.js"
import { loadConfig, saveConfig } from "./config.js"
import { isGitTracked } from "./decided-rules.js"
import type { KclawPaths } from "./paths.js"
import type { McpServerConfig } from "../mcp/manager.js"

/** <home>/mcp.json — the UI-managed MCP server config file. */
export function mcpConfigPath(home: string): string {
  return join(home, "mcp.json")
}

/** Workspace-relative form of the project MCP config file (gitignore / git output). */
export const PROJECT_MCP_REL = join(".kclaw", "mcp.json")

/** <workspace>/.kclaw/mcp.json — the project-scope MCP config file. */
export function projectMcpConfigPath(workspace: string): string {
  return join(workspace, PROJECT_MCP_REL)
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
 * Project-scope read: the same never-throws contract as loadMcpJson (missing
 * or wrong-shaped file → {}; corrupt → warning + {}), plus the birth-defense
 * companion: a git-tracked project file is ignored with a warning — a cloned
 * repository must not ship a config whose stdio entries execute local
 * processes on connect (same motive as the decided-rules defense).
 */
export function loadProjectMcpServers(workspace: string): Record<string, McpServerConfig> {
  const filePath = projectMcpConfigPath(workspace)
  if (!existsSync(filePath)) return {}
  if (isGitTracked(workspace, PROJECT_MCP_REL)) {
    console.error(
      `kclaw: ignoring git-tracked project MCP config ${filePath} ` +
        "(project MCP config is local-only; remove it from git or delete the file)",
    )
    return {}
  }
  return loadMcpJson(filePath)
}

/**
 * Birth defenses before the first project write (mirrors appendDecidedRule):
 * the `.kclaw` dir is created and `.kclaw/mcp.json` is appended to the
 * workspace .gitignore — both idempotent; the file is local-only and
 * env/headers may hold secrets.
 */
function ensureProjectMcpDefenses(workspace: string): void {
  mkdirSync(join(workspace, ".kclaw"), { recursive: true })
  const gitignore = join(workspace, ".gitignore")
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : ""
  if (existing.split("\n").map((l) => l.trim()).includes(PROJECT_MCP_REL)) return
  const sep = existing !== "" && !existing.endsWith("\n") ? "\n" : ""
  appendFileSync(gitignore, `${sep}${PROJECT_MCP_REL}\n`)
}

/** Write the project file (atomic, 0600); runs the birth defenses first. */
export function saveProjectMcpJson(workspace: string, servers: Record<string, McpServerConfig>): void {
  ensureProjectMcpDefenses(workspace)
  saveMcpJson(projectMcpConfigPath(workspace), servers)
}

/**
 * Merged read across both sources: the config file's `mcp.servers` (legacy,
 * read through loadConfig so it follows config.json once that file exists)
 * and mcp.json. Same-name entries resolve to the mcp.json form. A config
 * file that cannot be parsed throws here just as it does for the daemon at
 * startup — silently dropping a broken config could silently drop MCP tools.
 */
export function loadMcpServers(paths: KclawPaths): Record<string, McpServerConfig> {
  const legacy = loadConfig(paths).mcp?.servers ?? {}
  const managed = loadMcpJson(mcpConfigPath(paths.home))
  return { ...legacy, ...managed }
}

/**
 * Persist the full server set as the managed source of truth: everything is
 * written into mcp.json and the legacy section is stripped from whichever
 * config layout is on disk (a no-op once it is gone). Idempotent — every UI
 * save runs through here.
 */
export function consolidateMcpConfig(paths: KclawPaths, servers: Record<string, McpServerConfig>): void {
  saveMcpJson(mcpConfigPath(paths.home), servers)
  removeLegacyMcpSection(paths.config)
  removeLegacyJsonMcpSection(paths)
}

/** Strip `mcp.servers` from config.json (the section survives only in mcp.json). */
function removeLegacyJsonMcpSection(paths: KclawPaths): void {
  if (!existsSync(paths.configJson)) return
  const config = loadConfig(paths)
  if (config.mcp === undefined || Object.keys(config.mcp.servers ?? {}).length === 0) return
  delete config.mcp
  saveConfig(paths, config)
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
