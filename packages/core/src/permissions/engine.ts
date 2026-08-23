import { readlinkSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { newId } from "../protocol/ids.js"
import type { ToolCallBlock } from "../protocol/blocks.js"
import type { PermissionDecision, PermissionGate } from "../agent/loop.js"
import type { KclawConfig } from "../storage/config.js"

/** A compiled permission rule: bare tool name, or tool name plus arg glob. */
export interface CompiledRule {
  tool: string
  /** when absent the rule matches the tool regardless of arguments */
  argGlob?: string
}

/**
 * Parse one permission rule string: "tool:argGlob" scopes the rule to calls
 * whose extracted arg matches the glob; a bare string is tool-level.
 * Splits at the FIRST colon so arg globs may themselves contain colons.
 */
export function compileRule(s: string): CompiledRule {
  const colon = s.indexOf(":")
  if (colon === -1) return { tool: s }
  return { tool: s.slice(0, colon), argGlob: s.slice(colon + 1) }
}

/**
 * Glob match where `*` is the only metacharacter: it matches any character
 * sequence including `/` (so `**` needs no special casing). Case-sensitive.
 * Iterative star-backtracking, no regex compilation.
 */
export function globMatch(pattern: string, s: string): boolean {
  let pi = 0
  let si = 0
  let star = -1 // index of the last seen '*' in the pattern
  let mark = 0 // s-index that star's wildcard run started from
  while (si < s.length) {
    if (pi < pattern.length && pattern[pi] === s[si]) {
      pi++
      si++
    } else if (pi < pattern.length && pattern[pi] === "*") {
      star = pi++
      mark = si
    } else if (star !== -1) {
      // Mismatch after a star: extend its match by one char and retry.
      pi = star + 1
      si = ++mark
    } else {
      return false
    }
  }
  // Trailing stars match the (already consumed) rest of s.
  while (pi < pattern.length && pattern[pi] === "*") pi++
  return pi === pattern.length
}

/** True when the rule applies to this tool call (name, and arg if scoped). */
function ruleMatches(rule: CompiledRule, tool: string, arg: string): boolean {
  if (rule.tool !== tool) return false
  if (rule.argGlob === undefined) return true
  return globMatch(rule.argGlob, arg)
}

/**
 * Path-aware rule matching: the raw arg always matches literally first
 * (exec commands, JSON dumps); for file tools the rule is additionally tested
 * with BOTH the arg and the glob in normalized form (`~` expanded, resolved
 * against the workspace), so a rule written `~/.ssh/**` still hits the same
 * file spelled `.ssh/x` or `/Users/u/.ssh/x`.
 */
function scopedMatch(rule: CompiledRule, tool: string, rawArg: string, workspace: string | undefined): boolean {
  if (ruleMatches(rule, tool, rawArg)) return true
  if (rule.argGlob === undefined || !PATH_TOOLS.has(tool)) return false
  const normArg = normalizePathArg(rawArg, workspace)
  return (
    globMatch(rule.argGlob, normArg) ||
    globMatch(normalizePathArg(rule.argGlob, workspace), normArg)
  )
}

/**
 * Extract the string a scoped rule matches against: the command for exec,
 * the path for file-writing tools, a JSON dump of the whole args otherwise.
 */
export function extractArg(name: string, args: unknown): string {
  const a = args as { command?: unknown; path?: unknown } | null | undefined
  if (name === "exec") return String(a?.command ?? "")
  if (name === "fs_write" || name === "fs_edit") return String(a?.path ?? "")
  return JSON.stringify(args ?? {})
}

/** File-writing tools whose path arg gets a normalized twin for rule matching. */
const PATH_TOOLS = new Set(["fs_write", "fs_edit"])

/** File tools whose path arg must stay inside the workspace (boundary check). */
const FILE_TOOLS = new Set(["fs_read", "fs_list", "fs_write", "fs_edit"])

/** Expand a leading `~` / `~/` to the home directory; other strings pass through. */
function expandTilde(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2))
  return p
}

/**
 * Normalized form of a file tool's path arg: `~`/`~/` expanded, then resolved
 * against the workspace (cwd when unknown) exactly the way fs.ts resolves the
 * path before writing. The real path (symlinks followed), so a rule on the
 * true location cannot be dodged by entering it through a symlink. Rules are
 * tested against BOTH the raw arg and this form, so a deny like
 * `fs_write:~/.ssh/**` cannot be bypassed by spelling the same file as
 * `.ssh/x` (workspace=home), `/Users/u/.ssh/x`, or `~/./.ssh/x` — all resolve
 * to the same target the rule meant to protect.
 */
function normalizePathArg(raw: string, workspace: string | undefined): string {
  return realpathWithin(path.resolve(workspace ?? process.cwd(), expandTilde(raw)))
}

/**
 * Real path of `p`, tolerating a nonexistent leaf: the deepest existing
 * ancestor is realpath'd and the missing tail appended verbatim, so a
 * not-yet-created target keeps its lexical (planned) form. A broken symlink
 * resolves through its readlink target — writing through it lands at the
 * target, so the boundary must see the target; relative targets resolve
 * against the link's own directory, and a symlink cycle falls back to the
 * lexical form (fail-safe, matches pre-change behavior).
 */
export function realpathWithin(p: string): string {
  return realpathWithinInner(p, new Set())
}

function realpathWithinInner(p: string, seen: Set<string>): string {
  try {
    return realpathSync(p)
  } catch {
    try {
      const target = readlinkSync(p)
      // A relative readlink target resolves against the symlink's own
      // directory, not the process cwd (the `ln -s` default form).
      const resolvedTarget = path.resolve(path.dirname(p), target)
      if (seen.has(resolvedTarget)) return p // symlink cycle: lexical fallback is fail-safe
      seen.add(resolvedTarget)
      return realpathWithinInner(resolvedTarget, seen)
    } catch {
      const parent = path.dirname(p)
      if (parent === p) return p
      return path.join(realpathWithinInner(parent, seen), path.basename(p))
    }
  }
}

/**
 * True when a file tool's path arg escapes the workspace: `~`/`~/` expanded,
 * then resolved against the workspace exactly the way fs.ts resolves before
 * reading/writing (`path.resolve(root, p)` must equal or sit beneath `root`).
 * The resolved form is the REAL path (symlinks followed), so an in-workspace
 * symlink pointing outside still escapes; the workspace root is realpath'd
 * the same way, so a workspace that itself sits behind a symlink does not
 * over-confirm its own files.
 * Only meaningful when workspace is set; otherwise the workspace boundary
 * is not enforced at the permission layer and this returns false (legacy
 * behavior).
 */
function escapesWorkspace(tool: string, args: unknown, workspace: string | undefined): boolean {
  if (workspace === undefined || !FILE_TOOLS.has(tool)) return false
  const a = args as { path?: unknown } | null | undefined
  const root = realpathWithin(path.resolve(workspace))
  const resolved = realpathWithin(path.resolve(root, expandTilde(String(a?.path ?? ""))))
  return resolved !== root && !resolved.startsWith(root + path.sep)
}

/**
 * In-memory, process-lifetime grant store: rules a human approved during
 * this session so the same call stops re-prompting.
 */
export class SessionGrants {
  #rules: CompiledRule[] = []

  grant(rule: string): void {
    this.#rules.push(compileRule(rule))
  }

  /** True when a granted rule covers this call; workspace enables path-form matching. */
  hasMatch(tool: string, arg: string, workspace?: string): boolean {
    return this.#rules.some((r) => scopedMatch(r, tool, arg, workspace))
  }

  size(): number {
    return this.#rules.length
  }
}

export interface ConfigPermissionGateOptions {
  /** tool names allowed unconditionally (e.g. read-only built-ins) */
  safeTools?: Set<string>
  /** grant store consulted only when config enables sessionGrants */
  grants?: SessionGrants
  /** id factory for confirm decisions (injectable for tests) */
  newConfirmationId?: () => string
  /**
   * Workspace path tools operate in: file-tool path args are additionally
   * matched in normalized form (see normalizePathArg). Defaults to cwd.
   */
  workspace?: string
}

/** A compiled rule that remembers its source string for deny notes. */
interface DenyRule extends CompiledRule {
  source: string
}

/**
 * Config-driven PermissionGate. Decision order, short-circuiting:
 * deny blacklist → allow whitelist → safeTools → session grants → confirm
 * with a fresh `conf_` id the surrounding loop routes to a human.
 */
export class ConfigPermissionGate implements PermissionGate {
  readonly #allow: CompiledRule[]
  readonly #deny: DenyRule[]
  readonly #safeTools: Set<string>
  readonly #grants: SessionGrants | undefined
  readonly #sessionGrantsEnabled: boolean
  readonly #newConfirmationId: () => string
  readonly #workspace: string | undefined

  constructor(cfg: KclawConfig["permissions"], opts: ConfigPermissionGateOptions = {}) {
    this.#allow = cfg.allow.map(compileRule)
    this.#deny = cfg.deny.map((s) => ({ ...compileRule(s), source: s }))
    this.#safeTools = opts.safeTools ?? new Set()
    this.#grants = opts.grants
    this.#sessionGrantsEnabled = cfg.sessionGrants === true
    this.#newConfirmationId = opts.newConfirmationId ?? (() => newId("conf"))
    this.#workspace = opts.workspace
  }

  async check(toolCall: ToolCallBlock): Promise<PermissionDecision> {
    const tool = toolCall.name
    const arg = extractArg(tool, toolCall.args)
    // Path-aware matching: for file tools rules also match the arg's
    // resolved form, closing path-shape bypasses of deny rules.
    const matches = (r: CompiledRule) => scopedMatch(r, tool, arg, this.#workspace)
    for (const rule of this.#deny) {
      if (matches(rule)) {
        return { type: "deny", reason: "blacklist", noteText: `规则命中黑名单: ${rule.source}` }
      }
    }
    if (this.#allow.some(matches)) {
      return { type: "allow", reason: "whitelist" }
    }
    // Out-of-workspace file access is not auto-approved: even a "safe" tool
    // (fs_read/fs_list) must go to a human when its target escapes the
    // workspace. Runs after deny/allow so those still take precedence.
    if (escapesWorkspace(tool, toolCall.args, this.#workspace)) {
      return { type: "confirm", confirmationId: this.#newConfirmationId() }
    }
    if (this.#safeTools.has(tool)) {
      return { type: "allow", reason: "safe" }
    }
    if (this.#sessionGrantsEnabled && this.#grants?.hasMatch(tool, arg, this.#workspace)) {
      return { type: "allow", reason: "session_grant" }
    }
    return { type: "confirm", confirmationId: this.#newConfirmationId() }
  }
}
