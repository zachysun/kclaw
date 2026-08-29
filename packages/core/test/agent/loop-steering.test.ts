import { describe, it, expect, vi } from "vitest"
import { runAgent, type AgentDeps, type RunInput } from "../../src/agent/index.js"
import { newMessage } from "../../src/protocol/messages.js"
import type { AgentEvent, LlmClient, LlmStreamEvent, Message, ToolDefinition } from "../../src/index.js"

/** 第一轮吐一个 tool_use（触发工具批次→边界），此后每轮 end_turn。 */
function toolThenEndLlm(): LlmClient {
  let call = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      call += 1
      if (call === 1) {
        yield { type: "tool_call_started", index: 0, callId: "c1", name: "noop" }
        yield { type: "tool_call_delta", index: 0, delta: "{}" }
        yield { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } }
      } else {
        yield { type: "text_delta", delta: "done" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      }
    },
  }
}

const noopTool = { name: "noop", risk: "safe" as const, concurrency: "parallel" as const, async execute() { return { status: "ok" as const, output: "" } } }
const noopDef: ToolDefinition = { name: "noop", description: "", parameters: { type: "object", properties: {} } }

function baseInput(): RunInput {
  return { sessionId: "ses_1", history: [], system: "s", userText: "go" }
}

describe("AgentDeps.steering", () => {
  it("drains at the iteration boundary, in order, and the provider view includes the messages", async () => {
    const steer1 = newMessage("ses_1", "user", [{ id: "b1", type: "text", text: "补一句：注意并发" }])
    const steer2 = newMessage("ses_1", "user", [{ id: "b2", type: "text", text: "再补：写测试" }])
    const persisted: Message[] = []
    const events: AgentEvent[] = []
    const seenViews: number[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        seenViews.push(req.messages.filter((m) => m.role === "user").length)
        const base = toolThenEndLlm()
        // 第二轮起不再产生工具，直接透传
        if (seenViews.length === 1) yield* base.stream(req)
        else {
          yield { type: "text_delta", delta: "done" }
          yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
        }
      },
    }
    const deps: AgentDeps = {
      llm, model: "m",
      tools: new Map([["noop", noopTool]]),
      toolDefs: [noopDef],
      steering: vi.fn(() => (persisted.length >= 2 ? [steer1, steer2] : [])), // 工具消息落盘后的第一个边界吐两条
      onEvent: (e) => events.push(e),
      onMessage: (m) => persisted.push(m),
    }
    const outcome = await runAgent(baseInput(), deps)
    expect(outcome.stopReason).toBe("end_turn")
    // 注入发生在工具批次后、第二次 llm.stream 前：第二轮 provider view 的 user 消息数 = 原消息 + 2
    expect(seenViews[1]).toBe(3)
    expect(persisted.filter((m) => m.id === steer1.id || m.id === steer2.id)).toHaveLength(2)
    // 事件序：created → completed → steered（每条）
    const types = events.filter((e) => e.type === "message.steered").map((e) => e.payload.messageId)
    expect(types).toEqual([steer1.id, steer2.id])
    const idxCreated = events.findIndex((e) => e.type === "message.created" && e.payload.message.id === steer1.id)
    const idxCompleted = events.findIndex((e) => e.type === "message.completed" && e.payload.message.id === steer1.id)
    const idxSteered = events.findIndex((e) => e.type === "message.steered" && e.payload.messageId === steer1.id)
    expect(idxCreated).toBeGreaterThanOrEqual(0)
    expect(idxCompleted).toBeGreaterThan(idxCreated)
    expect(idxSteered).toBeGreaterThan(idxCompleted)
  })

  it("a throwing steering drain fails the run (steering_failed) and resolves error", async () => {
    const events: AgentEvent[] = []
    const deps: AgentDeps = {
      llm: toolThenEndLlm(), model: "m",
      tools: new Map([["noop", noopTool]]),
      toolDefs: [noopDef],
      steering: () => { throw new Error("boom") },
      onEvent: (e) => events.push(e),
      onMessage: () => {},
    }
    const outcome = await runAgent(baseInput(), deps)
    expect(outcome.stopReason).toBe("error")
    expect(events.find((e) => e.type === "run.failed")?.payload.error.code).toBe("steering_failed")
  })

  it("without steering, behavior is identical to before (no extra events)", async () => {
    const events: AgentEvent[] = []
    const deps: AgentDeps = {
      llm: toolThenEndLlm(), model: "m",
      tools: new Map([["noop", noopTool]]),
      toolDefs: [noopDef],
      onEvent: (e) => events.push(e),
      onMessage: () => {},
    }
    const outcome = await runAgent(baseInput(), deps)
    expect(outcome.stopReason).toBe("end_turn")
    expect(events.some((e) => e.type === "message.steered")).toBe(false)
  })
})
