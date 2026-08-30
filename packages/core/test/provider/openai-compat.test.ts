import { describe, it, expect } from "vitest"
import { createOpenAiCompatClient } from "../../src/provider/openai-compat.js"

function sseResponse(chunks: object[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`))
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const REQ = { model: "glm-4.7", system: "sys", messages: [], tools: [] }

async function collect(c: { stream(r: never): AsyncIterable<never> }, req = REQ) {
  const out: unknown[] = []
  for await (const e of c.stream(req)) out.push(e)
  return out
}

describe("openai-compat client", () => {
  it("streams text deltas and message_done", async () => {
    const fetchImpl = (async () => sseResponse([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ])) as typeof fetch
    const events = await collect(createOpenAiCompatClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }))
    expect(events).toEqual([
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
      { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
    ])
  })

  it("maps reasoning_content to thinking_delta", async () => {
    const fetchImpl = (async () => sseResponse([
      { choices: [{ delta: { reasoning_content: "thinking..." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ])) as typeof fetch
    const events = await collect(createOpenAiCompatClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }))
    expect(events[0]).toEqual({ type: "thinking_delta", delta: "thinking..." })
  })

  it("accumulates tool_call argument deltas per index", async () => {
    const fetchImpl = (async () => sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    ])) as typeof fetch
    const events = await collect(createOpenAiCompatClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }))
    expect(events).toEqual([
      { type: "tool_call_started", index: 0, callId: "call_1", name: "exec" },
      { type: "tool_call_delta", index: 0, delta: '{"comm' },
      { type: "tool_call_delta", index: 0, delta: 'and":"ls"}' },
      { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 3, outputTokens: 4 } },
    ])
  })

  it("sends POST with system message first and tool definitions", async () => {
    let captured: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } }])
    }) as unknown as typeof fetch
    await collect(createOpenAiCompatClient({ baseUrl: "https://x/v1", apiKey: "k", fetchImpl }), {
      model: "m", system: "be brief",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "exec", description: "run", parameters: { type: "object" } }],
    })
    expect(captured!.url).toBe("https://x/v1/chat/completions")
    const body = await captured!.json()
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" })
    expect(body.tools[0].function.name).toBe("exec")
    expect(body.stream).toBe(true)
    expect(captured!.headers.get("authorization")).toBe("Bearer k")
  })

  it("messages 里的 system 项按顺序透传（人格 system 之后）", async () => {
    let captured: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } }])
    }) as unknown as typeof fetch
    await collect(createOpenAiCompatClient({ baseUrl: "https://x/v1", apiKey: "k", fetchImpl }), {
      model: "m", system: "be brief",
      messages: [
        { role: "system", content: "早期对话脉络：早前聊过压缩" },
        { role: "user", content: "hi" },
      ],
      tools: [],
    })
    const body = await captured!.json()
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" }) // 人格在前
    expect(body.messages[1].role).toBe("system")
    expect(body.messages[1].content.startsWith("早期对话脉络：")).toBe(true)
  })

  it("throws the classified `llm http <status>` message on non-2xx", async () => {
    // the exact prefix is the classification contract withRetry's
    // isTransient regex depends on (/llm http (429|5\d\d|timeout)/)
    const fetchImpl = (async () => new Response("upstream exploded", { status: 500 })) as typeof fetch
    const client = createOpenAiCompatClient({ baseUrl: "https://x", apiKey: "k", fetchImpl })
    await expect(async () => {
      for await (const _ of client.stream(REQ)) void _
    }).rejects.toThrow(/^llm http 500: upstream exploded$/)
  })

  it("times out a never-resolving fetch with `llm http timeout after <n>ms`", async () => {
    // fetchImpl mirrors real fetch: it rejects with the signal's reason once
    // AbortSignal.timeout fires — here it simply never resolves on its own
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = (init as RequestInit | undefined)?.signal
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }) as unknown as typeof fetch
    const client = createOpenAiCompatClient({ baseUrl: "https://x", apiKey: "k", fetchImpl, timeoutMs: 50 })
    // the exact prefix is the classification contract withRetry's isTransient
    // regex depends on (/llm http (429|5\d\d|timeout)/)
    await expect(async () => {
      for await (const _ of client.stream(REQ)) void _
    }).rejects.toThrow(/^llm http timeout after 50ms/)
  })

  it("times out a stalled SSE body mid-stream with the same classified message", async () => {
    // mirrors undici: headers arrive, data never follows, and the body errors
    // when the request signal aborts — the hung-provider-stream shape
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = (init as RequestInit | undefined)?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true })
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as unknown as typeof fetch
    const client = createOpenAiCompatClient({ baseUrl: "https://x", apiKey: "k", fetchImpl, timeoutMs: 50 })
    await expect(async () => {
      for await (const _ of client.stream(REQ)) void _
    }).rejects.toThrow(/^llm http timeout after 50ms/)
  })

  it("passes non-abort fetch errors through unchanged", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch
    const client = createOpenAiCompatClient({ baseUrl: "https://x", apiKey: "k", fetchImpl, timeoutMs: 10_000 })
    await expect(async () => {
      for await (const _ of client.stream(REQ)) void _
    }).rejects.toThrow(TypeError)
  })

  it("reassembles SSE frames and multibyte characters split across chunks", async () => {
    const encoder = new TextEncoder()
    const frame1 = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel你lo" } }] })}\n\n`
    const frame2 = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`
    const done = `data: [DONE]\n\n`
    const bytes = encoder.encode(frame1 + frame2 + done)
    // split points: inside the first frame's JSON, between its trailing \n\n,
    // between the 3 UTF-8 bytes of 你, and just before the [DONE] frame
    const multibyte = bytes.indexOf(0xe4)
    expect(multibyte).toBeGreaterThan(0)
    const cuts = [7, Math.floor(frame1.length / 2), frame1.length - 1, multibyte + 1, multibyte + 2, bytes.length - 3]
    const parts: Uint8Array[] = []
    let start = 0
    for (const c of [...new Set(cuts)].sort((a, b) => a - b)) {
      if (c > start && c < bytes.length) { parts.push(bytes.slice(start, c)); start = c }
    }
    parts.push(bytes.slice(start))
    const body = new ReadableStream({
      start(controller) { for (const p of parts) controller.enqueue(p); controller.close() },
    })
    const fetchImpl = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch
    const events = await collect(createOpenAiCompatClient({ baseUrl: "https://x", apiKey: "k", fetchImpl }))
    expect(events).toEqual([
      { type: "text_delta", delta: "Hel你lo" },
      { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    ])
  })
})
