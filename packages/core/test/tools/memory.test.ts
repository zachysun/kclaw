import { describe, it, expect, vi } from "vitest"
import { createMemoryTools } from "../../src/tools/memory.js"
import type { MemorySystem } from "../../src/memory/system.js"

function fakeSystem() {
  return {
    triggerImmediate: vi.fn(async () => undefined),
    searchAll: vi.fn(async () => [
      { kind: "episode" as const, scope: "project:kclaw-abc123", label: "经历 · 重连线", text: "指数退避消灭了风暴" },
      { kind: "cognition" as const, scope: "global", label: "认知 · 通用规则", text: "始终中文回复" },
    ]),
  } as unknown as MemorySystem
}

describe("memory_save", () => {
  it("triggers immediate write for the current turn and returns ok", async () => {
    const sys = fakeSystem()
    const { memory_save } = createMemoryTools({ system: sys, sessionId: "ses_1", workdir: "/w", immediateEnabled: true })
    const res = await memory_save.execute({ text: "记住这个重连结论" }, { onOutput: () => {} })
    expect(res.status).toBe("ok")
    expect(sys.triggerImmediate).toHaveBeenCalledWith("ses_1")
  })
  it("returns the closed-mode error text when immediate is disabled (tool stays registered)", async () => {
    const sys = fakeSystem()
    const { memory_save } = createMemoryTools({ system: sys, sessionId: "ses_1", workdir: "/w", immediateEnabled: false })
    const res = await memory_save.execute({ text: "记住" }, { onOutput: () => {} })
    expect(res.status).toBe("error")
    expect(res.output).toContain("memory.write.immediate=false")
    expect(res.output).toContain("后台定时/跟随触发时沉淀")
    expect(sys.triggerImmediate).not.toHaveBeenCalled()
  })
  it("rejects unknown args but no longer accepts tags", async () => {
    const { memory_save } = createMemoryTools({ system: fakeSystem(), sessionId: "s", workdir: "/w", immediateEnabled: true })
    const res = await memory_save.execute({ text: "x", tags: ["a"] }, { onOutput: () => {} })
    expect(res.status).toBe("ok") // tags 被忽略（不报错），text 照常触发
  })
})

describe("memory_search", () => {
  it("returns labeled cross-store hits", async () => {
    const { memory_search } = createMemoryTools({ system: fakeSystem(), sessionId: "s", workdir: "/w", immediateEnabled: true })
    const res = await memory_search.execute({ query: "重连" }, { onOutput: () => {} })
    expect(res.status).toBe("ok")
    expect(res.output).toContain("[经历]")
    expect(res.output).toContain("[认知]")
    expect(res.output).toContain("project:kclaw-abc123")
  })
  it("empty result message", async () => {
    const sys = { searchAll: vi.fn(async () => []) } as unknown as MemorySystem
    const { memory_search } = createMemoryTools({ system: sys, sessionId: "s", workdir: "/w", immediateEnabled: true })
    const res = await memory_search.execute({ query: "x" }, { onOutput: () => {} })
    expect(res.output).toContain("没有")
  })
})
