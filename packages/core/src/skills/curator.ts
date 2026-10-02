/**
 * Skill curator — the lifecycle half of the self-evolving skill loop.
 *
 * skill_create (proposals) handles birth; the curator handles aging. Every
 * skill_read lands a use count in `<skillsDir>/.curator/usage.json`; the
 * idle-time scan (server/src/skill-curator.ts) then moves agent-created
 * global skills through the lifecycle:
 *
 * - idle ≥ staleDays → marked stale in `.curator/state.json` (a marker only —
 *   SKILL.md is never rewritten, so nothing the model sees changes).
 * - idle ≥ archiveDays → the skill directory MOVES into `<skillsDir>/.archive/
 *   <name>-<timestamp>/`. A move, never a delete: restoring is a `mv` back.
 *   `.archive` is dot-ignored by the scanner, so an archived skill instantly
 *   disappears from every listing while its files stay on disk.
 *
 * Eligibility is deliberately narrow: only skills the AGENT created (applied
 * `kind:"new"` proposals in `.proposals/`) qualify. User-authored skills,
 * reuse links (symlink dirs, targets maintained elsewhere), and skills pinned
 * in frontmatter (`pinned: true`) are never touched. All file operations are
 * guarded — a curator failure must never take the daemon down.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { writeFileAtomic } from "../storage/atomic.js"
import { LINKS_FILENAME } from "./links.js"

const CURATOR_DIR = ".curator"
const USAGE_FILENAME = "usage.json"
const STATE_FILENAME = "state.json"
const ARCHIVE_DIRNAME = ".archive"
const DAY_MS = 86_400_000

export interface CuratorConfig {
  enabled: boolean
  staleDays: number
  archiveDays: number
  hour: number
}

export interface SkillUseRecord { count: number; lastUsedAt: string }

export interface CuratorReport {
  /** Skills newly marked stale this sweep. */
  stale: string[]
  /** Skills archived (moved into .archive/) this sweep. */
  archived: string[]
  /** Reuse links removed because their target was archived. */
  linksRemoved: string[]
}

type UsageMap = Record<string, SkillUseRecord>
type StateMap = Record<string, { staleSince?: string }>

/** Telemetry key: scope-qualified so a global and a project skill of the same name don't merge. */
function useKey(origin: "global" | "project", name: string): string {
  return `${origin}:${name}`
}

/**
 * Record one skill use (skill_read). Fire-and-forget best effort: telemetry
 * must never surface as a tool error. Callers pass the workspace's origin as
 * the winning record's origin.
 */
export function recordSkillUse(skillsDir: string, origin: "global" | "project", name: string): void {
  try {
    const usage = readJson<UsageMap>(join(skillsDir, CURATOR_DIR, USAGE_FILENAME)) ?? {}
    const key = useKey(origin, name)
    const prev = usage[key]
    usage[key] = {
      count: (prev?.count ?? 0) + 1,
      lastUsedAt: new Date().toISOString(),
    }
    mkdirSync(join(skillsDir, CURATOR_DIR), { recursive: true })
    writeFileAtomic(join(skillsDir, CURATOR_DIR, USAGE_FILENAME), JSON.stringify(usage, null, 2) + "\n", 0o600)
  } catch {
    // telemetry is never load-bearing
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    const raw = readFileSync(path, "utf8")
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

/** The frontmatter booleans the curator honors, read straight from SKILL.md. */
function frontmatterFlags(skillDir: string): { pinned: boolean; agentCreated: boolean } {
  const out = { pinned: false, agentCreated: false }
  try {
    const raw = readFileSync(join(skillDir, "SKILL.md"), "utf8")
    const lines = raw.replace(/^\uFEFF/, "").split("\n").map((l) => l.replace(/\r$/, ""))
    if (lines[0] !== "---") return out
    const end = lines.indexOf("---", 1)
    if (end === -1) return out
    const fm = parse(lines.slice(1, end).join("\n"))
    if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return out
    const record = fm as Record<string, unknown>
    out.pinned = record["pinned"] === true
    out.agentCreated = record["agent-created"] === true
  } catch {
    // unreadable frontmatter = not agent-created, not pinned (neither matters)
  }
  return out
}

/** Names of skills the agent itself created: applied `kind:"new"` proposals (+ the frontmatter flag). */
function agentCreatedNames(skillsDir: string): Set<string> {
  const names = new Set<string>()
  const proposalsDir = join(skillsDir, ".proposals")
  if (!existsSync(proposalsDir)) return names
  try {
    for (const f of readdirSync(proposalsDir)) {
      if (!f.endsWith(".json")) continue
      const p = readJson<{ status?: string; kind?: string; name?: string }>(join(proposalsDir, f))
      if (p?.status === "applied" && p.kind === "new" && typeof p.name === "string") names.add(p.name)
    }
  } catch {
    // unreadable proposals → no legacy names; the frontmatter flag still applies
  }
  return names
}

/** One idle-time sweep over the global skills directory. */
export function curateGlobalSkills(skillsDir: string, cfg: CuratorConfig, now = new Date()): CuratorReport {
  const report: CuratorReport = { stale: [], archived: [], linksRemoved: [] }
  if (!cfg.enabled || !existsSync(skillsDir)) return report

  const usage = readJson<UsageMap>(join(skillsDir, CURATOR_DIR, USAGE_FILENAME)) ?? {}
  const state = readJson<StateMap>(join(skillsDir, CURATOR_DIR, STATE_FILENAME)) ?? {}
  const agentCreated = agentCreatedNames(skillsDir)
  const archiveRoot = join(skillsDir, ARCHIVE_DIRNAME)
  let stateDirty = false

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const dir = join(skillsDir, entry.name)
    // 复用链接是指向外部源目录的软链接，归属用户维护，curator 永不触碰。
    if (lstatSync(dir).isSymbolicLink()) continue
    const flags = frontmatterFlags(dir)
    const isAgentCreated = flags.agentCreated || agentCreated.has(entry.name)
    if (!isAgentCreated || flags.pinned) continue

    const last = usage[useKey("global", entry.name)]?.lastUsedAt
    const lastMs = last !== undefined ? Date.parse(last) : statSync(dir).mtimeMs
    const idleDays = (now.getTime() - lastMs) / DAY_MS

    if (idleDays >= cfg.archiveDays) {
      try {
        mkdirSync(archiveRoot, { recursive: true })
        const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14)
        renameSync(dir, join(archiveRoot, `${entry.name}-${stamp}`))
        report.archived.push(entry.name)
        if (state[entry.name] !== undefined) {
          delete state[entry.name]
          stateDirty = true
        }
        // 归档后失效的复用链接一并清理（链接目标已不在原位）。
        report.linksRemoved.push(...removeLinksPointingTo(skillsDir, dir))
      } catch (err) {
        console.error(`kclaw skill curator: archive ${entry.name} failed:`, err)
      }
      continue
    }
    if (idleDays >= cfg.staleDays) {
      if (state[entry.name]?.staleSince === undefined) {
        state[entry.name] = { staleSince: now.toISOString() }
        stateDirty = true
      }
      report.stale.push(entry.name)
    } else if (state[entry.name] !== undefined) {
      delete state[entry.name]
      stateDirty = true
    }
  }

  if (stateDirty) {
    try {
      mkdirSync(join(skillsDir, CURATOR_DIR), { recursive: true })
      writeFileAtomic(join(skillsDir, CURATOR_DIR, STATE_FILENAME), JSON.stringify(state, null, 2) + "\n", 0o600)
    } catch (err) {
      console.error("kclaw skill curator: state write failed:", err)
    }
  }
  return report
}

/** Remove reuse links (and their sidecar records) whose target points into the archived skill's former location. */
function removeLinksPointingTo(skillsDir: string, archivedDir: string): string[] {
  const removed: string[] = []
  const linksPath = join(skillsDir, LINKS_FILENAME)
  const book = readJson<{ links?: Array<{ name: string; target: string }> }>(linksPath)
  if (book?.links === undefined || book.links.length === 0) return removed
  const kept = book.links.filter((l) => {
    if (typeof l.name !== "string" || typeof l.target !== "string") return true
    // 归档是整目录移动：目标的旧位置已空。链接目标等于旧位置、或位于其
    // 子路径下，都算失效（按 realpath 归一，容忍符号链前缀差异）。
    let normalized = l.target
    try {
      normalized = realpathSync(l.target)
    } catch {
      // 目标本身已失效：同样按旧位置前缀判断
    }
    const pointsInto = normalized === archivedDir || normalized.startsWith(`${archivedDir}/`)
    if (!pointsInto) return true
    try {
      rmSync(join(skillsDir, l.name), { force: true })
    } catch {
      // best effort: the link is dangling anyway
    }
    removed.push(l.name)
    return false
  })
  if (removed.length > 0) {
    try {
      writeFileAtomic(linksPath, JSON.stringify({ links: kept }, null, 2) + "\n", 0o600)
    } catch {
      // sidecar write failure doesn't undo the archive
    }
  }
  return removed
}
