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
import type { SkillEvolutionTriggers } from "../skills/evolution.js"
import type { ToolExecutor } from "../agent/tools.js"
import { makeTool, requireString, ToolError } from "./shared.js"

export const SKILL_READ_DESCRIPTION =
  "按名字加载一个技能（skill）的完整说明，返回其操作规程正文。优先使用系统提示词\"可用技能\"列表里的技能；不在该列表中的技能设置了 disable-model-invocation，只有在用户明确点名要求时才应加载。"

export const SKILL_LIST_DESCRIPTION =
  "列出当前已装且模型可见的技能（名字 + 一句话描述）。系统提示词里的\"可用技能\"清单有长度预算、技能过多时会被截断，子代理更是没有清单——需要完整清单或按关键词找技能时调用本工具。可选 query：按名字与描述子串过滤（大小写不敏感）；不传则列出全部。找到后用 skill_read 加载正文。"

export const SKILL_CREATE_DESCRIPTION =
  "把一段可复用的经验固化为技能提案（提案制：不直接安装，提案进入待确认列表，用户在 WebUI 审阅后才可能生效）。name 是技能目录名（小写字母、数字、连字符）；content 是完整的 SKILL.md 文件内容（YAML frontmatter 含 description 字段 + Markdown 正文）；rationale 可选，说明这段经验为什么值得沉淀。新增还是修订、落全局还是落项目由系统按已装技能自动判定，不要自己传。"

/** 功能关闭时的固定文案（照 memory_save 的 immediate 关闭先例）。 */
export const SKILL_CREATE_CLOSED_MSG =
  "技能提案未开启（skills.evolution.enabled=false）：在配置中将 skills.evolution.enabled 设为 true 后可用"

/** Same visibility口径 as the prompt listing: model-invisible skills stay hidden. */
function visible(skills: SkillRecord[]): SkillRecord[] {
  return skills.filter((s) => !s.disableModelInvocation)
}

/**
 * `create` 在位才注册 skill_create（daemon 组装时传；裸引擎测试不传）：
 * enabled=false 时模型调用得到固定关闭文案，enabled=true 时走提案面
 * （kind/scope 系统推导）。safe + parallel（spec 实现决策口径）：提案文件
 * 是 writeFileAtomic 原子写的独立文件，同名冲突由 create 的随机后缀化解，
 * 并发调用安全。
 */
export function createSkillTools(skills: SkillRecord[], create?: {
  enabled: boolean
  sessionId: string
  propose: SkillEvolutionTriggers["propose"]
}): {
  skill_read: ToolExecutor & { name: "skill_read" }
  skill_list: ToolExecutor & { name: "skill_list" }
  skill_create?: ToolExecutor & { name: "skill_create" }
} {
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

  if (create === undefined) return { skill_read, skill_list }

  const skill_create = makeTool("skill_create", "safe", "parallel", async (args) => {
    if (!create.enabled) return { status: "error", output: SKILL_CREATE_CLOSED_MSG }
    const name = requireString(args, "name")
    const content = requireString(args, "content")
    const rawRationale = (args as { rationale?: unknown } | undefined)?.rationale
    if (rawRationale !== undefined && typeof rawRationale !== "string") throw new ToolError("args.rationale must be a string")
    const r = create.propose(create.sessionId, {
      name,
      content,
      ...(typeof rawRationale === "string" ? { rationale: rawRationale } : {}),
    })
    if (!r.ok) throw new ToolError(r.error)
    return {
      status: "ok",
      output: `技能提案已登记（${r.proposal.id}，${r.proposal.kind === "new" ? "新增" : "修订"} · ${r.proposal.scope === "global" ? "全局" : "项目"}落点）：尚未生效，待用户在 WebUI 审阅确认`,
    }
  })

  return { skill_read, skill_list, skill_create }
}
