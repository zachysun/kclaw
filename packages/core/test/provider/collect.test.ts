import { describe, it, expect } from "vitest"
import { collectStreamText } from "../../src/provider/collect.js"
import type { LlmClient, LlmRequest, LlmStreamEvent } from "../../src/provider/types.js"

function fakeLlm(events: LlmStreamEvent[] | Error): LlmClient {
  return {
    async *stream(_req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      if (events instanceof Error) throw events
      for (const e of events) yield e
    },
  }
}

const req: LlmRequest = { model: "m", system: "s", messages: [], tools: [] }

describe("collectStreamText", () => {
  it("concatenates every text_delta across the stream", async () => {
    const llm = fakeLlm([
      { type: "text_delta", delta: "Hello" },
      { type: "thinking_delta", delta: "ignored" },
      { type: "text_delta", delta: ", " },
      { type: "tool_call_started", index: 0, callId: "c1", name: "t" },
      { type: "text_delta", delta: "world" },
      { type: "message_done", stopReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } },
    ])
    await expect(collectStreamText(llm, req)).resolves.toBe("Hello, world")
  })

  it("returns empty string for a stream with no text_delta", async () => {
    const llm = fakeLlm([{ type: "message_done", stopReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } }])
    await expect(collectStreamText(llm, req)).resolves.toBe("")
  })

  it("propagates stream errors to the caller", async () => {
    const llm = fakeLlm(new Error("boom"))
    await expect(collectStreamText(llm, req)).rejects.toThrow("boom")
  })
})
