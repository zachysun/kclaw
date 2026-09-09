import { describe, it, expect } from "vitest"
import { runAgent } from "../../src/agent/loop.js"
import { HookChain } from "../../src/hooks/runner.js"
import type { ToolExecutor } from "../../src/agent/tools.js"
import type { LlmClient, LlmRequest, LlmStreamEvent } from "../../src/provider/types.js"
import type { Message } from "../../src/protocol/messages.js"
import type { AgentEvent, EventType } from "../../src/protocol/events.js"
import type { ToolCallBlock } from "../../src/protocol/blocks.js"
import { chainOf, hook } from "./hook-utils.js"

function echoTool(body: Partial<ToolExecutor> = {}): ToolExecutor {
  return {
    risk: "safe", concurrency: "parallel",
    async execute(args) {
      return { status: "ok", output: JSON.stringify(args) }
    },
    ...body,
  }
}

function scriptClient(script: LlmStreamEvent[][]): LlmClient {
  let i = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield* script[Math.min(i++, script.length - 1)]
    },
  }
}

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

function eventsOf<T extends EventType>(events: AgentEvent[], type: T): AgentEvent<T>[] {
  return events.filter((e): e is AgentEvent<T> => e.type === type)
}

function firstIndexOf(events: AgentEvent[], type: EventType): number {
  return events.findIndex((e) => e.type === type)
}

async function run(deps: Partial<Parameters<typeof runAgent>[1]>) {
  const messages: Message[] = []
  const events: Parameters<Extract<Parameters<typeof runAgent>[1], { onEvent: unknown }>["onEvent"]>[] = []
  const outcome = await runAgent(
    { sessionId: "s", history: [], system: "", userText: "go" },
    {
      llm: scriptClient([[...toolCallStream(0, "call_1", "search", '{"q":"x"}')], FINAL]),
      model: "m",
      hooks: chainOf(),
      onEvent: (e) => events.push(e),
      onMessage: (m) => messages.push(m),
      ...deps,
    } as Parameters<typeof runAgent>[1],
  )
  return { messages, events: events as unknown as Array<{ type: string }>, outcome }
}

describe("runAgent tool turn", () => {
  it("executes tool, writes ordered tool message, loops to final", async () => {
    const tools = new Map([["search", echoTool()]])
    const toolDefs = [{ name: "search", description: "search the web", parameters: { type: "object" } }]
    const inner = scriptClient([[...toolCallStream(0, "call_1", "search", '{"q":"x"}')], FINAL])
    const requests: LlmRequest[] = []
    const llm: LlmClient = {
      async *stream(req) {
        requests.push(req)
        yield* inner.stream(req)
      },
    }
    const { messages, outcome } = await run({ tools, toolDefs, llm })
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const toolMsg = messages[2]
    expect(toolMsg.blocks[0]).toMatchObject({ type: "tool_result", callId: "call_1", status: "ok", output: '{"q":"x"}' })
    expect(outcome.stopReason).toBe("end_turn")
    expect(requests[0]?.tools).toEqual(toolDefs)
  })

  it("feeds executor errors back as error results", async () => {
    const boom: ToolExecutor = {
      risk: "safe", concurrency: "parallel",
      async execute() { throw new Error("boom") },
    }
    const { messages } = await run({ tools: new Map([["search", boom]]) })
    const result = messages[2].blocks[0] as { status: string; output: string }
    expect(result.status).toBe("error")
    expect(result.output).toContain("boom")
  })

  it("deny 钩子失败 → 该工具被拒绝（fail-closed），run 继续、hook.failed 可见", async () => {
    let executed = 0
    const search: ToolExecutor = {
      risk: "safe", concurrency: "parallel",
      async execute() { executed++; return { status: "ok", output: "{}" } },
    }
    const guard = hook("guard", "tool-before", () => { throw new Error("非工作时段") }, { failure: "deny", order: 1 })
    // 直接构造链以接住 onFailure（chainOf 不带回调；真实装配里它接到事件总线）
    const failures: AgentEvent[] = []
    const hooks = new HookChain({ timeoutMs: () => Number.POSITIVE_INFINITY, onFailure: (e) => failures.push(e as AgentEvent) })
    hooks.register(guard)
    const { messages, outcome } = await run({
      tools: new Map([["search", search]]),
      hooks,
    })
    expect(executed).toBe(0) // 拒绝在执行前发生
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const result = messages[2].blocks[0] as { type: string; status: string; output: string }
    expect(result.status).toBe("error")
    expect(result.output).toContain("钩子 guard 失败")
    expect(result.output).toContain("非工作时段")
    const note = messages[2].blocks.find((b) => b.type === "note") as { kind: string; text: string }
    expect(note.kind).toBe("denied")
    expect(failures.map((e) => e.type)).toEqual(["hook.failed"])
    expect(outcome.stopReason).toBe("end_turn") // run 照常收尾，模型能看到拒绝并反应
  })

  it("feeds invalid tool args and unknown tool back as error results", async () => {
    let executed = 0
    const search: ToolExecutor = {
      risk: "safe", concurrency: "parallel",
      async execute(args) {
        executed++
        return { status: "ok", output: JSON.stringify(args) }
      },
    }
    const script: LlmStreamEvent[][] = [[
      ...toolCallStream(0, "call_bad", "search", "{invalid"),
      ...toolCallStream(1, "call_missing", "nonexistent", "{}"),
    ], FINAL]
    const { messages, outcome } = await run({ tools: new Map([["search", search]]), llm: scriptClient(script) })
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const results = messages[2].blocks as Array<{ type: string; callId: string; status: string; output: string }>
    expect(results.map((b) => b.callId)).toEqual(["call_bad", "call_missing"])
    expect(results[0]).toMatchObject({ type: "tool_result", status: "error" })
    expect(results[0].output).toContain("invalid")
    expect(results[1]).toMatchObject({ type: "tool_result", status: "error" })
    expect(results[1].output).toContain("unknown tool")
    expect(executed).toBe(0)
    expect(outcome.stopReason).toBe("end_turn")
  })

  it("emits tool_call.completed with the raw block when args json is malformed", async () => {
    const events: AgentEvent[] = []
    const messages: Message[] = []
    await runAgent(
      { sessionId: "s", history: [], system: "", userText: "go" },
      {
        llm: scriptClient([[...toolCallStream(0, "call_bad", "search", "{invalid")], FINAL]),
        model: "m",
        hooks: chainOf(),
        onEvent: (e) => events.push(e),
        onMessage: (m) => messages.push(m),
        tools: new Map([["search", echoTool()]]),
      },
    )
    const completed = events.filter((e) => e.type === "tool_call.completed")
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ payload: { block: { callId: "call_bad", argsJson: "{invalid" } } })
    // the completed event precedes the error tool_result for that call
    const errResult = events.find((e) =>
      e.type === "tool_result.completed" && (e.payload as { block?: { callId?: string } }).block?.callId === "call_bad")
    expect(errResult).toBeTruthy()
    expect(events.indexOf(completed[0]!)).toBeLessThan(events.indexOf(errResult!))
    expect((messages[2].blocks[0] as { status: string }).status).toBe("error")
  })

  it("executes no-args tool calls with an empty args object", async () => {
    const messages: Message[] = []
    await runAgent(
      { sessionId: "s", history: [], system: "", userText: "go" },
      {
        // tool_call_started with NO args delta: argsJson stays "" and must
        // parse as {} instead of failing with "invalid tool args json"
        llm: scriptClient([[
          { type: "tool_call_started", index: 0, callId: "call_1", name: "search" },
          { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
        ], FINAL]),
        model: "m",
        hooks: chainOf(),
        onEvent: () => {},
        onMessage: (m) => messages.push(m),
        tools: new Map([["search", echoTool()]]),
      },
    )
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(messages[2].blocks[0]).toMatchObject({ type: "tool_result", callId: "call_1", status: "ok", output: "{}" })
  })

  it("runs parallel tools concurrently and serial tools exclusively, results in callId order", async () => {
    const active = new Set<string>()
    const order: string[] = []
    const mk = (name: string, concurrency: "parallel" | "serial", ms: number): [string, ToolExecutor] => [name, {
      risk: "safe", concurrency,
      async execute() {
        active.add(name); order.push(`start:${name}`)
        await new Promise((r) => setTimeout(r, ms))
        active.delete(name); order.push(`end:${name}`)
        if (concurrency === "serial" && active.size > 0) throw new Error("overlap detected")
        return { status: "ok", output: name }
      },
    }]
    const tools = new Map([mk("a", "parallel", 30), mk("b", "parallel", 10), mk("c", "serial", 5)])
    const events: Array<{ type: string; payload: { block?: { callId?: string } } }> = []
    const script: LlmStreamEvent[][] = [[
      ...toolCallStream(0, "call_a", "a", "{}"),
      ...toolCallStream(1, "call_b", "b", "{}"),
      ...toolCallStream(2, "call_c", "c", "{}"),
    ], FINAL]
    const messages: Message[] = []
    await runAgent(
      { sessionId: "s", history: [], system: "", userText: "go" },
      {
        llm: scriptClient(script), model: "m",
        hooks: chainOf(),
        onEvent: (e) => events.push(e as never),
        onMessage: (m) => messages.push(m),
        tools,
      },
    )
    // 并行的 a、b 有重叠；串行的 c 不与任何工具重叠
    expect(order.indexOf("end:b")).toBeLessThan(order.indexOf("end:a"))
    const resultBlocks = messages.find((m) => m.role === "tool")!.blocks
    expect(resultBlocks.map((b) => (b as { callId: string }).callId)).toEqual(["call_a", "call_b", "call_c"])
    // execution starts in model order, so tool_result.created events do too
    expect(events.filter((e) => e.type === "tool_result.created").map((e) => e.payload.block?.callId))
      .toEqual(["call_a", "call_b", "call_c"])
  })

  it("streams events with real messageIds and tool_result lifecycle in order", async () => {
    const events: AgentEvent[] = []
    const messages: Message[] = []
    const streamy: ToolExecutor = {
      risk: "safe", concurrency: "parallel",
      async execute(_args, ctx) {
        ctx.onOutput("chunk")
        return { status: "ok", output: "final" }
      },
    }
    await runAgent(
      { sessionId: "s", history: [], system: "", userText: "go" },
      {
        llm: scriptClient([[
          { type: "thinking_delta", delta: "ponder" },
          ...toolCallStream(0, "call_1", "search", "{}"),
        ], FINAL]),
        model: "m",
        hooks: chainOf(),
        onEvent: (e) => events.push(e),
        onMessage: (m) => messages.push(m),
        tools: new Map([["search", streamy]]),
      },
    )
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const asstToolTurn = messages[1]
    const toolMsg = messages[2]
    const asstFinal = messages[3]

    // 1) every message.created precedes its message's first block event
    //    (the user message's created now leads the whole stream)
    const createdEvents = eventsOf(events, "message.created")
    expect(createdEvents.map((e) => e.payload.message.id))
      .toEqual([messages[0]!.id, asstToolTurn.id, toolMsg.id, asstFinal.id])
    expect(firstIndexOf(events, "message.created")).toBeLessThan(firstIndexOf(events, "thinking.created"))
    expect(firstIndexOf(events, "message.created")).toBeLessThan(firstIndexOf(events, "tool_call.created"))
    const positionOf = (e: AgentEvent) => events.indexOf(e)
    expect(positionOf(createdEvents.find((e) => e.payload.message.id === asstFinal.id)!))
      .toBeLessThan(firstIndexOf(events, "text.created"))
    expect(positionOf(createdEvents.find((e) => e.payload.message.id === toolMsg.id)!))
      .toBeLessThan(firstIndexOf(events, "tool_result.created"))

    // 2) streaming deltas carry the real assistant messageIds
    expect(eventsOf(events, "thinking.delta").every((e) => e.payload.messageId === asstToolTurn.id)).toBe(true)
    expect(eventsOf(events, "tool_call.delta").every((e) => e.payload.messageId === asstToolTurn.id)).toBe(true)
    expect(eventsOf(events, "text.delta").every((e) => e.payload.messageId === asstFinal.id)).toBe(true)
    expect(eventsOf(events, "text.created").map((e) => e.payload.messageId)).toEqual([asstFinal.id])
    const toolCallBlockId = asstToolTurn.blocks.find((b): b is ToolCallBlock => b.type === "tool_call")!.id
    expect(eventsOf(events, "tool_call.delta").map((e) => e.payload.blockId)).toEqual([toolCallBlockId])

    // 3) tool_result lifecycle: created → delta → completed with the tool message's real id
    expect(firstIndexOf(events, "tool_result.created")).toBeLessThan(firstIndexOf(events, "tool_result.delta"))
    expect(firstIndexOf(events, "tool_result.delta")).toBeLessThan(firstIndexOf(events, "tool_result.completed"))
    expect(eventsOf(events, "tool_result.created")[0].payload).toMatchObject({
      messageId: toolMsg.id, block: { type: "tool_result", callId: "call_1" },
    })
    expect(eventsOf(events, "tool_result.delta")[0].payload).toEqual({
      messageId: toolMsg.id, callId: "call_1", delta: "chunk",
    })
    expect(eventsOf(events, "tool_result.completed")[0].payload).toMatchObject({
      messageId: toolMsg.id, block: { callId: "call_1", status: "ok", output: "final" },
    })
  })
})

describe("tool loop guard", () => {
  const repeated = (rounds: number, argsJson = '{"q":"x"}'): LlmStreamEvent[][] =>
    [...Array(rounds)].map((_, i) => [...toolCallStream(0, `call_${i}`, "search", argsJson)]).concat([FINAL])

  const resultsOf = (events: Parameters<Parameters<typeof runAgent>[1]["onEvent"]>[]) =>
    eventsOf(events as AgentEvent[], "tool_result.completed").map((e) => (e.payload as { block: ToolCallBlock }).block)

  it("appends a loop-guard reminder once repeats reach the threshold", async () => {
    const messages: Message[] = []
    const events: AgentEvent[] = []
    await runAgent(
      { sessionId: "s", history: [], system: "", userText: "go" },
      {
        llm: scriptClient(repeated(6)),
        model: "m",
        tools: new Map([["search", echoTool()]]),
        loopMaxRepeats: 5,
        hooks: chainOf(),
        onEvent: (e) => events.push(e as AgentEvent),
        onMessage: (m) => messages.push(m),
      } as Parameters<typeof runAgent>[1],
    )
    const results = eventsOf(events, "tool_result.completed").map((e) => (e.payload as { block: { output: string } }).block)
    expect(results).toHaveLength(6)
    expect(results[3]!.output).not.toContain("loop-guard")
    expect(results[4]!.output).toContain("loop-guard")
    expect(results[5]!.output).toContain("已连续重复 6 次")
    expect(messages.at(-2)!.blocks.some((b) => b.type === "tool_result" && b.output.includes("loop-guard"))).toBe(true)
  })

  it("a changed signature resets the counter; 0 disables the guard", async () => {
    const events: AgentEvent[] = []
    const calls = (rounds: number, argsJson: string): LlmStreamEvent[][] =>
      [...Array(rounds)].map((_, i) => [...toolCallStream(0, `call_${i}`, "search", argsJson)])
    // 6 rounds: a,a,a,b,b,b,end — thresholds never reached per signature
    const script = [...calls(3, '{"q":"a"}'), ...calls(3, '{"q":"b"}'), FINAL]
    await runAgent(
      { sessionId: "s", history: [], system: "", userText: "go" },
      {
        llm: scriptClient(script),
        model: "m",
        tools: new Map([["search", echoTool()]]),
        loopMaxRepeats: 5,
        hooks: chainOf(),
        onEvent: (e) => events.push(e as AgentEvent),
        onMessage: () => {},
      } as Parameters<typeof runAgent>[1],
    )
    const results = eventsOf(events, "tool_result.completed").map((e) => (e.payload as { block: { output: string } }).block)
    expect(results).toHaveLength(6)
    expect(results.every((r) => !r.output.includes("loop-guard"))).toBe(true)

    const eventsOff: AgentEvent[] = []
    await runAgent(
      { sessionId: "s", history: [], system: "", userText: "go" },
      {
        llm: scriptClient(repeated(4)),
        model: "m",
        tools: new Map([["search", echoTool()]]),
        loopMaxRepeats: 0,
        hooks: chainOf(),
        onEvent: (e) => eventsOff.push(e as AgentEvent),
        onMessage: () => {},
      } as Parameters<typeof runAgent>[1],
    )
    const off = eventsOf(eventsOff, "tool_result.completed").map((e) => (e.payload as { block: { output: string } }).block)
    expect(off.every((r) => !r.output.includes("loop-guard"))).toBe(true)
  })
})
