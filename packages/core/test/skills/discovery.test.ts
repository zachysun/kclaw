import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BUILTIN_SOURCES, createSkillLink, discoverSkills, previewSkillBody, resolveDiscoverySources, scanSkillDirs, writeLinksFile } from "../../src/skills/index.js"

const NO_BUILTIN: ReadonlyArray<{ agent: string; dir: string }> = []

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

    const found = discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN })
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
    let found = discoverSkills({ skillsDir, owned, builtin: NO_BUILTIN })
    expect(found[0]).toMatchObject({ reused: true, conflict: false })

    // 另有同名但内容不同的自有技能 → 冲突；同一份内容已被复用（reused）
    // 与名字撞上自有技能（conflict）两个状态可以同时成立
    const rival = makeSkill(join(root, "owned"), "pdf", { description: "自有版" })
    void rival
    const ownedRival = scanSkillDirs({ global: join(root, "owned") })
    found = discoverSkills({ skillsDir, owned: ownedRival, builtin: NO_BUILTIN })
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

    const found = discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN })
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
    expect(discoverSkills({ skillsDir, owned: [], builtin: NO_BUILTIN })).toEqual([])
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
    const viaLink = previewSkillBody({ skillsDir, path: join(source, "pdf"), builtin: NO_BUILTIN })
    expect(viaLink).toMatchObject({ ok: true, name: "pdf-real" })
    if (viaLink.ok) expect(viaLink.body).toContain("正文")
    const viaReal = previewSkillBody({ skillsDir, path: external, builtin: NO_BUILTIN })
    expect(viaReal).toMatchObject({ ok: true })

    // 越界路径一律拒绝：skillsDir 自身、存在但不在发现集合里的目录、
    // 不存在的路径
    expect(previewSkillBody({ skillsDir, path: skillsDir, builtin: NO_BUILTIN })).toMatchObject({ ok: false })
    const stranger = join(root, "stranger")
    mkdirSync(stranger, { recursive: true })
    writeFileSync(join(stranger, "SKILL.md"), "---\ndescription: 陌生\n---\n\n正文\n")
    expect(previewSkillBody({ skillsDir, path: stranger, builtin: NO_BUILTIN })).toMatchObject({ ok: false })
    expect(previewSkillBody({ skillsDir, path: "/etc", builtin: NO_BUILTIN })).toMatchObject({ ok: false })
    expect(previewSkillBody({ skillsDir, path: join(root, "nowhere"), builtin: NO_BUILTIN })).toMatchObject({ ok: false })
  })
})
