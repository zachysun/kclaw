import { describe, it, expect } from "vitest"
import { createAnthropicClient, ANTHROPIC_DEFAULT_MAX_TOKENS, ANTHROPIC_VERSION } from "../../src/provider/anthropic.js"
import type { LlmRequest } from "../../src/provider/types.js"

function sseResponse(events: object[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const REQ: LlmRequest = { model: "claude-sonnet-4", system: "sys", messages: [], tools: [] }

async function collect(client: { stream(r: LlmRequest): AsyncIterable<never> }, req: LlmRequest = REQ) {
  const out: unknown[] = []
  for await (const e of client.stream(req)) out.push(e)
  return out
}

describe("anthropic client", () => {
  it("streams text deltas and maps message_start/message_delta usage", async () => {
    const fetchImpl = (async () => sseResponse([
      { type: "message_start", message: { usage: { input_tokens: 7 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ])) as typeof fetch
    const events = await collect(createAnthropicClient({ baseUrl: "https://api.anthropic.com", apiKey: "k", fetchImpl }))
    expect(events).toEqual([
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
      { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } },
    ])
  })

  it("maps tool_use blocks to tool_call_started/delta and stop_reason tool_use", async () => {
    const fetchImpl = (async () => sseResponse([
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "exec" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"comm' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'and":"ls"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ])) as typeof fetch
    const events = await collect(createAnthropicClient({ baseUrl: "https://api.anthropic.com", apiKey: "k", fetchImpl }))
    expect(events).toEqual([
      { type: "tool_call_started", index: 1, callId: "toolu_1", name: "exec" },
      { type: "tool_call_delta", index: 1, delta: '{"comm' },
      { type: "tool_call_delta", index: 1, delta: 'and":"ls"}' },
      { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 9 } },
    ])
  })

  it("maps thinking_delta and the refusal stop reason", async () => {
    const fetchImpl = (async () => sseResponse([
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ])) as typeof fetch
    const events = await collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }))
    expect(events[0]).toEqual({ type: "thinking_delta", delta: "hmm" })
    expect(events.at(-1)).toMatchObject({ stopReason: "content_filter" })
  })

  it("sends the Messages payload: system folding, tool results merged, tool_use blocks, default max_tokens", async () => {
    let captured: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return sseResponse([{ type: "message_stop" }])
    }) as unknown as typeof fetch
    await collect(createAnthropicClient({ baseUrl: "https://api.anthropic.com", apiKey: "sk-a", fetchImpl }), {
      model: "claude-sonnet-4",
      system: "be brief",
      messages: [
        { role: "system", content: "extra persona" },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, toolCalls: [{ callId: "t1", name: "exec", argsJson: '{"command":"ls"}' }] },
        { role: "tool", toolCallId: "t1", content: "out1" },
        { role: "tool", toolCallId: "t2", content: "out2" },
        { role: "assistant", content: null }, // empty assistant turn is dropped
      ],
      tools: [{ name: "exec", description: "run", parameters: { type: "object" } }],
    })
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages")
    expect(captured!.headers.get("x-api-key")).toBe("sk-a")
    expect(captured!.headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION)
    const body = await captured!.json()
    expect(body.system).toBe("be brief\n\nextra persona")
    expect(body.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
    expect(body.stream).toBe(true)
    expect(body.tools[0]).toEqual({ name: "exec", description: "run", input_schema: { type: "object" } })
    // user → assistant(tool_use) → one user message carrying both tool_results
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "ls" } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "out1" },
        { type: "tool_result", tool_use_id: "t2", content: "out2" },
      ] },
    ])
  })

  it("accepts a base that already includes /v1 and forwards a declared maxOutput", async () => {
    let captured: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return sseResponse([{ type: "message_stop" }])
    }) as unknown as typeof fetch
    await collect(createAnthropicClient({ baseUrl: "https://proxy.example.com/v1", apiKey: "", fetchImpl }), {
      ...REQ, maxTokens: 1024,
    })
    expect(captured!.url).toBe("https://proxy.example.com/v1/messages")
    expect(captured!.headers.get("x-api-key")).toBeNull() // empty key → no auth header
    expect((await captured!.json()).max_tokens).toBe(1024)
  })

  it("maps data-URL image parts to base64 source blocks", async () => {
    let captured: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return sseResponse([{ type: "message_stop" }])
    }) as unknown as typeof fetch
    await collect(createAnthropicClient({ baseUrl: "https://api.anthropic.com", apiKey: "k", fetchImpl }), {
      ...REQ,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] }],
    })
    const body = await captured!.json()
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ])
  })

  it("surfaces http errors and mid-stream error events", async () => {
    const errFetch = (async () => new Response('{"error":{"type":"authentication_error"}}', { status: 401 })) as unknown as typeof fetch
    await expect(collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "bad", fetchImpl: errFetch })))
      .rejects.toThrow("llm http 401")
    const evFetch = (async () => sseResponse([
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ])) as typeof fetch
    await expect(collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl: evFetch })))
      .rejects.toThrow("llm anthropic overloaded_error: Overloaded")
  })
})
