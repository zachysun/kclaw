import { describe, it, expect } from "vitest"
import { collectStreamResult, collectStreamText } from "../../src/provider/collect.js"
import type { LlmClient, LlmRequest, LlmStreamEvent } from "../../src/provider/types.js"

function fakeLlm(events: LlmStreamEvent[] | Error): LlmClient {
  return {
    async *stream(_req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      if (events instanceof Error) throw events
      for (const e of events) yield e
    },
  }
}

function fakeLlmStreamingForever(): LlmClient {
  return {
    async *stream(_req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      for (;;) {
        yield { type: "text_delta", delta: "x" }
      }
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

  it("signal 中止时抛错且不返回部分文本", async () => {
    const controller = new AbortController()
    const llm = fakeLlmStreamingForever()
    const p = collectStreamText(llm, { model: "m", system: "", messages: [], tools: [] }, { signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toThrow()
  })
})

describe("collectStreamResult", () => {
  it("returns the text and the message_done usage", async () => {
    const llm = fakeLlm([
      { type: "text_delta", delta: "摘要" },
      { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 800, outputTokens: 120 } },
    ])
    await expect(collectStreamResult(llm, req)).resolves.toEqual({
      text: "摘要",
      usage: { inputTokens: 800, outputTokens: 120 },
    })
  })

  it("usage stays undefined when the stream ends without message_done", async () => {
    const llm = fakeLlm([{ type: "text_delta", delta: "x" }])
    const res = await collectStreamResult(llm, req)
    expect(res.text).toBe("x")
    expect(res.usage).toBeUndefined()
  })
})
