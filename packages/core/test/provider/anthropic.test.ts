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

  it("sums cache_creation/cache_read into inputTokens and carries the cache fields (identity: input = non-cached + read + write)", async () => {
    const fetchImpl = (async () => sseResponse([
      { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 300, cache_read_input_tokens: 50 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ])) as typeof fetch
    const events = await collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }))
    expect(events.at(-1)).toEqual({
      type: "message_done",
      stopReason: "end_turn",
      usage: { inputTokens: 450, outputTokens: 9, cacheReadTokens: 50, cacheWriteTokens: 300 },
    })
  })

  it("keeps cache fields undefined (not 0) when the stream carries no cache metrics", async () => {
    const fetchImpl = (async () => sseResponse([
      { type: "message_start", message: { usage: { input_tokens: 7 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ])) as typeof fetch
    const events = await collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }))
    expect(events.at(-1)).toEqual({
      type: "message_done",
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 3 },
    })
  })

  it("merges cache fields from message_delta with field-level last-wins", async () => {
    const fetchImpl = (async () => sseResponse([
      { type: "message_start", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 40, cache_read_input_tokens: 5 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2, cache_read_input_tokens: 8 } },
      { type: "message_stop" },
    ])) as typeof fetch
    const events = await collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }))
    // input re-sums over the updated read: 10 + 40 + 8 = 58; write stays 40.
    expect(events.at(-1)).toEqual({
      type: "message_done",
      stopReason: "end_turn",
      usage: { inputTokens: 58, outputTokens: 2, cacheReadTokens: 8, cacheWriteTokens: 40 },
    })
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
    expect(captured!.headers.get("authorization")).toBe("Bearer sk-a")
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
    expect(captured!.headers.get("authorization")).toBeNull()
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

describe("anthropic cache breakpoints (prompt_cache channel)", () => {
  function captureBodies(statuses: number[]): { bodies: Array<Record<string, unknown>>; fetchCalls: () => number; fetchImpl: typeof fetch } {
    const bodies: Array<Record<string, unknown>> = []
    let calls = 0
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const status = statuses[Math.min(calls++, statuses.length - 1)]!
      bodies.push(JSON.parse(String(init?.body)))
      if (status !== 200) return new Response('{"error":{"type":"invalid_request_error"}}', { status })
      return sseResponse([{ type: "message_stop" }])
    }) as unknown as typeof fetch
    return { bodies, fetchCalls: () => calls, fetchImpl }
  }

  const TOOLS = [
    { name: "zeta", description: "z", parameters: { type: "object", properties: { q: { type: "string" } } } },
    { name: "alpha", description: "a", parameters: { type: "object" } },
  ]
  const MSGS = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: null, toolCalls: [{ callId: "t1", name: "alpha", argsJson: "{}" }] },
    { role: "tool" as const, toolCallId: "t1", content: "out1" },
  ]
  const CACHE_REQ: LlmRequest = {
    model: "claude-sonnet-4", system: "be brief", messages: MSGS, tools: TOOLS,
    promptCache: { key: "ses_x" },
  }

  it("places exactly three breakpoints: last tool top-level, system as a single block array, last message's last block", async () => {
    const { bodies, fetchImpl } = captureBodies([200])
    await collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }), CACHE_REQ)
    const body = bodies[0]!
    // tools: on the TOOL object top level (sibling of name/description/input_schema), not inside input_schema
    const lastTool = body.tools.at(-1) as Record<string, unknown>
    expect(lastTool.cache_control).toEqual({ type: "ephemeral" })
    expect((lastTool.input_schema as Record<string, unknown>).cache_control).toBeUndefined()
    // system: string → single-element block array with the marker on the block
    expect(body.system).toEqual([{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }])
    // messages: the last block of the last message (a merged tool_result here)
    const lastMsg = body.messages.at(-1) as { content: Array<Record<string, unknown>> }
    expect(lastMsg.content.at(-1)!.type).toBe("tool_result")
    expect(lastMsg.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" })
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(3)
  })

  it("absent promptCache → payload byte-identical to the legacy shape: string system, no markers anywhere", async () => {
    const { bodies, fetchImpl } = captureBodies([200])
    await collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }), {
      model: "claude-sonnet-4", system: "be brief", messages: MSGS, tools: TOOLS,
    })
    const body = bodies[0]!
    expect(body.system).toBe("be brief")
    expect(JSON.stringify(body)).not.toContain("cache_control")
    expect(JSON.stringify(body)).not.toContain("prompt_cache_key")
  })

  it("entry configured off (promptCacheEnabled: false) suppresses markers even when the request opts in", async () => {
    const { bodies, fetchImpl } = captureBodies([200])
    await collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl, promptCacheEnabled: false }), CACHE_REQ)
    expect(bodies[0]!.system).toBe("be brief")
    expect(JSON.stringify(bodies[0]!)).not.toContain("cache_control")
  })

  it("skips breakpoints for empty tools / empty system / empty messages", async () => {
    const { bodies, fetchImpl } = captureBodies([200])
    await collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }), {
      model: "m", system: "", messages: [], tools: [], promptCache: { key: "k" },
    })
    const body = bodies[0]!
    expect(body.system).toBe("")
    expect(body.tools).toEqual([])
    expect(body.messages).toEqual([])
    expect(JSON.stringify(body)).not.toContain("cache_control")
  })

  it("strips markers and retries once on 400, then remembers the verdict for later requests", async () => {
    const { bodies, fetchCalls, fetchImpl } = captureBodies([400, 200, 200])
    const client = createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl })
    await collect(client, CACHE_REQ)
    expect(fetchCalls()).toBe(2)
    expect(JSON.stringify(bodies[0])).toContain("cache_control")
    expect(JSON.stringify(bodies[1])).not.toContain("cache_control")
    expect(bodies[1]!.system).toBe("be brief") // stripped retry = legacy shape byte-for-byte
    // the verdict persists per client instance: no retry on the next request
    await collect(client, CACHE_REQ)
    expect(fetchCalls()).toBe(3)
    expect(JSON.stringify(bodies[2])).not.toContain("cache_control")
  })

  it("does NOT strip on 401 (auth is not a schema problem)", async () => {
    const { bodies, fetchCalls, fetchImpl } = captureBodies([401])
    await expect(collect(createAnthropicClient({ baseUrl: "https://x", apiKey: "bad", fetchImpl }), CACHE_REQ))
      .rejects.toThrow("llm http 401")
    expect(fetchCalls()).toBe(1)
    expect(JSON.stringify(bodies[0])).toContain("cache_control")
  })

  it("a 400 after the marker-free retry surfaces the original llm http 400 and does NOT remember the verdict", async () => {
    const { bodies, fetchCalls, fetchImpl } = captureBodies([400, 400, 400, 400])
    const client = createAnthropicClient({ baseUrl: "https://x", apiKey: "k", fetchImpl })
    await expect(collect(client, CACHE_REQ)).rejects.toThrow("llm http 400")
    // A still-failing retry points at a non-marker cause (bad model name etc.):
    // the verdict is not remembered, so the next request tries the markers
    // again before stripping.
    await expect(collect(client, CACHE_REQ)).rejects.toThrow("llm http 400")
    expect(fetchCalls()).toBe(4)
    expect(JSON.stringify(bodies[0])).toContain("cache_control")
    expect(JSON.stringify(bodies[1])).not.toContain("cache_control")
    expect(JSON.stringify(bodies[2])).toContain("cache_control")
    expect(JSON.stringify(bodies[3])).not.toContain("cache_control")
  })
})
