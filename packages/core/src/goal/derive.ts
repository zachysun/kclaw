/**
 * /goal 循环的事件派生（issue #47）：一次前向扫描 goal.set(create) 之后
 * 的全部事件，得出检查时刻的循环状态（DerivedLoop）。纯函数——调用方
 * 负责读事件流与失败回退（读不到时按空事件派生即全零）。写侧规则在
 * 调用方（packages/server/src/goal-loop.ts），两侧唯一的编码约定：goal.checked
 * 的 verdict 缺失 = 门失败短路留下的检查（判定器没跑）。
 *
 * 尾部连败回溯规则：同性质的检查连续累积，任何不同性质的检查（成功
 * 裁决/另一类失败/门通过）都断开计数。
 */
import type { GoalCheckedEvent, SessionEvent } from "../protocol/session-events.js"
import type { DerivedLoop } from "./types.js"
import { noProgressMarked } from "./prompt.js"

export function deriveGoalLoop(events: SessionEvent[]): DerivedLoop {
  const zero: DerivedLoop = {
    totalRounds: 0, rounds: 0, tokensUsed: 0, noProgressStreak: 0, gateFailStreak: 0,
    parseFails: 0, transportFails: 0, approvalTimeoutStreak: 0, lastRun: undefined,
  }
  let createIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === "goal.set" && e.op === "create") {
      createIdx = i
      break
    }
  }
  if (createIdx === -1) return zero
  const runs: Array<{ trigger: string; stopReason: string; timeout: boolean }> = []
  let currentRun: { trigger: string; timeout: boolean } | undefined
  const checks: GoalCheckedEvent[] = []
  let totalRounds = 0
  let tokensUsed = 0
  for (let i = createIdx + 1; i < events.length; i++) {
    const e = events[i]!
    if (e.type === "run.started") {
      currentRun = { trigger: e.trigger, timeout: false }
      if (e.trigger === "goal") totalRounds++
    } else if (e.type === "permission.decided") {
      if (currentRun !== undefined && e.decision === "timeout") currentRun.timeout = true
    } else if (e.type === "run.ended") {
      if (currentRun !== undefined) {
        runs.push({ trigger: currentRun.trigger, stopReason: e.stopReason, timeout: currentRun.timeout })
        currentRun = undefined
      }
      if (e.usage !== undefined) tokensUsed += e.usage.inputTokens + e.usage.outputTokens
    } else if (e.type === "goal.checked") {
      checks.push(e)
      if (e.tokens !== undefined) tokensUsed += e.tokens.inputTokens + e.tokens.outputTokens
    }
  }
  let rounds = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i]!.trigger === "goal") rounds++
    else if (runs[i]!.trigger === "user") break
  }
  let approvalTimeoutStreak = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i]!.timeout) approvalTimeoutStreak++
    else break
  }
  // 尾部连败回溯：mode 记录最尾部检查的性质，此后只有同性质才累计。
  let mode: "gate" | "noprogress" | "parse" | "transport" | undefined
  let noProgressStreak = 0
  let gateFailStreak = 0
  let parseFails = 0
  let transportFails = 0
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i]!
    if (c.judgeError !== undefined) {
      const kind = c.judgeError.kind
      if (mode === undefined) mode = kind
      if (mode === kind && kind === "parse") parseFails++
      else if (mode === kind && kind === "transport") transportFails++
      else break
      continue
    }
    if (c.verdict === undefined) {
      // 无裁决 = 门失败短路留下的检查。
      if (mode === undefined) mode = "gate"
      if (mode === "gate" && c.gates.some((g) => !g.ok)) gateFailStreak++
      else break
      continue
    }
    if (c.verdict === "not_met" && noProgressMarked(c.progress)) {
      if (mode === undefined) mode = "noprogress"
      if (mode === "noprogress") noProgressStreak++
      else break
      continue
    }
    break
  }
  const lastRun = runs.length > 0
    ? { trigger: runs[runs.length - 1]!.trigger, stopReason: runs[runs.length - 1]!.stopReason }
    : undefined
  return { totalRounds, rounds, tokensUsed, noProgressStreak, gateFailStreak, parseFails, transportFails, approvalTimeoutStreak, lastRun }
}
