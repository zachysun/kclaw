import { describe, it, expect } from "vitest"
import { newMessage, newAssistantMessage, type AssistantMessage } from "../../src/protocol/messages.js"

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
