/**
 * Builtin hook 声明守卫：三个压缩钩子必须不限时（meta.timeoutMs =
 * Infinity）。它们的函数体是两次 provider 调用，时长由 LLM 决定——迁移前
 * 内联代码本就不限时；一旦这条声明丢失，5 秒链预算会把每次真实压缩掐成
 * 失败并甩出一个后台重复压缩（2026-09-09 线上复现过）。
 */
import { describe, it, expect } from "vitest"
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
