import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BUILTIN_SOURCES, createSkillLink, discoveredTargetPaths, discoverSkills, previewSkillBody, readInstalledPlugins, resolveDiscoverySources, scanSkillDirs, writeLinksFile } from "../../src/skills/index.js"

const NO_BUILTIN: ReadonlyArray<{ agent: string; dir: string }> = []
const NO_PLUGIN: ReadonlyArray<{ agent: string; home: string }> = []

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kclaw-discovery-"))
  cleanups.push(root)
  return root
}

function makeSkill(dir: string, name: string, opts: { description?: string; frontmatter?: string } = {}): string {
  mkdirSync(join(dir, name), { recursive: true })
  const fm = opts.frontmatter ?? `description: ${opts.description ?? name}`
  writeFileSync(join(dir, name, "SKILL.md"), `---\n${fm}\n---\n\n${name} 正文\n`)
  return join(dir, name)
}

describe("resolveDiscoverySources", () => {
  it("builtin convention list covers the four agents in fixed order", () => {
    expect(BUILTIN_SOURCES.map((s) => s.agent)).toEqual(["claude", "codex", "dsh", "zcode"])
  })

  it("lists builtins plus extraSources, marking missing directories stale", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    mkdirSync(skillsDir, { recursive: true })
    writeLinksFile(skillsDir, { links: [], extraSources: [join(root, "extra-skills")] })
    const sources = resolveDiscoverySources(skillsDir, NO_BUILTIN)
    expect(sources.map((s) => s.agent)).toEqual(["custom"])
    expect(sources[0]).toMatchObject({ stale: true, dir: join(root, "extra-skills") })
  })
})

describe("discoverSkills", () => {
  it("dedupes chained symlinks by realpath and merges origins", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    const real = makeSkill(root, "real-docs", { description: "真实目录" })
    const agentA = join(root, "agent-a-skills")
    const agentB = join(root, "agent-b-skills")
    mkdirSync(agentA, { recursive: true })
    mkdirSync(agentB, { recursive: true })
    symlinkSync(real, join(agentA, "docs"))
    // 连锁：B 指向 A 的链接（两跳软链接）
    symlinkSync(join(agentA, "docs"), join(agentB, "docs"))
    writeLinksFile(skillsDir, { links: [], extraSources: [agentA, agentB] })

    const found = discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })
    expect(found).toHaveLength(1)
    // 记录里的 target 一律 realpath 归一（macOS 上 /var → /private/var）
    expect(found[0]).toMatchObject({ name: "docs", displayName: "docs", description: "真实目录", target: realpathSync(real), sources: ["custom"], reused: false, conflict: false, stale: false })
  })

  it("marks reused by realpath across scopes, and conflicts only on same-name-different-content", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    const external = makeSkill(root, "pdf-real", { description: "外部" })
    const source = join(root, "agent-skills")
    mkdirSync(source, { recursive: true })
    symlinkSync(external, join(source, "pdf"))
    writeLinksFile(skillsDir, { links: [], extraSources: [source] })

    // 已把同一内容复用为别的名字（真实语义：记录就在全局 skillsDir 的
    // .links.json 里）→ reused=true、不冲突
    createSkillLink({ skillsDir, name: "pdf-manual", target: external, agent: "claude", tier: "all" })
    const owned = scanSkillDirs({ global: skillsDir })
    let found = discoverSkills({ skillsDir, owned, builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })
    expect(found[0]).toMatchObject({ reused: true, conflict: false })

    // 另有同名但内容不同的自有技能 → 冲突；同一份内容已被复用（reused）
    // 与名字撞上自有技能（conflict）两个状态可以同时成立
    const rival = makeSkill(join(root, "owned"), "pdf", { description: "自有版" })
    void rival
    const ownedRival = scanSkillDirs({ global: join(root, "owned") })
    found = discoverSkills({ skillsDir, owned: ownedRival, builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })
    expect(found[0]).toMatchObject({ name: "pdf", reused: true, conflict: true })
  })

  it("lists dangling candidates as stale and tolerates a missing source", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    const source = join(root, "agent-skills")
    mkdirSync(source, { recursive: true })
    symlinkSync(join(root, "nowhere"), join(source, "ghost"))
    makeSkill(source, "fine-skill", { description: "健在" })
    writeLinksFile(skillsDir, { links: [], extraSources: [source, join(root, "missing-dir")] })

    const found = discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })
    expect(found.map((f) => [f.name, f.stale])).toEqual([["fine-skill", false], ["ghost", true]])
    expect(found.find((f) => f.name === "ghost")).toMatchObject({ target: "", sources: ["custom"] })
  })

  it("ignores dot-directories and directories without SKILL.md", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    const source = join(root, "agent-skills")
    mkdirSync(join(source, ".system"), { recursive: true })
    writeFileSync(join(source, ".system", "SKILL.md"), "---\ndescription: 隐藏\n---\n\n正文\n")
    mkdirSync(join(source, "no-md"), { recursive: true })
    writeLinksFile(skillsDir, { links: [], extraSources: [source] })
    expect(discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })).toEqual([])
  })
})

describe("previewSkillBody", () => {
  it("returns the body for paths under a registered source and refuses everything else", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    mkdirSync(skillsDir, { recursive: true })
    const external = makeSkill(root, "pdf-real", { description: "外部" })
    const source = join(root, "agent-skills")
    mkdirSync(source, { recursive: true })
    symlinkSync(external, join(source, "pdf"))
    writeLinksFile(skillsDir, { links: [], extraSources: [source] })

    // 经软链接路径与经真实路径都能读，返回的是 SKILL.md 正文
    const viaLink = previewSkillBody({ skillsDir, path: join(source, "pdf"), builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })
    expect(viaLink).toMatchObject({ ok: true, name: "pdf-real" })
    if (viaLink.ok) expect(viaLink.body).toContain("正文")
    const viaReal = previewSkillBody({ skillsDir, path: external, builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })
    expect(viaReal).toMatchObject({ ok: true })

    // 越界路径一律拒绝：skillsDir 自身、存在但不在发现集合里的目录、
    // 不存在的路径
    expect(previewSkillBody({ skillsDir, path: skillsDir, builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })).toMatchObject({ ok: false })
    const stranger = join(root, "stranger")
    mkdirSync(stranger, { recursive: true })
    writeFileSync(join(stranger, "SKILL.md"), "---\ndescription: 陌生\n---\n\n正文\n")
    expect(previewSkillBody({ skillsDir, path: stranger, builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })).toMatchObject({ ok: false })
    expect(previewSkillBody({ skillsDir, path: "/etc", builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })).toMatchObject({ ok: false })
    expect(previewSkillBody({ skillsDir, path: join(root, "nowhere"), builtin: NO_BUILTIN, pluginHomes: NO_PLUGIN })).toMatchObject({ ok: false })
  })
})

describe("plugin skills", () => {
  /** Fake one agent's plugin install: inventory file + versioned install tree. */
  function makePlugin(home: string, agent: string, name: string, version: string, skills: Array<[string, string]>, id = name): string {
    const installPath = join(home, "plugins", "cache", `${id}-market`, name, version)
    for (const [rel, description] of skills) {
      mkdirSync(join(installPath, "skills", rel), { recursive: true })
      writeFileSync(join(installPath, "skills", rel, "SKILL.md"), `---\ndescription: ${description}\n---\n\n正文\n`)
    }
    const pluginsDir = join(home, "plugins")
    mkdirSync(pluginsDir, { recursive: true })
    const file = join(pluginsDir, "installed_plugins.json")
    const list = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).plugins as unknown[]) : []
    list.push({ id: `${name}@market`, name, installPath, version })
    writeFileSync(file, JSON.stringify({ version: 1, plugins: list }))
    return installPath
  }

  it("reads the inventory tolerantly: missing and corrupt files yield no plugins", () => {
    const root = tempRoot()
    expect(readInstalledPlugins(join(root, "nope"), "claude")).toEqual([])
    mkdirSync(join(root, "plugins"), { recursive: true })
    writeFileSync(join(root, "plugins", "installed_plugins.json"), "{broken")
    expect(readInstalledPlugins(root, "claude")).toEqual([])
    writeFileSync(join(root, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: [{ name: "x" }, { name: "y", installPath: 5 }, { name: "z", installPath: join(root, "missing") }] }))
    expect(readInstalledPlugins(root, "claude")).toEqual([])
  })

  it("parses the claude map shape: plugin name from the key, per-project entries collapsed", () => {
    const root = tempRoot()
    const install = join(root, "cache", "mkt", "superpowers", "6.3.0")
    mkdirSync(install, { recursive: true })
    mkdirSync(join(root, "plugins"), { recursive: true })
    writeFileSync(
      join(root, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: {
          "superpowers@claude-plugins-official": [
            { scope: "local", projectPath: "/a", installPath: install, version: "6.3.0" },
            { scope: "local", projectPath: "/b", installPath: install, version: "6.3.0" },
          ],
          "context7@claude-plugins-official": [{ scope: "user", projectPath: "-", installPath: join(root, "gone"), version: "0.0.0" }],
        },
      }),
    )
    const refs = readInstalledPlugins(root, "claude")
    expect(refs).toEqual([{ agent: "claude", name: "superpowers", installPath: install }])
  })

  it("enumerates plugin skills at both nesting levels with the plugin label", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    mkdirSync(skillsDir, { recursive: true })
    const home = join(root, "agent-home")
    makePlugin(home, "zcode", "superpowers", "6.3.0", [["tdd", "测试驱动"], ["engineering/grill-me", "拷问"]])
    const homes = [{ agent: "zcode", home }]

    const found = discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN, pluginHomes: homes })
    expect(found.map((f) => [f.name, f.plugin])).toEqual([["grill-me", "superpowers"], ["tdd", "superpowers"]])
    // 分类层技能的 target 指向分类目录下的真实技能目录
    expect(found.find((f) => f.name === "grill-me")!.target).toBe(realpathSync(join(home, "plugins/cache/superpowers-market/superpowers/6.3.0/skills/engineering/grill-me")))
  })

  it("dedupes the same plugin installed under two agents by plugin+path, merging agent labels", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    mkdirSync(skillsDir, { recursive: true })
    const homeA = join(root, "home-a")
    const homeB = join(root, "home-b")
    const pathA = makePlugin(homeA, "claude", "superpowers", "6.3.0", [["tdd", "A 版"]])
    const pathB = makePlugin(homeB, "zcode", "superpowers", "6.3.0", [["tdd", "B 版"]])
    expect(pathA).not.toBe(pathB)
    const found = discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN, pluginHomes: [{ agent: "claude", home: homeA }, { agent: "zcode", home: homeB }] })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ name: "tdd", plugin: "superpowers", sources: ["claude", "zcode"] })
  })

  it("keeps a same-named user-level skill and plugin skill as separate rows over different content", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    const source = join(root, "agent-skills")
    mkdirSync(source, { recursive: true })
    makeSkill(source, "skill-creator", { description: "用户级版本" })
    writeLinksFile(skillsDir, { links: [], extraSources: [source] })
    const home = join(root, "agent-home")
    makePlugin(home, "zcode", "toolkit", "1.0.0", [["skill-creator", "插件版本"]])
    const found = discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN, pluginHomes: [{ agent: "zcode", home }] })
    expect(found).toHaveLength(2)
    expect(found.map((f) => [f.name, f.plugin ?? "dir"]).sort()).toEqual([["skill-creator", "dir"], ["skill-creator", "toolkit"]])
  })

  it("discoveredTargetPaths drives the outdated check: after a plugin bumps versions the old link target drops out", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    mkdirSync(skillsDir, { recursive: true })
    const home = join(root, "agent-home")
    const v1 = makePlugin(home, "zcode", "superpowers", "6.3.0", [["tdd", "旧版"]])
    // 复用的目标是插件里的技能目录（installPath/skills/tdd），不是插件根
    const v1Skill = realpathSync(join(v1, "skills", "tdd"))
    const homes = [{ agent: "zcode", home }]
    createSkillLink({ skillsDir, name: "tdd", target: v1Skill, agent: "zcode", tier: "all" })
    expect(discoveredTargetPaths({ skillsDir, builtin: NO_BUILTIN, pluginHomes: homes }).has(v1Skill)).toBe(true)

    // 升级：inventory 指向新版本目录（旧目录留在磁盘上）
    makePlugin(home, "zcode", "superpowers", "7.0.0", [["tdd", "新版"]], "superpowers")
    writeFileSync(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 1, plugins: [{ id: "superpowers@market", name: "superpowers", installPath: join(home, "plugins/cache/superpowers-market/superpowers/7.0.0"), version: "7.0.0" }] }))
    expect(discoveredTargetPaths({ skillsDir, builtin: NO_BUILTIN, pluginHomes: homes }).has(v1Skill)).toBe(false)
    const found = discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN, pluginHomes: homes })
    expect(found.map((f) => [f.name, f.description])).toEqual([["tdd", "新版"]])
  })
})
