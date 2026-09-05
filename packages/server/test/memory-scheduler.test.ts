/**
 * Memory scheduler tests (Task 13 + 审查补测)：定时触发 + 跟随门禁（挂起检查补查）+ 重启恢复。
 *
 * startMemoryScheduler 的宿主行为用 fake MemorySystem 驱动（调度器只消费
 * MemorySystem 的公开方法：triggerInterval/triggerFollow/markIntervalRun/
 * intervalLastRun/pendingFollowChecks/clearFollowCheck/lastActivity）；
 * 跟随门禁的判定逻辑以纯函数 followGateDue 单测，调度器消费路径（due→clear+trigger、
 * 新活动超越→clear 不 trigger、interval 未到期→不触发、idleMinutes=0→不消费）各有集成用例。
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

const viFnAsync = () => vi.fn(async () => undefined)

/** 调度器消费的全部 MemorySystem 公开方法，fake 对齐真实名字；可按用例覆盖。 */
function fakeSystem(over: Record<string, unknown> = {}) {
  return {
    triggerInterval: vi.fn(async () => undefined),
    triggerFollow: viFnAsync(),
    triggerNightly: viFnAsync(),
    recentSessionId: vi.fn(() => undefined),
    markIntervalRun: vi.fn(),
    markNightlyRun: vi.fn(),
    intervalLastRun: vi.fn(() => undefined),
    nightlyLastRun: vi.fn(() => undefined),
    pendingFollowChecks: vi.fn(() => []),
    clearFollowCheck: vi.fn(),
    lastActivity: vi.fn(() => ""),
    ...over,
  }
}

describe("startMemoryScheduler", () => {
  it("runs the interval trigger when intervalMinutes has elapsed since the last run", async () => {
    const sys = fakeSystem()
    const now = new Date("2026-08-29T12:00:00Z")
    // 定时触发无显式归属会话：pipeline 内部对全部会话逐个补增量，调度器只传 workdir
    sessions.create("t", undefined, "/w/kclaw")
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

  it("interval: an unexpired intervalLastRun skips triggerInterval (非首跑)", async () => {
    const sys = fakeSystem({ intervalLastRun: vi.fn(() => "2026-08-29T11:59:00Z") })
    const now = new Date("2026-08-29T12:00:00Z") // 距上次 1 分钟 < intervalMinutes=30
    const handle = startMemoryScheduler({
      system: sys as unknown as MemorySystem, sessions,
      config: structuredClone(defaultConfig),
      workdirs: () => ["/w/kclaw"],
      intervalMs: 10, now: () => now,
    })
    await new Promise((r) => setTimeout(r, 30))
    await handle.stop()
    expect(sys.triggerInterval).not.toHaveBeenCalled()
  })

  it("follow gate: a due check is cleared and triggers triggerFollow", async () => {
    const sys = fakeSystem({
      pendingFollowChecks: vi.fn(() => [{ sessionId: "ses_a", endTurnAt: "2026-08-29T10:00:00Z" }]),
      lastActivity: vi.fn(() => "2026-08-29T09:59:00Z"), // 早于 endTurnAt：无新活动
    })
    const now = new Date("2026-08-29T10:11:00Z") // idle 窗口（10 分钟）已过
    const handle = startMemoryScheduler({
      system: sys as unknown as MemorySystem, sessions,
      config: structuredClone(defaultConfig), // idleMinutes=10
      workdirs: () => ["/w/kclaw"],
      intervalMs: 10, now: () => now,
    })
    await new Promise((r) => setTimeout(r, 30))
    await handle.stop()
    expect(sys.clearFollowCheck).toHaveBeenCalledWith("/w/kclaw", "ses_a")
    expect(sys.triggerFollow).toHaveBeenCalledWith("/w/kclaw", "ses_a")
  })

  it("follow gate: newer activity supersedes the check — cleared but NOT triggered (I-1)", async () => {
    const sys = fakeSystem({
      pendingFollowChecks: vi.fn(() => [{ sessionId: "ses_a", endTurnAt: "2026-08-29T10:00:00Z" }]),
      lastActivity: vi.fn(() => "2026-08-29T10:30:00Z"), // 晚于 endTurnAt：新活动超越锚点
    })
    const now = new Date("2026-08-29T10:11:00Z")
    const handle = startMemoryScheduler({
      system: sys as unknown as MemorySystem, sessions,
      config: structuredClone(defaultConfig),
      workdirs: () => ["/w/kclaw"],
      intervalMs: 10, now: () => now,
    })
    await new Promise((r) => setTimeout(r, 30))
    await handle.stop()
    // I-1：旧检查让位 → clear；但被超越的锚点不触发 follow 提取
    expect(sys.clearFollowCheck).toHaveBeenCalledWith("/w/kclaw", "ses_a")
    expect(sys.triggerFollow).not.toHaveBeenCalled()
  })

  it("follow gate: end_turn schedules a check; new activity before idleMinutes cancels it", async () => {
    // 集成级：跟随门禁逻辑做成纯函数 followGateDue 导出单测（见实现），这里测判定函数
    const { followGateDue } = await import("../src/memory-scheduler.js")
    const endTurnAt = "2026-08-29T10:00:00Z"
    // 新活动发生在 end_turn 之后（idle 窗口内）→ 取消（not due）
    expect(followGateDue(endTurnAt, "2026-08-29T10:05:00Z", { idleMinutes: 10, lastActivityAt: "2026-08-29T10:04:00Z" })).toBe(false)
    // idle 窗口已过且 end_turn 之后无新活动 → due
    expect(followGateDue(endTurnAt, "2026-08-29T10:11:00Z", { idleMinutes: 10, lastActivityAt: "2026-08-29T09:59:30Z" })).toBe(true)
    // 边界（M-6）：end_turn 时刻的活动不取消（activity == end → 判 due）
    expect(followGateDue(endTurnAt, "2026-08-29T10:11:00Z", { idleMinutes: 10, lastActivityAt: endTurnAt })).toBe(true)
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

  it("nightly: triggers after consolidateHour when not yet run today; records the LOCAL date", async () => {
    const now = new Date("2026-08-29T12:00:00Z") // 本地小时在常见时区（东八 = 20 点）≥ 3
    const meta = sessions.create("t", undefined, "/w/kclaw")
    // 判据归 core 后（卡⑤），归属会话由 system.recentSessionId 提供——stub 直接送出刚建的会话
    const sys = fakeSystem({ recentSessionId: vi.fn(() => meta.id) })
    const handle = startMemoryScheduler({
      system: sys as unknown as MemorySystem, sessions,
      config: structuredClone(defaultConfig),
      workdirs: () => ["/w/kclaw"],
      intervalMs: 10, now: () => now,
    })
    await new Promise((r) => setTimeout(r, 30))
    await handle.stop()
    expect(sys.triggerNightly).toHaveBeenCalledWith("/w/kclaw", meta.id)
    // 期望日期按本机时区现算，断言在任何时区都成立
    const p = (n: number): string => String(n).padStart(2, "0")
    const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    expect(sys.markNightlyRun).toHaveBeenCalledWith("/w/kclaw", today)
  })

  it("nightly: already run today (local date) skips the trigger", async () => {
    const now = new Date("2026-08-29T12:00:00Z")
    const p = (n: number): string => String(n).padStart(2, "0")
    const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    const sys = fakeSystem({ nightlyLastRun: vi.fn(() => today) })
    const handle = startMemoryScheduler({
      system: sys as unknown as MemorySystem, sessions,
      config: structuredClone(defaultConfig),
      workdirs: () => ["/w/kclaw"],
      intervalMs: 10, now: () => now,
    })
    await new Promise((r) => setTimeout(r, 30))
    await handle.stop()
    expect(sys.triggerNightly).not.toHaveBeenCalled()
    expect(sys.markNightlyRun).not.toHaveBeenCalled()
  })

  it("nightly: negative consolidateHour disables the branch", async () => {
    const sys = fakeSystem()
    const cfg = structuredClone(defaultConfig)
    cfg.memory.consolidateHour = -1
    const handle = startMemoryScheduler({ system: sys as unknown as MemorySystem, sessions, config: cfg, workdirs: () => ["/w/kclaw"], intervalMs: 10 })
    await new Promise((r) => setTimeout(r, 30))
    await handle.stop()
    expect(sys.triggerNightly).not.toHaveBeenCalled()
    expect(sys.markNightlyRun).not.toHaveBeenCalled()
  })

  it("idleMinutes=0 disables the follow branch entirely (no check consumption)", async () => {
    const sys = fakeSystem({
      pendingFollowChecks: vi.fn(() => [{ sessionId: "ses_a", endTurnAt: "2026-08-29T10:00:00Z" }]),
    })
    const cfg = structuredClone(defaultConfig)
    cfg.memory.write.idleMinutes = 0
    const handle = startMemoryScheduler({ system: sys as unknown as MemorySystem, sessions, config: cfg, workdirs: () => ["/w/kclaw"], intervalMs: 10 })
    await new Promise((r) => setTimeout(r, 30))
    await handle.stop()
    expect(sys.triggerFollow).not.toHaveBeenCalled()
    expect(sys.clearFollowCheck).not.toHaveBeenCalled()
  })
})
