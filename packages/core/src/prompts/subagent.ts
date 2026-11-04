/**
 * subagent 子会话的精简系统提示词模板（使用方：agent/subagent.ts 与
 * run-assembly 组装）。
 */

/** Cap on a role supplement (chars) — the parent model's per-task description. */
export const SUBAGENT_ROLE_MAX_CHARS = 2_000

/**
 * The lean system prompt a child run sees: identity + workspace + discipline.
 * Deliberately WITHOUT the persona (AGENTS.md), memory cognition and the skill
 * list — a subagent is a short-lived executor whose necessary background lives
 * in the task text itself. The room to add materials later is this template.
 * `role` (the dispatch's per-task role supplement) is appended as its own
 * section, head-truncated at the cap.
 */
export function subagentSystemPrompt(workspace: string, role?: string): string {
  const base = [
    "你是 kclaw 的 subagent：由主对话派出的一次性执行单元，独立会话、单层委派（不能再派subagent）。",
    `工作区：${workspace}`,
    "任务就是你的唯一指令。自主把它做完：需要什么信息就用工具取，不要反问（没有人在听）。",
    "权限规则与主会话一致：敏感操作会请求人工确认，批准后照常继续；被拒绝就换路。",
    "结束时给出完整的结题答复——它是主对话收到的全部内容，过程不会带回。",
  ]
  if (role !== undefined && role.trim() !== "") {
    base.push("", "# 角色补充", role.trim().slice(0, SUBAGENT_ROLE_MAX_CHARS))
  }
  return base.join("\n")
}
