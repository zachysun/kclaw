/**
 * skill tools: the model-facing half of progressive disclosure.
 *
 * skill_read loads one skill's full instructions (the SKILL.md body) by
 * name. skill_list lists the model-visible skills — the self-service
 * discovery half: the system-prompt listing has a character budget and may
 * be truncated, and child runs get no listing at all, so an agent can pull
 * the full inventory (or filter it by keyword) here instead. Both are safe +
 * parallel: they only read files the daemon already scanned, never the
 * workspace itself.
 *
 * The soft visibility rule rides on the tool descriptions, not a hard gate:
 * skills hidden from the model-facing listing (disable-model-invocation)
 * stay loadable by name through skill_read, because the user naming a skill
 * in conversation ("按 commit-helper 的规程办") is the only entry point for
 * that tier — but skill_list keeps the same visibility口径 as the prompt
 * listing and does not surface them.
 */
import type { SkillRecord } from "../skills/index.js"
import type { ToolExecutor } from "../agent/tools.js"
import { makeTool, requireString, ToolError } from "./shared.js"

export const SKILL_READ_DESCRIPTION =
  "按名字加载一个技能（skill）的完整说明，返回其操作规程正文。优先使用系统提示词\"可用技能\"列表里的技能；不在该列表中的技能设置了 disable-model-invocation，只有在用户明确点名要求时才应加载。"

export const SKILL_LIST_DESCRIPTION =
  "列出当前已装且模型可见的技能（名字 + 一句话描述）。系统提示词里的\"可用技能\"清单有长度预算、技能过多时会被截断，子代理更是没有清单——需要完整清单或按关键词找技能时调用本工具。可选 query：按名字与描述子串过滤（大小写不敏感）；不传则列出全部。找到后用 skill_read 加载正文。"

/** Same visibility口径 as the prompt listing: model-invisible skills stay hidden. */
function visible(skills: SkillRecord[]): SkillRecord[] {
  return skills.filter((s) => !s.disableModelInvocation)
}

export function createSkillTools(skills: SkillRecord[]): { skill_read: ToolExecutor & { name: "skill_read" }; skill_list: ToolExecutor & { name: "skill_list" } } {
  const skill_read = makeTool("skill_read", "safe", "parallel", async (args) => {
    const name = requireString(args, "name")
    const matches = skills.filter((s) => s.name === name)
    // Defensive: a same-named project copy wins, mirroring scanSkillDirs.
    const skill = matches.find((s) => s.origin === "project") ?? matches[0]
    if (skill === undefined) throw new ToolError(`没有叫 ${name} 的技能（可用 skill_list 列出已装技能，或 /skill 查看）`)
    if (skill.body.trim() === "") throw new ToolError(`技能 ${name} 没有正文`)
    return { status: "ok", output: skill.body }
  })

  const skill_list = makeTool("skill_list", "safe", "parallel", async (args) => {
    const raw = (args as { query?: unknown } | undefined)?.query
    if (raw !== undefined && typeof raw !== "string") throw new ToolError("query 必须是字符串")
    const query = raw?.trim().toLowerCase() ?? ""
    const rows = visible(skills)
      .filter((s) => query === "" || s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    if (rows.length === 0) {
      return { status: "ok", output: query === "" ? "当前没有模型可见的技能。" : `没有名字或描述匹配「${raw}」的技能。` }
    }
    return { status: "ok", output: rows.map((s) => `- ${s.name}: ${s.description}`).join("\n") }
  })

  return { skill_read, skill_list }
}
