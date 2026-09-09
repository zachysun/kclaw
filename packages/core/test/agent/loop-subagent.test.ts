/**
 * Engine-level coverage of the two subagent contracts the loop owns:
 * 1. The run's abort signal now reaches tool executors (the pre-subagent gap —
 *    `signal` sat unused in the executor contract).
 * 2. A blocking executor settles the tool turn only when IT settles (the
 *    shape subagent_run relies on for parent-stop-child-stop).
 */
import { describe, it, expect } from "vitest"
import { runAgent } from "../../src/agent/loop.js"
import { chainOf } from "./hook-utils.js"
import type { ToolExecutor } from "../../src/agent/tools.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import type { Message } from "../../src/protocol/messages.js"

function toolCallStream(idx: number, callId: string, name: string, argsJson: string): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: idx, callId, name },
    { type: "tool_call_delta", index: idx, delta: argsJson },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

const FINAL: LlmStreamEvent[] = [
  { type: "text_delta", delta: "done" },
  { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
]

function scriptClient(script: LlmStreamEvent[][]): LlmClient {
  let i = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield* script[Math.min(i++, script.length - 1)]!
    },
  }
}

describe("engine → executor abort signal", () => {
  it("hands the run's signal to executor.execute (a long tool observes the abort)", async () => {
    const controller = new AbortController()
    const observed: Array<AbortSignal | undefined> = []
    const blocking: ToolExecutor = {
      risk: "safe", concurrency: "parallel",
      async execute(_args, ctx) {
        observed.push(ctx.signal)
        // Wait for the abort like a real spawner would (child run cancels).
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) return resolve()
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true })
          setTimeout(resolve, 5_000) // safety: never hang the suite
        })
        return { status: "error", output: "child stopped" }
      },
    }
    const messages: Message[] = []
    const outcome = runAgent(
      { sessionId: "s", history: [], system: "", userText: "go" },
      {
        llm: scriptClient([[...toolCallStream(0, "call_1", "block", "{}")], FINAL]),
        model: "m",
        tools: new Map([["block", blocking]]),
        toolDefs: [{ name: "block", description: "blocks until aborted", parameters: { type: "object" } }],
        signal: controller.signal,
        hooks: chainOf(),
        onEvent: () => undefined,
        onMessage: (m) => messages.push(m),
      },
    )
    // Abort while the tool is mid-flight; the executor must see the signal,
    // settle, and the run then finishes aborted at its next checkpoint.
    setTimeout(() => controller.abort(), 20)
    const result = await outcome
    expect(observed[0]).toBe(controller.signal)
    expect(result.stopReason).toBe("aborted")
    const toolMsg = messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const block = toolMsg!.blocks.find((b) => b.type === "tool_result")
    expect(block && block.type === "tool_result" && block.status).toBe("error")
  })
})
