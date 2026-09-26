/**
 * MCP server configuration storage. The management surface is a dedicated
 * `<home>/mcp.json` (JSON, 0600) — editable by the WebUI without ever
 * rewriting the config file — plus a per-workspace project file at
 * `<workspace>/.kclaw/mcp.json` (local-only, gitignore-guarded).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { writeFileAtomic } from "./atomic.js"
import { isGitTracked } from "./decided-rules.js"
import type { McpServerConfig } from "../mcp/types.js"

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

/**
 * True when the workdir's project config file would BE the global file —
 * the shape where the daemon home sits inside the project (workspace =
 * the user's home directory). Such a project layer cannot exist
 * independently: both groups would read, persist and watch the same file,
 * so a global edit "leaks" into the project and back. Callers must skip
 * the directory entirely (no project group, no watch); lexical path
 * identity is the test — symlinked spellings of the same dir are out of
 * scope.
 */
export function projectMcpCollidesWithGlobal(workdir: string, home: string): boolean {
  return resolve(projectMcpConfigPath(workdir)) === resolve(mcpConfigPath(home))
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
