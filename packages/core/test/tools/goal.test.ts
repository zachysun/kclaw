import { describe, it, expect, vi } from "vitest"
import { createGoalTools, type GoalToolHost } from "../../src/tools/goal.js"
import type { GoalSnapshot } from "../../src/goal/types.js"
import type { GoalView } from "../../src/protocol/goal.js"
import type { ToolExecutor } from "../../src/agent/tools.js"

const call = (t: { execute: ToolExecutor["execute"] }, args: unknown) => t.execute(args, { onOutput: () => {} })

const snap = (over: Partial<GoalSnapshot> = {}): GoalSnapshot => ({
  text: "跑到测试全绿",
  acceptance: ["pnpm test"],
  state: "active",
  setAt: "2026-10-19T00:00:00Z",
  rounds: 2,
  totalRounds: 10,
  tokensUsed: 1200,
  ...over,
})

const view = (goal: GoalSnapshot, armed = true): GoalView => ({
  goal,
  derived: { noProgressStreak: 0, gateFailStreak: 0 },
  armed,
  limits: { maxRounds: 10, tokenBudget: 2_000_000 },
})

function fakeHost(
  over: Partial<GoalToolHost> = {},
  initial?: GoalSnapshot,
): GoalToolHost & {
  setMock: ReturnType<typeof vi.fn>
  stopMock: ReturnType<typeof vi.fn>
  requestMock: ReturnType<typeof vi.fn>
} {
  let current: GoalSnapshot | undefined = initial
  const setMock = vi.fn((_: string, input: { text: string; acceptance: string[] }) => {
    current = snap({ ...input, rounds: 0, tokensUsed: 0 })
    return current
  })
  const stopMock = vi.fn(() => {
    const g = current!
    current = { ...g, state: "paused", stoppedReason: "user-stop" }
    return { goal: current, aborted: true, dropped: 1 }
  })
  const requestMock = vi.fn(() => true)
  const host: GoalToolHost = {
    set: setMock,
    pause: () => {
      current = { ...current!, state: "paused" }
      return current!
    },
    resume: () => {
      current = { ...current!, state: "active", stoppedReason: undefined }
      return current!
    },
    userStop: stopMock,
    view: () => (current === undefined ? undefined : view(current)),
    requestCheck: requestMock,
    ...over,
  }
  return Object.assign(host, { setMock, stopMock, requestMock })
}

describe("goal tools", () => {
  it("create_goal starts a loop and reports it armed", async () => {
    const h = fakeHost()
    const t = createGoalTools({ host: h, sessionId: "ses_1" })
    const r = await call(t.create_goal, { text: "修好构建", acceptance: ["pnpm build"] })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("armed + 首轮入队")
    expect(h.setMock).toHaveBeenCalledWith("ses_1", { text: "修好构建", acceptance: ["pnpm build"] })
  })

  it("create_goal refuses while a live goal exists; a completed one frees the slot", async () => {
    const h = fakeHost({ view: () => view(snap({ state: "paused" })) })
    const t = createGoalTools({ host: h, sessionId: "ses_1" })
    const r = await call(t.create_goal, { text: "另一个" })
    expect(r.status).toBe("error")
    expect(r.output).toContain("已有目标")
    const done = createGoalTools({ host: fakeHost({ view: () => view(snap({ state: "complete", stoppedReason: "met" })) }), set: fakeHost().setMock })
    const r2 = await call(done.create_goal, { text: "新目标" })
    expect(r2.status).toBe("ok")
  })

  it("create_goal validates args", async () => {
    const t = createGoalTools({ host: fakeHost(), sessionId: "s" })
    expect((await call(t.create_goal, {})).status).toBe("error")
    expect((await call(t.create_goal, { text: "x", acceptance: "nope" })).status).toBe("error")
    expect((await call(t.create_goal, { text: "x", acceptance: [""] })).status).toBe("error")
  })

  it("get_goal renders the view; no goal renders the empty state", async () => {
    const t = createGoalTools({ host: fakeHost({}, snap()), sessionId: "s" })
    const r = await call(t.get_goal, {})
    expect(r.status).toBe("ok")
    expect(r.output).toContain("跑到测试全绿")
    expect(r.output).toContain("验收命令：pnpm test")
    const none = createGoalTools({ host: fakeHost({ view: () => undefined }), sessionId: "s" })
    expect((await call(none.get_goal, {})).output).toContain("没有目标")
  })

  it("update_goal complete requests a judge pass and never claims completion", async () => {
    const h = fakeHost({}, snap())
    const t = createGoalTools({ host: h, sessionId: "s" })
    const r = await call(t.update_goal, { action: "complete" })
    expect(r.status).toBe("ok")
    expect(h.requestMock).toHaveBeenCalledWith("s")
    expect(r.output).toContain("由判定器决定")
    // not kickable (e.g. mid-judging): honest fallback, still ok
    const h2 = fakeHost({ requestCheck: () => false }, snap())
    const r2 = await call(createGoalTools({ host: h2, sessionId: "s" }).update_goal, { action: "complete" })
    expect(r2.status).toBe("ok")
    expect(r2.output).toContain("run 边界自动进行")
  })

  it("update_goal pause/resume/stop map onto the host methods", async () => {
    const h = fakeHost({}, snap())
    const t = createGoalTools({ host: h, sessionId: "s" })
    expect((await call(t.update_goal, { action: "pause" })).output).toContain("已暂停")
    expect((await call(t.update_goal, { action: "resume" })).output).toContain("已恢复")
    const stop = await call(t.update_goal, { action: "stop" })
    expect(stop.output).toContain("已停止")
    expect(h.stopMock).toHaveBeenCalled()
    expect((await call(t.update_goal, { action: "teleport" })).status).toBe("error")
  })

  it("update_goal surfaces host errors (no goal etc.)", async () => {
    const h = fakeHost({
      view: () => undefined,
      pause: () => {
        throw new Error("本会话没有目标")
      },
    })
    const t = createGoalTools({ host: h, sessionId: "s" })
    const r = await call(t.update_goal, { action: "pause" })
    expect(r.status).toBe("error")
    expect(r.output).toContain("本会话没有目标")
  })

  it("risk classification: create/update sensitive+serial, get safe+parallel", () => {
    const t = createGoalTools({ host: fakeHost(), sessionId: "s" })
    expect(t.create_goal.risk).toBe("sensitive")
    expect(t.update_goal.risk).toBe("sensitive")
    expect(t.create_goal.concurrency).toBe("serial")
    expect(t.get_goal.risk).toBe("safe")
    expect(t.get_goal.concurrency).toBe("parallel")
  })
})
