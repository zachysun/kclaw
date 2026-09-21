/**
 * Builtin hook 声明守卫：三个压缩钩子必须不限时（meta.timeoutMs =
 * Infinity）。它们的函数体是两次 provider 调用，时长由 LLM 决定——迁移前
 * 内联代码本就不限时；一旦这条声明丢失，5 秒链预算会把每次真实压缩掐成
 * 失败并甩出一个后台重复压缩（2026-09-09 线上复现过）。
 */
import { describe, it, expect, vi } from "vitest"
import { makeBuiltinHooks, type BuiltinHookDeps } from "../../src/hooks/builtin.js"

describe("builtin hook meta", () => {
  it("mid-run-panic / overflow-emergency / post-run-compaction 不限时，其余内置走链默认", () => {
    // 构造期只闭包不调用：sessions/contextTokens 需存在即可
    const entries = makeBuiltinHooks({ config: { sessions: {} } } as unknown as BuiltinHookDeps)
    for (const name of ["mid-run-panic", "overflow-emergency", "post-run-compaction"]) {
      expect(entries.find((e) => e.meta.name === name)!.meta.timeoutMs).toBe(Number.POSITIVE_INFINITY)
    }
    expect(entries.find((e) => e.meta.name === "usage-ledger")!.meta.timeoutMs).toBeUndefined()
    expect(entries.find((e) => e.meta.name === "memory-inject")!.meta.timeoutMs).toBeUndefined()
  })
})

/**
 * skill-follow-check（run-after 40）：提案制技能进化的收尾粗查排检查。
 * 门禁四条：childRun 不排（记忆隔离同向）；功能未启用不排；idleMinutes=0
 * 不排；skillsEvolution 未装配不排。粗查失败不影响 run（钩子 failure=skip）。
 */
describe("skill-follow-check", () => {
  const baseConfig = (): Record<string, unknown> => ({
    skills: { evolution: { enabled: true, idleMinutes: 10 } },
  })

  function hookOf(deps: Record<string, unknown>): { handler: (ctx: unknown) => unknown; meta: { position: string; order: number } } {
    const entries = makeBuiltinHooks({ sessionId: "ses_a", config: baseConfig(), ...deps } as unknown as BuiltinHookDeps)
    const entry = entries.find((e) => e.meta.name === "skill-follow-check")!
    return { handler: entry.handler as (ctx: unknown) => unknown, meta: entry.meta }
  }
  const ctx = { outcome: { stopReason: "end_turn", totalUsage: { inputTokens: 0, outputTokens: 0 } }, model: "m" }

  it("registers at run-after order 40", () => {
    const { meta } = hookOf({})
    expect(meta.position).toBe("run-after")
    expect(meta.order).toBe(40)
  })

  it("schedules via skillsEvolution.considerFollowCheck when enabled", async () => {
    const consider = vi.fn(() => ({ involved: true, names: ["x"] }))
    const { handler } = hookOf({ skillsEvolution: { considerFollowCheck: consider } })
    await handler(ctx)
    expect(consider).toHaveBeenCalledWith("ses_a", expect.any(String), expect.anything())
  })

  it("skips for child runs, disabled config, idleMinutes 0, or missing skillsEvolution", async () => {
    const consider = vi.fn(() => ({ involved: false, names: [] }))
    const enabled = { skillsEvolution: { considerFollowCheck: consider } }
    await hookOf({ ...enabled, childRun: true }).handler(ctx)
    const off = baseConfig(); (off.skills as { evolution: { enabled: boolean } }).evolution.enabled = false
    await hookOf({ ...enabled, config: off }).handler(ctx)
    const zero = baseConfig(); (zero.skills as { evolution: { idleMinutes: number } }).evolution.idleMinutes = 0
    await hookOf({ ...enabled, config: zero }).handler(ctx)
    await hookOf({}).handler(ctx) // 未装配
    expect(consider).not.toHaveBeenCalled()
  })
})
