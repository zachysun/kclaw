import { describe, it, expect } from "vitest"
import { mergeUsage, newMessage, newAssistantMessage, type AssistantMessage, type Usage } from "../../src/protocol/messages.js"

describe("newMessage", () => {
  it("creates user message with text blocks", () => {
    const m = newMessage("ses_1", "user", [{ id: "blk_1", type: "text", text: "hi" }])
    expect(m.role).toBe("user")
    expect(typeof m.createdAt).toBe("string")
  })
})

describe("newAssistantMessage", () => {
  it("carries model metadata", () => {
    const m: AssistantMessage = newAssistantMessage("ses_1", "glm-4.7", [])
    expect(m.model).toBe("glm-4.7")
    expect(m.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(m.stopReason).toBe("end_turn")
  })
})

describe("mergeUsage", () => {
  const u = (i: number, o: number, cacheRead?: number, cacheWrite?: number): Usage => ({
    inputTokens: i,
    outputTokens: o,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  })

  it("numeric fields sum; cache fields present in every input sum", () => {
    expect(mergeUsage(u(10, 5, 4, 1), u(20, 7, 6, 2))).toEqual(u(30, 12, 10, 3))
  })

  it("a cache field absent from ANY input poisons that field to absent (unknown, not partial sum)", () => {
    expect(mergeUsage(u(10, 5, 4), u(20, 7))).toEqual(u(30, 12))
    expect(mergeUsage(u(10, 5), u(20, 7, 6))).toEqual(u(30, 12))
  })

  it("undefined inputs are skipped; all-undefined degenerates to a zero usage without cache fields", () => {
    expect(mergeUsage(u(10, 5, 4), undefined, u(1, 1, 1))).toEqual(u(11, 6, 5))
    expect(mergeUsage()).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(mergeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})
