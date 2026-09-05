import { describe, it, expect, vi } from "vitest"
import { runAgent } from "../../src/agent/loop.js"
import { toProviderMessages } from "../../src/agent/context.js"
import { withRetry } from "../../src/provider/retry.js"
import type { LlmClient, LlmStreamEvent, ProviderMessage } from "../../src/provider/types.js"
import type { Message } from "../../src/protocol/messages.js"
import type { AgentEvent } from "../../src/protocol/events.js"
import { chainOf } from "./hook-utils.js"

/** Every assistant toolCall in the provider view whose result is missing. */
function unpairedToolCalls(view: ProviderMessage[]): string[] {
  const bad: string[] = []
  for (let i = 0; i < view.length; i++) {
    const m = view[i]!
    if (m.role !== "assistant" || !m.toolCalls) continue
    const answered = new Set<string>()
    for (let j = i + 1; j < view.length && view[j]!.role === "tool"; j++) {
      answered.add(view[j]!.toolCallId)
    }
    for (const tc of m.toolCalls) if (!answered.has(tc.callId)) bad.push(tc.callId)
  }
  return bad
}

/** Records events AND persists into one timeline so ordering is assertable. */
function harness(llm: LlmClient, extra: Record<string, unknown> = {}) {
  const timeline: string[] = []
  const events: AgentEvent[] = []
  const messages: Message[] = []
  const run = runAgent(
    { sessionId: "s", history: [], system: "", userText: "go" },
    {
      llm,
      model: "m",
      hooks: chainOf(),
      onEvent: (e) => { events.push(e); timeline.push(`event:${e.type}`) },
      onMessage: (m) => { messages.push(m); timeline.push(`persist:${m.role}`) },
      ...extra,
    },
  )
  return { run, events, messages, timeline }
}

const DONE: LlmStreamEvent = { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }

describe("provider failure lifecycle", () => {
  it("resolves with the error lifecycle when the llm stream fails for good", async () => {
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> { throw new Error("llm http 401: bad key") },
    }
    const { run, events, messages } = harness(llm)
    const outcome = await run // must resolve, never reject
    expect(outcome.stopReason).toBe("error")
    // run.started is followed by a terminal run event in ALL cases
    expect(events[0]!.type).toBe("run.started")
    expect(events.at(-1)!.type).toBe("run.failed")
    expect(events.find((e) => e.type === "run.failed")).toMatchObject({
      payload: { error: { code: "llm_error", message: expect.stringContaining("401") } },
    })
    expect(events.find((e) => e.type === "llm.failed")).toMatchObject({
      payload: { error: { code: "llm_error" }, willRetry: false },
    })
    // stream produced nothing → empty assistant is dropped entirely (the
    // USER message still completes — its lifecycle is not stream-dependent)
    expect(messages.map((m) => m.role)).toEqual(["user"])
    expect(events.some((e) => e.type === "message.completed" && e.payload.message.role === "assistant")).toBe(false)
  })

  it("persists partial content with stopReason error when the stream dies mid-text", async () => {
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield { type: "text_delta", delta: "partial " }
        throw new Error("llm http 503: prolonged outage")
      },
    }
    const { run, events, messages, timeline } = harness(llm)
    const outcome = await run
    expect(outcome.stopReason).toBe("error")
    const assistant = messages.find((m) => m.role === "assistant")!
    expect(assistant.stopReason).toBe("error")
    expect(assistant.blocks).toEqual([expect.objectContaining({ type: "text", text: "partial " })])
    // events reflect persisted state: persist → (assistant) message.completed
    // → llm.failed → run.failed. The timeline's FIRST message.completed is the
    // user message's, so the assistant one is the LAST entry.
    expect(timeline.indexOf("persist:assistant")).toBeLessThan(timeline.lastIndexOf("event:message.completed"))
    expect(timeline.lastIndexOf("event:message.completed")).toBeLessThan(timeline.indexOf("event:llm.failed"))
    expect(timeline.indexOf("event:llm.failed")).toBeLessThan(timeline.indexOf("event:run.failed"))
  })

  it("emits no llm.completed when the call failed (llm.failed terminates the call)", async () => {
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> { throw new TypeError("fetch failed") },
    }
    const { run, events } = harness(llm)
    await run
    expect(events.some((e) => e.type === "llm.completed")).toBe(false)
    expect(events.find((e) => e.type === "llm.failed")).toMatchObject({ payload: { willRetry: false } })
  })

  it("persists no assistant message for a stream that produced zero blocks", async () => {
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> { yield DONE },
    }
    const { run, events, messages } = harness(llm)
    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")
    expect(messages.map((m) => m.role)).toEqual(["user"])
    expect(events.some((e) => e.type === "message.completed" && e.payload.message.role === "assistant")).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "run.completed", payload: { stopReason: "end_turn" } })
  })

  it("reports llm.started with an attempt counter fed by retry composition", async () => {
    let n = 0
    const raw: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        if (++n <= 2) throw new Error("llm http 503: x")
        yield { type: "text_delta", delta: "ok" }
        yield DONE
      },
    }
    const onLlmRetry = vi.fn()
    // Daemon-side composition: withRetry's onRetry is also passed to the
    // loop as AgentDeps.onLlmRetry so retries become visible as events.
    const llm = withRetry(raw, { baseDelayMs: 1, jitter: () => 0, onRetry: (info) => onLlmRetry(info) })
    const { run, events } = harness(llm, { onLlmRetry })
    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")
    expect(onLlmRetry).toHaveBeenCalledTimes(2)
    expect(onLlmRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1 })
    // llm.started fires before the stream (and its retries) begin, so a call
    // still reports attempt 1; the composition's retries surface separately.
    expect(events.find((e) => e.type === "llm.started")).toMatchObject({ payload: { model: "m", attempt: 1 } })
  })

  it("llm.started reads the optional llmAttempt hook (default 1)", async () => {
    const ok: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield { type: "text_delta", delta: "ok" }
        yield DONE
      },
    }
    // with the hook: the loop reports whatever the composition's counter says
    const hooked = harness(ok, { llmAttempt: () => 3 })
    await hooked.run
    expect(hooked.events.find((e) => e.type === "llm.started")).toMatchObject({
      payload: { model: "m", attempt: 3 },
    })

    // without the hook: a fresh call reports attempt 1 (unchanged default)
    const plain = harness(ok)
    await plain.run
    expect(plain.events.find((e) => e.type === "llm.started")).toMatchObject({
      payload: { model: "m", attempt: 1 },
    })
  })
})

describe("dangling tool calls from a dead stream", () => {
  const TOOLS = new Map([
    ["exec", { risk: "sensitive" as const, concurrency: "parallel" as const, async execute() { return { status: "ok", output: "ran" } } }],
  ])

  it("abort mid tool_call args streaming synthesizes error results for dangling calls", async () => {
    const controller = new AbortController()
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield { type: "tool_call_started", index: 0, callId: "call_1", name: "exec" }
        yield { type: "tool_call_delta", index: 0, delta: '{"comm' }
        controller.abort()
        await new Promise<never>(() => {})
      },
    }
    const { run, messages } = harness(llm, { signal: controller.signal, tools: TOOLS })
    const outcome = await run
    expect(outcome.stopReason).toBe("aborted")
    const assistant = messages.find((m) => m.role === "assistant")!
    // the partial tool_call block itself is persisted (partial content lands)
    expect(assistant.blocks.some((b) => b.type === "tool_call")).toBe(true)
    const toolMsg = messages.find((m) => m.role === "tool")!
    expect(toolMsg.blocks).toEqual([
      expect.objectContaining({ type: "tool_result", callId: "call_1", status: "error", output: expect.stringContaining("aborted") }),
    ])
    // next-run provider view contains no unpaired toolCalls
    expect(unpairedToolCalls(toProviderMessages(outcome.messages, 40))).toEqual([])
  })

  it("provider failure mid tool_call streaming also synthesizes results", async () => {
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield { type: "tool_call_started", index: 0, callId: "call_9", name: "exec" }
        yield { type: "tool_call_delta", index: 0, delta: '{"comm' }
        throw new Error("llm http 500: dead")
      },
    }
    const { run, messages } = harness(llm, { tools: TOOLS })
    const outcome = await run
    expect(outcome.stopReason).toBe("error")
    const toolMsg = messages.find((m) => m.role === "tool")!
    expect(toolMsg.blocks[0]).toMatchObject({ callId: "call_9", status: "error", output: expect.stringContaining("failed") })
    expect(unpairedToolCalls(toProviderMessages(outcome.messages, 40))).toEqual([])
  })
})

describe("max iterations truncation", () => {
  const TOOLS = new Map([
    ["exec", { risk: "sensitive" as const, concurrency: "parallel" as const, async execute() { return { status: "ok", output: "ran" } } }],
  ])

  it("attaches the truncation note before the final assistant is persisted", async () => {
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield { type: "tool_call_started", index: 0, callId: "call_1", name: "exec" }
        yield { type: "tool_call_delta", index: 0, delta: "{}" }
        yield { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { run, events, messages } = harness(llm, { tools: TOOLS, maxIterations: 2 })
    const outcome = await run
    expect(outcome.stopReason).toBe("error")
    expect(events.at(-1)).toMatchObject({ type: "run.failed", payload: { error: { code: "max_iterations" } } })
    // loop terminated after exactly maxIterations assistant turns
    const assistants = messages.filter((m) => m.role === "assistant")
    expect(assistants).toHaveLength(2)
    const note = assistants.at(-1)!.blocks.find((b) => b.type === "note")
    expect(note).toMatchObject({ type: "note", kind: "system" })
    // the note is part of the persisted message: emitted before that message.completed
    const noteIdx = events.findIndex((e) => e.type === "note.emitted")
    const finalCompletedIdx = events.findIndex((e) =>
      e.type === "message.completed" && (e.payload as { message: { id: string } }).message.id === assistants.at(-1)!.id)
    expect(noteIdx).toBeGreaterThan(-1)
    expect(noteIdx).toBeLessThan(finalCompletedIdx)
  })
})
