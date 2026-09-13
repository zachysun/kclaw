/**
 * Skill reuse links: symlinked skill directories adopted from other coding
 * agents, with a sidecar metadata file next to the links.
 *
 * The loader (scanSkillDirs) already follows symlinked directories, so a
 * reuse link needs no scanner changes — only bookkeeping and a visibility
 * tier that the external SKILL.md cannot express (it belongs to another
 * agent and must never be modified). The sidecar file is dot-prefixed so
 * the skill directory enumeration ignores it by the existing name rules.
 *
 * Tier semantics overwrite the two frontmatter booleans after the
 * global+project merge, matched by realpath (a link record applies to the
 * content it points at, not merely to a name — an owned skill that later
 * takes the same name keeps its own frontmatter and is surfaced as a
 * conflict by discovery instead):
 *   all   → model-visible + user-invocable
 *   user  → hidden from the model listing, user-invocable by name
 *   model → model-visible, hidden from the user listing
 *   off   → parked: hidden from both, link and skill_read access stay alive
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { isSkillDirName, parseSkillFile, type SkillRecord } from "./index.js"

/** Visibility tier of a reused skill; mirrors the frontmatter 2×2. */
export type ReuseTier = "all" | "user" | "model" | "off"

/** Where a reused skill came from; "custom" covers manually added sources. */
export type ReuseAgent = "claude" | "codex" | "dsh" | "zcode" | "custom"

export interface LinkRecord {
  /** Link name — the skill identity inside kclaw's skills directory. */
  name: string
  /** Absolute path of the real skill directory the symlink points to. */
  target: string
  agent: ReuseAgent
  tier: ReuseTier
  /** Set when the reused skill was bundled in an installed plugin — shown
   * wherever the skill appears ("来自插件 X"). Absent on older records. */
  plugin?: string
}

export interface LinksFile {
  links: LinkRecord[]
  /** Manually added discovery source directories (absolute paths). */
  extraSources: string[]
}

export const LINKS_FILENAME = ".links.json"

export function linksFilePath(skillsDir: string): string {
  return join(skillsDir, LINKS_FILENAME)
}

const emptyLinks = (): LinksFile => ({ links: [], extraSources: [] })

/** Agents accepted from the wire; anything else is not a link record. */
const AGENTS: readonly ReuseAgent[] = ["claude", "codex", "dsh", "zcode", "custom"]
const TIERS: readonly ReuseTier[] = ["all", "user", "model", "off"]

/**
 * Read a scope's links file. A missing file, a corrupt file, or a file whose
 * entries lost their shape degrades to empty — the sidecar must never block
 * skill loading, and hand-edited garbage is dropped rather than trusted.
 */
export function readLinksFile(skillsDir: string): LinksFile {
  const file = linksFilePath(skillsDir)
  if (!existsSync(file)) return emptyLinks()
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return emptyLinks()
    const obj = raw as Record<string, unknown>
    const links: LinkRecord[] = Array.isArray(obj.links)
      ? obj.links
          .filter(
            (l): l is LinkRecord =>
              l !== null && typeof l === "object" &&
              typeof (l as Record<string, unknown>).name === "string" &&
              typeof (l as Record<string, unknown>).target === "string" &&
              typeof (l as Record<string, unknown>).agent === "string" &&
              AGENTS.includes((l as Record<string, unknown>).agent as ReuseAgent) &&
              typeof (l as Record<string, unknown>).tier === "string" &&
              TIERS.includes((l as Record<string, unknown>).tier as ReuseTier) &&
              isSkillDirName((l as Record<string, unknown>).name as string),
          )
          .map((l) => {
            // plugin is advisory attribution: keep it when well-formed, drop
            // it silently otherwise (older records legitimately lack it).
            return typeof l.plugin === "string" && l.plugin !== "" ? { ...l, plugin: l.plugin } : { ...l, plugin: undefined }
          })
      : []
    const extraSources: string[] = Array.isArray(obj.extraSources)
      ? obj.extraSources.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim())
      : []
    return { links, extraSources }
  } catch {
    return emptyLinks()
  }
}

/** Atomic write (temp file + rename), 0600 — same hygiene as other sidecars. */
export function writeLinksFile(skillsDir: string, file: LinksFile): void {
  mkdirSync(skillsDir, { recursive: true })
  const target = linksFilePath(skillsDir)
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, target)
}

const TIER_OVERWRITE: Record<ReuseTier, { disableModelInvocation: boolean; userInvocable: boolean }> = {
  all: { disableModelInvocation: false, userInvocable: true },
  user: { disableModelInvocation: true, userInvocable: true },
  model: { disableModelInvocation: false, userInvocable: false },
  off: { disableModelInvocation: true, userInvocable: false },
}

/**
 * The tier matching a skill's own frontmatter visibility booleans — the
 * inverse of TIER_OVERWRITE. A skill authored with `disable-model-invocation:
 * true` MEANS "user-invocable only"; reusing it should default to that tier
 * instead of blanket "all", so adoption preserves the author's intent until
 * the user explicitly overrides it.
 */
export function suggestTier(disableModelInvocation: boolean, userInvocable: boolean): ReuseTier {
  if (disableModelInvocation && userInvocable) return "user"
  if (userInvocable) return "all"
  return disableModelInvocation ? "off" : "model"
}

/** suggestTier over a raw SKILL.md: unparseable frontmatter degrades to "all". */
function suggestTierFromSkill(raw: string): ReuseTier {
  const parsed = parseSkillFile(raw, "candidate", "candidate", "global")
  return parsed !== undefined ? suggestTier(parsed.disableModelInvocation, parsed.userInvocable) : "all"
}

/**
 * Apply reuse tiers to a merged scan result. Later scopes win (project over
 * global, matching the directory override direction). Matching is by
 * realpath of the skill directory against the record's target, so the tier
 * follows the linked content: an owned skill that merely shares the name is
 * left alone. The record's plugin attribution (when the reused skill was
 * bundled in an installed plugin) rides along on the scan record so every
 * surface listing the skill can say where it came from.
 */
export function applyReuseTiers(skills: SkillRecord[], scopes: LinksFile[]): SkillRecord[] {
  if (scopes.every((f) => f.links.length === 0)) return skills
  const real = (p: string): string | undefined => {
    try {
      return realpathSync(p)
    } catch {
      return undefined
    }
  }
  return skills.map((s) => {
    const dir = real(s.dir)
    if (dir === undefined) return s
    for (let i = scopes.length - 1; i >= 0; i--) {
      const hit = scopes[i]!.links.find((l) => real(l.target) === dir)
      if (hit !== undefined) return { ...s, ...TIER_OVERWRITE[hit.tier], plugin: hit.plugin }
    }
    return s
  })
}

export type LinkOpResult = { ok: true } | { ok: false; error: string }

/**
 * Create a reuse symlink plus its sidecar record. The link name must be a
 * legal skill directory name; the target must be an existing directory with
 * a SKILL.md. A name already taken inside the scope by different content
 * (realpath mismatch) is a conflict — the caller surfaces it as 409; the
 * same content under the same name is also refused (already reused).
 * Missing scope directories are created recursively.
 *
 * tier omitted → derived from the target's own frontmatter visibility
 * fields (suggestTier): reusing a skill preserves the author's visibility
 * intent unless the caller (user) explicitly picks a tier.
 */
export function createSkillLink(opts: { skillsDir: string; name: string; target: string; agent: ReuseAgent; tier?: ReuseTier; plugin?: string }): LinkOpResult {
  const { skillsDir, name, target, agent, plugin } = opts
  if (!isSkillDirName(name)) return { ok: false, error: "invalid skill name" }
  const linkPath = join(skillsDir, name)
  let realTarget: string
  let tier: ReuseTier
  try {
    realTarget = realpathSync(target)
    if (!statSync(realTarget).isDirectory()) return { ok: false, error: "target is not a directory" }
    const skillFile = join(realTarget, "SKILL.md")
    if (!statSync(skillFile).isFile()) return { ok: false, error: "target has no SKILL.md" }
    tier = opts.tier ?? suggestTierFromSkill(readFileSync(skillFile, "utf8"))
  } catch {
    return { ok: false, error: "target is not a readable skill directory" }
  }
  try {
    if (lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === realTarget) {
      return { ok: false, error: "already reused under this name" }
    }
    return { ok: false, error: "name already taken by a different skill" }
  } catch {
    // linkPath does not exist — the free case, fall through to creation.
  }
  const file = readLinksFile(skillsDir)
  try {
    // First reuse into a project creates the missing scope directory.
    mkdirSync(skillsDir, { recursive: true })
    symlinkSync(realTarget, linkPath)
  } catch (e) {
    return { ok: false, error: `symlink failed: ${String(e)}` }
  }
  writeLinksFile(skillsDir, {
    ...file,
    links: [...file.links, plugin !== undefined ? { name, target: realTarget, agent, tier, plugin } : { name, target: realTarget, agent, tier }],
  })
  return { ok: true }
}

/**
 * Remove a reuse link and its sidecar record. Only a genuine symlink at the
 * link path is unlinked — if the name is occupied by a real directory (hand
 * placed after the fact), the record is cleared but nothing on disk is
 * touched.
 */
export function removeSkillLink(opts: { skillsDir: string; name: string }): LinkOpResult {
  const { skillsDir, name } = opts
  if (!isSkillDirName(name)) return { ok: false, error: "invalid skill name" }
  const file = readLinksFile(skillsDir)
  const kept = file.links.filter((l) => l.name !== name)
  if (kept.length === file.links.length) return { ok: false, error: "no such link record" }
  const linkPath = join(skillsDir, name)
  try {
    if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath)
  } catch {
    // Link already gone — clearing the record is still the right outcome.
  }
  writeLinksFile(skillsDir, { ...file, links: kept })
  return { ok: true }
}

/** Update one link record's visibility tier. */
export function setSkillLinkTier(opts: { skillsDir: string; name: string; tier: ReuseTier }): LinkOpResult {
  const { skillsDir, name, tier } = opts
  if (!isSkillDirName(name)) return { ok: false, error: "invalid skill name" }
  const file = readLinksFile(skillsDir)
  if (!file.links.some((l) => l.name === name)) return { ok: false, error: "no such link record" }
  writeLinksFile(skillsDir, { ...file, links: file.links.map((l) => (l.name === name ? { ...l, tier } : l)) })
  return { ok: true }
}

export function addDiscoverySource(opts: { skillsDir: string; dir: string }): LinkOpResult {
  if (!opts.dir.trim().startsWith("/")) return { ok: false, error: "source must be an absolute path" }
  const file = readLinksFile(opts.skillsDir)
  if (file.extraSources.includes(opts.dir)) return { ok: false, error: "source already registered" }
  writeLinksFile(opts.skillsDir, { ...file, extraSources: [...file.extraSources, opts.dir] })
  return { ok: true }
}

export function removeDiscoverySource(opts: { skillsDir: string; dir: string }): LinkOpResult {
  const file = readLinksFile(opts.skillsDir)
  if (!file.extraSources.includes(opts.dir)) return { ok: false, error: "no such source" }
  writeLinksFile(opts.skillsDir, { ...file, extraSources: file.extraSources.filter((s) => s !== opts.dir) })
  return { ok: true }
}
