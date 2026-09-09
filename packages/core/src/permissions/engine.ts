import { readlinkSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { newId } from "../protocol/ids.js"
import type { ToolCallBlock } from "../protocol/blocks.js"
import type { PermissionDecision, PermissionGate } from "../agent/loop.js"
import type { KclawConfig } from "../storage/config.js"
import type { PermissionMode } from "./modes.js"

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
function scopedMatch(rule: CompiledRule, tool: string, rawArg: string, workspace: string | undefined, profile: PermissionProfile): boolean {
  if (ruleMatches(rule, tool, rawArg)) return true
  if (rule.argGlob === undefined || !profile.pathAware) return false
  const normArg = normalizePathArg(rawArg, workspace)
  return (
    globMatch(rule.argGlob, normArg) ||
    globMatch(normalizePathArg(rule.argGlob, workspace), normArg)
  )
}

/**
 * The facts a tool already exposes at registration time: its risk class and
 * the field names of its JSON-Schema parameters. The permission engine
 * derives EVERY treatment from these two facts — tools carry no permission
 * metadata of their own.
 */
export interface ToolFacts {
  risk: "safe" | "sensitive"
  argFields: string[]
}

/**
 * The five permission treatments, derived from {@link ToolFacts}. The
 * derivation reproduces the hardcoded rosters it replaced exactly (verified
 * against the 11 builtins): readonly denies every sensitive tool; the path
 * twin applies to path-arg tools that are sensitive; the workspace boundary
 * covers every path-arg tool; only SAFE path tools enjoy the readRoots
 * exemption; rules match the command field for command tools, the path field
 * for sensitive path tools, and the JSON dump otherwise.
 */
export interface PermissionProfile {
  /** readonly mode denies this tool wholesale (risk === "sensitive"). */
  readonlyDenied: boolean
  /** Path rules additionally match this tool's arg in normalized form. */
  pathAware: boolean
  /** The tool's path arg is boundary-checked against the workspace. */
  boundaryChecked: boolean
  /** Read-only path tool: the readRoots exemption applies. */
  readRootExempt: boolean
  /** Which arg field rules extract: "command" | "path" | null (JSON dump). */
  argField: "command" | "path" | null
}

/** The treatment of an UNREGISTERED tool (model hallucination): strictest. */
const UNREGISTERED_PROFILE: PermissionProfile = {
  readonlyDenied: false,
  pathAware: false,
  boundaryChecked: false,
  readRootExempt: false,
  argField: null,
}

export function permissionProfile(facts: ToolFacts | undefined): PermissionProfile {
  if (facts === undefined) return UNREGISTERED_PROFILE
  const hasPath = facts.argFields.includes("path")
  const hasCommand = facts.argFields.includes("command")
  const sensitive = facts.risk === "sensitive"
  return {
    readonlyDenied: sensitive,
    pathAware: hasPath && sensitive,
    boundaryChecked: hasPath,
    readRootExempt: hasPath && !sensitive,
    argField: hasCommand ? "command" : hasPath && sensitive ? "path" : null,
  }
}

/**
 * Extract the string a scoped rule matches against, per the tool's profile:
 * the command for command tools, the path for sensitive path tools, a JSON
 * dump of the whole args otherwise.
 */
export function extractArg(args: unknown, profile: PermissionProfile): string {
  const a = args as { command?: unknown; path?: unknown } | null | undefined
  if (profile.argField === "command") return String(a?.command ?? "")
  if (profile.argField === "path") return String(a?.path ?? "")
  return JSON.stringify(args ?? {})
}

/**
 * Canonical form an exec rule matches against: whitespace collapsed to
 * single spaces and the command token reduced to its basename, so a deny
 * like `exec:rm -rf*` cannot be dodged with double spaces or /bin/rm.
 * Flag reordering (-r -f vs -rf) is deliberately NOT normalized.
 */
export function normalizeCommand(cmd: string): string {
  const collapsed = cmd.replace(/\s+/g, " ").trim()
  if (collapsed === "") return ""
  const space = collapsed.indexOf(" ")
  const head = space === -1 ? collapsed : collapsed.slice(0, space)
  const rest = space === -1 ? "" : collapsed.slice(space)
  return path.basename(head) + rest
}

/**
 * Split a shell command line into sub-commands at ; && || | newlines and the
 * command-substitution openers `$(` and a backtick — QUOTE-AWARE: single
 * quotes keep everything inert, double quotes make `;`/`|`/`&&` inert but
 * still split at `$(` and a backtick (command substitution executes there
 * too), and an escaping backslash makes the next char a literal. exec runs
 * under a shell, so `git status $(curl evil)` would really execute the
 * substitution — the split makes deny match the embedded command while
 * multi-segment lines lose allow/grant coverage (same semantics as the other
 * continuations). Ambiguous corners over-split rather than under-split, the
 * safe direction: deny scans every segment while allow/grant simply stops
 * applying across concatenations.
 */
export function splitSubcommands(cmd: string): string[] {
  const segs: string[] = []
  let cur = ""
  let quote: '"' | "'" | undefined
  const flush = (): void => {
    const s = cur.trim()
    if (s !== "") segs.push(s)
    cur = ""
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    // `$(` and a backtick execute even inside double quotes → split always;
    // inside single quotes they are inert data.
    if (quote !== "'" && c === "$" && cmd[i + 1] === "(") {
      flush()
      i++
      continue
    }
    if (quote !== "'" && c === "`") {
      flush()
      continue
    }
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      cur += c
      continue
    }
    if (c === "\\") {
      cur += c
      i++
      if (i < cmd.length) cur += cmd[i]!
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === ";" || c === "|" || c === "\n") {
      flush()
      continue
    }
    if (c === "&" && cmd[i + 1] === "&") {
      flush()
      i++
      continue
    }
    cur += c
  }
  flush()
  return segs
}

/** POSIX-ish word splitter for ONE segment: quotes group (and are removed),
 *  an escaping backslash makes the next char literal. Unterminated quotes
 *  take the rest of the line into one word. Not a full shell grammar — just
 *  enough for deny-token matching. */
export function tokenizeWords(segment: string): string[] {
  const words: string[] = []
  let cur = ""
  let quote: '"' | "'" | undefined
  const end = (): void => {
    if (cur !== "") words.push(cur)
    cur = ""
  }
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!
    if (quote === undefined && (c === " " || c === "\t")) {
      end()
      continue
    }
    if (quote === undefined && (c === '"' || c === "'")) {
      quote = c
      continue
    }
    if (quote !== undefined && c === quote) {
      quote = undefined
      continue
    }
    if (c === "\\" && i + 1 < segment.length && quote !== "'") {
      cur += segment[++i]!
      continue
    }
    cur += c
  }
  end()
  return words
}

/**
 * Token form of one segment for deny matching: words with the head reduced
 * to its basename and aggregated letters-only short flags expanded (`-rf` →
 * `-r -f`). Long flags (`--force`), flags with attached values (`-d,`) and
 * plain args stay whole — a command-specific flag database is out of scope;
 * rule and segment expand identically, so consistency is what matters.
 */
export function denyTokens(segment: string): string[] {
  const words = tokenizeWords(segment)
  if (words.length === 0) return []
  const head = path.basename(words[0]!)
  const rest = words.slice(1).flatMap((w) =>
    /^-[a-zA-Z]{2,}$/.test(w) ? [...w.slice(1)].map((ch) => `-${ch}`) : [w],
  )
  return [head, ...rest]
}

/**
 * Token-set cover: does one deny-rule glob cover one command segment?
 * Head must equal the segment head (prefix when the rule head ends with
 * `*`); every remaining rule token must be present among the segment's
 * tokens (multiset — each match consumes one; a trailing `*` on a rule token
 * degrades it to a prefix match). Order-insensitive by design, which closes
 * the flag-reordering blind spot: `exec:rm -rf*` also covers `rm -r -f x`
 * and `rm -f -r /bin/x`. DENY-SIDE ONLY — over-matching is the safe
 * direction here; allow/decided/grants keep the legacy string form (widening
 * an auto-allow would be fail-open). Rule globs carrying internal `*`s
 * (`*secret*`) are not token-coverable → false (the legacy glob path still
 * runs).
 */
export function denyTokenCover(ruleGlob: string, segment: string): boolean {
  const ruleWords = tokenizeWords(ruleGlob)
  const seg = denyTokens(segment)
  if (ruleWords.length === 0 || seg.length === 0) return false
  const headRaw = ruleWords[0]!
  const headStar = headRaw.endsWith("*")
  const headTok = headStar ? headRaw.slice(0, -1) : headRaw
  if (headTok.includes("*")) return false
  const head = path.basename(headTok)
  const segHead = seg[0]!
  if (headStar ? !segHead.startsWith(head) : segHead !== head) return false
  const pool = seg.slice(1)
  for (const raw of ruleWords.slice(1)) {
    const star = raw.endsWith("*")
    const base = star ? raw.slice(0, -1) : raw
    if (base.includes("*")) return false
    const pieces = /^-[a-zA-Z]{2,}$/.test(base) ? [...base.slice(1)].map((ch) => `-${ch}`) : [base]
    for (let k = 0; k < pieces.length; k++) {
      const want = pieces[k]!
      const wantStar = star && k === pieces.length - 1
      const idx = pool.findIndex((t) => (wantStar ? t.startsWith(want) : t === want))
      if (idx === -1) return false
      pool.splice(idx, 1)
    }
  }
  return true
}

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
 * tested against BOTH the raw arg and this form, so a path deny rule cannot
 * be bypassed by spelling the same file as `.ssh/x` (workspace=home),
 * `/Users/u/.ssh/x`, or `~/./.ssh/x` — all resolve to the same target the
 * rule meant to protect.
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
 * True when a path-arg tool's target escapes the workspace: `~`/`~/` expanded,
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
function escapesWorkspace(profile: PermissionProfile, args: unknown, workspace: string | undefined, readRoots: string[] = []): boolean {
  if (workspace === undefined || !profile.boundaryChecked) return false
  const a = args as { path?: unknown } | null | undefined
  const root = realpathWithin(path.resolve(workspace))
  const resolved = realpathWithin(path.resolve(root, expandTilde(String(a?.path ?? ""))))
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    // A read tool reaching an allowed read root (daemon attachments dir)
    // is not an escape: it is the workspace for reading purposes.
    if (profile.readRootExempt) {
      for (const extra of readRoots) {
        const extraRoot = realpathWithin(path.resolve(extra))
        if (resolved === extraRoot || resolved.startsWith(extraRoot + path.sep)) return false
      }
    }
    return true
  }
  return false
}

/**
 * In-memory, run-scoped grant store: rules a human approved (via `once`) so
 * the same call stops re-prompting within this run. A fresh instance is
 * created per run and dies with it — cross-run repetition is the decided
 * rules' job (learned grants persist), not this store's.
 */
export class SessionGrants {
  #rules: CompiledRule[] = []

  grant(rule: string): void {
    this.#rules.push(compileRule(rule))
  }

  /** True when a granted rule covers this call; workspace+profile enable path-form matching. */
  hasMatch(tool: string, arg: string, workspace?: string, profile: PermissionProfile = permissionProfile(undefined)): boolean {
    return this.#rules.some((r) => scopedMatch(r, tool, arg, workspace, profile))
  }

  /** Snapshot of granted rules (for the exec branch's per-rule matching). */
  rules(): readonly CompiledRule[] {
    return this.#rules
  }

  size(): number {
    return this.#rules.length
  }
}

export interface ConfigPermissionGateOptions {
  /** tool names allowed unconditionally (e.g. read-only built-ins) */
  safeTools?: Set<string>
  /**
   * Registration facts per tool (risk + schema arg field names), derived by
   * the run assembly from the tool registry. Every treatment beyond the
   * safeTools allowlist is derived from these via permissionProfile; a tool
   * missing from the table (model hallucination) gets the strictest default.
   */
  toolFacts?: Map<string, ToolFacts>
  /**
   * Run-scoped grant store (batch D wiring). Consulted only when config
   * enables sessionGrants AND the session mode is not `auto`: auto's contract
   * is learning from HUMAN confirmations — a run grant would hide the
   * repetitions induction needs to observe (batch C semantics unchanged).
   */
  grants?: SessionGrants
  /** id factory for confirm decisions (injectable for tests) */
  newConfirmationId?: () => string
  /**
   * Workspace path tools operate in: file-tool path args are additionally
   * matched in normalized form (see normalizePathArg). Defaults to cwd.
   */
  workspace?: string
  /**
   * Extra roots whose READ access (safe path-arg tools only) is treated like
   * the workspace — the daemon passes its attachments dir here so an
   * uploaded attachment is readable without a per-file confirmation.
   * Write tools are never exempted.
   */
  readRoots?: string[]
  /**
   * Session permission mode. `readonly` denies sensitive tools wholesale
   * (reason "readonly"); `acceptEdits` auto-approves sensitive path-arg tools
   * (fs_write/fs_edit) whose target stays inside the workspace — reason
   * "accept_edits"; `default` (absent) confirms them. See permissions/modes.ts.
   */
  mode?: PermissionMode
  /**
   * Decided rules — allow rules a human produced by choosing "always allow"
   * on a confirmation prompt (project + global scopes, pre-loaded per run).
   * They sit AFTER the hand-written allow rules in the decision order and
   * carry the same workspace-escape guard; approvals get reason "learned".
   */
  decidedRules?: string[]
  /**
   * Whether the exec sandbox is available (the run assembly derives this from
   * the sandbox provider's probe, single source with the exec tool's actual
   * wrapper). When true, a command-class tool that would otherwise fall to
   * confirm auto-passes with reason "sandboxed" — the sandbox, not a human,
   * is the approval. Never overrides deny/rules; readonly still
   * short-circuits everything above.
   */
  sandboxAvailable?: boolean
  /**
   * User-facing explanation shown on the confirmation when a command falls
   * back to confirm BECAUSE the sandbox is unavailable (enabled in config but
   * the platform probe failed). Absent when the sandbox is simply disabled by
   * choice — that needs no explanation.
   */
  sandboxUnavailableNote?: string
  /**
   * Tools whose executor the run assembly actually wrapped in the OS sandbox
   * (exec today). The "sandboxed" auto-pass must never claim a tool is
   * sandboxed when its execution is not wrapped — a schema-`command` adapter
   * tool would otherwise ride the trusted no-prompt tier unsandboxed.
   */
  sandboxedTools?: ReadonlySet<string>
}

/** A compiled rule that remembers its source string for deny notes. */
interface DenyRule extends CompiledRule {
  source: string
}

/**
 * Config-driven PermissionGate. Decision order, short-circuiting:
 * deny blacklist → allow whitelist → decided rules → acceptEdits → workspace
 * boundary → safeTools → session grants → confirm, with a fresh `conf_` id
 * the surrounding loop routes to a human.
 * Command-arg tools (sensitive + `command` parameter — exec today) take a
 * dedicated branch (safeTools never lists them): deny matches every
 * normalized sub-command of a concatenated line, while allow/decided/grant
 * only ever cover a single, concatenation-free command.
 */
export class ConfigPermissionGate implements PermissionGate {
  readonly #allow: CompiledRule[]
  readonly #deny: DenyRule[]
  readonly #decided: CompiledRule[]
  readonly #mode: PermissionMode
  readonly #safeTools: Set<string>
  readonly #profiles: Map<string, PermissionProfile>
  readonly #grants: SessionGrants | undefined
  readonly #sessionGrantsEnabled: boolean
  readonly #newConfirmationId: () => string
  readonly #workspace: string | undefined
  readonly #readRoots: string[]
  readonly #sandboxAvailable: boolean
  readonly #sandboxUnavailableNote: string | undefined
  readonly #sandboxedTools: ReadonlySet<string>

  constructor(cfg: KclawConfig["permissions"], opts: ConfigPermissionGateOptions = {}) {
    this.#allow = cfg.allow.map(compileRule)
    this.#deny = cfg.deny.map((s) => ({ ...compileRule(s), source: s }))
    this.#decided = (opts.decidedRules ?? []).map(compileRule)
    this.#mode = opts.mode ?? "default"
    this.#safeTools = opts.safeTools ?? new Set()
    this.#profiles = new Map([...(opts.toolFacts ?? [])].map(([name, facts]) => [name, permissionProfile(facts)]))
    this.#grants = opts.grants
    this.#sessionGrantsEnabled = cfg.sessionGrants === true
    this.#newConfirmationId = opts.newConfirmationId ?? (() => newId("conf"))
    this.#workspace = opts.workspace
    this.#readRoots = opts.readRoots ?? []
    this.#sandboxAvailable = opts.sandboxAvailable ?? false
    this.#sandboxUnavailableNote = opts.sandboxUnavailableNote
    this.#sandboxedTools = opts.sandboxedTools ?? new Set()
  }

  /** A compiled command rule vs one normalized sub-command (other tools' rules never cover this one). */
  #execRuleMatches(rule: CompiledRule, tool: string, s: string): boolean {
    if (rule.tool !== tool) return false
    return rule.argGlob === undefined ? true : globMatch(normalizeCommand(rule.argGlob), s)
  }

  /**
   * Deny-side exec matching, two paths ORed: the legacy normalized-string
   * glob (every rule keeps firing on exactly what it fired on before) plus
   * token-set cover (closes the flag-reordering/aggregate-flag blind spot —
   * `exec:rm -rf*` also catches `rm -r -f x`). Allow/decided/grants never use
   * the token path: widening an auto-allow would be fail-open.
   */
  #execDenyHit(rule: DenyRule, tool: string, segment: string): boolean {
    if (rule.tool !== tool) return false
    if (rule.argGlob === undefined) return true
    if (globMatch(normalizeCommand(rule.argGlob), normalizeCommand(segment))) return true
    return denyTokenCover(rule.argGlob, segment)
  }

  async check(toolCall: ToolCallBlock): Promise<PermissionDecision> {
    const tool = toolCall.name
    const profile = this.#profiles.get(tool) ?? permissionProfile(undefined)
    const arg = extractArg(toolCall.args, profile)
    // Readonly short-circuits EVERYTHING for sensitive tools (even a
    // whitelisted allow rule): the mode promises zero mutation risk.
    if (this.#mode === "readonly" && profile.readonlyDenied) {
      return { type: "deny", reason: "readonly", noteText: "只读模式（readonly）" }
    }

    // trusted（批次 C）：沙箱与工作区边界内的操作全部自动放行、不弹确认；
    // 边界外——exec 无法沙箱化、越界、无沙箱保护的敏感工具——一律拒绝
    // （fail-closed）。免审档没有人工兜底，deny 黑名单仍最优先。
    if (this.#mode === "trusted") {
      if (profile.argField === "command") {
        const subs = splitSubcommands(arg)
        for (const rule of this.#deny) {
          if (subs.some((s) => this.#execDenyHit(rule, tool, s))) {
            return { type: "deny", reason: "blacklist", noteText: `规则命中黑名单: ${rule.source}` }
          }
        }
        // Only a tool the assembly ACTUALLY wrapped in the OS sandbox may
        // pass as "sandboxed" — a schema-command adapter tool (MCP etc.) is
        // not wrapped, so it is denied, never auto-passed unsandboxed.
        if (this.#sandboxAvailable && this.#sandboxedTools.has(tool)) {
          return { type: "allow", reason: "sandboxed" }
        }
        return {
          type: "deny", reason: "mode",
          noteText: this.#sandboxAvailable
            ? "trusted 模式无法沙箱化该敏感工具"
            : "trusted 模式要求 exec 进沙箱，但沙箱不可用",
        }
      }
      const matches = (r: CompiledRule) => scopedMatch(r, tool, arg, this.#workspace, profile)
      for (const rule of this.#deny) {
        if (matches(rule)) {
          return { type: "deny", reason: "blacklist", noteText: `规则命中黑名单: ${rule.source}` }
        }
      }
      if (escapesWorkspace(profile, toolCall.args, this.#workspace, this.#readRoots)) {
        return { type: "deny", reason: "mode", noteText: "trusted 模式只放行工作区内的操作" }
      }
      if (profile.pathAware) {
        // 工作区内：sensitive 路径写（fs_write/fs_edit）→ trusted 放行；
        // safe 路径读（fs_read/fs_list）→ safe 放行。
        return profile.readonlyDenied
          ? { type: "allow", reason: "trusted" }
          : { type: "allow", reason: "safe" }
      }
      if (this.#safeTools.has(tool)) return { type: "allow", reason: "safe" }
      // 无沙箱保护的 sensitive 工具（MCP 适配器、未注册工具）在免审档不能放行。
      return { type: "deny", reason: "mode", noteText: "trusted 模式无法沙箱化该敏感工具" }
    }

    // Command-arg tools: deny matches every sub-command (normalized); allow,
    // decided rules and session grants only ever apply to a single,
    // concatenation-free command — a rule like `exec:git status*` must not
    // wave through `git status; …`.
    if (profile.argField === "command") {
      const subs = splitSubcommands(arg)
      for (const rule of this.#deny) {
        if (subs.some((s) => this.#execDenyHit(rule, tool, s))) {
          return { type: "deny", reason: "blacklist", noteText: `规则命中黑名单: ${rule.source}` }
        }
      }
      if (subs.length === 1) {
        const single = normalizeCommand(subs[0]!)
        if (this.#allow.some((r) => this.#execRuleMatches(r, tool, single))) {
          return { type: "allow", reason: "whitelist" }
        }
        if (this.#decided.some((r) => this.#execRuleMatches(r, tool, single))) {
          return { type: "allow", reason: "learned" }
        }
        if (this.#sessionGrantsEnabled && this.#mode !== "auto" && this.#grants !== undefined) {
          const grantHit = this.#grants.rules().some((r) => this.#execRuleMatches(r, tool, single))
          if (grantHit) return { type: "allow", reason: "session_grant" }
        }
      }
      // The sandbox is the approval, not a human: a command with no rule
      // coverage (including multi-segment lines) that would otherwise go to
      // confirm runs sandboxed when the OS sandbox is available — and only
      // when the assembly actually wrapped THIS tool in it. It can never
      // override a deny above; readonly never reaches here.
      if (this.#sandboxAvailable && this.#sandboxedTools.has(tool)) {
        return { type: "allow", reason: "sandboxed" }
      }
      // Fail-closed: without the sandbox this stays a human confirmation. When
      // the sandbox was enabled but unavailable (not just disabled), explain
      // why on the confirmation.
      return {
        type: "confirm",
        confirmationId: this.#newConfirmationId(),
        ...(this.#sandboxUnavailableNote === undefined ? {} : { noteText: this.#sandboxUnavailableNote }),
      }
    }

    // --- everything else: unchanged decision order ---
    // Path-aware matching: for path-arg tools rules also match the arg's
    // resolved form, closing path-shape bypasses of deny rules.
    const matches = (r: CompiledRule) => scopedMatch(r, tool, arg, this.#workspace, profile)
    for (const rule of this.#deny) {
      if (matches(rule)) {
        return { type: "deny", reason: "blacklist", noteText: `规则命中黑名单: ${rule.source}` }
      }
    }
    // A whitelisted rule only takes precedence over the workspace boundary
    // while the target stays inside it (realpath form). An allow rule whose
    // lexical path is waved through by a symlink pointing outside falls
    // through to the escape check below and goes to confirm, not allow.
    if (this.#allow.some(matches) && !escapesWorkspace(profile, toolCall.args, this.#workspace, this.#readRoots)) {
      return { type: "allow", reason: "whitelist" }
    }
    // Decided rules (human-approved "always allow"): same precedence shape as
    // hand-written allow — inside the workspace only, escaped targets fall to
    // the boundary check below — but one step later, so explicit
    // configuration always outranks past approvals.
    if (this.#decided.some(matches) && !escapesWorkspace(profile, toolCall.args, this.#workspace, this.#readRoots)) {
      return { type: "allow", reason: "learned" }
    }
    // acceptEdits: sensitive path-arg tools (fs_write/fs_edit today) are
    // auto-approved while the target stays inside the workspace; escaped
    // targets fall through to the boundary check. exec (command-arg) never
    // reaches this branch. AcceptEdits therefore cannot authorize anything
    // beyond the workspace.
    if (this.#mode === "acceptEdits" && profile.pathAware && !escapesWorkspace(profile, toolCall.args, this.#workspace, this.#readRoots)) {
      return { type: "allow", reason: "accept_edits" }
    }
    // Out-of-workspace path access is not auto-approved: even a "safe" tool
    // must go to a human when its target escapes the workspace. Runs after
    // deny/allow/decided/acceptEdits so those still take precedence.
    if (escapesWorkspace(profile, toolCall.args, this.#workspace, this.#readRoots)) {
      return { type: "confirm", confirmationId: this.#newConfirmationId() }
    }
    if (this.#safeTools.has(tool)) {
      return { type: "allow", reason: "safe" }
    }
    if (this.#sessionGrantsEnabled && this.#mode !== "auto" && this.#grants?.hasMatch(tool, arg, this.#workspace, profile)) {
      return { type: "allow", reason: "session_grant" }
    }
    return { type: "confirm", confirmationId: this.#newConfirmationId() }
  }
}
