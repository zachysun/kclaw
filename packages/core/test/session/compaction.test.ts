import { describe, expect, it } from "vitest"
import { newAssistantMessage, newMessage } from "../../src/protocol/messages.js"
import { estimateContextTokens, estimateTokens } from "../../src/session/compaction.js"

describe("estimateTokens", () => {
  it("charges CJK 0.75/char and ASCII 0.25/char, ceil", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("ab")).toBe(1)          // 2 * 0.25 = 0.5 → 1
    expect(estimateTokens("你好")).toBe(2)         // 2 * 0.75 = 1.5 → 2
    expect(estimateTokens("a你好")).toBe(2)        // 0.25 + 1.5 = 1.75 → 2
  })
})

describe("estimateContextTokens", () => {
  it("anchors on the last assistant usage and estimates only newer messages", () => {
    const u1 = newMessage("s", "user", [{ id: "b1", type: "text", text: "问".repeat(400) }])
    const a1 = newAssistantMessage("s", "m", [{ id: "b2", type: "text", text: "答" }])
    a1.usage = { inputTokens: 10_000, outputTokens: 5 }
    const u2 = newMessage("s", "user", [{ id: "b3", type: "text", text: "你好".repeat(100) }])
    const est = estimateContextTokens([u1, a1, u2], "新问题")
    // 10_000 anchor + 200 CJK chars (150) + "新问题" (3 chars → ceil(2.25) = 3)
    expect(est).toBeGreaterThanOrEqual(10_000 + 150 + 3)
    expect(est).toBeLessThan(10_000 + 200)
  })

  it("estimates everything when no assistant message exists", () => {
    const u = newMessage("s", "user", [{ id: "b1", type: "text", text: "你好" }])
    expect(estimateContextTokens([u])).toBeGreaterThanOrEqual(2)
  })
})
