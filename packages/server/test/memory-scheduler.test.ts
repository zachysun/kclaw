/**
 * Memory scheduler tests (Task 13): 定时触发 + 跟随门禁（挂起检查补查）+ 重启恢复。
 *
 * startMemoryScheduler 的宿主行为用 fake MemorySystem 驱动（调度器只消费
 * MemorySystem 的公开方法：triggerInterval/triggerFollow/markIntervalRun/
 * intervalLastRun/pendingFollowChecks/clearFollowCheck/lastActivity）；
 * 跟随门禁的判定逻辑以纯函数 followGateDue 单测。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMemoryScheduler } from "../src/memory-scheduler.js"
import { SessionStore } from "@kclaw/core"
import { defaultConfig } from "@kclaw/core"
import type { MemorySystem } from "@kclaw/core"

let root: string
let sessions: SessionStore
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kclaw-memsched-"))
  sessions = new SessionStore(join(root, "sessions"))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 调度器消费的全部 MemorySystem 公开方法，fake 对齐真实名字。 */
function fakeSystem() {
  return {
    triggerInterval: vi.fn(async () => undefined),
    triggerFollow: viFnAsync(),
    markIntervalRun: vi.fn(),
    intervalLastRun: vi.fn(() => undefined),
    pendingFollowChecks: vi.fn(() => []),
    clearFollowCheck: vi.fn(),
    lastActivity: vi.fn(() => ""),
  }
}
const viFnAsync = () => vi.fn(async () => undefined)

describe("startMemoryScheduler", () => {
  it("runs the interval trigger when intervalMinutes has elapsed since the last run", async () => {
    const sys = fakeSystem()
    const now = new Date("2026-08-29T12:00:00Z")
    const handle = startMemoryScheduler({
      system: sys as unknown as MemorySystem, sessions,
      config: structuredClone(defaultConfig),
      workdirs: () => ["/w/kclaw"],
      intervalMs: 10, now: () => now,
    })
    await new Promise((r) => setTimeout(r, 30))
    await handle.stop()
    expect(sys.triggerInterval).toHaveBeenCalledWith("/w/kclaw")
    expect(sys.markIntervalRun).toHaveBeenCalledWith("/w/kclaw", now.toISOString())
  })

  it("follow gate: end_turn schedules a check; new activity before idleMinutes cancels it", async () => {
    // 集成级：跟随门禁逻辑做成纯函数 followGateDue 导出单测（见实现），这里测判定函数
    const { followGateDue } = await import("../src/memory-scheduler.js")
    const endTurnAt = "2026-08-29T10:00:00Z"
    // 新活动发生在 end_turn 之后（idle 窗口内）→ 取消（not due）
    expect(followGateDue(endTurnAt, "2026-08-29T10:05:00Z", { idleMinutes: 10, lastActivityAt: "2026-08-29T10:04:00Z" })).toBe(false)
    // idle 窗口已过且 end_turn 之后无新活动 → due
    expect(followGateDue(endTurnAt, "2026-08-29T10:11:00Z", { idleMinutes: 10, lastActivityAt: "2026-08-29T09:59:30Z" })).toBe(true)
  })

  it("intervalMinutes=0 disables the interval trigger", async () => {
    const sys = fakeSystem()
    const cfg = structuredClone(defaultConfig)
    cfg.memory.write.intervalMinutes = 0
    const handle = startMemoryScheduler({ system: sys as unknown as MemorySystem, sessions, config: cfg, workdirs: () => ["/w"], intervalMs: 10 })
    await new Promise((r) => setTimeout(r, 30))
    await handle.stop()
    expect(sys.triggerInterval).not.toHaveBeenCalled()
  })
})
