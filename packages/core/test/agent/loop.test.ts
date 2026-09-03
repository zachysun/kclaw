import { describe, it, expect } from "vitest"
import { runAgent } from "../../src/agent/loop.js"
import type { PermissionGate } from "../../src/agent/loop.js"
import { withLastUserText } from "../../src/agent/context.js"
import type { ToolExecutor } from "../../src/agent/tools.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import { newMessage, type Message } from "../../src/protocol/messages.js"

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

describe("runAgent default window", () => {
  it("default window is 200: a 100-message history is sent whole", async () => {
    const history = Array.from({ length: 100 }, (_, i) =>
      newMessage("s", i % 2 === 0 ? "user" : "assistant", [{ id: `b${i}`, type: "text", text: `m${i}` }]),
    )
    let msgCount = 0
    const rec: LlmClient = {
      async *stream(req) {
        msgCount = req.messages.length
        yield { type: "text_delta", delta: "ok" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    await runAgent(
      { sessionId: "s", history, system: "", userText: "继续" },
      { llm: rec, model: "m", onEvent: () => {}, onMessage: () => {} },
    )
    expect(msgCount).toBe(101) // 100 history + the new user message — nothing truncated
  })
})

describe("runAgent mapLlmMessages（LLM 执行前的模型视图改写钩子）", () => {
  const FINAL: LlmStreamEvent[] = [
    { type: "text_delta", delta: "好的" },
    { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
  ]

  it("swaps what the model sees but keeps persistence and outcome verbatim", async () => {
    const requests: Parameters<LlmClient["stream"]>[0][] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* FINAL
      },
    }
    const persisted: Message[] = []
    const outcome = await runAgent(
      { sessionId: "s", history: [], system: "", userText: "帮我 /test 跑一下" },
      {
        llm,
        model: "m",
        onEvent: () => {},
        onMessage: (m) => persisted.push(m),
        mapLlmMessages: (msgs) => withLastUserText(msgs, "帮我 /test 跑一下\n\n（技能调用指示）"),
      } as Parameters<typeof runAgent>[1],
    )
    // 模型视图：包装文本
    const userContent = (requests[0]!.messages.at(-1) as { role: string; content: string }).content
    expect(userContent).toBe("帮我 /test 跑一下\n\n（技能调用指示）")
    // 持久化与 outcome：原文
    expect((persisted[0]!.blocks[0] as { text: string }).text).toBe("帮我 /test 跑一下")
    expect((outcome.messages[0]!.blocks[0] as { text: string }).text).toBe("帮我 /test 跑一下")
  })

  it("fires on every LLM round of the tool loop (idempotent per round)", async () => {
    const requests: Parameters<LlmClient["stream"]>[0][] = []
    let i = 0
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* i++ === 0
          ? [
              { type: "tool_call_started", index: 0, callId: "call_1", name: "exec" },
              { type: "tool_call_delta", index: 0, delta: '{"command":"ls"}' },
              { type: "message_done", stopReason: "tool_use" as const, usage: { inputTokens: 0, outputTokens: 0 } },
            ]
          : FINAL
      },
    }
    const EXEC: ToolExecutor = {
      risk: "safe", concurrency: "serial",
      async execute() { return { status: "ok", output: "ran" } },
    }
    await runAgent(
      { sessionId: "s", history: [], system: "", userText: "帮我 /test 跑一下" },
      {
        llm,
        model: "m",
        onEvent: () => {},
        onMessage: () => {},
        tools: new Map([["exec", EXEC]]),
        mapLlmMessages: (msgs) => withLastUserText(msgs, "wrapped"),
      } as Parameters<typeof runAgent>[1],
    )
    expect(requests).toHaveLength(2)
    for (const req of requests) {
      // 第二轮的末条已是 tool 消息——钩子每轮都拿到完整列表，用户消息那份
      // 始终是改写后的文本。
      const user = req.messages.find((m) => m.role === "user") as { content: string }
      expect(user.content).toBe("wrapped")
    }
  })

  it("behaves exactly as before when the hook is unset", async () => {
    const requests: Parameters<LlmClient["stream"]>[0][] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* FINAL
      },
    }
    await runAgent(
      { sessionId: "s", history: [], system: "", userText: "原文" },
      { llm, model: "m", onEvent: () => {}, onMessage: () => {} } as Parameters<typeof runAgent>[1],
    )
    expect((requests[0]!.messages.at(-1) as { role: string; content: string }).content).toBe("原文")
  })
})
