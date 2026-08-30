import { describe, it, expect, vi } from "vitest"
import { runAgent, type AgentDeps, type RunInput } from "../../src/agent/index.js"
import { newMessage } from "../../src/protocol/messages.js"
import type { AgentEvent, LlmClient, LlmStreamEvent, Message, ProviderMessage, ToolDefinition } from "../../src/index.js"

const noopTool = { name: "noop", risk: "safe" as const, concurrency: "parallel" as const, async execute() { return { status: "ok" as const, output: "" } } }
const noopDef: ToolDefinition = { name: "noop", description: "", parameters: { type: "object", properties: {} } }

/** 带 id 的 user 消息（压缩视图按 message id 找 upto 边界）。 */
function userMsg(id: string, text: string): Message {
  const m = newMessage("ses_1", "user", [{ id: `b-${id}`, type: "text", text }])
  m.id = id
  return m
}

/** 第一轮吐一个 tool_use（触发工具批次→迭代边界），此后每轮 end_turn；记录每次收到的 messages。 */
function toolThenEndRecording(views: ProviderMessage[][]): LlmClient {
  let call = 0
  return {
    async *stream(req): AsyncIterable<LlmStreamEvent> {
      call += 1
      views.push(req.messages)
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

function baseInput(history: Message[] = []): RunInput {
  return { sessionId: "ses_1", history, system: "s", userText: "go" }
}

function baseDeps(llm: LlmClient, events: AgentEvent[]): Pick<AgentDeps, "llm" | "model" | "tools" | "toolDefs" | "onEvent" | "onMessage"> {
  return {
    llm, model: "m",
    tools: new Map([["noop", noopTool]]),
    toolDefs: [noopDef],
    onEvent: (e) => events.push(e),
    onMessage: () => {},
  }
}

describe("compaction hooks in the agent loop", () => {
  it("边界钩子先于 steering 注入，返回的视图应用于下一次请求", async () => {
    const order: string[] = []
    const views: ProviderMessage[][] = []
    const events: AgentEvent[] = []
    const deps: AgentDeps = {
      ...baseDeps(toolThenEndRecording(views), events),
      midRunCompaction: async () => { order.push("compact"); return { upto: "u1", top: "S" } },
      steering: () => { order.push("steer"); return [] },
    }
    const outcome = await runAgent(baseInput([userMsg("u0", "很早的话题"), userMsg("u1", "upto 消息")]), deps)
    expect(outcome.stopReason).toBe("end_turn")
    // 顺序：工具批次完成 → midRunCompaction → steering drain
    expect(order).toEqual(["compact", "steer"])
    // 下一次请求：messages[0] 是脉络项
    expect(views[1]![0]!.role).toBe("system")
    expect(String(views[1]![0]!.content)).toMatch(/^早期对话脉络：S/)
    // upto（含）之前的原文不再出现
    const flat = views[1]!.map((m) => JSON.stringify(m)).join("\n")
    expect(flat).not.toContain("很早的话题")
    expect(flat).not.toContain("upto 消息")
    // 第一次请求（压缩前）仍包含全部原文
    expect(views[0]!.map((m) => JSON.stringify(m)).join("\n")).toContain("很早的话题")
  })

  it("钩子抛错时运行照常继续", async () => {
    const events: AgentEvent[] = []
    const views: ProviderMessage[][] = []
    const deps: AgentDeps = {
      ...baseDeps(toolThenEndRecording(views), events),
      midRunCompaction: async () => { throw new Error("boom") },
    }
    const outcome = await runAgent(baseInput(), deps)
    expect(outcome.stopReason).toBe("end_turn")
    // 压缩失败：第二次请求不带头绪项（视图未变更）
    expect(views[1]!.every((m) => m.role !== "system")).toBe(true)
    expect(events.some((e) => e.type === "run.failed")).toBe(false)
  })

  it("超限且未收到 delta 时重试一次并成功", async () => {
    const views: ProviderMessage[][] = []
    const events: AgentEvent[] = []
    let calls = 0
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        calls += 1
        views.push(req.messages)
        if (calls === 1) throw new Error("maximum context length exceeded")
        yield { type: "text_delta", delta: "recovered" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const deps: AgentDeps = {
      ...baseDeps(llm, events),
      onContextOverflow: async () => ({ upto: "u1", top: "S" }),
    }
    const outcome = await runAgent(baseInput([userMsg("u0", "很早的话题"), userMsg("u1", "upto 消息")]), deps)
    expect(calls).toBe(2)
    expect(outcome.stopReason).toBe("end_turn")
    // 重试换压缩视图：messages[0] 是脉络项，upto 前原文消失
    expect(String(views[1]![0]!.content)).toMatch(/^早期对话脉络：S/)
    expect(views[1]!.map((m) => JSON.stringify(m)).join("\n")).not.toContain("很早的话题")
    // 内部自愈：不额外发 llm.started / llm.failed
    expect(events.filter((e) => e.type === "llm.started")).toHaveLength(1)
    expect(events.some((e) => e.type === "llm.failed")).toBe(false)
  })

  it("已收到 delta 的流失败不触发超限重试", async () => {
    const events: AgentEvent[] = []
    let calls = 0
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        calls += 1
        yield { type: "text_delta", delta: "partial" }
        throw new Error("maximum context length exceeded")
      },
    }
    const onContextOverflow = vi.fn(async () => ({ upto: "u1", top: "S" }))
    const deps: AgentDeps = {
      ...baseDeps(llm, events),
      onContextOverflow,
    }
    const outcome = await runAgent(baseInput(), deps)
    expect(calls).toBe(1)
    expect(outcome.stopReason).toBe("error")
    expect(onContextOverflow).not.toHaveBeenCalled()
  })

  it("信号在急救钩子 await 期间中止：不再做注定无用的重试，run 以 aborted 收场", async () => {
    // 窄窗口（T5 minor）：溢出发生后、急救压缩归并完成的那一刻用户取消——
    // 钩子返回了有效视图但信号已中止。修复前循环会带着已中止的信号再发起一次
    // 请求（streamWithAbort 立即短路，但那仍是一次多余的模型调用，calls 到 2）；
    // 修复后 await 归来先查信号，直接放弃重试（calls 停在 1）。
    const events: AgentEvent[] = []
    let calls = 0
    const ctrl = new AbortController()
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        calls += 1
        if (calls === 1) throw new Error("maximum context length exceeded")
        yield { type: "text_delta", delta: "recovered" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const deps: AgentDeps = {
      ...baseDeps(llm, events),
      signal: ctrl.signal,
      onContextOverflow: async () => { ctrl.abort(); return { upto: "u1", top: "S" } },
    }
    const outcome = await runAgent(baseInput(), deps)
    expect(calls).toBe(1)
    expect(outcome.stopReason).toBe("aborted")
  })
})
