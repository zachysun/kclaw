/**
 * Skill packages: model-discoverable, on-demand instruction packs.
 *
 * A skill is a directory containing one SKILL.md (YAML frontmatter + Markdown
 * body), compatible with the Agent Skills format and Claude Code's frontmatter
 * field table. Only five fields are interpreted; every other field is ignored
 * without failing the load (ecosystem skills must drop in unmodified):
 *   name                      display name, defaults to the directory name
 *   description               what it does / when to use, defaults to the
 *                             first body paragraph
 *   when_to_use               appended to the description
 *   disable-model-invocation  keep it out of the model-facing listing
 *   user-invocable            keep it out of the user-facing listing
 *
 * The directory name is the skill's unique identity (Agent Skills format
 * constraint: lowercase alphanumerics and hyphens, 1–64 chars). Visibility is
 * a discovery channel, not access control — all four tiers stay loadable by
 * name through the skill_read tool.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
// 本模块内部也要用（export * 只做再导出，不把名字引入本模块作用域）。
import { isSkillDirName, SKILL_MENTION_REGEX } from "./names.js"

export * from "./links.js"
export * from "./discovery.js"
export * from "./names.js"
export * from "./proposals.js"
export * from "./evolution.js"

/** Combined description + when_to_use cap, aligned with Claude Code's listing. */
const DESCRIPTION_MAX_CHARS = 1536

export interface SkillRecord {
  /** Directory name — the unique identity and the skill_read key. */
  name: string
  /** Frontmatter `name` when given; the directory name otherwise. */
  displayName: string
  /** description (+ when_to_use), capped; defaults to the first body paragraph. */
  description: string
  /** Markdown body below the frontmatter. */
  body: string
  /** Claude Code field: keep out of the model-facing listing. */
  disableModelInvocation: boolean
  /** Claude Code field: keep out of the user-facing listing. */
  userInvocable: boolean
  /** Which scope the loaded copy came from (project wins on name collision). */
  origin: "global" | "project"
  /** Absolute path of the winning skill directory. */
  dir: string
  /** Set when this copy is a reuse link whose skill was bundled in an
   * installed plugin — surfaces show "来自插件 <plugin>". Absent otherwise. */
  plugin?: string
}

// isSkillDirName / SKILL_DIR_NAME live in ./names.js (leaf module, re-exported
// above) so sibling modules can validate names without cycling through here.

function firstParagraph(body: string): string {
  for (const para of body.split(/\n\s*\n/)) {
    const t = para.trim()
    if (t !== "") return t
  }
  return ""
}

function boolField(f: Record<string, unknown>, key: string, dflt: boolean): boolean {
  return typeof f[key] === "boolean" ? (f[key] as boolean) : dflt
}

function strField(f: Record<string, unknown>, key: string): string | undefined {
  const v = f[key]
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined
}

/**
 * Parse one SKILL.md. Returns undefined only when the file is genuinely
 * broken (frontmatter present but unparseable YAML) — a missing frontmatter
 * is a legal minimal skill (all defaults), matching the ecosystem's
 * tolerance. The directory name must already be validated by the caller.
 * CRLF line endings and a leading BOM are tolerated (Windows-authored files).
 */
export function parseSkillFile(raw: string, dirName: string, dir: string, origin: "global" | "project"): SkillRecord | undefined {
  const lines = raw.replace(/^\uFEFF/, "").split("\n").map((l) => l.replace(/\r$/, ""))
  let fm: Record<string, unknown> = {}
  let bodyStart = 1
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1)
    if (end === -1) return undefined
    try {
      const parsed = parse(lines.slice(1, end).join("\n"))
      // Empty frontmatter (---\n---) parses to undefined/null: a legal
      // header with no fields, not a broken file.
      if (parsed !== undefined && parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) return undefined
      fm = (parsed ?? {}) as Record<string, unknown>
    } catch {
      return undefined
    }
    bodyStart = end + 1
  }
  const body = lines.slice(bodyStart).join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
  const description = [strField(fm, "description") ?? firstParagraph(body), strField(fm, "when_to_use")]
    .filter((p): p is string => p !== undefined)
    .join(" ")
  return {
    name: dirName,
    displayName: strField(fm, "name") ?? dirName,
    description: description.length > DESCRIPTION_MAX_CHARS ? `${description.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : description,
    body,
    disableModelInvocation: boolField(fm, "disable-model-invocation", false),
    userInvocable: boolField(fm, "user-invocable", true),
    origin,
    dir,
  }
}

function loadSkillDir(dir: string, dirName: string, origin: "global" | "project"): SkillRecord | undefined {
  try {
    const file = join(dir, "SKILL.md")
    if (!statSync(file).isFile()) return undefined
    return parseSkillFile(readFileSync(file, "utf8"), dirName, dir, origin)
  } catch {
    return undefined
  }
}

/**
 * Scan the two skill scopes and merge by name: a project skill entirely
 * replaces a same-named global one (whole-directory override, no field
 * merging). Unreadable or missing directories simply contribute nothing.
 * Per-entry failures (a dangling symlink, a vanished race) skip that entry
 * only — one bad entry must not wipe the whole scope (/fs/browse precedent).
 * Symlinked skill directories load through to their target.
 */
export function scanSkillDirs(dirs: { global?: string; project?: string }): SkillRecord[] {
  const byName = new Map<string, SkillRecord>()
  for (const [origin, root] of [["global", dirs.global], ["project", dirs.project]] as const) {
    if (root === undefined || !existsSync(root)) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      try {
        const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(root, entry.name)).isDirectory())
        if (!isDir) continue
      } catch {
        continue // dangling symlink / vanished mid-scan: skip this entry only
      }
      if (!isSkillDirName(entry.name)) continue
      const skill = loadSkillDir(join(root, entry.name), entry.name, origin)
      if (skill !== undefined) byName.set(entry.name, skill)
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Model-facing discovery: everything not hidden by disable-model-invocation. */
export function isModelVisible(s: SkillRecord): boolean {
  return !s.disableModelInvocation
}

/**
 * Slash-style skill mentions in a user message, at ANY position: every
 * `/<name>` token matching SKILL_MENTION_REGEX (shared with the evolution
 * coarse check) matches an installed, user-invocable skill by exact
 * directory name. Duplicates collapse; scan order is preserved.
 */
export function matchSkillInvocations(text: string, skills: readonly SkillRecord[]): SkillRecord[] {
  const invocable = new Map(skills.filter(isUserVisible).map((s) => [s.name, s]))
  const matched: SkillRecord[] = []
  for (const m of text.matchAll(SKILL_MENTION_REGEX)) {
    const skill = invocable.get(m[1]!)
    if (skill !== undefined && !matched.includes(skill)) matched.push(skill)
  }
  return matched
}

/**
 * The model-facing copy for invoked skills: the user's message VERBATIM plus
 * one trailing line telling the model to load each named skill via skill_read
 * before following it. This is the implicit wrap applied at the daemon
 boundary — persistence, the event stream and the chat bubble all keep the
 * raw input; only the provider request sees this text. undefined = nothing
 * matched, send the message as-is.
 */
export function wrapSkillInvocations(text: string, matched: readonly SkillRecord[]): string | undefined {
  if (matched.length === 0) return undefined
  if (matched.length === 1) {
    const name = matched[0]!.name
    return `${text}\n\n（本条消息中的「/${name}」是在调用技能 ${name}：请先用 skill_read 工具读取该技能的完整规程，再按该规程处理本条消息。）`
  }
  const refs = matched.map((s) => `「/${s.name}」`).join("")
  const names = matched.map((s) => `技能 ${s.name}`).join("、")
  return `${text}\n\n（本条消息中的${refs}是在调用技能：请先用 skill_read 工具依次读取${names} 的完整规程，再按这些规程处理本条消息。）`
}

/** User-facing discovery: everything not hidden by user-invocable: false. */
export function isUserVisible(s: SkillRecord): boolean {
  return s.userInvocable
}

/**
 * The model-facing skill listing appended to the system prompt: name +
 * description per model-visible skill, under an instruction to load the full
 * body via the skill_read tool before following it. Empty when no skill is
 * model-visible. A character budget (default generous enough that healthy
 * setups never hit it) truncates the listing with a visible marker.
 */
export function skillListPrompt(skills: SkillRecord[], opts: { budgetChars?: number } = {}): string {
  const budget = opts.budgetChars ?? 6000
  const visible = skills.filter(isModelVisible)
  if (visible.length === 0) return ""
  const header = "## 可用技能\n需要时先用 skill_read 工具按名字加载完整说明，再照说明执行：\n"
  const lines: string[] = []
  let used = header.length
  let truncated = false
  for (const s of visible) {
    const line = `- ${s.name}: ${s.description}\n`
    if (used + line.length > budget) {
      truncated = true
      break
    }
    lines.push(line)
    used += line.length
  }
  const marker = truncated ? "（技能过多，部分技能未列出——请考虑精简技能目录）\n" : ""
  return header + lines.join("") + marker
}
