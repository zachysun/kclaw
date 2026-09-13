import { describe, it, expect } from "vitest"
import { parseSkillFile } from "../../src/skills/index.js"
import { createSkillTools } from "../../src/tools/skills.js"

const skill = (raw: string, name = "demo") => parseSkillFile(raw, name, `/skills/${name}`, "global")!

const run = async (tool: ReturnType<typeof createSkillTools>["skill_read"], name: string) =>
  tool.execute({ name }, { onOutput: () => {} })

const runList = async (tool: ReturnType<typeof createSkillTools>["skill_list"], query?: string) =>
  tool.execute(query === undefined ? {} : { query }, { onOutput: () => {} })

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

describe("skill_list tool", () => {
  const tools = () =>
    createSkillTools([
      skill("---\ndescription: 演示技能\n---\n\n正文\n", "alpha-demo"),
      skill("---\ndescription: 测试驱动开发\n---\n\n正文\n", "tdd-flow"),
      parseSkillFile("---\ndescription: 隐藏技能\ndisable-model-invocation: true\n---\n\n正文\n", "hidden", "/skills/hidden", "global")!,
    ])

  it("is safe and parallel", () => {
    const { skill_list } = tools()
    expect(skill_list.risk).toBe("safe")
    expect(skill_list.concurrency).toBe("parallel")
  })

  it("lists all model-visible skills sorted by name, one line each", async () => {
    const { skill_list } = tools()
    const r = await runList(skill_list)
    expect(r.status).toBe("ok")
    expect(r.output!.split("\n")).toEqual(["- alpha-demo: 演示技能", "- tdd-flow: 测试驱动开发"])
  })

  it("hides disable-model-invocation skills — same口径 as the prompt listing", async () => {
    const { skill_list } = createSkillTools([
      skill("---\ndescription: 隐藏技能\ndisable-model-invocation: true\n---\n\n正文\n", "hidden"),
      skill("---\ndescription: 可见技能\n---\n\n正文\n", "visible-skill"),
    ])
    const r = await runList(skill_list)
    expect(r.output).toContain("visible-skill")
    expect(r.output).not.toContain("隐藏技能")
  })

  it("filters by query over name and description, case-insensitive", async () => {
    const { skill_list } = tools()
    const byName = await runList(skill_list, "TDD")
    expect(byName.status).toBe("ok")
    expect(byName.output).toContain("tdd-flow")
    expect(byName.output).not.toContain("alpha-demo")
    const byDesc = await runList(skill_list, "驱动")
    expect(byDesc.output).toContain("tdd-flow")
    const miss = await runList(skill_list, "不存在的东西")
    expect(miss.status).toBe("ok")
    expect(miss.output).toContain("没有名字或描述匹配")
  })

  it("non-string query is an error", async () => {
    const { skill_list } = tools()
    const r = await skill_list.execute({ query: 5 }, { onOutput: () => {} })
    expect(r.status).toBe("error")
  })
})
