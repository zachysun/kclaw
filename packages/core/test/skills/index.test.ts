import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSkillFile, scanSkillDirs, skillListPrompt } from "../../src/skills/index.js"

const FULL = `---
name: commit-helper
description: 按本仓库的提交信息规范生成提交说明。处理 git commit 相关任务时使用。
when_to_use: 用户要求提交、写 commit message、或提到"提交规范"时。
disable-model-invocation: true
---

# 提交规范

1. 标题一行，祈使语气
2. 正文说明动机
`

describe("parseSkillFile", () => {
  it("parses the five known fields and the body", () => {
    const s = parseSkillFile(FULL, "commit-helper", "/skills/commit-helper", "global")!
    expect(s.name).toBe("commit-helper")
    expect(s.displayName).toBe("commit-helper")
    expect(s.description).toContain("按本仓库的提交信息规范")
    expect(s.description).toContain("用户要求提交")
    expect(s.disableModelInvocation).toBe(true)
    expect(s.userInvocable).toBe(true)
    expect(s.body).toContain("# 提交规范")
    expect(s.origin).toBe("global")
    expect(s.dir).toBe("/skills/commit-helper")
  })
  it("defaults display name to the directory name and booleans to false/true", () => {
    const s = parseSkillFile("---\ndescription: 只写正文规程\n---\n\n第一步……\n", "deploy-flow", "/d", "project")!
    expect(s.displayName).toBe("deploy-flow")
    expect(s.disableModelInvocation).toBe(false)
    expect(s.userInvocable).toBe(true)
    expect(s.origin).toBe("project")
  })
  it("falls back to the first body paragraph when description is missing", () => {
    const s = parseSkillFile("---\n---\n\n首段就是描述。\n\n正文第二段。\n", "minimal", "/d", "global")!
    expect(s.description).toBe("首段就是描述。")
  })
  it("returns undefined when the frontmatter is unparseable YAML", () => {
    expect(parseSkillFile("---\nname: [broken\n---\n\n正文\n", "broken", "/d", "global")).toBeUndefined()
  })
  it("truncates description + when_to_use at 1536 chars", () => {
    const long = "x".repeat(2000)
    const s = parseSkillFile(`---\ndescription: ${long}\n---\n\n正文\n`, "long", "/d", "global")!
    expect(s.description.length).toBeLessThanOrEqual(1536)
    expect(s.description.endsWith("…")).toBe(true)
  })
  it("ignores unknown fields without failing", () => {
    const s = parseSkillFile("---\nallowed-tools: Bash(git:*) Read\nmodel: sonnet\nmetadata:\n  author: someone\n---\n\n正文\n", "compat", "/d", "global")!
    expect(s.description).toBe("正文")
    expect((s as Record<string, unknown>)["model"]).toBeUndefined()
  })
})

describe("scanSkillDirs", () => {
  it("merges global and project skills with project overriding by name", () => {
    const root = mkdtempSync(join(tmpdir(), "kclaw-skills-"))
    try {
      const global = join(root, "global-skills")
      const project = join(root, "project-skills")
      mkdirSync(join(global, "commit-helper"), { recursive: true })
      writeFileSync(join(global, "commit-helper", "SKILL.md"), "---\ndescription: 全局版\n---\n\n全局正文\n")
      mkdirSync(join(global, "tdd-flow"), { recursive: true })
      writeFileSync(join(global, "tdd-flow", "SKILL.md"), "---\ndescription: 测试驱动\n---\n\n正文\n")
      mkdirSync(join(project, "commit-helper"), { recursive: true })
      writeFileSync(join(project, "commit-helper", "SKILL.md"), "---\ndescription: 项目版\n---\n\n项目正文\n")
      mkdirSync(join(project, "deploy-flow"), { recursive: true })
      writeFileSync(join(project, "deploy-flow", "SKILL.md"), "---\ndescription: 部署\n---\n\n正文\n")
      const skills = scanSkillDirs({ global, project })
      expect(skills.map((s) => s.name).sort()).toEqual(["commit-helper", "deploy-flow", "tdd-flow"])
      expect(skills.find((s) => s.name === "commit-helper")?.description).toBe("项目版")
      expect(skills.find((s) => s.name === "tdd-flow")?.origin).toBe("global")
      expect(skills.find((s) => s.name === "deploy-flow")?.origin).toBe("project")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("skips invalid directory names and broken SKILL.md without failing the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "kclaw-skills-"))
    try {
      const global = join(root, "skills")
      mkdirSync(join(global, "Bad_Name"), { recursive: true })
      writeFileSync(join(global, "Bad_Name", "SKILL.md"), "---\ndescription: 名字非法\n---\n\n正文\n")
      mkdirSync(join(global, "broken"), { recursive: true })
      writeFileSync(join(global, "broken", "SKILL.md"), "---\nname: [broken\n---\n\n正文\n")
      mkdirSync(join(global, "fine"), { recursive: true })
      writeFileSync(join(global, "fine", "SKILL.md"), "---\ndescription: 正常\n---\n\n正文\n")
      mkdirSync(join(global, "no-skill-md"), { recursive: true })
      const skills = scanSkillDirs({ global })
      expect(skills.map((s) => s.name)).toEqual(["fine"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("tolerates missing directories", () => {
    expect(scanSkillDirs({ global: "/nonexistent-kclaw-test", project: "/also-nonexistent" })).toEqual([])
  })
  it("a broken symlink entry does not wipe the whole scope; a valid symlinked skill dir loads", () => {
    const root = mkdtempSync(join(tmpdir(), "kclaw-skills-"))
    try {
      const global = join(root, "skills")
      const real = join(root, "real-skill")
      mkdirSync(real, { recursive: true })
      writeFileSync(join(real, "SKILL.md"), "---\ndescription: 链接的技能\n---\n\n正文\n")
      mkdirSync(global, { recursive: true })
      symlinkSync(real, join(global, "linked-skill"))
      symlinkSync(join(root, "nowhere"), join(global, "dangling"))
      mkdirSync(join(global, "fine"), { recursive: true })
      writeFileSync(join(global, "fine", "SKILL.md"), "---\ndescription: 正常\n---\n\n正文\n")
      const skills = scanSkillDirs({ global })
      expect(skills.map((s) => s.name).sort()).toEqual(["fine", "linked-skill"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("parses CRLF frontmatter and strips a leading BOM", () => {
    const crlf = "---\r\ndescription: Windows 写的技能\r\nuser-invocable: false\r\n---\r\n\r\n正文\r\n"
    const s = parseSkillFile(`\uFEFF${crlf}`, "crlf", "/d", "global")!
    expect(s.description).toBe("Windows 写的技能")
    expect(s.userInvocable).toBe(false)
    expect(s.body).toBe("正文")
  })
})

describe("skillListPrompt", () => {
  const mk = (name: string, description: string, disableModelInvocation = false): ReturnType<typeof parseSkillFile> &
    object => parseSkillFile(`---\ndescription: ${description}\n---\n\n正文\n`, name, "/d", "global")!

  it("lists model-visible skills only", () => {
    const a = mk("alpha", "甲技能说明")
    const b = { ...mk("beta", "乙技能说明"), disableModelInvocation: true }
    const text = skillListPrompt([a, b])
    expect(text).toContain("alpha")
    expect(text).toContain("甲技能说明")
    expect(text).not.toContain("beta")
  })
  it("returns empty string when nothing is model-visible", () => {
    expect(skillListPrompt([])).toBe("")
    const b = { ...mk("beta", "乙"), disableModelInvocation: true }
    expect(skillListPrompt([b])).toBe("")
  })
  it("truncates with a marker when the listing exceeds the budget", () => {
    const many = Array.from({ length: 50 }, (_, i) => mk(`skill-${i}`, "很长的技能描述".repeat(20)))
    const text = skillListPrompt(many, { budgetChars: 1000 })
    expect(text.length).toBeLessThanOrEqual(1200)
    expect(text).toContain("部分技能未列出")
    expect(text).not.toContain("skill-49")
  })
})
