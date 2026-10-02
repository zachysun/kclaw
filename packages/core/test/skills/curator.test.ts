/**
 * The skill curator contract: telemetry recording, eligibility (agent-created
 * only), stale marking, archiving as a MOVE (never a delete) and the
 * exemptions (pinned, reuse links, user-authored).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { curateGlobalSkills, recordSkillUse, type CuratorConfig } from "../../src/skills/curator.js"

let skillsDir: string
beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), "kclaw-curator-"))
})
afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true })
})

const CFG: CuratorConfig = { enabled: true, staleDays: 14, archiveDays: 30, hour: 4 }

/** Drop a skill directory; frontmatter written verbatim. */
function makeSkill(name: string, frontmatter = "---\ndescription: test\n---\n\nbody"): void {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(join(skillsDir, name, "SKILL.md"), frontmatter)
}

/** Drop an applied "new" proposal — the agent-created marker for pre-flag skills. */
function makeAppliedNewProposal(name: string): void {
  mkdirSync(join(skillsDir, ".proposals"), { recursive: true })
  writeFileSync(join(skillsDir, ".proposals", `p-${name}.json`), JSON.stringify({ status: "applied", kind: "new", name }))
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString()

function seedUse(name: string, lastUsedAt: string): void {
  mkdirSync(join(skillsDir, ".curator"), { recursive: true })
  writeFileSync(join(skillsDir, ".curator", "usage.json"), JSON.stringify({ [`global:${name}`]: { count: 3, lastUsedAt } }))
}

describe("recordSkillUse", () => {
  it("appends a scoped use record with a fresh timestamp", () => {
    recordSkillUse(skillsDir, "global", "my-skill")
    const usage = JSON.parse(readFileSync(join(skillsDir, ".curator", "usage.json"), "utf8"))
    expect(usage["global:my-skill"].count).toBe(1)
    expect(typeof usage["global:my-skill"].lastUsedAt).toBe("string")
    recordSkillUse(skillsDir, "global", "my-skill")
    const after = JSON.parse(readFileSync(join(skillsDir, ".curator", "usage.json"), "utf8"))
    expect(after["global:my-skill"].count).toBe(2)
  })
})

describe("curateGlobalSkills", () => {
  it("never touches user-authored skills, however old they are", () => {
    makeSkill("user-skill")
    const report = curateGlobalSkills(skillsDir, CFG, new Date(Date.now() + 400 * 86_400_000))
    expect(report.archived).toEqual([])
    expect(existsSync(join(skillsDir, "user-skill"))).toBe(true)
  })

  it("marks agent-created skills stale at staleDays and archives at archiveDays (a move, not a delete)", () => {
    makeSkill("auto-fmt")
    makeAppliedNewProposal("auto-fmt")
    seedUse("auto-fmt", daysAgo(20))
    const t = new Date()
    const report = curateGlobalSkills(skillsDir, CFG, t)
    expect(report.stale).toEqual(["auto-fmt"])
    expect(report.archived).toEqual([])
    expect(existsSync(join(skillsDir, ".curator", "state.json"))).toBe(true)

    // 40 天未用：归档。目录移动进 .archive/（带时间戳后缀），原位消失。
    const later = new Date(t.getTime() + 21 * 86_400_000)
    const report2 = curateGlobalSkills(skillsDir, CFG, later)
    expect(report2.archived).toEqual(["auto-fmt"])
    expect(existsSync(join(skillsDir, "auto-fmt"))).toBe(false)
    const archived = readdirSync(join(skillsDir, ".archive"))
    expect(archived).toHaveLength(1)
    expect(archived[0]!.startsWith("auto-fmt-")).toBe(true)
    // 正文完好：移动不是删除，移回即恢复
    expect(existsSync(join(skillsDir, ".archive", archived[0]!, "SKILL.md"))).toBe(true)
  })

  it("the frontmatter agent-created flag qualifies without a proposal file", () => {
    makeSkill("flagged", "---\ndescription: test\nagent-created: true\n---\n\nbody")
    seedUse("flagged", daysAgo(40))
    const report = curateGlobalSkills(skillsDir, CFG)
    expect(report.archived).toEqual(["flagged"])
  })

  it("pinned and reuse-linked skills are exempt even when eligible", () => {
    makeSkill("pinned-skill", "---\ndescription: test\nagent-created: true\npinned: true\n---\n\nbody")
    makeSkill("linked-skill", "---\ndescription: test\nagent-created: true\n---\n\nbody")
    seedUse("pinned-skill", daysAgo(90))
    seedUse("linked-skill", daysAgo(90))
    // linked-skill 目录实际是软链接（复用链接形态）
    rmSync(join(skillsDir, "linked-skill"), { recursive: true })
    const outside = mkdtempSync(join(tmpdir(), "kclaw-src-"))
    writeFileSync(join(outside, "SKILL.md"), "---\ndescription: src\n---\n\nbody")
    symlinkSync(outside, join(skillsDir, "linked-skill"))
    const report = curateGlobalSkills(skillsDir, CFG)
    expect(report.archived).toEqual([])
    expect(existsSync(join(skillsDir, "pinned-skill"))).toBe(true)
    expect(existsSync(join(skillsDir, "linked-skill"))).toBe(true)
  })

  it("recent use keeps a skill active and clears a stale marker", () => {
    makeSkill("hot-skill")
    makeAppliedNewProposal("hot-skill")
    // 先标 stale，再用起来：下一次 sweep 清掉标记
    seedUse("hot-skill", daysAgo(20))
    curateGlobalSkills(skillsDir, CFG)
    seedUse("hot-skill", new Date().toISOString())
    const report = curateGlobalSkills(skillsDir, CFG)
    expect(report.stale).toEqual([])
    const state = JSON.parse(readFileSync(join(skillsDir, ".curator", "state.json"), "utf8"))
    expect(state["hot-skill"]).toBeUndefined()
  })

  it("disabled curator is a no-op", () => {
    makeSkill("auto-fmt")
    makeAppliedNewProposal("auto-fmt")
    seedUse("auto-fmt", daysAgo(90))
    const report = curateGlobalSkills(skillsDir, { ...CFG, enabled: false })
    expect(report.archived).toEqual([])
    expect(existsSync(join(skillsDir, "auto-fmt"))).toBe(true)
  })
})
