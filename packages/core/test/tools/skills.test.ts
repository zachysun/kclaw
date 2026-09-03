import { describe, it, expect } from "vitest"
import { parseSkillFile } from "../../src/skills/index.js"
import { createSkillTools } from "../../src/tools/skills.js"

const skill = (raw: string, name = "demo") => parseSkillFile(raw, name, `/skills/${name}`, "global")!

const run = async (tool: ReturnType<typeof createSkillTools>["skill_read"], name: string) =>
  tool.execute({ name }, { onOutput: () => {} })

describe("skill_read tool", () => {
  it("returns the skill body by name", async () => {
    const { skill_read } = createSkillTools([
      skill("---\ndescription: 演示\n---\n\n# 规程\n\n第一步。\n"),
    ])
    const r = await run(skill_read, "demo")
    expect(r.status).toBe("ok")
    expect(r.output).toContain("# 规程")
    expect(r.output).toContain("第一步。")
  })
  it("is safe and parallel", () => {
    const { skill_read } = createSkillTools([])
    expect(skill_read.risk).toBe("safe")
    expect(skill_read.concurrency).toBe("parallel")
  })
  it("unknown name is an error", async () => {
    const { skill_read } = createSkillTools([])
    const r = await run(skill_read, "nope")
    expect(r.status).toBe("error")
    expect(r.output).toContain("nope")
  })
  it("empty body is an error, not a silent ok", async () => {
    const { skill_read } = createSkillTools([skill("---\ndescription: 只有头\n---\n")])
    const r = await run(skill_read, "demo")
    expect(r.status).toBe("error")
  })
  it("project copy wins over same-named global", async () => {
    const { skill_read } = createSkillTools([
      skill("---\ndescription: 全局\n---\n\n全局正文\n"),
      parseSkillFile("---\ndescription: 项目\n---\n\n项目正文\n", "demo", "/p/demo", "project")!,
    ])
    const r = await run(skill_read, "demo")
    expect(r.status).toBe("ok")
    expect(r.output).toContain("项目正文")
  })
})
