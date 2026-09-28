/**
 * /goal 的三组提示词（issue #47）：判定器（独立 LLM，严格 JSON 三值
 * 裁决）、续跑注入（下一轮 goal 触发 run 的用户文本）、收尾注入（token
 * 预算耗尽后的最后一轮）。纯函数、无 Node API——浏览器构建可引用。
 * 注入文本沿用仓库的 XML 标签约定（<goal-continue>/<goal-wrapup>，同
 * <compacted-summary> 先例），闭合标签逃逸在拼装处处理。
 */
import type { GoalGateOutcome, GoalJudgeResult, GoalSnapshot } from "./types.js"
import { GOAL_GATE_EXHAUSTED, GOAL_JUDGE_MAX_TOKENS } from "./limits.js"

/** 判定器允许的输出 token 上限（请求组装处消费）。 */
export const judgeMaxTokens = GOAL_JUDGE_MAX_TOKENS

/** 闭合标签逃逸：证据里出现的 `</goal-...>` 会被打散，防提示词提前收口。 */
function escapeClosingTags(text: string): string {
  return text.replace(/<\/(goal-[\w-]+)>/g, "<\\$1>")
}

function acceptanceList(acceptance: string[]): string {
  if (acceptance.length === 0) return "（用户未提供验收命令）"
  return acceptance.map((cmd, i) => `${i + 1}. \`${cmd}\``).join("\n")
}

/**
 * 判定器 system 提示词：角色、证据规则、输出契约。温度 0 + 严格 JSON。
 */
export function judgeSystemPrompt(): string {
  return [
    "你是目标达成判定器。你的唯一任务：根据证据判断一个编码目标是否已经达成。",
    "",
    "裁决只能是三值之一：",
    '- "met"：验收命令全部通过，且对话证据表明目标描述的终态已经成立；',
    '- "impossible"：证据表明目标在当前条件下无法达成（需求自相矛盾、缺少不可能获得的前提、外部依赖永久失效等），而不是"很难"或"还没做到"；',
    '- "not_met"：其余一切情况（包括进展顺利但未完成、毫无进展、方向错了）。',
    "",
    "判定纪律：",
    "1. 只看证据，不听模型的自述：对话里说「我做完了」而验收命令失败，就是 not_met；",
    "2. 不预测、不乐观——终态没有在证据里坐实就是 not_met；",
    "3. impossible 要慎用：拿不准就用 not_met，让下一轮继续。",
    "",
    "输出契约：只输出一个 JSON 对象，不要任何其他文字、代码围栏或解释：",
    '{"verdict":"not_met|met|impossible","reason":"一句话说明依据","progress":"一句话概括本轮进展，没有进展就写无"}',
    "",
    "reason 与 progress 用中文，各不超过 120 字。",
  ].join("\n")
}

/**
 * 判定器 user 内容：目标原文、验收命令与本轮输出、对话尾部证据窗。
 * `evidence` 由 judge.ts 的窗口构建器产出（已截断、带省略计数）。
 */
export function judgeUserContent(goal: GoalSnapshot, gates: GoalGateOutcome[], evidence: string): string {
  const gateLines =
    gates.length === 0
      ? "（本轮无验收命令输出）"
      : gates
          .map((g) => `- \`${g.command}\` → ${g.ok ? "通过" : `失败（exit ${g.exitCode ?? "无"}）`}\n  输出尾部：\n  ${g.outputTail.split("\n").join("\n  ")}`)
          .join("\n")
  return escapeClosingTags(
    [
      `【目标】\n${goal.text}`,
      "",
      `【验收命令】\n${acceptanceList(goal.acceptance)}`,
      "",
      `【本轮验收命令输出】\n${gateLines}`,
      "",
      `【对话证据（尾部窗口，头部省略）】\n${evidence}`,
      "",
      "请按输出契约给出 JSON 裁决。",
    ].join("\n"),
  )
}

/** 首轮 goal run 的用户文本：目标原文 + 验收标准 + 开工指令。 */
export function firstRoundUserText(goal: GoalSnapshot): string {
  return [
    `<goal-start>`,
    `目标：${goal.text}`,
    `验收标准（命令将在沙箱内执行，全部通过才算达成）：`,
    acceptanceList(goal.acceptance),
    `请开始推进。每轮结束前先用验收命令自查，未通过就继续修，不要在未通过时宣称完成。`,
    `</goal-start>`,
  ].join("\n")
}

/**
 * 续跑注入：not_met 后下一轮的用户文本。带判定器意见与（若刚跑过）
 * 验收输出，让下一轮有明确的修正方向。
 */
export function continuationUserText(
  goal: GoalSnapshot,
  last: GoalJudgeResult,
  gates: GoalGateOutcome[],
): string {
  const gateLines =
    gates.length === 0
      ? ""
      : `\n最近一轮验收输出：\n${gates.map((g) => `- \`${g.command}\` ${g.ok ? "通过" : "失败"}：\n  ${g.outputTail.split("\n").join("\n  ")}`).join("\n")}\n`
  return escapeClosingTags(
    [
      `<goal-continue round="${goal.totalRounds + 1}">`,
      `目标：${goal.text}`,
      gateLines,
      `判定器意见（${last.verdict === "not_met" ? "未达成" : last.verdict}）：${last.reason}`,
      ...(last.progress !== undefined && last.progress !== "" ? [`本轮进展：${last.progress}`] : []),
      `继续推进；先用验收命令自查，再决定下一步。`,
      `</goal-continue>`,
    ].join("\n"),
  )
}

/** 验收失败短路续跑：判定器没跑，方向就是让模型直面失败的验收输出。 */
export function gateFailureUserText(goal: GoalSnapshot, gates: GoalGateOutcome[], failedRounds: number): string {
  return escapeClosingTags(
    [
      `<goal-continue round="${goal.totalRounds + 1}">`,
      `目标：${goal.text}`,
      `验收命令已连续 ${failedRounds} 轮未通过（连续 ${GOAL_GATE_EXHAUSTED} 轮即停止循环）。本轮输出：`,
      ...gates.map((g) => `- \`${g.command}\`（exit ${g.exitCode ?? "无"}）：\n  ${g.outputTail.split("\n").join("\n  ")}`),
      `先修复验收命令暴露的问题；若目标本身不可达成，请明确说明原因并停止尝试。`,
      `</goal-continue>`,
    ].join("\n"),
  )
}

/**
 * 判定器不可用时的续跑（fail-open）：解析/传输失败未熔断，循环继续但
 * 本轮没有判定意见——明确告知模型自查验收，不要等外部裁决。
 */
export function judgeUnavailableUserText(goal: GoalSnapshot, errorKind: "parse" | "transport", attempt: number): string {
  return escapeClosingTags(
    [
      `<goal-continue round="${goal.totalRounds + 1}">`,
      `目标：${goal.text}`,
      `判定器本轮不可用（${errorKind === "parse" ? "输出解析失败" : "调用失败"}，第 ${attempt} 次），没有外部裁决意见。`,
      `请自行用验收命令检查进展并继续推进；达到终态时明确说明依据。`,
      `</goal-continue>`,
    ].join("\n"),
  )
}

/** 收尾轮注入：token 预算耗尽，给最后一轮把状态收干净。 */
export function windDownUserText(goal: GoalSnapshot): string {
  return [
    `<goal-wrapup>`,
    `目标：${goal.text}`,
    `该目标的生命周期 token 预算已耗尽，这是最后一轮。请收尾：`,
    `1. 不要开始新的重大改动；`,
    `2. 把已完成的工作整理到可交接状态（必要的说明写进文件或总结）；`,
    `3. 最后一句话说明目标达成到什么程度、剩余什么没做。`,
    `</goal-wrapup>`,
  ].join("\n")
}

/** goal 触发 run 的出处 note（NoteBlock kind:"goal" 的文本）。 */
export function goalLoopNote(round: number): string {
  return `本会话设有进行中的目标（第 ${round} 轮自动续跑）。你的中间消息会注入当前运行；停止目标请用 /goal stop。`
}
