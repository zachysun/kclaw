/**
 * Decided rules — allow rules a human produced by choosing "always allow"
 * (project / global) on a confirmation prompt. One YAML file per scope, one
 * entry per decision, each carrying provenance (when, which call, which
 * session). The files are the management surface: human-readable, versioned
 * by content, never the hand-written config.yaml (that stays write-free).
 *
 * The project file is LOCAL-ONLY by design: it is gitignored on creation and
 * ignored (with a warning) when found git-tracked, so a cloned repository
 * cannot ship a pre-authorized allow list inside itself.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"
import { join, resolve as pathResolve } from "node:path"
import { parse, stringify } from "yaml"
import { writeFileAtomic } from "./atomic.js"
import type { KclawPaths } from "./paths.js"
import { normalizeCommand, realpathWithin, splitSubcommands } from "../permissions/engine.js"

/** One persisted approval: the rule plus why it exists. */
export interface DecidedRuleEntry {
  rule: string
  /** ISO-8601 moment the human chose "always allow". */
  decidedAt: string
  origin: {
    tool: string
    /** Raw args JSON of the call that produced the rule (audit trail). */
    argsJson: string
    sessionId?: string
  }
  /**
   * Where the rule came from: "manual" = a human chose "always allow" on a
   * confirmation; "auto" = the auto mode inducted it after repeated `once`
   * approvals. Absent (old files) reads as "manual".
   */
  source?: "auto" | "manual"
}

interface DecidedRulesFile {
  rules: DecidedRuleEntry[]
}

/** ~/.kclaw/permissions.yaml — global scope. */
export function globalDecidedRulesPath(home: string): string {
  return join(home, "permissions.yaml")
}

/** <workspace>/.kclaw/permissions.yaml — project scope. */
export function projectDecidedRulesPath(workspace: string): string {
  return join(workspace, ".kclaw", "permissions.yaml")
}

/** Workspace-relative form of the project rules file (gitignore / git output). */
export const PROJECT_RULES_REL = join(".kclaw", "permissions.yaml")

/**
 * Narrow the approved call into the rule we persist — deliberately narrower
 * than what the human saw, because a persisted approval must not
 * over-authorize look-alike calls:
 * - command tools: first segment's first word + subcommand as a prefix glob
 *   (`git push origin main` → `exec:git push*`; a bare `ls` stays exact) —
 *   the engine's single-segment constraint still guards chained commands;
 * - path tools: the exact resolved path;
 * - anything else (schema-less MCP tools): tool-level.
 */
export function narrowDecidedRule(toolCall: { name: string; args: unknown }, workspace?: string): string {
  const args = toolCall.args as { command?: unknown; path?: unknown } | null
  if (typeof args?.command === "string" && args.command.trim() !== "") {
    const segs = splitSubcommands(args.command)
    const seg = normalizeCommand(segs[0] ?? "")
    const words = seg.split(" ").filter((w) => w !== "")
    const glob = words.length <= 1 ? seg : `${words[0]} ${words[1]}*`
    return `${toolCall.name}:${glob}`
  }
  if (typeof args?.path === "string" && args.path.trim() !== "") {
    const expanded = args.path === "~" ? homedir() : args.path.startsWith("~/") ? join(homedir(), args.path.slice(2)) : args.path
    const resolved = realpathWithin(pathResolve(workspace ?? process.cwd(), expanded))
    return `${toolCall.name}:${resolved}`
  }
  return toolCall.name
}

/** Read one decided-rules file; missing file → []; corrupt content → [] with a warning. */
export function loadDecidedRules(filePath: string): DecidedRuleEntry[] {
  if (!existsSync(filePath)) return []
  try {
    const file = parse(readFileSync(filePath, "utf8")) as DecidedRulesFile | null
    const rules = file?.rules
    if (!Array.isArray(rules)) return []
    return rules.filter((r): r is DecidedRuleEntry =>
      r !== null && typeof r === "object" && typeof (r as DecidedRuleEntry).rule === "string",
    )
  } catch (e) {
    console.error(`kclaw decided rules unreadable, ignoring: ${filePath} (${e instanceof Error ? e.message : String(e)})`)
    return []
  }
}

/** Rule strings only — the form the permission gate consumes. */
export function decidedRuleStrings(entries: DecidedRuleEntry[]): string[] {
  return entries.map((r) => r.rule)
}

/**
 * True when `relPath` inside `workspace` is tracked by git. A missing git
 * binary or a non-repo directory counts as untracked (fail-open for LOADING
 * is safe here: the fallback is the gitignore protection, and a tracked-file
 * check that cannot run must not block a user's own rules).
 */
export function isGitTracked(workspace: string, relPath: string): boolean {
  const res = spawnSync("git", ["-C", workspace, "ls-files", "--error-unmatch", relPath], {
    stdio: "ignore",
  })
  return res.status === 0
}

/** Append `.kclaw/permissions.yaml` to the workspace .gitignore (idempotent). */
function ensureGitignoreEntry(workspace: string): void {
  const gitignore = join(workspace, ".gitignore")
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : ""
  const entry = PROJECT_RULES_REL
  if (existing.split("\n").map((l) => l.trim()).includes(entry)) return
  const sep = existing !== "" && !existing.endsWith("\n") ? "\n" : ""
  appendFileSync(gitignore, `${sep}${entry}\n`)
}

/**
 * Append one decided entry, creating the file (0600) on first use. For the
 * project scope, pass `workspace` so the defenses run: the `.kclaw` dir is
 * created and the file is gitignored at birth.
 */
export function appendDecidedRule(
  filePath: string,
  entry: DecidedRuleEntry,
  opts: { workspace?: string } = {},
): void {
  if (opts.workspace !== undefined) {
    mkdirSync(join(opts.workspace, ".kclaw"), { recursive: true })
    ensureGitignoreEntry(opts.workspace)
  }
  const rules = loadDecidedRules(filePath)
  rules.push(entry)
  writeFileAtomic(filePath, stringify({ rules }) + "\n")
  chmodSync(filePath, 0o600)
}

/** Remove the entry at `index`; false when out of bounds. Returns the removed entry. */
export function deleteDecidedRule(filePath: string, index: number): DecidedRuleEntry | undefined {
  const rules = loadDecidedRules(filePath)
  if (index < 0 || index >= rules.length) return undefined
  const [removed] = rules.splice(index, 1)
  writeFileAtomic(filePath, stringify({ rules }) + "\n")
  chmodSync(filePath, 0o600)
  return removed
}

export interface DecidedRulesSnapshot {
  /** Rule strings for the gate (global + project, unless project is ignored). */
  rules: string[]
  /** The project file exists but is git-tracked: it was ignored (seeded-rule defense). */
  projectIgnored: boolean
}

/**
 * Per-run load of both scopes, in gate-ready string form. A git-tracked
 * project file is skipped with a console warning — a cloned repo must not be
 * able to pre-authorize its own commands.
 */
export function loadDecidedRulesForRun(paths: KclawPaths, workspace?: string): DecidedRulesSnapshot {
  const globalRules = loadDecidedRules(globalDecidedRulesPath(paths.home))
  let projectRules: DecidedRuleEntry[] = []
  let projectIgnored = false
  if (workspace !== undefined) {
    const projectPath = projectDecidedRulesPath(workspace)
    if (existsSync(projectPath)) {
      if (isGitTracked(workspace, PROJECT_RULES_REL)) {
        projectIgnored = true
        console.error(
          `kclaw: ignoring git-tracked project permissions file ${projectPath} ` +
            "(decided rules are local-only; remove it from git or delete the file)",
        )
      } else {
        projectRules = loadDecidedRules(projectPath)
      }
    }
  }
  return {
    rules: decidedRuleStrings([...globalRules, ...projectRules]),
    projectIgnored,
  }
}
