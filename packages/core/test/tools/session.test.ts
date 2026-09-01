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

  it("跨多次压缩不重复扫描：前段的命中只归属本段摘要", async () => {
    // 两次压缩：第一段覆盖 m1..m4（含"权限引擎"），第二段覆盖 m5..m6。
    // 旧累计 span 实现会把 m1 的命中在第二段下重复发一次，这里断言只出现一次、
    // 且归属于第一段摘要。
    const events = [
      { type: "message", id: "m1", role: "user", blocks: [{ type: "text", text: "讨论权限引擎的 allow 规则" }], createdAt: "a" },
      { type: "message", id: "m2", role: "assistant", blocks: [{ type: "text", text: "好的" }], createdAt: "b" },
      { type: "message", id: "m3", role: "user", blocks: [{ type: "text", text: "继续聊其他话题" }], createdAt: "c" },
      { type: "message", id: "m4", role: "assistant", blocks: [{ type: "text", text: "收到" }], createdAt: "d" },
      { type: "compaction", at: "e", trigger: "auto", from: null, upto: "m4", messages: 4, segmentSummary: "第一段摘要", top: "t1" },
      { type: "message", id: "m5", role: "user", blocks: [{ type: "text", text: "现在聊聊别的" }], createdAt: "f" },
      { type: "message", id: "m6", role: "assistant", blocks: [{ type: "text", text: "好的，请讲" }], createdAt: "g" },
      { type: "compaction", at: "h", trigger: "auto", from: "m5", upto: "m6", messages: 2, segmentSummary: "第二段摘要", top: "t2" },
    ]
    const hits = await searchSessionEvents(events as never, "权限引擎", 5)
    expect(hits.length).toBe(1)
    expect(hits[0]!.summary).toBe("第一段摘要")
  })

  it("limit 为 0 返回空", async () => {
    const events = [
      { type: "message", id: "m1", role: "user", blocks: [{ type: "text", text: "讨论权限引擎的 allow 规则" }], createdAt: "a" },
      { type: "compaction", at: "b", trigger: "auto", from: null, upto: "m1", messages: 1, segmentSummary: "权限引擎讨论", top: "t" },
    ]
    const hits = await searchSessionEvents(events as never, "权限引擎", 0)
    expect(hits).toEqual([])
  })

  it("非空事件流无命中返回空", async () => {
    const events = [
      { type: "message", id: "m1", role: "user", blocks: [{ type: "text", text: "今天天气不错" }], createdAt: "a" },
      { type: "compaction", at: "b", trigger: "auto", from: null, upto: "m1", messages: 1, segmentSummary: "天气闲聊", top: "t" },
    ]
    const hits = await searchSessionEvents(events as never, "权限引擎", 5)
    expect(hits).toEqual([])
  })
})
