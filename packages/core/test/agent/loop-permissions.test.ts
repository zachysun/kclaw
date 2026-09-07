import { describe, it, expect, vi, afterEach } from "vitest"
import { runAgent } from "../../src/agent/loop.js"
import type { PermissionGate } from "../../src/agent/loop.js"
import type { ToolExecutor } from "../../src/agent/tools.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import type { AssistantMessage, Message } from "../../src/protocol/messages.js"
import type { AgentEvent } from "../../src/protocol/events.js"
import { chainOf } from "./hook-utils.js"

const FINAL: LlmStreamEvent[] = [
  { type: "text_delta", delta: "ok" },
  { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
]

function toolTurn(): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId: "call_1", name: "exec" },
    { type: "tool_call_delta", index: 0, delta: '{"command":"rm -rf /"}' },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } },
  ]
}

/** First stream call asks for the tool, every later call finishes the run. */
function scriptClient(script: LlmStreamEvent[][]): LlmClient {
  let i = 0
  return { async *stream(): AsyncIterable<LlmStreamEvent> { yield* script[Math.min(i++, script.length - 1)]! } }
}

const EXEC: ToolExecutor = {
  risk: "sensitive", concurrency: "serial",
  async execute() { return { status: "ok", output: "should not run" } },
}

async function runWith(gate: PermissionGate, extra: Record<string, unknown> = {}) {
  const messages: Message[] = []
  const events: AgentEvent[] = []
  const executed = vi.fn()
  const outcome = await runAgent(
    { sessionId: "s", history: [], system: "", userText: "go" },
    {
      llm: scriptClient([toolTurn(), FINAL]),
      model: "m",
      hooks: chainOf(),
      onEvent: (e) => events.push(e),
      onMessage: (m) => messages.push(m),
      tools: new Map([["exec", {
        ...EXEC,
        execute: async (...a: Parameters<ToolExecutor["execute"]>) => { executed(); return EXEC.execute(...a) },
      }]]),
      permissions: gate,
      ...extra,
    },
  )
  return { messages, events, executed, outcome }
}

describe("permission gate", () => {
  afterEach(() => { vi.useRealTimers() })

  it("allow path executes the tool", async () => {
    const gate: PermissionGate = { async check() { return { type: "allow", reason: "whitelist" } } }
    const { executed, messages } = await runWith(gate)
    expect(executed).toHaveBeenCalled()
    const result = messages.find((m) => m.role === "tool")!.blocks[0] as { status: string }
    expect(result.status).toBe("ok")
  })

  it("deny path: no execution, error result + note block, model continues", async () => {
    const gate: PermissionGate = {
      async check() { return { type: "deny", reason: "blacklist", noteText: "命令在黑名单中" } },
    }
    const { executed, messages, events } = await runWith(gate)
    expect(executed).not.toHaveBeenCalled()
    const toolMsg = messages.find((m) => m.role === "tool")!
    const result = toolMsg.blocks.find((b) => b.type === "tool_result") as { status: string; output: string }
    expect(result.status).toBe("error")
    expect(result.output).toContain("黑名单")
    expect(toolMsg.blocks.some((b) => b.type === "note" && (b as { kind: string }).kind === "denied")).toBe(true)
    expect(events.some((e) => e.type === "note.emitted")).toBe(true)
    expect(events.at(-1)?.type).toBe("run.completed")
  })

  it("confirm path: request event, approval resolves, tool runs", async () => {
    const gate: PermissionGate = {
      async check() { return { type: "confirm", confirmationId: "conf_1" } },
    }
    const { events, executed } = await runWith(gate, {
      resolveConfirmation: async () => ({ decision: "once" as const, by: "cli" as const }),
    })
    expect(events.find((e) => e.type === "confirmation.requested")).toMatchObject({
      payload: { confirmationId: "conf_1", toolCall: { callId: "call_1", name: "exec" }, risk: "sensitive" },
    })
    expect(events.find((e) => e.type === "confirmation.resolved")).toMatchObject({
      payload: { decision: "once", by: "cli" },
    })
    expect(executed).toHaveBeenCalled()
  })

  it("confirm path: timeout denies without executing", async () => {
    vi.useFakeTimers()
    const gate: PermissionGate = {
      async check() { return { type: "confirm", confirmationId: "conf_1" } },
    }
    const never = new Promise<never>(() => {})
    const p = runWith(gate, {
      resolveConfirmation: () => never,
      confirmTimeoutMs: 100,
    })
    vi.advanceTimersByTimeAsync(150)
    const { executed, events } = await p
    expect(executed).not.toHaveBeenCalled()
    expect(events.find((e) => e.type === "confirmation.resolved")).toMatchObject({
      payload: { decision: "timeout", by: "timeout" },
    })
  })

  it("abort before the run starts persists no assistant message", async () => {
    const controller = new AbortController()
    controller.abort()
    const gate: PermissionGate = { async check() { return { type: "allow", reason: "safe" } } }
    const hanging: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> { await new Promise<never>(() => {}) },
    }
    const { messages, events, outcome } = await runWith(gate, { signal: controller.signal, llm: hanging })
    expect(outcome.stopReason).toBe("aborted")
    // No synthetic empty assistant message: providers reject empty assistant
    // content (the user message's own lifecycle events are unaffected).
    expect(messages.map((m) => m.role)).toEqual(["user"])
    expect(events.some((e) => e.type === "message.completed" && e.payload.message.role === "assistant")).toBe(false)
    const last = events.at(-1)!
    expect(last.type).toBe("run.completed")
    expect(last.payload).toMatchObject({ stopReason: "aborted" })
  })

  it("abort during the LLM stream stops with stopReason aborted", async () => {
    const controller = new AbortController()
    const gate: PermissionGate = { async check() { return { type: "allow", reason: "safe" } } }
    // A hanging stream: one delta arrives, then the user aborts while the
    // model is "thinking" and the stream never sends message_done.
    const hanging: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield { type: "text_delta", delta: "partial " }
        controller.abort()
        await new Promise<never>(() => {})
      },
    }
    const { messages, events, outcome } = await runWith(gate, { signal: controller.signal, llm: hanging })
    expect(outcome.stopReason).toBe("aborted")
    const abortedMsg = messages.find((m) => m.role === "assistant") as AssistantMessage
    expect(abortedMsg.stopReason).toBe("aborted")
    expect(events.find((e) => e.type === "message.completed" && e.payload.message.role === "assistant")).toMatchObject({
      payload: { message: { stopReason: "aborted" } },
    })
    const last = events.at(-1)!
    expect(last.type).toBe("run.completed")
    expect(last.payload).toMatchObject({ stopReason: "aborted" })
  })

  it("abort while a confirmation is pending finishes aborted, not timeout-deny", async () => {
    const controller = new AbortController()
    const gate: PermissionGate = {
      async check() { return { type: "confirm", confirmationId: "conf_1" } },
    }
    const { messages, events, outcome } = await runWith(gate, {
      signal: controller.signal,
      resolveConfirmation: () => new Promise(() => { controller.abort() }), // aborts while pending
    })
    expect(outcome.stopReason).toBe("aborted")
    // the confirmation was asked for but never resolved — an abort is not a timeout
    expect(events.some((e) => e.type === "confirmation.requested")).toBe(true)
    expect(events.some((e) => e.type === "confirmation.resolved")).toBe(false)
    const toolMsg = messages.find((m) => m.role === "tool")!
    expect(toolMsg.blocks[0]).toMatchObject({ type: "tool_result", callId: "call_1", status: "error", output: expect.stringContaining("aborted") })
    expect(events.at(-1)).toMatchObject({ type: "run.completed", payload: { stopReason: "aborted" } })
  })

  it("abort mid tool-turn stops scheduling further tools", async () => {
    const controller = new AbortController()
    const started: string[] = []
    const tools = new Map<string, ToolExecutor>([
      ["a", {
        risk: "safe", concurrency: "parallel",
        async execute() {
          started.push("a")
          controller.abort() // the user cancels while a is still running
          await new Promise((r) => setTimeout(r, 20))
          return { status: "ok", output: "a done" }
        },
      }],
      ["s", {
        risk: "safe", concurrency: "serial",
        async execute() { started.push("s"); return { status: "ok", output: "s done" } },
      }],
    ])
    const messages: Message[] = []
    const events: AgentEvent[] = []
    const outcome = await runAgent(
      { sessionId: "s", history: [], system: "", userText: "go" },
      {
        llm: scriptClient([[
          { type: "tool_call_started", index: 0, callId: "call_a", name: "a" },
          { type: "tool_call_delta", index: 0, delta: "{}" },
          { type: "tool_call_started", index: 1, callId: "call_s", name: "s" },
          { type: "tool_call_delta", index: 1, delta: "{}" },
          { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } },
        ], FINAL]),
        model: "m",
        signal: controller.signal,
        hooks: chainOf(),
        onEvent: (e) => events.push(e),
        onMessage: (m) => messages.push(m),
        tools,
      },
    )
    // the already-running tool settled; the serial one was never scheduled
    expect(started).toEqual(["a"])
    expect(outcome.stopReason).toBe("aborted")
    const toolMsg = messages.find((m) => m.role === "tool")!
    expect(toolMsg.blocks.map((b) => (b as { callId: string; output: string }).callId)).toEqual(["call_a", "call_s"])
    expect(toolMsg.blocks[0]).toMatchObject({ status: "ok", output: "a done" })
    expect(toolMsg.blocks[1]).toMatchObject({ status: "error", output: expect.stringContaining("aborted") })
    expect(events.at(-1)).toMatchObject({ payload: { stopReason: "aborted" } })
  })
})
