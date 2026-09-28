/**
 * /goal 领域类型（issue #47）：一次会话级可验证目标的快照、状态机与判定
 * 结果。快照是唯一持久形态（session meta 的 goal 字段，经 goal.set 事件
 * 全量替换）；进程内的自续开关（armed）与连败计数不在此处——它们属于
 * daemon 侧消费器（goal-loop.ts），重启即消失是设计约定（ADR-0002）。
 * 类型 only：浏览器构建经 @kclaw/core/protocol 引用本文件时不带 Node API。
 */
import type { Usage } from "../protocol/messages.js"

/**
 * 目标状态机。active = 消费器会在空闲边缘自续跑；paused = 用户暂停或
 * 守卫暂停（等待用户介入后 resume）；blocked = 等一次人工裁决（确认
 * 超时累计）后由用户恢复；complete = 终态（达成/不可能/任一上限），
 * 只剩 clear。paused 与 blocked 的区别只在暂停原因的语义呈现，恢复
 * 动作相同（resume 重新 armed）。
 */
export type GoalState = "active" | "paused" | "blocked" | "complete"

/**
 * complete 的两种判定器终态在 stoppedReason 里区分（met/impossible）；
 * paused 与 blocked 的区别只在暂停原因的语义呈现（blocked = 等人工
 * 裁决），恢复动作相同（resume 重新 armed）。
 */

/**
 * 终止/暂停原因码（complete 或 paused/blocked 停摆时的 stoppedReason）。
 * met/impossible = 判定器终态；round-limit = 连续自续轮数达上限；
 * budget-limit = 目标生命周期 token 预算耗尽（含收尾轮）；gate-exhausted
 * = 验收命令连续失败达上限；no-progress = 判定器连续判"无进展"；
 * permission = 确认超时累计（运行被人工裁决卡住）；judge-failed = 判定器
 * 熔断；run-error = 一轮运行出错（不自动重试，等用户）；user-stop =
 * 用户主动停止。
 */
export type GoalStopReason =
  | "met"
  | "impossible"
  | "round-limit"
  | "budget-limit"
  | "gate-exhausted"
  | "no-progress"
  | "permission"
  | "judge-failed"
  | "run-error"
  | "user-stop"

/** 判定器三值裁决。not_met = 继续跑；met/impossible = 终态。 */
export type GoalVerdict = "not_met" | "met" | "impossible"

/**
 * 目标快照（meta.goal 的形状）。计数字段由消费器在每次判定后经
 * goal.set 全量写回：rounds 是连续自续轮（任何 user 触发的 run 清零），
 * totalRounds 是生命周期累计；tokensUsed 含运行用量与判定器用量。
 */
export interface GoalSnapshot {
  /** 终态目标描述（用户给定的原文）。 */
  text: string
  /** 验收命令（沙箱内执行；全部通过才进判定器）。 */
  acceptance: string[]
  state: GoalState
  setAt: string
  /** 连续自续轮数（user 触发的 run 清零；达上限停 round-limit）。 */
  rounds: number
  /** 生命周期自续轮数累计（展示用）。 */
  totalRounds: number
  /** 生命周期 token 消耗（运行 usage + 判定器 usage 累计）。 */
  tokensUsed: number
  stoppedReason?: GoalStopReason
  stoppedAt?: string
  /** 停止/暂停时给用户看的一句话解释。 */
  stoppedNote?: string
  lastJudgeAt?: string
  lastJudgeVerdict?: GoalVerdict
  lastJudgeReason?: string
  /** 判定器要求的进展一句话（下一次续跑提示词带它）。 */
  lastJudgeProgress?: string
}

/** 一次判定器调用结果（含用量；解析失败走 GoalJudgeError 不落这里）。 */
export interface GoalJudgeResult {
  verdict: GoalVerdict
  reason: string
  progress?: string
  tokens: Usage
}

/** 一条验收命令的执行结果（goal.checked 事件与判定提示词共用）。 */
export interface GoalGateOutcome {
  command: string
  ok: boolean
  /** 沙箱内进程退出码；启动失败/超时为 null。 */
  exitCode: number | null
  /** 输出尾部（截断到展示上限；不截断全文进判定提示词）。 */
  outputTail: string
}

/**
 * 判定器失败分类：parse = 输出不是合法三值 JSON（含越界 verdict）；
 * transport = LLM 调用本身失败。两类分别计数，触发各自的熔断阈值。
 */
export type GoalJudgeErrorKind = "parse" | "transport"

export interface GoalJudgeError {
  kind: GoalJudgeErrorKind
  message: string
}
