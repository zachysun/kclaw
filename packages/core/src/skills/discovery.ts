/**
 * Discovery: scan other coding agents' user-level skill directories AND
 * their installed plugins' bundled skills, then list what can be reused.
 * Directory sources are the four built-in convention directories plus the
 * scope's manually registered extraSources; plugin sources come from each
 * agent's installed_plugins.json (installPath = the currently installed
 * version). Candidates resolving to the same real directory through chained
 * symlinks (e.g. .zcode → .claude → .cc-switch) are deduplicated by
 * realpath with merged origin labels; the same plugin installed under two
 * agents is deduplicated by plugin name + in-plugin path (the two caches
 * hold distinct copies of the same content).
 *
 * Every failure is surfaced as state, not an error: a missing source
 * directory, a dangling candidate, or a stale link each marks the affected
 * entry and leaves the rest of the listing intact.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isSkillDirName, parseSkillFile, type SkillRecord } from "./index.js"
import { readLinksFile, suggestTier, writeLinksFile, type LinksFile } from "./links.js"

export const BUILTIN_SOURCES: ReadonlyArray<{ agent: "claude" | "codex" | "dsh" | "zcode"; dir: string }> = [
  { agent: "claude", dir: join(homedir(), ".claude", "skills") },
  { agent: "codex", dir: join(homedir(), ".codex", "skills") },
  { agent: "dsh", dir: join(homedir(), ".dsh", "skills") },
  { agent: "zcode", dir: join(homedir(), ".zcode", "skills") },
]

/** Agent homes whose installed plugins contribute bundled skills. zCode's
 * plugin system lives under ~/.zcode/cli (one level deeper than Claude's). */
export const PLUGIN_HOMES: ReadonlyArray<{ agent: "claude" | "zcode"; home: string }> = [
  { agent: "claude", home: join(homedir(), ".claude") },
  { agent: "zcode", home: join(homedir(), ".zcode", "cli") },
]

export interface InstalledPluginRef {
  /** Which agent's plugin system installed it. */
  agent: string
  name: string
  /** Absolute path of the installed (current) version's root directory. */
  installPath: string
}

/**
 * Parse an agent's installed_plugins.json. Two shapes exist in the wild:
 * zCode holds a flat array ({plugins: [{name, installPath}]}); Claude holds
 * a map keyed by "<plugin>@<marketplace>" whose values are per-project
 * install entries WITHOUT a name field — the name comes from the key, and
 * same-path entries (one per project) collapse. A missing or corrupt file
 * means no plugin skills — the inventory is advisory, never an error.
 */
export function readInstalledPlugins(agentHome: string, agent: string): InstalledPluginRef[] {
  const file = join(agentHome, "plugins", "installed_plugins.json")
  if (!existsSync(file)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return []
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return []
  const pluginsField = (raw as { plugins?: unknown }).plugins
  const out: InstalledPluginRef[] = []
  const push = (name: unknown, installPath: unknown): void => {
    if (typeof name !== "string" || name === "" || typeof installPath !== "string" || installPath === "") return
    if (!existsSync(installPath)) return
    if (out.some((p) => p.name === name && p.installPath === installPath)) return
    out.push({ agent, name, installPath })
  }
  if (Array.isArray(pluginsField)) {
    for (const p of pluginsField) {
      if (p === null || typeof p !== "object") continue
      push((p as { name?: unknown }).name, (p as { installPath?: unknown }).installPath)
    }
    return out
  }
  if (typeof pluginsField === "object" && pluginsField !== null) {
    for (const [key, entries] of Object.entries(pluginsField as Record<string, unknown>)) {
      const name = key.includes("@") ? key.slice(0, key.indexOf("@")) : key
      if (!Array.isArray(entries)) continue
      for (const e of entries) {
        if (e === null || typeof e !== "object") continue
        push(name, (e as { installPath?: unknown }).installPath)
      }
    }
  }
  return out
}

export interface DiscoveredSkill {
  /** Directory name of the candidate (the would-be link name). */
  name: string
  displayName: string
  description: string
  /** Realpath of the candidate skill directory. */
  target: string
  /** Merged origin labels, e.g. ["claude", "zcode"]. */
  sources: string[]
  /** Set when the candidate is a skill bundled in an installed plugin. */
  plugin?: string
  /** The tier matching the skill's own frontmatter visibility fields — the
   * default for the reuse link's tier, preserving the author's intent. */
  suggestedTier: "all" | "user" | "model" | "off"
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
  /** Set when the candidate is bundled in an installed plugin. */
  plugin?: string
  /** Skill directory path relative to the plugin root (dedup key part). */
  relPath?: string
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

/** True when dir holds a SKILL.md file. */
function hasSkillMd(dir: string): boolean {
  try {
    return statSync(join(dir, "SKILL.md")).isFile()
  } catch {
    return false
  }
}

/**
 * Enumerate one installed plugin's bundled skills: installPath/skills holds
 * either <name>/SKILL.md directly or a <category>/<name>/SKILL.md grouping
 * level (two levels is the ecosystem's shape; deeper nesting is not
 * descended into). Names must be legal skill directory names.
 */
function candidatesOfPlugin(plugin: InstalledPluginRef): Candidate[] {
  const skillsRoot = join(plugin.installPath, "skills")
  if (!existsSync(skillsRoot)) return []
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Candidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const level1 = join(skillsRoot, entry.name)
    if (isSkillDirName(entry.name) && hasSkillMd(level1)) {
      try {
        out.push({ name: entry.name, target: realpathSync(level1), sources: [plugin.agent], plugin: plugin.name, relPath: entry.name })
      } catch {
        continue
      }
      continue
    }
    // Grouping level (e.g. engineering/): descend one more layer.
    let sub: import("node:fs").Dirent[]
    try {
      sub = readdirSync(level1, { withFileTypes: true })
    } catch {
      continue
    }
    for (const inner of sub) {
      if (!inner.isDirectory() || !isSkillDirName(inner.name)) continue
      const level2 = join(level1, inner.name)
      if (!hasSkillMd(level2)) continue
      try {
        out.push({ name: inner.name, target: realpathSync(level2), sources: [plugin.agent], plugin: plugin.name, relPath: `${entry.name}/${inner.name}` })
      } catch {
        continue
      }
    }
  }
  return out
}

/** All installed plugins across the contributing agent homes. */
function installedPlugins(homes: ReadonlyArray<{ agent: string; home: string }>): InstalledPluginRef[] {
  return homes.flatMap((h) => readInstalledPlugins(h.home, h.agent))
}

/**
 * Backfill missing plugin attribution on reuse links: a record created
 * before attribution existed (or without it) whose target resolves to a
 * currently-installed plugin skill gets the plugin name written in. Idempotent
 * and best-effort — returns how many records were patched.
 */
export function backfillPluginAttribution(opts: {
  skillsDir: string
  pluginHomes?: ReadonlyArray<{ agent: string; home: string }>
}): number {
  const file = readLinksFile(opts.skillsDir)
  const missing = file.links.filter((l) => l.plugin === undefined)
  if (missing.length === 0) return 0
  const pluginOfTarget = new Map<string, string>()
  for (const plugin of installedPlugins(opts.pluginHomes ?? PLUGIN_HOMES)) {
    for (const cand of candidatesOfPlugin(plugin)) pluginOfTarget.set(cand.target!, plugin.name)
  }
  if (pluginOfTarget.size === 0) return 0
  let patched = 0
  const links = file.links.map((l) => {
    if (l.plugin !== undefined) return l
    let real: string | undefined
    try {
      real = realpathSync(l.target)
    } catch {
      return l
    }
    const plugin = pluginOfTarget.get(real)
    if (plugin === undefined) return l
    patched += 1
    return { ...l, plugin }
  })
  if (patched > 0) writeLinksFile(opts.skillsDir, { ...file, links })
  return patched
}

/**
 * Realpath targets currently offered by discovery (directory candidates and
 * plugin candidates, dangling excluded) — the "current versions" set used
 * to mark a reuse link as outdated after its plugin moved to a new version
 * directory.
 */
export function discoveredTargetPaths(opts: {
  skillsDir: string
  builtin?: ReadonlyArray<{ agent: string; dir: string }>
  pluginHomes?: ReadonlyArray<{ agent: string; home: string }>
}): Set<string> {
  const targets = new Set<string>()
  for (const source of resolveDiscoverySources(opts.skillsDir, opts.builtin)) {
    for (const cand of candidatesOfSource(source)) {
      if (cand.target !== undefined) targets.add(cand.target)
    }
  }
  for (const plugin of installedPlugins(opts.pluginHomes ?? PLUGIN_HOMES)) {
    for (const cand of candidatesOfPlugin(plugin)) targets.add(cand.target!)
  }
  return targets
}

/**
 * Discover reusable skills for a scope. `owned` is the merged skill scan of
 * that scope (global + project): a candidate conflicts when an owned skill
 * holds the same name over different content — same content means it is the
 * skill already reused under that name. Directory candidates dedup by
 * realpath; plugin candidates dedup by plugin name + in-plugin path (two
 * agents' caches hold distinct copies of the same content, and a same-named
 * user-level skill is genuinely different content worth its own row).
 */
export function discoverSkills(opts: {
  skillsDir: string
  owned: SkillRecord[]
  builtin?: ReadonlyArray<{ agent: string; dir: string }>
  pluginHomes?: ReadonlyArray<{ agent: string; home: string }>
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

  const byKey = new Map<string, Candidate>()
  const stale: Candidate[] = []
  const merge = (key: string, cand: Candidate): void => {
    const hit = byKey.get(key)
    if (hit === undefined) byKey.set(key, cand)
    else if (!hit.sources.includes(cand.sources[0]!)) hit.sources.push(cand.sources[0]!)
  }
  for (const source of resolveDiscoverySources(opts.skillsDir, opts.builtin)) {
    for (const cand of candidatesOfSource(source)) {
      if (cand.target === undefined) {
        stale.push(cand)
        continue
      }
      merge(`dir:${cand.target}`, { ...cand })
    }
  }
  for (const plugin of installedPlugins(opts.pluginHomes ?? PLUGIN_HOMES)) {
    for (const cand of candidatesOfPlugin(plugin)) merge(`plugin:${cand.plugin}/${cand.relPath}`, cand)
  }

  const found: DiscoveredSkill[] = []
  for (const cand of byKey.values()) {
    const parsed = parseSkillFile(readOrEmpty(join(cand.target!, "SKILL.md")), cand.name, cand.target!, "global")
    const ownedReal = realOwned.get(cand.name)
    found.push({
      name: cand.name,
      displayName: parsed?.displayName ?? cand.name,
      description: parsed?.description ?? "",
      target: cand.target!,
      sources: cand.sources,
      plugin: cand.plugin,
      suggestedTier: parsed !== undefined ? suggestTier(parsed.disableModelInvocation, parsed.userInvocable) : "all",
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
      suggestedTier: "all",
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
  pluginHomes?: ReadonlyArray<{ agent: string; home: string }>
}): { ok: true; body: string; name: string } | { ok: false; error: string } {
  let real: string
  try {
    real = realpathSync(opts.path)
  } catch {
    return { ok: false, error: "path not found" }
  }
  const sources = resolveDiscoverySources(opts.skillsDir, opts.builtin)
  const known = discoverSkills({ skillsDir: opts.skillsDir, owned: [], builtin: opts.builtin, pluginHomes: opts.pluginHomes })
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
