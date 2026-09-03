/**
 * skill tool: skill_read loads one skill's full instructions (the SKILL.md
 * body) by name — the on-demand half of progressive disclosure. Safe +
 * parallel: it only reads files the daemon already scanned, never the
 * workspace itself.
 *
 * The soft visibility rule rides on the tool description, not a hard gate:
 * skills hidden from the model-facing listing (disable-model-invocation) stay
 * loadable by name, because the user naming a skill in conversation ("按
 * commit-helper 的规程办") is the only entry point for that tier.
 */
import type { SkillRecord } from "../skills/index.js"
import type { ToolExecutor } from "../agent/tools.js"
import { makeTool, requireString, ToolError } from "./shared.js"

export const SKILL_READ_DESCRIPTION =
  "按名字加载一个技能（skill）的完整说明，返回其操作规程正文。优先使用系统提示词\"可用技能\"列表里的技能；不在该列表中的技能设置了 disable-model-invocation，只有在用户明确点名要求时才应加载。"

export function createSkillTools(skills: SkillRecord[]): { skill_read: ToolExecutor & { name: "skill_read" } } {
  const skill_read = makeTool("skill_read", "safe", "parallel", async (args) => {
    const name = requireString(args, "name")
    const matches = skills.filter((s) => s.name === name)
    // Defensive: a same-named project copy wins, mirroring scanSkillDirs.
    const skill = matches.find((s) => s.origin === "project") ?? matches[0]
    if (skill === undefined) throw new ToolError(`没有叫 ${name} 的技能（可用技能见系统提示词列表，或 /skill 查看）`)
    if (skill.body.trim() === "") throw new ToolError(`技能 ${name} 没有正文`)
    return { status: "ok", output: skill.body }
  })
  return { skill_read }
}
