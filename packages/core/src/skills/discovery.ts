/**
 * Discovery: scan other coding agents' user-level skill directories and
 * list what can be reused. Sources are the four built-in convention
 * directories plus the scope's manually registered extraSources; candidates
 * resolving to the same real directory through chained symlinks (e.g.
 * .zcode → .claude → .cc-switch) are deduplicated by realpath with merged
 * origin labels.
 *
 * Every failure is surfaced as state, not an error: a missing source
 * directory, a dangling candidate, or a stale link each marks the affected
 * entry and leaves the rest of the listing intact.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isSkillDirName, parseSkillFile, type SkillRecord } from "./index.js"
import { readLinksFile, type LinksFile } from "./links.js"

export const BUILTIN_SOURCES: ReadonlyArray<{ agent: "claude" | "codex" | "dsh" | "zcode"; dir: string }> = [
  { agent: "claude", dir: join(homedir(), ".claude", "skills") },
  { agent: "codex", dir: join(homedir(), ".codex", "skills") },
  { agent: "dsh", dir: join(homedir(), ".dsh", "skills") },
  { agent: "zcode", dir: join(homedir(), ".zcode", "skills") },
]

export interface DiscoveredSkill {
  /** Directory name of the candidate (the would-be link name). */
  name: string
  displayName: string
  description: string
  /** Realpath of the candidate skill directory. */
  target: string
  /** Merged origin labels, e.g. ["claude", "zcode"]. */
  sources: string[]
  /** A links record (any scope) already points at this real directory. */
  reused: boolean
  /** Set when an owned skill holds the same name over different content. */
  conflict: boolean
  /** The candidate directory is dangling or otherwise unreadable. */
  stale: boolean
}

export interface DiscoverySource {
  agent: string
  dir: string
  /** The directory does not exist (never created, or removed since). */
  stale: boolean
}

/**
 * The effective source list for a scope: the four built-ins plus the
 * extraSources registered in the scope's links file. Missing directories
 * stay in the list marked stale so the page can say so instead of silently
 * dropping them. The built-ins are injectable so tests can run against
 * temp trees instead of the real home directory.
 */
export function resolveDiscoverySources(skillsDir: string, builtin: ReadonlyArray<{ agent: string; dir: string }> = BUILTIN_SOURCES): DiscoverySource[] {
  const extras = readLinksFile(skillsDir).extraSources
  return [
    ...builtin.map((s) => ({ agent: s.agent as string, dir: s.dir })),
    ...extras.map((dir) => ({ agent: "custom", dir })),
  ].map((s) => ({ ...s, stale: !existsSync(s.dir) }))
}

interface Candidate {
  name: string
  target: string | undefined // undefined = dangling
  sources: string[]
}

function candidatesOfSource(source: DiscoverySource): Candidate[] {
  if (source.stale) return []
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(source.dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Candidate[] = []
  for (const entry of entries) {
    const name = entry.name
    if (!isSkillDirName(name)) continue
    const linkPath = join(source.dir, name)
    let target: string | undefined
    try {
      target = realpathSync(linkPath)
      if (!statSync(target).isDirectory()) continue
      if (!statSync(join(target, "SKILL.md")).isFile()) continue
    } catch {
      // A dangling entry under a live source is a stale candidate, not a
      // silent skip — the page should show it so the user can clean up.
      if (entry.isSymbolicLink()) {
        out.push({ name, target: undefined, sources: [source.agent] })
      }
      continue
    }
    out.push({ name, target, sources: [source.agent] })
  }
  return out
}

/**
 * Discover reusable skills for a scope. `owned` is the merged skill scan of
 * that scope (global + project): a candidate conflicts when an owned skill
 * holds the same name over different content — same content means it is the
 * skill already reused under that name. Dedup is by realpath; record order
 * is stable (name, then first-seen source).
 */
export function discoverSkills(opts: {
  skillsDir: string
  owned: SkillRecord[]
  builtin?: ReadonlyArray<{ agent: string; dir: string }>
  /** Links records of further scopes (e.g. project links when anchored at
   * the global scope) — a target reused in ANY scope shows as reused. */
  extraLinksScopes?: LinksFile[]
}): DiscoveredSkill[] {
  const linksScopes: LinksFile[] = [readLinksFile(opts.skillsDir), ...(opts.extraLinksScopes ?? [])]
  const reusedTargets = new Set<string>()
  for (const file of linksScopes) {
    for (const l of file.links) {
      try {
        reusedTargets.add(realpathSync(l.target))
      } catch {
        // Dangling link target: nothing to dedupe against.
      }
    }
  }
  const realOwned = new Map(
    opts.owned.map((s) => {
      try {
        return [s.name, realpathSync(s.dir)] as const
      } catch {
        return [s.name, s.dir] as const
      }
    }),
  )

  const byTarget = new Map<string, Candidate>()
  const stale: Candidate[] = []
  for (const source of resolveDiscoverySources(opts.skillsDir, opts.builtin)) {
    for (const cand of candidatesOfSource(source)) {
      if (cand.target === undefined) {
        stale.push(cand)
        continue
      }
      const hit = byTarget.get(cand.target)
      if (hit === undefined) byTarget.set(cand.target, { ...cand })
      else if (!hit.sources.includes(cand.sources[0]!)) hit.sources.push(cand.sources[0]!)
    }
  }

  const found: DiscoveredSkill[] = []
  for (const cand of byTarget.values()) {
    const parsed = parseSkillFile(readOrEmpty(join(cand.target!, "SKILL.md")), cand.name, cand.target!, "global")
    const ownedReal = realOwned.get(cand.name)
    found.push({
      name: cand.name,
      displayName: parsed?.displayName ?? cand.name,
      description: parsed?.description ?? "",
      target: cand.target!,
      sources: cand.sources,
      reused: reusedTargets.has(cand.target!),
      conflict: ownedReal !== undefined && ownedReal !== cand.target,
      stale: false,
    })
  }
  for (const cand of stale) {
    found.push({
      name: cand.name,
      displayName: cand.name,
      description: "",
      target: "",
      sources: cand.sources,
      reused: false,
      conflict: false,
      stale: true,
    })
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/**
 * Read a candidate's SKILL.md body for preview. `path` must resolve to a
 * real directory that discovery actually found (a candidate target), or sit
 * under a registered source — candidates typically live OUTSIDE the agent
 * directories (those hold only symlinks), so "under a source" alone would
 * reject the very targets the discovery list hands out. The endpoint is
 * token-gated but must not become an arbitrary-file-read primitive regardless.
 */
export function previewSkillBody(opts: {
  skillsDir: string
  path: string
  builtin?: ReadonlyArray<{ agent: string; dir: string }>
}): { ok: true; body: string; name: string } | { ok: false; error: string } {
  let real: string
  try {
    real = realpathSync(opts.path)
  } catch {
    return { ok: false, error: "path not found" }
  }
  const sources = resolveDiscoverySources(opts.skillsDir, opts.builtin)
  const known = discoverSkills({ skillsDir: opts.skillsDir, owned: [], builtin: opts.builtin })
  const knownTargets = new Set(known.map((d) => d.target))
  const underSource = sources.some((s) => {
    if (s.stale) return false
    try {
      const root = realpathSync(s.dir)
      return real === root || real.startsWith(root + "/")
    } catch {
      return false
    }
  })
  if (!underSource && !knownTargets.has(real)) return { ok: false, error: "path is not a discovered skill" }
  const skillFile = real.endsWith("/SKILL.md") ? real : join(real, "SKILL.md")
  const raw = readOrEmpty(skillFile)
  if (raw === "" && !existsSync(skillFile)) return { ok: false, error: "no SKILL.md at path" }
  const parsed = parseSkillFile(raw, real.split("/").pop() ?? "", real, "global")
  return { ok: true, body: parsed?.body ?? raw, name: parsed?.displayName ?? real.split("/").pop() ?? "" }
}
