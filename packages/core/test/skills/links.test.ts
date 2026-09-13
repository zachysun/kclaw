import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { applyReuseTiers, createSkillLink, readLinksFile, removeSkillLink, scanSkillDirs, setSkillLinkTier, suggestTier, writeLinksFile } from "../../src/skills/index.js"

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kclaw-links-"))
  cleanups.push(root)
  return root
}

function makeSkill(dir: string, name: string, opts: { description?: string; frontmatter?: string } = {}): string {
  mkdirSync(join(dir, name), { recursive: true })
  const fm = opts.frontmatter ?? `description: ${opts.description ?? name}`
  writeFileSync(join(dir, name, "SKILL.md"), `---\n${fm}\n---\n\n正文\n`)
  return join(dir, name)
}

describe("links file", () => {
  it("missing and corrupt files degrade to empty without throwing", () => {
    const root = tempRoot()
    expect(readLinksFile(root)).toEqual({ links: [], extraSources: [] })
    writeFileSync(join(root, ".links.json"), "{not json")
    expect(readLinksFile(root)).toEqual({ links: [], extraSources: [] })
    writeFileSync(join(root, ".links.json"), '{"links":[{"name":"BAD_NAME","target":"/x","agent":"claude","tier":"all"}],"extraSources":["/ok"]}')
    // 非法条目（目录名不合法）被丢弃，extraSources 保留
    expect(readLinksFile(root)).toEqual({ links: [], extraSources: ["/ok"] })
  })

  it("round-trips records and rejects unknown agent/tier shapes", () => {
    const root = tempRoot()
    const file = { links: [{ name: "pdf", target: "/tmp/x", agent: "claude" as const, tier: "all" as const }], extraSources: ["/tmp/src"] }
    writeLinksFile(root, file)
    expect(readLinksFile(root)).toEqual(file)
    expect(lstatSync(join(root, ".links.json")).mode & 0o777).toBe(0o600)
    writeLinksFile(root, { links: [{ name: "pdf", target: "/tmp/x", agent: "nonsense" as never, tier: "all" }], extraSources: [] })
    expect(readLinksFile(root).links).toEqual([])
  })
})

describe("createSkillLink / removeSkillLink / setSkillLinkTier", () => {
  it("creates a symlink plus a record, refuses name conflicts, and removes both on cancel", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    const external = makeSkill(root, "pdf", { description: "外部 pdf" })
    mkdirSync(skillsDir, { recursive: true })

    const created = createSkillLink({ skillsDir, name: "pdf", target: external, agent: "claude", tier: "all" })
    expect(created).toEqual({ ok: true })
    expect(lstatSync(join(skillsDir, "pdf")).isSymbolicLink()).toBe(true)
    // 记录里的 target 是 realpath 归一后的路径（macOS 上 /var → /private/var）
    expect(readLinksFile(skillsDir).links).toEqual([{ name: "pdf", target: realpathSync(external), agent: "claude", tier: "all" }])

    // 同名同内容 → 已复用；同名不同内容 → 冲突
    expect(createSkillLink({ skillsDir, name: "pdf", target: external, agent: "claude", tier: "all" })).toMatchObject({ ok: false })
    const other = makeSkill(root, "other", {})
    expect(createSkillLink({ skillsDir, name: "pdf", target: other, agent: "claude", tier: "all" })).toMatchObject({ ok: false, error: "name already taken by a different skill" })

    // 目标无 SKILL.md / 不存在
    const bare = join(root, "bare")
    mkdirSync(bare, { recursive: true })
    expect(createSkillLink({ skillsDir, name: "no-skill-md", target: bare, agent: "claude", tier: "all" })).toMatchObject({ ok: false })
    expect(createSkillLink({ skillsDir, name: "missing", target: join(root, "nowhere"), agent: "claude", tier: "all" })).toMatchObject({ ok: false })

    // 取消复用：链接与记录一起消失
    expect(removeSkillLink({ skillsDir, name: "pdf" })).toEqual({ ok: true })
    expect(existsSync(join(skillsDir, "pdf"))).toBe(false)
    expect(readLinksFile(skillsDir).links).toEqual([])
    expect(removeSkillLink({ skillsDir, name: "pdf" })).toMatchObject({ ok: false })
  })

  it("never unlinks a real directory that took the name; creating into a missing scope dir recurses", () => {
    const root = tempRoot()
    const skillsDir = join(root, "nested", "skills") // 不存在，应自动递归创建
    const external = makeSkill(root, "pdf", {})
    expect(createSkillLink({ skillsDir, name: "pdf", target: external, agent: "zcode", tier: "off" })).toEqual({ ok: true })
    expect(existsSync(join(skillsDir, "pdf"))).toBe(true)

    // 链接删掉后有人放了同名真实目录：remove 只清记录、不动磁盘
    removeSkillLink({ skillsDir, name: "pdf" })
    mkdirSync(join(skillsDir, "pdf"), { recursive: true })
    createSkillLink({ skillsDir, name: "pdf", target: external, agent: "zcode", tier: "off" })
    expect(createSkillLink({ skillsDir, name: "pdf", target: external, agent: "zcode", tier: "off" })).toMatchObject({ ok: false })
    removeSkillLink({ skillsDir, name: "pdf" })
    expect(existsSync(join(skillsDir, "pdf"))).toBe(true) // 真实目录还在
    expect(readLinksFile(skillsDir).links).toEqual([])
  })

  it("setSkillLinkTier updates only the named record", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    const a = makeSkill(root, "alpha-skill", {})
    const b = makeSkill(root, "beta-skill", {})
    mkdirSync(skillsDir, { recursive: true })
    createSkillLink({ skillsDir, name: "alpha-skill", target: a, agent: "dsh", tier: "all" })
    createSkillLink({ skillsDir, name: "beta-skill", target: b, agent: "dsh", tier: "all" })
    expect(setSkillLinkTier({ skillsDir, name: "alpha-skill", tier: "model" })).toEqual({ ok: true })
    expect(readLinksFile(skillsDir).links.map((l) => [l.name, l.tier])).toEqual([["alpha-skill", "model"], ["beta-skill", "all"]])
    expect(setSkillLinkTier({ skillsDir, name: "gamma-skill", tier: "all" })).toMatchObject({ ok: false })
  })
})

describe("applyReuseTiers", () => {
  it("overwrites the two booleans by realpath match; owned skills sharing only a name are untouched", () => {
    const root = tempRoot()
    const globalDir = join(root, "global")
    const external = makeSkill(root, "pdf", { frontmatter: "description: 外部" })
    mkdirSync(globalDir, { recursive: true })
    symlinkSync(external, join(globalDir, "pdf"))
    const owned = makeSkill(globalDir, "commit-helper", { frontmatter: "description: 自有" })
    const skills = scanSkillDirs({ global: globalDir })
    expect(skills).toHaveLength(2)

    const links = { links: [{ name: "pdf", target: external, agent: "claude" as const, tier: "user" as const }], extraSources: [] }
    const result = applyReuseTiers(skills, [links])
    const pdf = result.find((s) => s.name === "pdf")!
    expect(pdf.disableModelInvocation).toBe(true)
    expect(pdf.userInvocable).toBe(true)
    const owned2 = result.find((s) => s.name === "commit-helper")!
    // 同名不同内容不受影响——但这里名字不同，专门验一下自有技能原样
    expect(owned2.dir).toBe(owned)
    expect(owned2.disableModelInvocation).toBe(false)

    // 四档语义
    const expectTier = (tier: "all" | "user" | "model" | "off", dm: boolean, ui: boolean) => {
      const r = applyReuseTiers(skills, [{ links: [{ name: "pdf", target: external, agent: "claude", tier }], extraSources: [] }])
      const s = r.find((x) => x.name === "pdf")!
      expect([s.disableModelInvocation, s.userInvocable]).toEqual([dm, ui])
    }
    expectTier("all", false, true)
    expectTier("user", true, true)
    expectTier("model", false, false)
    expectTier("off", true, false)
  })

  it("later scopes win (project over global) and empty scopes are a no-op", () => {
    const root = tempRoot()
    const globalDir = join(root, "global")
    const external = makeSkill(root, "pdf", {})
    mkdirSync(globalDir, { recursive: true })
    symlinkSync(external, join(globalDir, "pdf"))
    const skills = scanSkillDirs({ global: globalDir })

    const globalLinks = { links: [{ name: "pdf", target: external, agent: "claude" as const, tier: "all" as const }], extraSources: [] }
    const projectLinks = { links: [{ name: "pdf", target: external, agent: "claude" as const, tier: "off" as const }], extraSources: [] }
    expect(applyReuseTiers(skills, [globalLinks, projectLinks])[0]!.userInvocable).toBe(false)
    expect(applyReuseTiers(skills, [globalLinks])[0]!.userInvocable).toBe(true)
    expect(applyReuseTiers(skills, [])).toEqual(skills)
  })

  it("reads tier state through the scan used by the server route (real file on disk)", () => {
    const root = tempRoot()
    const globalDir = join(root, "global")
    const external = makeSkill(root, "pdf", {})
    mkdirSync(globalDir, { recursive: true })
    symlinkSync(external, join(globalDir, "pdf"))
    writeLinksFile(globalDir, { links: [{ name: "pdf", target: external, agent: "claude", tier: "off" }], extraSources: [] })
    const skills = applyReuseTiers(scanSkillDirs({ global: globalDir }), [readLinksFile(globalDir)])
    expect(skills.find((s) => s.name === "pdf")?.userInvocable).toBe(false)
    expect(readFileSync(join(globalDir, ".links.json"), "utf8")).toContain('"tier": "off"')
  })

  it("carries plugin attribution: create with plugin → record → scan record surfaces it", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    const external = makeSkill(root, "tdd", {})
    expect(createSkillLink({ skillsDir, name: "tdd", target: external, agent: "zcode", tier: "all", plugin: "superpowers" })).toEqual({ ok: true })
    const links = readLinksFile(skillsDir)
    expect(links.links[0]).toMatchObject({ name: "tdd", plugin: "superpowers" })
    // 旧格式记录（无 plugin 字段）照常读取，plugin 为 undefined
    writeLinksFile(skillsDir, { links: [{ name: "tdd", target: external, agent: "zcode", tier: "all" }], extraSources: [] })
    const legacy = applyReuseTiers(scanSkillDirs({ global: skillsDir }), [readLinksFile(skillsDir)])
    expect(legacy.find((s) => s.name === "tdd")?.plugin).toBeUndefined()
    // 新记录的归属随 realpath 匹配落到扫描结果上，自有技能不受影响
    writeLinksFile(skillsDir, { links: [{ name: "tdd", target: external, agent: "zcode", tier: "all", plugin: "superpowers" }], extraSources: [] })
    const owned = makeSkill(skillsDir, "commit-helper", {})
    const skills = applyReuseTiers(scanSkillDirs({ global: skillsDir }), [readLinksFile(skillsDir)])
    expect(skills.find((s) => s.name === "tdd")?.plugin).toBe("superpowers")
    expect(skills.find((s) => s.name === "commit-helper")?.dir).toBe(owned)
    expect(skills.find((s) => s.name === "commit-helper")?.plugin).toBeUndefined()
    void owned
  })
})

describe("suggestTier", () => {
  it("maps the frontmatter visibility booleans to the matching tier (inverse of the overwrite)", () => {
    expect(suggestTier(false, true)).toBe("all")
    expect(suggestTier(true, true)).toBe("user")
    expect(suggestTier(false, false)).toBe("model")
    expect(suggestTier(true, false)).toBe("off")
  })
})

describe("createSkillLink tier derivation", () => {
  it("tier omitted → derived from the target's own frontmatter; explicit tier wins", () => {
    const root = tempRoot()
    const skillsDir = join(root, "skills")
    const userOnly = makeSkill(root, "user-only", { frontmatter: "description: 仅用户\ndisable-model-invocation: true" })
    expect(createSkillLink({ skillsDir, name: "user-only", target: userOnly, agent: "zcode", tier: undefined as never })).toEqual({ ok: true })
    expect(readLinksFile(skillsDir).links.find((l) => l.name === "user-only")?.tier).toBe("user")
    const explicit = makeSkill(root, "explicit", { frontmatter: "description: 仅用户\ndisable-model-invocation: true" })
    expect(createSkillLink({ skillsDir, name: "explicit", target: explicit, agent: "zcode", tier: "all" })).toEqual({ ok: true })
    expect(readLinksFile(skillsDir).links.find((l) => l.name === "explicit")?.tier).toBe("all")
  })
})
