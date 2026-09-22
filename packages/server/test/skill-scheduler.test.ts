/**
 * Skill scheduler tests：空闲检查消费端的宿主行为（成功才清 / 失败重试 /
 * 重试上限 / 同批去重 / 门禁与关闭态）。fake 对齐调度器消费的
 * SkillEvolutionSystem 公开方法（照 memory-scheduler.test.ts 的先例）；
 * pendingFollowChecks/clearFollowCheck 用同一可变数组模拟账本，清了才不吐。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startSkillScheduler } from "../src/skill-scheduler.js"
import { SessionStore, defaultConfig } from "@kclaw/core"

let root: string
let sessions: SessionStore
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kclaw-sklsched-"))
  sessions = new SessionStore(join(root, "sessions"))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

interface FakeCheck { sessionId: string; endTurnAt: string }

function fakeSystem(over: Record<string, unknown> = {}) {
  // 真会话 id：调度器会对 meta 缺失的检查无条件清理，检查必须指向存在会话。
  const sid = sessions.create("t", undefined, "/w/kclaw").id
  const checks: FakeCheck[] = []
  const sys = {
    considerFollowCheck: vi.fn(() => ({ involved: false, names: [] })),
    triggerFollow: vi.fn(async () => undefined),
    pendingFollowChecks: vi.fn(() => [...checks]),
    clearFollowCheck: vi.fn((_workdir: string, sessionId: string) => {
      const i = checks.findIndex((c) => c.sessionId === sessionId)
      if (i >= 0) checks.splice(i, 1)
    }),
    lastActivity: vi.fn(() => ""),
    /** 测试用例借这里放检查（模拟 run 钩子已排的账）。 */
    checks,
    /** 真实存在的会话 id（meta 缺失清理用例需要"不存在"的 id，另行手写）。 */
    sid,
  }
  return Object.assign(sys, over)
}

function enabledConfig() {
  const cfg = structuredClone(defaultConfig)
  cfg.skills = { evolution: { enabled: true, idleMinutes: 10 } }
  return cfg
}

function start(sys: unknown, cfg = enabledConfig(), now = new Date("2026-08-29T10:11:00Z"), log?: (m: string) => void) {
  return startSkillScheduler({
    system: sys as never, sessions, config: cfg,
    workdirs: () => ["/w/kclaw"],
    intervalMs: 10, now: () => now,
    ...(log === undefined ? {} : { log }),
  })
}

const tick = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 30)) }

describe("startSkillScheduler", () => {
  it("a due check triggers follow and is cleared AFTER success (clear-after-success)", async () => {
    const sys = fakeSystem({
      lastActivity: vi.fn(() => "2026-08-29T09:59:00Z"), // 早于 endTurnAt：无新活动
    })
    sys.checks.push({ sessionId: sys.sid, endTurnAt: "2026-08-29T10:00:00Z" })
    const handle = start(sys)
    await tick()
    await handle.stop()
    expect(sys.triggerFollow).toHaveBeenCalledWith("/w/kclaw", sys.sid)
    expect(sys.clearFollowCheck).toHaveBeenCalledWith("/w/kclaw", sys.sid)
    expect(sys.checks).toHaveLength(0)
  })

  it("a failed trigger keeps the check for retry (no clear) until a success", async () => {
    // 挂起式触发器：失败由测试显式放行（真失败耗时远大于 sweep，压缩时钟下
    // 否则一个 tick 就会连败三次触发放弃——那是下一个用例的事）。
    let settle: ((err: Error | undefined) => void) | undefined
    const sys = fakeSystem({
      lastActivity: vi.fn(() => ""),
      triggerFollow: vi.fn(() => new Promise<void>((res, rej) => { settle = (err) => (err === undefined ? res() : rej(err)) })),
    })
    sys.checks.push({ sessionId: sys.sid, endTurnAt: "2026-08-29T10:00:00Z" })
    const handle = start(sys)
    await tick() // 首扫触发，挂起中
    expect(sys.triggerFollow).toHaveBeenCalledTimes(1)
    expect(sys.clearFollowCheck).not.toHaveBeenCalled()
    settle?.(new Error("provider 5xx")) // 失败 settle：检查保留
    await tick()
    expect(sys.clearFollowCheck).not.toHaveBeenCalled()
    expect(sys.checks).toHaveLength(1) // 失败批次不丢，同检查重试
    expect(sys.triggerFollow).toHaveBeenCalledTimes(2)
    settle?.(undefined) // 重试成功 → 成功才清
    await tick()
    await handle.stop()
    expect(sys.clearFollowCheck).toHaveBeenCalledWith("/w/kclaw", sys.sid)
    expect(sys.checks).toHaveLength(0)
  })

  it("abandons a check after MAX_ATTEMPTS consecutive failures (no infinite retry)", async () => {
    const sys = fakeSystem({
      lastActivity: vi.fn(() => ""),
      triggerFollow: vi.fn(async () => { throw new Error("still broken") }),
    })
    sys.checks.push({ sessionId: sys.sid, endTurnAt: "2026-08-29T10:00:00Z" })
    const logs: string[] = []
    const handle = start(sys, enabledConfig(), new Date("2026-08-29T10:11:00Z"), (m) => logs.push(m))
    await tick(); await tick()
    await handle.stop()
    // 3 次连败后放弃：检查已清，后续 sweep 不再触发
    expect(sys.triggerFollow).toHaveBeenCalledTimes(3)
    expect(sys.checks).toHaveLength(0)
    expect(logs.some((m) => m.includes("abandoned"))).toBe(true)
  })

  it("skips a check whose trigger is still in flight (no duplicate extraction)", async () => {
    let release: (() => void) | undefined
    const sys = fakeSystem({
      lastActivity: vi.fn(() => ""),
      triggerFollow: vi.fn(() => new Promise<void>((res) => { release = res })),
    })
    sys.checks.push({ sessionId: sys.sid, endTurnAt: "2026-08-29T10:00:00Z" })
    const handle = start(sys)
    await tick() // 首扫触发，promise 挂起
    expect(sys.triggerFollow).toHaveBeenCalledTimes(1)
    await tick() // 下个 sweep：同检查在飞 → 跳过
    expect(sys.triggerFollow).toHaveBeenCalledTimes(1)
    release?.()
    await handle.stop()
    expect(sys.clearFollowCheck).toHaveBeenCalledWith("/w/kclaw", sys.sid)
  })

  it("unconditionally clears a check whose session no longer exists (meta missing)", async () => {
    const sys = fakeSystem({ lastActivity: vi.fn(() => "") })
    // ses_gone 从未在 sessions 里创建：检查指向已删/不存在的会话
    sys.checks.push({ sessionId: "ses_gone", endTurnAt: "2026-08-29T10:00:00Z" })
    const handle = start(sys)
    await tick()
    await handle.stop()
    expect(sys.clearFollowCheck).toHaveBeenCalledWith("/w/kclaw", "ses_gone")
    expect(sys.triggerFollow).not.toHaveBeenCalled()
    expect(sys.checks).toHaveLength(0)
  })

  it("newer activity supersedes the check: cleared without triggering (I-1)", async () => {
    const sys = fakeSystem({ lastActivity: vi.fn(() => "2026-08-29T10:30:00Z") })
    sys.checks.push({ sessionId: sys.sid, endTurnAt: "2026-08-29T10:00:00Z" })
    const handle = start(sys)
    await tick()
    await handle.stop()
    expect(sys.clearFollowCheck).toHaveBeenCalledWith("/w/kclaw", sys.sid)
    expect(sys.triggerFollow).not.toHaveBeenCalled()
  })

  it("enabled=false or idleMinutes=0 consumes nothing", async () => {
    const sys = fakeSystem()
    sys.checks.push({ sessionId: sys.sid, endTurnAt: "2026-08-29T10:00:00Z" })
    const off = structuredClone(defaultConfig) // 默认 enabled=false
    const h1 = start(sys, off)
    await tick()
    await h1.stop()
    const zero = enabledConfig()
    zero.skills!.evolution!.idleMinutes = 0
    const h2 = start(sys, zero)
    await tick()
    await h2.stop()
    expect(sys.triggerFollow).not.toHaveBeenCalled()
    expect(sys.clearFollowCheck).not.toHaveBeenCalled()
    expect(sys.checks).toHaveLength(1)
  })

  it("idle window not yet elapsed: check stays pending (no trigger, no clear)", async () => {
    const sys = fakeSystem({ lastActivity: vi.fn(() => "") })
    sys.checks.push({ sessionId: sys.sid, endTurnAt: "2026-08-29T10:00:00Z" })
    // now 距 end_turn 5 分钟 < idleMinutes=10
    const handle = start(sys, enabledConfig(), new Date("2026-08-29T10:05:00Z"))
    await tick()
    await handle.stop()
    expect(sys.triggerFollow).not.toHaveBeenCalled()
    expect(sys.clearFollowCheck).not.toHaveBeenCalled()
    expect(sys.checks).toHaveLength(1)
  })
})
