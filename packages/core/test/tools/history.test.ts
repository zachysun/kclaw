// packages/core/test/tools/history.test.ts
import { describe, expect, it } from "vitest"
import { createHistoryTool, type HistorySearchFn } from "../../src/tools/history.js"

describe("history_search tool", () => {
  it("reports unavailable without a search fn", async () => {
    const res = await createHistoryTool()["history_search"].execute({ query: "x" })
    expect(res.status).toBe("ok")
    expect(res.output).toBe("(历史检索不可用)")
  })

  it("passes the schema-declared session_id through as the session filter", async () => {
    const seen: Array<{ limit?: number; sessionId?: string }> = []
    const search: HistorySearchFn = async (_q, opts) => {
      seen.push(opts ?? {})
      return [{ sessionId: "s1", title: "某会话", role: "user", at: "2026-10-03", excerpt: "命中原文" }]
    }
    const res = await createHistoryTool(search)["history_search"].execute({ query: "q", session_id: "s1" })
    expect(res.status).toBe("ok")
    expect(seen[0]).toEqual({ limit: 5, sessionId: "s1" })
    expect(res.output).toContain("命中原文")
    expect(res.output).toContain("session: s1")
  })

  it("omits the filter when session_id is absent or empty", async () => {
    const seen: Array<{ limit?: number; sessionId?: string }> = []
    const search: HistorySearchFn = async (_q, opts) => {
      seen.push(opts ?? {})
      return []
    }
    const tool = createHistoryTool(search)["history_search"]
    await tool.execute({ query: "q" })
    await tool.execute({ query: "q", session_id: "" })
    expect(seen[0]).toEqual({ limit: 5 })
    expect(seen[1]).toEqual({ limit: 5 })
  })

  it("rejects a non-string session_id and reports no hits with the fixed line", async () => {
    const tool = createHistoryTool(async () => [])["history_search"]
    expect((await tool.execute({ query: "q", session_id: 3 })).status).toBe("error")
    expect((await tool.execute({ query: "q" })).output).toBe("(没有匹配的历史消息)")
  })
})
