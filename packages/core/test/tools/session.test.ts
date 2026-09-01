// packages/core/test/tools/session.test.ts
import { describe, expect, it } from "vitest"
import { createSessionTools } from "../../src/tools/session.js"
import { searchSessionEvents } from "../../src/tools/session-search.js"

describe("session_search tool", () => {
  it("formats hits as summary + excerpt lines", async () => {
    const tool = createSessionTools(async () => [
      { summary: "分界相关段摘要", excerpt: "…分界落在用户消息上…" },
    ])["session_search"]
    const res = await tool.execute({ query: "分界" })
    expect(res.status).toBe("ok")
    expect(res.output).toContain("分界相关段摘要")
    expect(res.output).toContain("…分界落在用户消息上…")
  })

  it("reports no content without a search fn or without hits", async () => {
    expect((await createSessionTools()["session_search"].execute({ query: "x" })).output).toBe("(无可检索内容)")
    const tool = createSessionTools(async () => [])["session_search"]
    expect((await tool.execute({ query: "x" })).output).toBe("(无可检索内容)")
  })

  it("rejects a missing query and clamps limit", async () => {
    const tool = createSessionTools()["session_search"]
    expect((await tool.execute({})).status).toBe("error")
  })
})

describe("searchSessionEvents", () => {
  it("在被压段里按查询词命中，返回摘要与原文片段", async () => {
    const events = [
      { type: "message", id: "m1", role: "user", blocks: [{ type: "text", text: "讨论权限引擎的 allow 规则" }], createdAt: "a" },
      { type: "message", id: "m2", role: "assistant", blocks: [{ type: "text", text: "好的" }], createdAt: "b" },
      { type: "compaction", at: "c", trigger: "auto", from: null, upto: "m2", messages: 2, segmentSummary: "权限引擎讨论", top: "t" },
    ]
    const hits = await searchSessionEvents(events as never, "权限引擎", 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.summary).toBe("权限引擎讨论")
  })

  it("无命中返回空", async () => {
    const hits = await searchSessionEvents([], "不存在的词", 5)
    expect(hits).toEqual([])
  })
})
