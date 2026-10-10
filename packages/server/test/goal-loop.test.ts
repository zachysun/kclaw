/**
 * GoalLoopHost 驱动器接入口测试（issue #47）：真 SessionStore + 假
 * RunManager（记录 submit/stop）+ 脚本判定 LLM。每轮用
 * appendRunStarted/appendRunEnded 模拟引擎写入，onIdle 触发检查，
 * await dispose() 作为检查完成的同步点（它等所有 in-flight 检查落定）。
 * 覆盖：首轮入队、not_met 续跑、met/impossible 终态、run-error、
 * 熔断、轮数上限、无进展、预算收尾、暂停/恢复/停止/移除、重启 armed 语义。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore, loadConfig, resolvePaths, UsageStore } from "@kclaw/core"
import type { KclawConfig, LlmClient, LlmStreamEvent } from "@kclaw/core"
import { GoalLoopHost } from "../src/goal-loop.js"
import type { GoalRunQueue } from "../src/goal-loop.js"
import { GOAL_MAX_ROUNDS, GOAL_TOKEN_BUDGET } from "@kclaw/core"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-goalloop-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 判定脚本客户端：每次调用按序吐预设 JSON（同 daemon.test scriptClient）。 */
function judgeClient(script: string[]): LlmClient & { calls: number } {
  let i = 0
  return {
    calls: 0,
    async *stream(): AsyncIterable<LlmStreamEvent> {
      const self = this as LlmClient & { calls: number }
      self.calls += 1
      const text = script[Math.min(i++, script.length - 1)] ?? script[script.length - 1]!
      yield { type: "text_delta", delta: text }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }
    },
  }
}

function verdict(verdict: string, reason: string, progress: string): string {
  return JSON.stringify({ verdict, reason, progress })
}

interface Submitted {
  userText: string
  trigger: string
  note?: { kind: string; text: string }
}

/** 假 run 切片：只实现 GoalRunQueue 的面（记录 submit/stopAndClear，恒不忙）。 */
function fakeRun(): { run: GoalRunQueue; submitted: Submitted[]; stopCalls: () => number } {
  const submitted: Submitted[] = []
  let stopped = 0
  const run = {
    busy: () => false,
    queue: () => [],
    submit(_sessionId: string, input: { userText: string; trigger: string; note?: { kind: string; text: string } }) {
      submitted.push({ userText: input.userText, trigger: input.trigger, ...(input.note !== undefined ? { note: input.note } : {}) })
      return { messageId: `m_${submitted.length}`, queued: false, disposition: "wait" as const }
    },
    stopAndClear: () => {
      stopped += 1
      return { aborted: true, dropped: 0 }
    },
    queueCancel: () => ({ ok: true as const, cancelled: [] }),
  }
  return { run, submitted, stopCalls: () => stopped }
}

interface Harness {
  sessions: SessionStore
  host: GoalLoopHost
  llm: LlmClient & { calls: number }
  submitted: () => Submitted[]
  stopCalls: () => number
  sessionId: string
  config: KclawConfig
}

function makeHarness(judgeScript: string[]): Harness {
  const sessions = new SessionStore(join(dir, "s"))
  const config = loadConfig(resolvePaths(join(dir, "home")))
  config.sandbox = { enabled: false, writeRoots: [] }
  const { run, submitted, stopCalls } = fakeRun()
  const llm = judgeClient(judgeScript)
  const usage = new UsageStore(join(dir, "usage.db"))
  const host = new GoalLoopHost({
    config,
    sessions,
    getRun: () => run,
    usage,
    model: "mock-model",
    resolveEntryLlm: () => llm,
    home: join(dir, "home"),
  })
  const meta = sessions.create("目标会话")
  return { sessions, host, llm, submitted: () => submitted, stopCalls, sessionId: meta.id, config }
}

/** 模拟一轮 run 完成（引擎的写入动作）并驱动检查到落定。 */
async function driveRound(h: Harness, opts: { trigger?: string; stopReason?: string; usage?: { inputTokens: number; outputTokens: number } } = {}): Promise<void> {
  const at = new Date().toISOString()
  h.sessions.appendRunStarted(h.sessionId, { at, trigger: opts.trigger ?? "goal" })
  h.sessions.appendRunEnded(h.sessionId, { at, stopReason: (opts.stopReason ?? "end_turn") as "end_turn", usage: opts.usage ?? { inputTokens: 100, outputTokens: 50 } })
  h.host.onIdle(h.sessionId)
  await h.host.dispose()
}

function snapshotOf(h: Harness) {
  return h.sessions.meta(h.sessionId)!.goal!
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("GoalLoopHost", () => {
  it("create enqueues round 1 with the goal-start prompt and a goal note", async () => {
    const h = makeHarness([verdict("met", "好了", "完成")])
    h.host.set(h.sessionId, { text: "测试全过", acceptance: [] })
    const first = h.submitted()[0]!
    expect(first.trigger).toBe("goal")
    expect(first.userText).toContain("<goal-start>")
    expect(first.userText).toContain("测试全过")
    expect(first.note).toMatchObject({ kind: "goal" })
  })

  it("rejects acceptance commands when the sandbox is unavailable (fail-closed)", () => {
    const h = makeHarness([])
    expect(() => h.host.set(h.sessionId, { text: "目标", acceptance: ["pnpm test"] })).toThrow(/沙箱/)
  })

  it("met verdict completes the goal after round 1", async () => {
    const h = makeHarness([verdict("met", "验收命令全过", "完成")])
    h.host.set(h.sessionId, { text: "测试全过", acceptance: [] })
    await driveRound(h)
    const goal = snapshotOf(h)
    expect(goal.state).toBe("complete")
    expect(goal.stoppedReason).toBe("met")
    expect(goal.lastJudgeReason).toBe("验收命令全过")
    // 终态后不再入队。
    expect(h.submitted()).toHaveLength(1)
    expect(h.host.view(h.sessionId)!.armed).toBe(false)
  })

  it("not_met enqueues a continuation carrying the judge opinion", async () => {
    const h = makeHarness([verdict("not_met", "还差一个用例", "过半"), verdict("met", "好了", "完成")])
    h.host.set(h.sessionId, { text: "测试全过", acceptance: [] })
    await driveRound(h)
    const second = h.submitted()[1]!
    expect(second.userText).toContain("<goal-continue")
    expect(second.userText).toContain("还差一个用例")
    expect(snapshotOf(h).state).toBe("active")
    expect(snapshotOf(h).rounds).toBe(1)
    await driveRound(h)
    expect(snapshotOf(h).stoppedReason).toBe("met")
    expect(snapshotOf(h).totalRounds).toBe(2)
  })

  it("impossible verdict completes with the impossible reason", async () => {
    const h = makeHarness([verdict("impossible", "缺少前提", "无")])
    h.host.set(h.sessionId, { text: "不可能的目标", acceptance: [] })
    await driveRound(h)
    expect(snapshotOf(h)).toMatchObject({ state: "complete", stoppedReason: "impossible" })
  })

  it("an errored run pauses with run-error (no auto retry)", async () => {
    const h = makeHarness([verdict("met", "好了", "完成")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    await driveRound(h, { stopReason: "error" })
    expect(snapshotOf(h)).toMatchObject({ state: "paused", stoppedReason: "run-error" })
    expect(h.submitted()).toHaveLength(1)
  })

  it("three consecutive parse failures trip the judge breaker", async () => {
    const h = makeHarness(["不是 json", "还不是", "依旧不是"])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    await driveRound(h)
    await driveRound(h)
    await driveRound(h)
    // 每轮 check 内部自带一次重试：3 个脚本槽位即 3 轮失败。
    const goal = snapshotOf(h)
    expect(goal).toMatchObject({ state: "paused", stoppedReason: "judge-failed" })
    expect(h.submitted()).toHaveLength(3) // 前两轮 fail-open 续跑，第三轮熔断停
  })

  it("ten consecutive goal rounds without a user run stop at the round limit", async () => {
    const h = makeHarness([verdict("not_met", "继续", "推进了一点")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    for (let i = 0; i < GOAL_MAX_ROUNDS; i++) {
      await driveRound(h)
      if (i < GOAL_MAX_ROUNDS - 1) expect(snapshotOf(h).state).toBe("active")
    }
    expect(snapshotOf(h)).toMatchObject({ state: "paused", stoppedReason: "round-limit" })
    expect(snapshotOf(h).rounds).toBe(GOAL_MAX_ROUNDS)
    expect(h.submitted()).toHaveLength(GOAL_MAX_ROUNDS)
  })

  it("a user-triggered run clears the consecutive-round counter", async () => {
    const h = makeHarness([verdict("not_met", "继续", "推进了一点")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    for (let i = 0; i < GOAL_MAX_ROUNDS - 1; i++) await driveRound(h)
    expect(snapshotOf(h).state).toBe("active")
    // 用户消息触发的 run：连续计数归零。
    await driveRound(h, { trigger: "user" })
    expect(snapshotOf(h).rounds).toBe(0)
    expect(snapshotOf(h).state).toBe("active")
    // goal 轮重新计数，不再撞上限。
    await driveRound(h)
    expect(snapshotOf(h).rounds).toBe(1)
    expect(snapshotOf(h).state).toBe("active")
  })

  it("three no-progress verdicts stop the loop", async () => {
    const h = makeHarness([verdict("not_met", "原地打转", "无")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    await driveRound(h)
    await driveRound(h)
    await driveRound(h)
    expect(snapshotOf(h)).toMatchObject({ state: "paused", stoppedReason: "no-progress" })
  })

  it("token budget overruns get one wind-down round then budget-limit", async () => {
    const h = makeHarness([verdict("not_met", "继续", "推进")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    // 单轮 usage 顶到预算的 2/3：两轮即超。
    const big = { inputTokens: Math.floor(GOAL_TOKEN_BUDGET * 2 / 3), outputTokens: 0 }
    await driveRound(h, { usage: big })
    await driveRound(h, { usage: big })
    // 第三轮应是收尾轮（wrapup 文本），跑完后停 budget-limit。
    const last = h.submitted()[h.submitted().length - 1]!
    expect(last.userText).toContain("<goal-wrapup>")
    await driveRound(h, { usage: { inputTokens: 100, outputTokens: 50 } })
    expect(snapshotOf(h)).toMatchObject({ state: "paused", stoppedReason: "budget-limit" })
  })

  it("pause disarms; resume re-arms and continues on the next idle edge", async () => {
    const h = makeHarness([verdict("not_met", "继续", "推进"), verdict("met", "好了", "完成")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    await driveRound(h)
    expect(h.submitted()).toHaveLength(2)
    h.host.pause(h.sessionId)
    expect(snapshotOf(h).state).toBe("paused")
    // 暂停后：完成一轮也不续跑。
    await driveRound(h)
    expect(h.submitted()).toHaveLength(2)
    h.host.resume(h.sessionId)
    expect(snapshotOf(h).state).toBe("active")
    // resume 立即 kick：空闲会话马上检查（judge 出 met → 终态）。
    await h.host.dispose()
    await waitFor(() => snapshotOf(h).state === "complete")
    expect(snapshotOf(h).stoppedReason).toBe("met")
  })

  it("userStop aborts the run, persists user-stop and disarms", async () => {
    const h = makeHarness([])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    const r = h.host.userStop(h.sessionId)
    expect(r.goal).toMatchObject({ state: "paused", stoppedReason: "user-stop" })
    expect(h.host.view(h.sessionId)!.armed).toBe(false)
    // run 切片的 stopAndClear 真被调用，返回值原样透传。
    expect(h.stopCalls()).toBe(1)
    expect(r).toMatchObject({ aborted: true, dropped: 0 })
  })

  it("clear removes the goal and drops the queued round", async () => {
    const h = makeHarness([verdict("not_met", "继续", "推进")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    await driveRound(h)
    expect(snapshotOf(h).state).toBe("active")
    const out = h.host.clear(h.sessionId)
    expect(out.hadState).toBe("active")
    expect(snapshotOf(h)).toBeUndefined()
  })

  it("armed is process-local: a fresh host never continues an active goal (restart semantics)", async () => {
    const h = makeHarness([verdict("not_met", "继续", "推进")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    await driveRound(h)
    expect(snapshotOf(h).state).toBe("active")
    // 重启 = 新实例：快照还在、state 还是 active，但不 armed、不续跑。
    const sessions2 = new SessionStore(join(dir, "s"))
    const config2 = h.config
    const { run: run2 } = fakeRun()
    const host2 = new GoalLoopHost({
      config: config2,
      sessions: sessions2,
      getRun: () => run2,
      usage: new UsageStore(join(dir, "usage2.db")),
      model: "mock-model",
      resolveEntryLlm: () => judgeClient([]),
      home: join(dir, "home"),
    })
    expect(host2.view(h.sessionId)!.goal.state).toBe("active")
    expect(host2.view(h.sessionId)!.armed).toBe(false)
    host2.onIdle(h.sessionId)
    await host2.dispose()
    expect(host2.view(h.sessionId)!.goal.state).toBe("active") // 未推进
  })

  it("approval timeouts across consecutive runs block the loop (permission)", async () => {
    const h = makeHarness([verdict("not_met", "继续", "推进"), verdict("not_met", "继续", "推进")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    // 连续两轮 run 内各出现一次确认超时。
    for (let i = 0; i < 2; i++) {
      const at = new Date().toISOString()
      h.sessions.appendRunStarted(h.sessionId, { at, trigger: "goal" })
      h.sessions.appendPermissionDecided(h.sessionId, {
        at,
        confirmationId: `c_${i}`,
        decision: "timeout",
        by: "timeout",
        tool: { callId: "t", name: "exec", argsJson: "{}" },
      })
      h.sessions.appendRunEnded(h.sessionId, { at, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } })
      h.host.onIdle(h.sessionId)
      await h.host.dispose()
    }
    expect(snapshotOf(h)).toMatchObject({ state: "blocked", stoppedReason: "permission" })
  })

  it("view exposes derived counters and limits", async () => {
    const h = makeHarness([verdict("not_met", "继续", "推进")])
    h.host.set(h.sessionId, { text: "目标", acceptance: [] })
    await driveRound(h)
    const view = h.host.view(h.sessionId)!
    expect(view.derived.rounds).toBe(1)
    expect(view.derived.totalRounds).toBe(1)
    expect(view.derived.tokensUsed).toBeGreaterThan(150) // run 100+50 + judge 10+5
    expect(view.limits).toEqual({ maxRounds: GOAL_MAX_ROUNDS, tokenBudget: GOAL_TOKEN_BUDGET })
    expect(view.armed).toBe(true)
  })
})
