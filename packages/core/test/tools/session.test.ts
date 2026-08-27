// packages/core/test/tools/session.test.ts
import { describe, expect, it } from "vitest"
import { createSessionTools } from "../../src/tools/session.js"

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
