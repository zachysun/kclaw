/**
 * /goal 循环消费器（issue #47）：daemon 侧的驱动主机。挂在 RunManager
 * 的空闲边缘（onSessionIdle，与 team host 同一接缝）——每次队列排空时
 * 对设有 active 目标且 armed 的会话做一轮检查：跑验收门（沙箱）→ 调
 * 判定器（独立 LLM）→ 按裁决续跑或停摆。
 *
 * 计数全部从事件流派生（events.jsonl 唯一真相）：totalRounds/tokensUsed
 * 从 goal.set(create) 起算；连续轮数在 user 触发的 run 处断开；无进展/
 * 门失败/判定器连败各自从尾部 goal.checked 回溯（不同类结果互相断开）。
 * 进程内只留无法从事件恢复的东西：armed（自续开关，重启即失——ADR-0002
 * 的设计约定）、judging（检查互斥）、windDownPending（收尾轮标记，与
 * armed 同生灭故无需持久）、lastEnqueuedMessageId（clear 撤销排队轮）。
 * 快照里的计数字段是检查时刻的投影缓存，展示用。
 */
import {
  continuationUserText,
  firstRoundUserText,
  gateFailureUserText,
  goalLoopNote,
  judgeGoal,
  judgeUnavailableUserText,
  runAcceptanceGates,
  windDownUserText,
  GOAL_APPROVAL_TIMEOUT_ROUNDS,
  GOAL_GATE_EXHAUSTED,
  GOAL_JUDGE_PARSE_BREAKER,
  GOAL_JUDGE_TRANSPORT_BREAKER,
  GOAL_MAX_ROUNDS,
  GOAL_NO_PROGRESS_LIMIT,
  GOAL_TOKEN_BUDGET,
} from "@kclaw/core"
import type { GoalGateOutcome, GoalJudgeResult, GoalSnapshot, GoalStopReason, LlmClient, QueueNote, SessionStore, UsageStore, KclawConfig } from "@kclaw/core"
import { resolveRunModel } from "@kclaw/core"
import { createExecSandbox } from "@kclaw/core/sandbox"
import type { GoalCheckedEvent, SessionEvent } from "@kclaw/core/protocol"
import type { RunManager } from "./run.js"

/** 进程内运行时：armed 是 ADR-0002 的核心（重启后目标在、循环不续）。 */
interface GoalRuntime {
  armed: boolean
  judging: boolean
  windDownPending: boolean
  /** 最近一次入队的 goal 轮 messageId（clear 时撤销还没跑的排队轮）。 */
  lastEnqueuedMessageId?: string
}

/** 检查时刻从事件流派生的循环状态（单次前向扫描的产物）。 */
export interface DerivedLoop {
  /** 生命周期自续轮数（自 goal.set create 起）。 */
  totalRounds: number
  /** 连续自续轮数（user 触发的 run 断开）。 */
  rounds: number
  /** 生命周期 token 消耗（run 用量 + 判定器用量）。 */
  tokensUsed: number
  /** 判定器连续判无进展的次数。 */
  noProgressStreak: number
  /** 验收门连续失败轮数。 */
  gateFailStreak: number
  /** 连续解析失败的判定次数。 */
  parseFails: number
  /** 连续传输失败的判定次数。 */
  transportFails: number
  /** 连续含确认超时的 run 数。 */
  approvalTimeoutStreak: number
  /** 最后一个完成的 run（无 run 时 undefined）。 */
  lastRun: { trigger: string; stopReason: string } | undefined
}

export interface GoalLoopDeps {
  config: KclawConfig
  sessions: SessionStore
  /** Late-bound RunManager getter（构造早于 RunManager，调用都在启动之后）。 */
  getRun: () => RunManager
  usage: UsageStore
  /** daemon 启动时解析的默认模型串（compactSession 同款回落基底）。 */
  model: string
  /** provider 条目客户端解析（daemon 的 providerResolver.llm）。 */
  resolveEntryLlm: (entryKey?: string) => LlmClient
  /** 沙箱 home（~/.kclaw）。 */
  home: string
  log?: (message: string) => void
}

/** 路由/命令消费的只读视图：快照 + 派生计数 + 进程内开关状态。 */
export interface GoalView {
  goal: GoalSnapshot
  derived: DerivedLoop
  armed: boolean
  /** 机械上限的当前值（前端展示"第 N/M 轮"用）。 */
  limits: { maxRounds: number; tokenBudget: number }
}

/** 判定器无进展的标记串（提示词约定：没有进展就写「无」）。 */
const NO_PROGRESS_MARK = "无"

export class GoalLoopHost {
  readonly #deps: GoalLoopDeps
  readonly #runtimes = new Map<string, GoalRuntime>()
  /** 进行中的检查（stop() 等待它们落定）。 */
  readonly #inFlight = new Set<Promise<void>>()

  constructor(deps: GoalLoopDeps) {
    this.#deps = deps
  }

  #runtime(sessionId: string): GoalRuntime {
    let rt = this.#runtimes.get(sessionId)
    if (rt === undefined) {
      rt = { armed: false, judging: false, windDownPending: false }
      this.#runtimes.set(sessionId, rt)
    }
    return rt
  }

  #log(message: string): void {
    this.#deps.log?.(message)
  }

  /** 快照当前值（无目标/无会话返回 undefined）。 */
  snapshot(sessionId: string): GoalSnapshot | undefined {
    return this.#deps.sessions.meta(sessionId)?.goal
  }

  /** 路由/命令的只读视图（无目标返回 undefined）。 */
  view(sessionId: string): GoalView | undefined {
    const goal = this.snapshot(sessionId)
    if (goal === undefined) return undefined
    return {
      goal,
      derived: this.#derive(sessionId),
      armed: this.#runtime(sessionId).armed,
      limits: { maxRounds: GOAL_MAX_ROUNDS, tokenBudget: GOAL_TOKEN_BUDGET },
    }
  }

  /**
   * 设定或改写目标。create = armed + 立即发第一轮（会话忙则按 wait 排
   * 队）；edit 总是重新起跑（改了目标文本还停在 paused 没有道理）——
   * 状态回 active、停摆字段清空、判定摘要清空，计数沿旧 epoch 继续。
   * 带验收命令时要求沙箱可用（验收门将免审自动执行，不可沙箱化就不
   * 接受——fail-closed）。
   */
  set(sessionId: string, input: { text: string; acceptance: string[] }): GoalSnapshot {
    const { sessions } = this.#deps
    const meta = sessions.meta(sessionId)
    if (meta === undefined) throw new Error("session not found")
    if (meta.parentSessionId !== undefined) throw new Error("子代理会话不设置目标（只读会话）")
    const text = input.text.trim()
    if (text === "") throw new Error("目标描述不能为空")
    const acceptance = input.acceptance.map((a) => a.trim()).filter((a) => a !== "")
    if (acceptance.length > 0) {
      const sandbox = this.#sandbox(meta.workdir)
      if (!sandbox.available) {
        throw new Error(`验收命令需要可用的 exec 沙箱（${sandbox.unavailableReason ?? "未知原因"}）；去掉验收命令或启用沙箱后重试`)
      }
    }
    const existing = meta.goal
    const now = new Date().toISOString()
    const isCreate = existing === undefined
    const goal: GoalSnapshot = isCreate
      ? { text, acceptance, state: "active", setAt: now, rounds: 0, totalRounds: 0, tokensUsed: 0 }
      : {
          ...existing,
          text,
          acceptance,
          state: "active",
          stoppedReason: undefined,
          stoppedAt: undefined,
          stoppedNote: undefined,
          lastJudgeAt: undefined,
          lastJudgeVerdict: undefined,
          lastJudgeReason: undefined,
          lastJudgeProgress: undefined,
        }
    sessions.appendGoalSet(sessionId, { at: now, op: isCreate ? "create" : "edit", goal })
    const rt = this.#runtime(sessionId)
    rt.armed = true
    rt.windDownPending = false
    if (isCreate) this.#enqueueRound(sessionId, goal, firstRoundUserText(goal), 1)
    else this.#kick(sessionId)
    return goal
  }

  /** 用户暂停：停自续（活跃 run 不动——用户可另行停止）。 */
  pause(sessionId: string): GoalSnapshot {
    const goal = this.#requireGoal(sessionId, "pause")
    const now = new Date().toISOString()
    const next: GoalSnapshot = { ...goal, state: "paused" }
    this.#deps.sessions.appendGoalSet(sessionId, { at: now, op: "pause", goal: next })
    this.#runtime(sessionId).armed = false
    return next
  }

  /** 恢复：armed 并立刻检查（空闲则马上续跑；忙则等空闲边缘）。 */
  resume(sessionId: string): GoalSnapshot {
    const goal = this.snapshot(sessionId)
    if (goal === undefined) throw new Error("本会话没有目标")
    if (goal.state === "complete") throw new Error("目标已终态（达成/不可能），只能 clear 或改写")
    const now = new Date().toISOString()
    const next: GoalSnapshot = { ...goal, state: "active", stoppedReason: undefined, stoppedAt: undefined, stoppedNote: undefined }
    this.#deps.sessions.appendGoalSet(sessionId, { at: now, op: "resume", goal: next })
    const rt = this.#runtime(sessionId)
    rt.armed = true
    rt.windDownPending = false
    this.#kick(sessionId)
    return next
  }

  /** 用户停止：掐活跃 run + 清排队 + paused(user-stop) + 停摆。 */
  userStop(sessionId: string): { goal: GoalSnapshot; aborted: boolean; dropped: number } {
    const goal = this.snapshot(sessionId)
    if (goal === undefined) throw new Error("本会话没有目标")
    const { aborted, dropped } = this.#deps.getRun().stopAndClear(sessionId)
    let next = goal
    if (goal.state !== "complete") {
      const now = new Date().toISOString()
      next = { ...goal, state: "paused", stoppedReason: "user-stop", stoppedAt: now, stoppedNote: "用户停止了目标循环" }
      this.#deps.sessions.appendGoalSet(sessionId, { at: now, op: "pause", goal: next })
    }
    const rt = this.#runtime(sessionId)
    rt.armed = false
    rt.windDownPending = false
    return { goal: next, aborted, dropped }
  }

  /** 移除目标（终态或停摆后清理；排队中的 goal 轮一并撤销）。 */
  clear(sessionId: string): { hadState: GoalSnapshot["state"] } {
    const goal = this.snapshot(sessionId)
    if (goal === undefined) throw new Error("本会话没有目标")
    const rt = this.#runtimes.get(sessionId)
    if (rt?.lastEnqueuedMessageId !== undefined) {
      this.#deps.getRun().queueCancel(sessionId, rt.lastEnqueuedMessageId)
    }
    this.#deps.sessions.appendGoalCleared(sessionId, { at: new Date().toISOString(), hadState: goal.state })
    this.#runtimes.delete(sessionId)
    return { hadState: goal.state }
  }

  /** 空闲边缘入口（daemon 的 onSessionIdle 链）：fire-and-forget 一轮检查。 */
  onIdle(sessionId: string): void {
    this.#kick(sessionId)
  }

  #kick(sessionId: string): void {
    const rt = this.#runtime(sessionId)
    if (!rt.armed || rt.judging) return
    const goal = this.snapshot(sessionId)
    if (goal === undefined || goal.state !== "active") return
    const p = this.#check(sessionId)
      .catch(() => {})
      .finally(() => {
        this.#inFlight.delete(p)
      })
    this.#inFlight.add(p)
  }

  /** daemon 停机：等所有进行中的检查落定（判定调用可能还在飞）。 */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#inFlight])
  }

  #sandbox(workdir: string | undefined) {
    const { config, home } = this.#deps
    return createExecSandbox(config.sandbox ?? { enabled: false, writeRoots: [] }, {
      workspace: workdir ?? config.workspace,
      home,
    })
  }

  #requireGoal(sessionId: string, action: string): GoalSnapshot {
    const goal = this.snapshot(sessionId)
    if (goal === undefined) throw new Error("本会话没有目标")
    if (goal.state === "complete") throw new Error(`目标已终态，不能 ${action}（可 clear 或改写）`)
    return goal
  }

  /**
   * 一轮检查（九条停止条件在此汇合）：派生计数 → run 出错/确认超时守卫
   * → 验收门 → 判定器 → 裁决分支（终态/无进展/预算/轮数上限/熔断）→
   * 续跑。互斥由 rt.judging 保证；判定器 await 之后重新校验 armed 与快
   * 照状态（用户可能在等待期间 stop/pause/clear——审计照留，状态机只在
   * 仍 active 时推进）。
   */
  async #check(sessionId: string): Promise<void> {
    const { sessions, getRun, config, usage } = this.#deps
    const run = getRun()
    const rt = this.#runtime(sessionId)
    const goal = this.snapshot(sessionId)
    if (goal === undefined || goal.state !== "active" || !rt.armed) return
    if (run.busy(sessionId) || run.queue(sessionId).length > 0) return
    rt.judging = true
    try {
      const loop = this.#derive(sessionId)
      const alive = (): boolean => rt.armed && this.snapshot(sessionId)?.state === "active"

      // ① 上一轮 run 出错：不自动重试，等用户。
      if (loop.lastRun !== undefined && loop.lastRun.stopReason === "error") {
        this.#persistStop(sessionId, loop, "run-error", "上一轮运行出错，目标循环暂停（不自动重试）")
        return
      }
      // ② 确认超时连败：循环被人工裁决卡住，转 blocked 等用户。
      if (loop.approvalTimeoutStreak >= GOAL_APPROVAL_TIMEOUT_ROUNDS) {
        this.#persistStop(sessionId, loop, "permission", `连续 ${loop.approvalTimeoutStreak} 轮出现确认超时（无人在场裁决），目标循环暂停`)
        return
      }
      // ③ 验收门（短路判定器：失败输出即下一轮的修正指引）。
      const meta = sessions.meta(sessionId)
      if (meta === undefined) return
      const gates: GoalGateOutcome[] =
        goal.acceptance.length > 0
          ? await runAcceptanceGates(this.#sandbox(meta.workdir), goal.acceptance, meta.workdir ?? config.workspace)
          : []
      // goal.checked 的 round 记刚完成/正在评判的轮位（自续轮生命周期计数）。
      const round = loop.totalRounds
      const gateFailed = gates.some((g) => !g.ok)
      let judged: Awaited<ReturnType<typeof judgeGoal>> | undefined
      if (!gateFailed) {
        const judge = this.#judgeClient(meta.model)
        judged = await judgeGoal({
          llm: judge.llm,
          model: judge.model,
          goal,
          gates,
          messages: sessions.readMessages(sessionId),
        })
        // 审计与用量无条件落：判定已花掉的 token 不能因用户中途停摆而失踪。
        if (judged.ok) {
          sessions.appendGoalChecked(sessionId, {
            at: new Date().toISOString(),
            round,
            gates,
            verdict: judged.result.verdict,
            reason: judged.result.reason,
            ...(judged.result.progress !== undefined ? { progress: judged.result.progress } : {}),
            tokens: judged.result.tokens,
          })
          usage.record({
            sessionId,
            runId: `goal-judge-${round}-${Date.now()}`,
            model: judge.model,
            inputTokens: judged.result.tokens.inputTokens,
            outputTokens: judged.result.tokens.outputTokens,
            at: new Date().toISOString(),
          })
        } else {
          sessions.appendGoalChecked(sessionId, { at: new Date().toISOString(), round, gates, judgeError: judged.error })
        }
      } else {
        sessions.appendGoalChecked(sessionId, { at: new Date().toISOString(), round, gates })
      }
      if (!alive()) return

      // ④ 裁决分支。
      if (judged !== undefined && judged.ok) {
        const result = judged.result
        const tokensUsed = loop.tokensUsed + result.tokens.inputTokens + result.tokens.outputTokens
        const withJudge: DerivedLoop = { ...loop, tokensUsed }
        if (result.verdict === "met") {
          this.#persistComplete(sessionId, withJudge, "met", result)
          return
        }
        if (result.verdict === "impossible") {
          this.#persistComplete(sessionId, withJudge, "impossible", result)
          return
        }
        const noProgress = result.progress === undefined || result.progress.trim() === "" || result.progress.trim() === NO_PROGRESS_MARK
        const noProgStreak = noProgress ? loop.noProgressStreak + 1 : 0
        const guarded: DerivedLoop = { ...withJudge, noProgressStreak: noProgStreak }
        this.#refreshCounters(sessionId, guarded, result)
        // 收尾轮已跑过判定：无论进展如何，预算终停（met 已在上面返回）。
        if (rt.windDownPending) {
          rt.windDownPending = false
          this.#persistStop(sessionId, guarded, "budget-limit", `目标生命周期 token 预算（${GOAL_TOKEN_BUDGET}）已耗尽，收尾轮完成`)
          return
        }
        if (noProgStreak >= GOAL_NO_PROGRESS_LIMIT) {
          this.#persistStop(sessionId, guarded, "no-progress", `判定器连续 ${noProgStreak} 轮未见进展`)
          return
        }
        const cont = this.#continueDecision(sessionId, rt, guarded, loop.rounds)
        if (cont) return
        this.#enqueueRound(sessionId, { ...goal, totalRounds: loop.totalRounds }, continuationUserText({ ...goal, totalRounds: loop.totalRounds }, result, gates), round)
        return
      }

      // ⑤ 判定器失败 / 门失败分支（都不再消耗判定 token）。
      const gateStreak = gateFailed ? loop.gateFailStreak + 1 : loop.gateFailStreak
      const parseFails = judged !== undefined && !judged.ok && judged.error.kind === "parse" ? loop.parseFails + 1 : loop.parseFails
      const transportFails = judged !== undefined && !judged.ok && judged.error.kind === "transport" ? loop.transportFails + 1 : loop.transportFails
      const mixed: DerivedLoop = { ...loop, gateFailStreak: gateStreak, parseFails, transportFails }
      if (gateFailed) {
        if (gateStreak >= GOAL_GATE_EXHAUSTED) {
          this.#persistStop(sessionId, mixed, "gate-exhausted", `验收命令连续 ${gateStreak} 轮未通过`)
          return
        }
        this.#refreshCounters(sessionId, mixed)
        if (rt.windDownPending) {
          rt.windDownPending = false
          this.#persistStop(sessionId, mixed, "budget-limit", `目标生命周期 token 预算（${GOAL_TOKEN_BUDGET}）已耗尽，收尾轮完成`)
          return
        }
        const cont = this.#continueDecision(sessionId, rt, mixed, loop.rounds)
        if (cont) return
        this.#enqueueRound(sessionId, { ...goal, totalRounds: loop.totalRounds }, gateFailureUserText(goal, gates, gateStreak), round)
        return
      }
      // 判定器失败：熔断判定 + fail-open 续跑。
      const breaker =
        parseFails >= GOAL_JUDGE_PARSE_BREAKER || transportFails >= GOAL_JUDGE_TRANSPORT_BREAKER
      this.#refreshCounters(sessionId, mixed)
      if (breaker) {
        const error = judged !== undefined && !judged.ok ? judged.error : undefined
        this.#persistStop(sessionId, mixed, "judge-failed", `判定器连续失败已熔断（${error?.message ?? "未知错误"}）`)
        return
      }
      if (rt.windDownPending) {
        rt.windDownPending = false
        this.#persistStop(sessionId, mixed, "budget-limit", `目标生命周期 token 预算（${GOAL_TOKEN_BUDGET}）已耗尽，收尾轮完成`)
        return
      }
      const cont = this.#continueDecision(sessionId, rt, mixed, loop.rounds)
      if (cont) return
      const error = judged !== undefined && !judged.ok ? judged.error : { kind: "parse" as const, message: "unknown" }
      this.#enqueueRound(sessionId, { ...goal, totalRounds: loop.totalRounds }, judgeUnavailableUserText(goal, error.kind, error.kind === "parse" ? parseFails : transportFails), round)
    } catch (err) {
      // 检查自身故障不静默：停摆并说明，用户可 resume 重试。
      this.#log(`check failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
      try {
        this.#persistStop(sessionId, this.#derive(sessionId), "judge-failed", `检查流程故障：${err instanceof Error ? err.message : String(err)}`)
      } catch {
        // 派生也失败（事件流不可读）——armed 关掉保平安。
        rt.armed = false
      }
    } finally {
      rt.judging = false
    }
  }

  /**
   * 续跑前的公共闸门（预算/轮数上限，判定器失败与裁决分支共用）：
   * 预算超限 → 标记收尾轮并入队 wrap-up（返回 true = 已处理）；
   * 连续轮数达上限 → round-limit 停摆（true）；否则 false 继续入队。
   */
  #continueDecision(sessionId: string, rt: GoalRuntime, loop: DerivedLoop, consecutiveRounds: number): boolean {
    if (loop.tokensUsed >= GOAL_TOKEN_BUDGET) {
      rt.windDownPending = true
      const goal = this.snapshot(sessionId)
      if (goal !== undefined) {
        this.#enqueueRound(sessionId, { ...goal, totalRounds: loop.totalRounds }, windDownUserText(goal), loop.totalRounds + 1)
      }
      return true
    }
    if (consecutiveRounds + 1 > GOAL_MAX_ROUNDS) {
      this.#persistStop(sessionId, loop, "round-limit", `连续自续 ${GOAL_MAX_ROUNDS} 轮未达成（发一条消息可重置计数并继续）`)
      return true
    }
    return false
  }

  /** 判定器客户端与模型线：config.goals.judge 命中条目优先，否则会话模型线。 */
  #judgeClient(sessionModel: string | undefined): { llm: LlmClient; model: string } {
    const { config, resolveEntryLlm } = this.#deps
    const judgeKey = config.goals?.judge ?? ""
    if (judgeKey !== "" && config.providers.entries[judgeKey] !== undefined) {
      const resolved = resolveRunModel(config, judgeKey)
      return { llm: resolveEntryLlm(resolved.entryKey), model: resolved.model }
    }
    const defaultModel = config.providers.entries[config.providers.default]?.model || this.#deps.model || ""
    const resolved = resolveRunModel(config, sessionModel ?? defaultModel)
    return { llm: resolveEntryLlm(resolved.entryKey), model: resolved.model }
  }

  /** 入队一轮 goal run（submit 抛错按停摆处理并说明原因）。 */
  #enqueueRound(sessionId: string, goal: GoalSnapshot, userText: string, round: number): void {
    const note: QueueNote = { kind: "goal", text: goalLoopNote(round) }
    try {
      const result = this.#deps.getRun().submit(sessionId, { userText, trigger: "goal", note })
      this.#runtime(sessionId).lastEnqueuedMessageId = result.messageId
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.#log(`enqueue round ${round} for ${sessionId} failed: ${message}`)
      this.#persistStop(sessionId, this.#derive(sessionId), undefined, `自动续跑入队失败：${message}`)
    }
  }

  /** 停摆落一条 goal.set(state)：permission → blocked，其余 paused。 */
  #persistStop(sessionId: string, loop: DerivedLoop, reason: GoalStopReason | undefined, note: string): void {
    const goal = this.snapshot(sessionId)
    if (goal === undefined) return
    const state = reason === "permission" ? "blocked" : "paused"
    const now = new Date().toISOString()
    const next: GoalSnapshot = {
      ...goal,
      state,
      rounds: loop.rounds,
      totalRounds: loop.totalRounds,
      tokensUsed: loop.tokensUsed,
      ...(reason !== undefined ? { stoppedReason: reason, stoppedAt: now } : {}),
      stoppedNote: note,
    }
    this.#deps.sessions.appendGoalSet(sessionId, { at: now, op: "state", goal: next })
    const rt = this.#runtime(sessionId)
    rt.armed = false
    rt.windDownPending = false
    this.#log(`${sessionId} → ${state}${reason !== undefined ? ` (${reason})` : ""}: ${note}`)
  }

  #persistComplete(sessionId: string, loop: DerivedLoop, reason: "met" | "impossible", judged: GoalJudgeResult): void {
    const goal = this.snapshot(sessionId)
    if (goal === undefined) return
    const now = new Date().toISOString()
    const next: GoalSnapshot = {
      ...goal,
      state: "complete",
      rounds: loop.rounds,
      totalRounds: loop.totalRounds,
      tokensUsed: loop.tokensUsed,
      stoppedReason: reason,
      stoppedAt: now,
      stoppedNote: judged.reason,
      lastJudgeAt: now,
      lastJudgeVerdict: judged.verdict,
      lastJudgeReason: judged.reason,
      ...(judged.progress !== undefined ? { lastJudgeProgress: judged.progress } : {}),
    }
    this.#deps.sessions.appendGoalSet(sessionId, { at: now, op: "state", goal: next })
    const rt = this.#runtime(sessionId)
    rt.armed = false
    rt.windDownPending = false
    this.#log(`${sessionId} complete (${reason}): ${judged.reason}`)
  }

  /** 检查时刻把派生计数同步进快照（goal.set(state) 只更新计数与判定摘要）。 */
  #refreshCounters(sessionId: string, loop: DerivedLoop, judge?: GoalJudgeResult): void {
    const goal = this.snapshot(sessionId)
    if (goal === undefined) return
    const now = new Date().toISOString()
    const next: GoalSnapshot = {
      ...goal,
      rounds: loop.rounds,
      totalRounds: loop.totalRounds,
      tokensUsed: loop.tokensUsed,
      ...(judge !== undefined
        ? {
            lastJudgeAt: now,
            lastJudgeVerdict: judge.verdict,
            lastJudgeReason: judge.reason,
            ...(judge.progress !== undefined ? { lastJudgeProgress: judge.progress } : {}),
          }
        : {}),
    }
    this.#deps.sessions.appendGoalSet(sessionId, { at: now, op: "state", goal: next })
  }

  /**
   * 事件派生：一次前向扫描 goal.set(create) 之后的所有事件。run 边界配
   * 对出 {trigger, stopReason, 含确认超时}；goal.checked 派生判定/门连
   * 败与用量。尾部连败回溯规则：同性质的检查连续累积，任何不同性质的
   * 检查（成功裁决/另一类失败/门通过）都断开计数。
   */
  #derive(sessionId: string): DerivedLoop {
    const zero: DerivedLoop = {
      totalRounds: 0, rounds: 0, tokensUsed: 0, noProgressStreak: 0, gateFailStreak: 0,
      parseFails: 0, transportFails: 0, approvalTimeoutStreak: 0, lastRun: undefined,
    }
    let events: SessionEvent[]
    try {
      events = this.#deps.sessions.readEvents(sessionId)
    } catch {
      return zero
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
      if (
        c.verdict === "not_met" &&
        (c.progress === undefined || c.progress.trim() === "" || c.progress.trim() === NO_PROGRESS_MARK)
      ) {
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
}
