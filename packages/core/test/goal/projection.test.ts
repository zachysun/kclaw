/**
 * /goal 事件投影接缝测试（issue #47）：goal.set 全量替换进 meta.goal、
 * goal.cleared 删除、goal.checked 只留痕不动投影（含 updatedAt 口径）；
 * run.started 的 trigger "goal" 在事件流里可用（派生计数的前提）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../../src/session/store.js"
import type { GoalSnapshot } from "../../src/goal/types.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-goal-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return { text: "测试全过", acceptance: [], state: "active", setAt: "2026-01-01T00:00:00.000Z", rounds: 0, totalRounds: 0, tokensUsed: 0, ...overrides }
}

describe("goal events projection", () => {
  it("goal.set(create) lands the snapshot in meta.goal and advances updatedAt", () => {
    const s = new SessionStore(dir)
    const m = s.create("目标会话")
    const before = s.meta(m.id)!.updatedAt
    s.appendGoalSet(m.id, { at: "2026-01-02T00:00:00.000Z", op: "create", goal: snapshot({ rounds: 1, totalRounds: 1, tokensUsed: 42 }) })
    const after = s.meta(m.id)!
    expect(after.goal).toMatchObject({ text: "测试全过", state: "active", rounds: 1, totalRounds: 1, tokensUsed: 42 })
    expect(after.updatedAt).toBe("2026-01-02T00:00:00.000Z")
    expect(before).not.toBe("2026-01-02T00:00:00.000Z")
  })

  it("goal.set(state) replaces the snapshot wholesale (stop fields included)", () => {
    const s = new SessionStore(dir)
    const m = s.create("目标会话")
    s.appendGoalSet(m.id, { at: "2026-01-02T00:00:00.000Z", op: "create", goal: snapshot() })
    s.appendGoalSet(m.id, {
      at: "2026-01-03T00:00:00.000Z",
      op: "state",
      goal: snapshot({ state: "complete", stoppedReason: "met", stoppedAt: "2026-01-03T00:00:00.000Z", stoppedNote: "验收全过", lastJudgeVerdict: "met" }),
    })
    expect(s.meta(m.id)!.goal).toMatchObject({ state: "complete", stoppedReason: "met", lastJudgeVerdict: "met" })
  })

  it("goal.cleared removes the goal from the projection", () => {
    const s = new SessionStore(dir)
    const m = s.create("目标会话")
    s.appendGoalSet(m.id, { at: "2026-01-02T00:00:00.000Z", op: "create", goal: snapshot() })
    s.appendGoalCleared(m.id, { at: "2026-01-04T00:00:00.000Z", hadState: "complete" })
    expect(s.meta(m.id)!.goal).toBeUndefined()
  })

  it("goal.checked is audit-only: no projection change, no updatedAt advance", () => {
    const s = new SessionStore(dir)
    const m = s.create("目标会话")
    s.appendGoalSet(m.id, { at: "2026-01-02T00:00:00.000Z", op: "create", goal: snapshot() })
    const before = s.meta(m.id)!
    s.appendGoalChecked(m.id, {
      at: "2026-01-05T00:00:00.000Z",
      round: 1,
      gates: [{ command: "pnpm test", ok: true, exitCode: 0, outputTail: "green" }],
      verdict: "not_met",
      reason: "还差一个用例",
      progress: "过半",
      tokens: { inputTokens: 10, outputTokens: 4 },
    })
    expect(s.meta(m.id)).toEqual(before)
    // 留痕可从事件流读回（审计页渲染路径）。
    const checked = s.readEvents(m.id).filter((e) => e.type === "goal.checked")
    expect(checked).toHaveLength(1)
  })

  it("rebuilding meta from the stream replays goal events (event-sourcing round-trip)", () => {
    const s = new SessionStore(dir)
    const m = s.create("目标会话")
    s.appendGoalSet(m.id, { at: "2026-01-02T00:00:00.000Z", op: "create", goal: snapshot() })
    s.appendGoalSet(m.id, { at: "2026-01-03T00:00:00.000Z", op: "pause", goal: snapshot({ state: "paused", stoppedReason: "user-stop" }) })
    const rebuilt = new SessionStore(dir).meta(m.id)
    expect(rebuilt!.goal).toMatchObject({ state: "paused", stoppedReason: "user-stop" })
  })

  it("run.started accepts trigger goal and round-trips through the stream", () => {
    const s = new SessionStore(dir)
    const m = s.create("目标会话")
    s.appendRunStarted(m.id, { at: "2026-01-02T00:00:00.000Z", trigger: "goal" })
    const events = s.readEvents(m.id)
    expect(events.some((e) => e.type === "run.started" && e.trigger === "goal")).toBe(true)
  })
})
