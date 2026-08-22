import { describe, it, expect } from "vitest"
import { runAgent } from "../../src/agent/loop.js"
import type { PermissionGate } from "../../src/agent/loop.js"
import type { ToolExecutor } from "../../src/agent/tools.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import type { Message } from "../../src/protocol/messages.js"

/** First stream call asks for the tool, every later call finishes the run. */
function scriptClient(script: LlmStreamEvent[][]): LlmClient {
  let i = 0
  return { async *stream(): AsyncIterable<LlmStreamEvent> { yield* script[Math.min(i++, script.length - 1)]! } }
}

function toolTurn(): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId: "call_1", name: "exec" },
    { type: "tool_call_delta", index: 0, delta: '{"command":"ls"}' },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } },
  ]
}

const FINAL: LlmStreamEvent[] = [
  { type: "text_delta", delta: "done" },
  { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
]

const EXEC: ToolExecutor = {
  risk: "sensitive", concurrency: "serial",
  async execute() { return { status: "ok", output: "ran" } },
}

async function runWith(extra: Partial<Parameters<typeof runAgent>[1]> = {}) {
  const messages: Message[] = []
  const outcome = await runAgent(
    { sessionId: "s", history: [], system: "", userText: "go" },
    {
      llm: scriptClient([toolTurn(), FINAL]),
      model: "m",
      onEvent: () => {},
      onMessage: (m) => messages.push(m),
      tools: new Map([["exec", EXEC]]),
      ...extra,
    } as Parameters<typeof runAgent>[1],
  )
  return { messages, outcome }
}

describe("runAgent tool message grantedBy", () => {
  it("工具执行后 tool 消息带 grantedBy 映射", async () => {
    const gate: PermissionGate = { async check() { return { type: "allow", reason: "whitelist" } } }
    const { messages } = await runWith({ permissions: gate })
    const toolMsg = messages.find((m) => m.role === "tool") as Message & { grantedBy?: Record<string, string> }
    expect(toolMsg?.grantedBy).toBeDefined()
    expect(toolMsg?.grantedBy).toEqual({ call_1: "whitelist" })
  })

  it("无 gate 时默认放行原因记录为 safe", async () => {
    const { messages } = await runWith()
    const toolMsg = messages.find((m) => m.role === "tool") as Message & { grantedBy?: Record<string, string> }
    expect(toolMsg?.grantedBy).toEqual({ call_1: "safe" })
  })

  it("confirm 且批准时记录为 confirmed", async () => {
    const gate: PermissionGate = { async check() { return { type: "confirm", confirmationId: "conf_1" } } }
    const { messages } = await runWith({
      permissions: gate,
      resolveConfirmation: async () => ({ approved: true, by: "cli" }),
    })
    const toolMsg = messages.find((m) => m.role === "tool") as Message & { grantedBy?: Record<string, string> }
    expect(toolMsg?.grantedBy).toEqual({ call_1: "confirmed" })
  })
})
