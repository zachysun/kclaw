/**
 * /goal 判定契约常量（原 goal/prompt.ts 拆分：文本模板搬去 prompts/goal.ts，
 * 行为契约留在域内）。判定器输出契约与循环侧检测共用这里的常量。
 */
import { GOAL_JUDGE_MAX_TOKENS } from "./limits.js"

/** 判定器允许的输出 token 上限（请求组装处调用）。 */
export const judgeMaxTokens = GOAL_JUDGE_MAX_TOKENS

/**
 * 判定器"无进展"的标记串：判定器 system 提示词的输出契约（没有进展
 * 就写这个字，见 prompts/goal.ts）与循环调用侧的无进展检测共用同一常量。
 * 改这个字必须两端一起变，此处是唯一出处。
 */
export const NO_PROGRESS_MARK = "无"

/** progress 字段是否标记为无进展（缺失/空白/恰好是标记串）。 */
export function noProgressMarked(progress: string | undefined): boolean {
  if (progress === undefined) return true
  const t = progress.trim()
  return t === "" || t === NO_PROGRESS_MARK
}
