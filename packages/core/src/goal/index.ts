/**
 * /goal 领域模块的公共出口（issue #47）。daemon 侧消费器
 *（packages/server/src/goal-loop.ts）与浏览器端（快照/结果类型）从这里
 * 消费；沙箱执行器只服务 Node 侧。
 */
export type {
  GoalState,
  GoalStopReason,
  GoalVerdict,
  GoalSnapshot,
  GoalJudgeResult,
  GoalGateOutcome,
  GoalJudgeErrorKind,
  GoalJudgeError,
  DerivedLoop,
} from "./types.js"
export { judgeGoal, buildEvidenceWindow } from "./judge.js"
export type { JudgeGoalInput, JudgeGoalOutput } from "./judge.js"
export { runAcceptanceGates } from "./gate.js"
export { deriveGoalLoop } from "./derive.js"
export { goalPreGateGuard, decideGoalRound } from "./check.js"
export type { GoalRoundDecision } from "./check.js"
export {
  firstRoundUserText,
  continuationUserText,
  gateFailureUserText,
  judgeUnavailableUserText,
  windDownUserText,
  goalLoopNote,
  judgeSystemPrompt,
  judgeUserContent,
  NO_PROGRESS_MARK,
  noProgressMarked,
} from "./prompt.js"
export {
  GOAL_MAX_ROUNDS,
  GOAL_TOKEN_BUDGET,
  GOAL_NO_PROGRESS_LIMIT,
  GOAL_GATE_EXHAUSTED,
  GOAL_APPROVAL_TIMEOUT_ROUNDS,
  GOAL_JUDGE_PARSE_BREAKER,
  GOAL_JUDGE_TRANSPORT_BREAKER,
} from "./limits.js"
