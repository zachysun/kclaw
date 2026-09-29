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
  decideGoalRound,
  deriveGoalLoop,
  firstRoundUserText,
  goalLoopNote,
  goalPreGateGuard,
  judgeGoal,
  runAcceptanceGates,
  GOAL_MAX_ROUNDS,
  GOAL_TOKEN_BUDGET,
} from "@kclaw/core"
import type {
  DerivedLoop,
  EnqueueInput,
  GoalGateOutcome,
  GoalJudgeResult,
  GoalSnapshot,
  GoalStopReason,
  LlmClient,
  QueueNote,
  SessionStore,
  UsageStore,
  KclawConfig,
} from "@kclaw/core"
import { resolveRunModelLine } from "@kclaw/core"
import { createExecSandbox } from "@kclaw/core/sandbox"
import type { GoalView, SessionEvent } from "@kclaw/core/protocol"
import { createTracker } from "./host-kit.js"

/** 进程内运行时：armed 是 ADR-0002 的核心（重启后目标在、循环不续）。 */
interface GoalRuntime {
  armed: boolean
  judging: boolean
  windDownPending: boolean
  /** 最近一次入队的 goal 轮 messageId（clear 时撤销还没跑的排队轮）。 */
  lastEnqueuedMessageId?: string
}

/**
 * host 消费的 RunManager 切片：测试假对象实现这一面即可，不必手搓整个
 * RunManager（真 RunManager 结构满足本接口，daemon 原样传入）。
 */
export interface GoalRunQueue {
  busy(sessionId: string): boolean
  queue(sessionId: string): readonly unknown[]
  submit(sessionId: string, input: EnqueueInput): { messageId: string }
  stopAndClear(sessionId: string): { aborted: boolean; dropped: number }
  queueCancel(sessionId: string, messageId?: string): unknown
}

export interface GoalLoopDeps {
  config: KclawConfig
  sessions: SessionStore
  /** Late-bound RunManager getter（构造早于 RunManager，调用都在启动之后）。 */
  getRun: () => GoalRunQueue
  usage: UsageStore
  /** daemon 启动时解析的默认模型串（compactSession 同款回退基底）。 */
  model: string
  /** provider 条目客户端解析（daemon 的 providerResolver.llm）。 */
  resolveEntryLlm: (entryKey?: string) => LlmClient
  /** 沙箱 home（~/.kclaw）。 */
  home: string
  /** 时钟接缝（时间敏感逻辑可注假时钟测试；缺省真实时间）。 */
  now?: () => Date
  log?: (message: string) => void
}

/** 判定器无进展的标记串正本在 core/goal prompt.ts（与判定提示词共用）。 */

export class GoalLoopHost {
  readonly #deps: GoalLoopDeps
  readonly #runtimes = new Map<string, GoalRuntime>()
  /** 进行中的检查（stop() 等待它们落定；记账骨架见 host-kit）。 */
  readonly #inFlight = createTracker()

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

  #now(): Date {
    return this.#deps.now?.() ?? new Date()
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
    const now = this.#now().toISOString()
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
    const now = this.#now().toISOString()
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
    const now = this.#now().toISOString()
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
      const now = this.#now().toISOString()
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
    this.#deps.sessions.appendGoalCleared(sessionId, { at: this.#now().toISOString(), hadState: goal.state })
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
    this.#inFlight.track(
      this.#check(sessionId)
        .catch(() => {}),
    )
  }

  /** daemon 停机：等所有进行中的检查落定（判定调用可能还在飞）。 */
  async dispose(): Promise<void> {
    await this.#inFlight.settleAll()
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
   * 一轮检查（副作用编排；九条停止条件与续跑决策的芯在 core/goal 的
   * check.ts）：派生计数 → 门前守卫 → 验收门 → 判定器 → 决策执行
   * （终态/停摆/收尾轮/续跑入队）。互斥由 rt.judging 保证；判定器 await
   * 之后重新校验 armed 与快照状态（用户可能在等待期间 stop/pause/clear
   * ——审计照留，状态机只在仍 active 时推进）。
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

      // 停止条件①②（门执行前的守卫）与③-⑨的裁决芯在 core/goal
      //（goalPreGateGuard / decideGoalRound），这里只执行副作用。
      const guard = goalPreGateGuard(loop)
      if (guard !== undefined) {
        this.#persistStop(sessionId, loop, guard.reason, guard.note)
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
        // 审计与用量无条件写：判定已花掉的 token 不能因用户中途停摆而失踪。
        if (judged.ok) {
          sessions.appendGoalChecked(sessionId, {
            at: this.#now().toISOString(),
            round,
            gates,
            verdict: judged.result.verdict,
            reason: judged.result.reason,
            ...(judged.result.progress !== undefined ? { progress: judged.result.progress } : {}),
            tokens: judged.result.tokens,
          })
          usage.record({
            sessionId,
            runId: `goal-judge-${round}-${this.#now().getTime()}`,
            model: judge.model,
            inputTokens: judged.result.tokens.inputTokens,
            outputTokens: judged.result.tokens.outputTokens,
            at: this.#now().toISOString(),
          })
        } else {
          sessions.appendGoalChecked(sessionId, { at: this.#now().toISOString(), round, gates, judgeError: judged.error })
        }
      } else {
        sessions.appendGoalChecked(sessionId, { at: this.#now().toISOString(), round, gates })
      }
      if (!alive()) return

      // ④⑤ 裁决分支与判定器/门失败分支：决策与注入文本由 decideGoalRound 给出。
      const decision = decideGoalRound({ goal, loop, gates, judged, windDownPending: rt.windDownPending })
      if (decision.kind === "complete") {
        this.#persistComplete(sessionId, decision.loop, decision.reason, decision.judged)
        return
      }
      if (decision.kind === "stop") {
        if (decision.refreshFirst) this.#refreshCounters(sessionId, decision.loop, decision.judge)
        this.#persistStop(sessionId, decision.loop, decision.reason, decision.note)
        return
      }
      // 非终态：先写回计数（与判定摘要），预算超限的收尾轮置标记后入队。
      this.#refreshCounters(sessionId, decision.loop, decision.judge)
      if (decision.kind === "winddown") rt.windDownPending = true
      this.#enqueueRound(sessionId, { ...goal, totalRounds: loop.totalRounds }, decision.injection, decision.enqueueRound)
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

  /** 判定器客户端与模型线：config.goals.judge 命中条目优先，否则会话模型线（与 run 组装同一优先级链）。 */
  #judgeClient(sessionModel: string | undefined): { llm: LlmClient; model: string } {
    const { config, resolveEntryLlm } = this.#deps
    const judgeKey = config.goals?.judge ?? ""
    const resolved = judgeKey !== "" && config.providers.entries[judgeKey] !== undefined
      ? resolveRunModelLine(config, { inputModel: judgeKey })
      : resolveRunModelLine(config, { sessionModel, launchModel: this.#deps.model })
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
    const now = this.#now().toISOString()
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
    const now = this.#now().toISOString()
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
    const now = this.#now().toISOString()
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
   * 事件派生（纯函数在 core/goal 的 derive.ts：一次前向扫描 goal.set(create)
   * 之后的所有事件）。这里只负责读事件流；读流失败按空事件派生（全零回退）。
   */
  #derive(sessionId: string): DerivedLoop {
    let events: SessionEvent[]
    try {
      events = this.#deps.sessions.readEvents(sessionId)
    } catch {
      return deriveGoalLoop([])
    }
    return deriveGoalLoop(events)
  }
}
