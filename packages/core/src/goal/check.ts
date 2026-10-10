/**
 * /goal 一轮检查的决策芯（issue #47）：门与判定器产物 → 下一步动作，纯
 * 函数。九条停止条件、熔断判定、wind-down（预算超限补一轮收尾）与续跑
 * 注入文本的组装都在这里；调用方（packages/server/src/goal-loop.ts）负责
 * 副作用——跑验收命令、调判定器、写审计与用量、按决策入队或停止（ADR-0003
 * 的"门先行、失败短路判定器"不变量由此处的调用次序编码：门失败时
 * judged 为 undefined）。
 *
 * 决策携带更新后的派生计数（loop）：除 gate-exhausted 外，停止前都先有
 * 一次计数写回（refreshFirst——调用方按它决定先写 goal.set(state) 的计数
 * 刷新还是直接停），与 met/impossible 终态写回共用同一份计数。
 */
import type { JudgeGoalOutput } from "./judge.js"
import {
  continuationUserText,
  gateFailureUserText,
  judgeUnavailableUserText,
  noProgressMarked,
  windDownUserText,
} from "./prompt.js"
import {
  GOAL_APPROVAL_TIMEOUT_ROUNDS,
  GOAL_GATE_EXHAUSTED,
  GOAL_JUDGE_PARSE_BREAKER,
  GOAL_JUDGE_TRANSPORT_BREAKER,
  GOAL_MAX_ROUNDS,
  GOAL_NO_PROGRESS_LIMIT,
  GOAL_TOKEN_BUDGET,
} from "./limits.js"
import type { DerivedLoop, GoalGateOutcome, GoalJudgeResult, GoalSnapshot, GoalStopReason } from "./types.js"

/**
 * 门执行前的守卫（停止条件的前两条，不需要门/判定器产物）：
 * 上一轮 run 出错不自动重试；确认超时连败转 blocked 等人工裁决。
 */
export function goalPreGateGuard(loop: DerivedLoop): { reason: GoalStopReason; note: string } | undefined {
  if (loop.lastRun !== undefined && loop.lastRun.stopReason === "error") {
    return { reason: "run-error", note: "上一轮运行出错，目标循环暂停（不自动重试）" }
  }
  if (loop.approvalTimeoutStreak >= GOAL_APPROVAL_TIMEOUT_ROUNDS) {
    return { reason: "permission", note: `连续 ${loop.approvalTimeoutStreak} 轮出现确认超时（无人在场裁决），目标循环暂停` }
  }
  return undefined
}

export type GoalRoundDecision =
  | { kind: "complete"; reason: "met" | "impossible"; judged: GoalJudgeResult; loop: DerivedLoop }
  | {
      kind: "stop"
      reason: GoalStopReason
      note: string
      loop: DerivedLoop
      /** 停止前是否先做一次计数写回（唯一例外是 gate-exhausted）。 */
      refreshFirst: boolean
      judge?: GoalJudgeResult
    }
  | { kind: "winddown"; loop: DerivedLoop; injection: string; enqueueRound: number; judge?: GoalJudgeResult }
  | { kind: "continue"; loop: DerivedLoop; injection: string; enqueueRound: number; judge?: GoalJudgeResult }

/**
 * 续跑前的公共闸门（预算/轮数上限）：预算超限 → 标记收尾轮并入队
 * wrap-up（调用方置 windDownPending）；连续轮数达上限 → round-limit
 * 停止；否则 undefined 继续正常入队。
 */
function continueGate(
  goal: GoalSnapshot,
  loop: DerivedLoop,
  consecutiveRounds: number,
  judge: GoalJudgeResult | undefined,
): GoalRoundDecision | undefined {
  if (loop.tokensUsed >= GOAL_TOKEN_BUDGET) {
    return { kind: "winddown", loop, injection: windDownUserText(goal), enqueueRound: loop.totalRounds + 1, judge }
  }
  if (consecutiveRounds + 1 > GOAL_MAX_ROUNDS) {
    return {
      kind: "stop",
      reason: "round-limit",
      note: `连续自续 ${GOAL_MAX_ROUNDS} 轮未达成（发一条消息可重置计数并继续）`,
      loop,
      refreshFirst: true,
      judge,
    }
  }
  return undefined
}

/**
 * 一轮检查的裁决（门与判定器之后）。输入门产物、判定器输出（门失败
 * 短路时 undefined）与进程内收尾轮标记；输出更新后的计数与下一步动作。
 */
export function decideGoalRound(input: {
  goal: GoalSnapshot
  loop: DerivedLoop
  gates: GoalGateOutcome[]
  judged: JudgeGoalOutput | undefined
  windDownPending: boolean
}): GoalRoundDecision {
  const { goal, loop, gates } = input
  const gateFailed = gates.some((g) => !g.ok)

  // 裁决分支：判定器成功。
  if (input.judged !== undefined && input.judged.ok) {
    const result = input.judged.result
    const tokensUsed = loop.tokensUsed + result.tokens.inputTokens + result.tokens.outputTokens
    const withJudge: DerivedLoop = { ...loop, tokensUsed }
    if (result.verdict === "met") return { kind: "complete", reason: "met", judged: result, loop: withJudge }
    if (result.verdict === "impossible") return { kind: "complete", reason: "impossible", judged: result, loop: withJudge }
    const noProgStreak = noProgressMarked(result.progress) ? loop.noProgressStreak + 1 : 0
    const guarded: DerivedLoop = { ...withJudge, noProgressStreak: noProgStreak }
    // 收尾轮已跑过判定：无论进展如何，预算终停（met 已在上面返回）。
    if (input.windDownPending) {
      return {
        kind: "stop",
        reason: "budget-limit",
        note: `目标生命周期 token 预算（${GOAL_TOKEN_BUDGET}）已耗尽，收尾轮完成`,
        loop: guarded,
        refreshFirst: true,
        judge: result,
      }
    }
    if (noProgStreak >= GOAL_NO_PROGRESS_LIMIT) {
      return {
        kind: "stop",
        reason: "no-progress",
        note: `判定器连续 ${noProgStreak} 轮未见进展`,
        loop: guarded,
        refreshFirst: true,
        judge: result,
      }
    }
    const gate = continueGate(goal, guarded, loop.rounds, result)
    if (gate !== undefined) return gate
    return {
      kind: "continue",
      loop: guarded,
      injection: continuationUserText({ ...goal, totalRounds: loop.totalRounds }, result, gates),
      enqueueRound: loop.totalRounds,
      judge: result,
    }
  }

  // 门失败分支（判定器没跑，不再消耗判定 token）。
  if (gateFailed) {
    const gateStreak = loop.gateFailStreak + 1
    const mixed: DerivedLoop = { ...loop, gateFailStreak: gateStreak }
    if (gateStreak >= GOAL_GATE_EXHAUSTED) {
      // 唯一不做计数写回的停止：达限即停，gateFailStreak 留在停止时的写入里。
      return {
        kind: "stop",
        reason: "gate-exhausted",
        note: `验收命令连续 ${gateStreak} 轮未通过`,
        loop: mixed,
        refreshFirst: false,
      }
    }
    if (input.windDownPending) {
      return {
        kind: "stop",
        reason: "budget-limit",
        note: `目标生命周期 token 预算（${GOAL_TOKEN_BUDGET}）已耗尽，收尾轮完成`,
        loop: mixed,
        refreshFirst: true,
      }
    }
    const gate = continueGate(goal, mixed, loop.rounds, undefined)
    if (gate !== undefined) return gate
    return {
      kind: "continue",
      loop: mixed,
      injection: gateFailureUserText(goal, gates, gateStreak),
      enqueueRound: loop.totalRounds,
    }
  }

  // 判定器失败分支：熔断判定 + fail-open 续跑。
  const error = input.judged !== undefined && !input.judged.ok
    ? input.judged.error
    : { kind: "parse" as const, message: "unknown" }
  const parseFails = error.kind === "parse" ? loop.parseFails + 1 : loop.parseFails
  const transportFails = error.kind === "transport" ? loop.transportFails + 1 : loop.transportFails
  const mixed: DerivedLoop = { ...loop, parseFails, transportFails }
  if (parseFails >= GOAL_JUDGE_PARSE_BREAKER || transportFails >= GOAL_JUDGE_TRANSPORT_BREAKER) {
    return {
      kind: "stop",
      reason: "judge-failed",
      note: `判定器连续失败已熔断（${error.message}）`,
      loop: mixed,
      refreshFirst: true,
    }
  }
  if (input.windDownPending) {
    return {
      kind: "stop",
      reason: "budget-limit",
      note: `目标生命周期 token 预算（${GOAL_TOKEN_BUDGET}）已耗尽，收尾轮完成`,
      loop: mixed,
      refreshFirst: true,
    }
  }
  const gate = continueGate(goal, mixed, loop.rounds, undefined)
  if (gate !== undefined) return gate
  return {
    kind: "continue",
    loop: mixed,
    injection: judgeUnavailableUserText(goal, error.kind, error.kind === "parse" ? parseFails : transportFails),
    enqueueRound: loop.totalRounds,
  }
}
