import { describe, it, expect } from "vitest"
import { runAgent } from "../../src/agent/loop.js"
import type { LlmClient, LlmRequest, LlmStreamEvent } from "../../src/provider/types.js"
import type { AgentEvent } from "../../src/protocol/events.js"
import type { Message } from "../../src/protocol/messages.js"
import { newMessage } from "../../src/protocol/messages.js"
import { newBlockId } from "../../src/protocol/blocks.js"
import { chainOf, hook } from "./hook-utils.js"

function textClient(deltas: string[]): LlmClient {
  const events: LlmStreamEvent[] = deltas.map((d) => ({ type: "text_delta", delta: d }))
  events.push({ type: "message_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } })
  return { async *stream(): AsyncIterable<LlmStreamEvent> { yield* events } }
}

async function runText(deps: Partial<Parameters<typeof runAgent>[1]> = {}) {
  const events: AgentEvent[] = []
  const messages: Message[] = []
  const outcome = await runAgent(
    { sessionId: "ses_1", history: [], system: "sys", userText: "hi" },
    {
      llm: textClient(["Hel", "lo"]),
      model: "glm-4.7",
      hooks: chainOf(),
      onEvent: (e) => events.push(e),
      onMessage: (m) => messages.push(m),
      ...deps,
    },
  )
  return { events, messages, outcome }
}

describe("runAgent text turn", () => {
  it("persists user and assistant messages and emits lifecycle events", async () => {
    const { events, messages, outcome } = await runText()
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("run.started")
    expect(types).toContain("text.created")
    expect(types.filter((t) => t === "text.delta")).toHaveLength(2)
    expect(types).toContain("text.completed")
    expect(types.at(-1)).toBe("run.completed")

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
    const assistant = messages[1]
    expect(assistant.blocks).toEqual([expect.objectContaining({ type: "text", text: "Hello" })])

    expect(outcome.stopReason).toBe("end_turn")
    expect(outcome.totalUsage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(outcome.messages).toHaveLength(2)
  })

  it("emits llm.started/llm.completed around the call", async () => {
    const { events } = await runText()
    const types = events.map((e) => e.type)
    expect(types).toContain("llm.started")
    expect(types).toContain("llm.completed")
  })
})

/** Timeline label: message lifecycle entries carry their role so user and
 * assistant `message.completed` are distinguishable in ordering assertions. */
function label(e: AgentEvent): string {
  if (e.type === "message.created" || e.type === "message.completed") {
    return `${e.type}:${e.payload.message.role}`
  }
  return e.type
}

describe("runAgent user message lifecycle events", () => {
  it("default path: created → persist → completed → llm.started in wire order", async () => {
    const events: AgentEvent[] = []
    const messages: Message[] = []
    const timeline: string[] = []
    await runAgent(
      { sessionId: "ses_1", history: [], system: "sys", userText: "hi" },
      {
        llm: textClient(["ok"]),
        model: "m",
        hooks: chainOf(),
        onEvent: (e) => { events.push(e); timeline.push(`event:${label(e)}`) },
        onMessage: (m) => { messages.push(m); timeline.push(`persist:${m.role}`) },
      },
    )

    // wire order: run.started → user created → user completed → llm.*
    expect(events.map(label).slice(0, 4)).toEqual([
      "run.started", "message.created:user", "message.completed:user", "llm.started",
    ])
    const [created, completed] = [events[1]!, events[2]!]
    expect(created.payload).toEqual({ message: messages[0] })
    expect(completed.payload).toEqual({ message: messages[0] })

    // events reflect persisted state: the user message is onMessage'd BEFORE
    // its message.completed goes out (same contract as assistant messages).
    const idx = (s: string): number => timeline.indexOf(s)
    expect(idx("event:message.created:user")).toBeLessThan(idx("persist:user"))
    expect(idx("persist:user")).toBeLessThan(idx("event:message.completed:user"))
    expect(idx("event:message.completed:user")).toBeLessThan(idx("event:llm.started"))
  })

  it("run-before hook: augmentation lands between created and persist/completed", async () => {
    const events: AgentEvent[] = []
    const messages: Message[] = []
    const timeline: string[] = []
    let received: Message | undefined
    let skeleton: Message | undefined // snapshot at hook time (the hook mutates)
    const outcome = await runAgent(
      { sessionId: "ses_1", history: [], system: "sys", userText: "hi" },
      {
        llm: textClient(["ok"]),
        model: "m",
        hooks: chainOf(hook("land", "run-before", (ctx) => {
          timeline.push("hook")
          received = ctx.message
          skeleton = { ...ctx.message, blocks: [...ctx.message.blocks] }
          ctx.message.blocks.push({ id: newBlockId(), type: "note", kind: "memory", text: "相关记忆: x" })
          return ctx.message
        })),
        onEvent: (e) => { events.push(e); timeline.push(`event:${label(e)}`) },
        onMessage: (m) => { messages.push(m); timeline.push(`persist:${m.role}`) },
      },
    )

    // the hook saw the SKELETON announced by message.created (no notes yet),
    // exactly the instance created announced, and the returned (augmented)
    // message is what continues.
    expect(skeleton!.blocks.some((b) => b.type === "note")).toBe(false)
    expect(events[1]!.payload.message).toBe(received)
    expect(messages[0]).toBe(received)
    expect(messages[0]!.blocks.some((b) => b.type === "note")).toBe(true)
    const completed = events[2]!
    expect(completed.type).toBe("message.completed")
    expect(completed.payload.message.blocks.some((b) => b.type === "note")).toBe(true)
    expect(outcome.messages[0]).toBe(messages[0])

    // created → hook → persist → completed → llm.started
    const idx = (s: string): number => timeline.indexOf(s)
    expect(idx("event:message.created:user")).toBeLessThan(idx("hook"))
    expect(idx("hook")).toBeLessThan(idx("persist:user"))
    expect(idx("persist:user")).toBeLessThan(idx("event:message.completed:user"))
    expect(idx("event:message.completed:user")).toBeLessThan(idx("event:llm.started"))
  })

  it("injected userMessage: created/completed fire (events only, never re-persisted)", async () => {
    const userMessage = newMessage("ses_1", "user", [
      { id: newBlockId(), type: "text", text: "hi" },
    ])
    const events: AgentEvent[] = []
    const messages: Message[] = []
    let hooked: Message | undefined
    const outcome = await runAgent(
      { sessionId: "ses_1", history: [], system: "sys", userText: "ignored", userMessage },
      {
        llm: textClient(["ok"]),
        model: "m",
        hooks: chainOf(hook("land", "run-before", (ctx) => {
          hooked = ctx.message
          ctx.message.blocks.push({ id: newBlockId(), type: "note", kind: "job", text: "本会话由定时任务触发" })
          return ctx.message
        })),
        onEvent: (e) => events.push(e),
        onMessage: (m) => messages.push(m),
      },
    )

    // events for the injected message too; the hook augments it in place
    expect(events.map(label).slice(0, 3)).toEqual([
      "run.started", "message.created:user", "message.completed:user",
    ])
    expect(events[1]!.payload.message.id).toBe(userMessage.id)
    expect(hooked).toBe(userMessage)
    expect(events[2]!.payload.message.blocks.some((b) => b.type === "note")).toBe(true)

    // the injected path still never persists the user message through
    // onMessage (the caller owns its persistence), and the run used the
    // augmented instance.
    expect(messages.map((m) => m.role)).toEqual(["assistant"])
    expect(outcome.messages[0]).toBe(userMessage)
  })
})

describe("user message handling failures terminate the run", () => {
  it("a throwing fatal run-before hook ends with run.failed and an error outcome", async () => {
    const events: AgentEvent[] = []
    const outcome = await runAgent(
      { sessionId: "ses_1", history: [], system: "sys", userText: "hi" },
      {
        llm: textClient(["never"]), // must never be called
        model: "m",
        hooks: chainOf(hook("boom", "run-before", () => { throw new Error("disk full") })),
        onEvent: (e) => events.push(e),
        onMessage: () => { throw new Error("persisted anyway?") },
      },
    )
    // resolved — never rejected — with the error stopReason
    expect(outcome.stopReason).toBe("error")
    expect(outcome.messages.map((m) => m.role)).toEqual(["user"])
    // invariant: run.started is always followed by a terminal event
    expect(events.map(label)).toEqual(["run.started", "message.created:user", "run.failed"])
    expect(events.at(-1)!.payload).toEqual({
      error: { code: "user_message_failed", message: "disk full" },
    })
  })

  it("a throwing onMessage (persistence) ends the same way: run.failed, no llm call", async () => {
    const llmCalls: LlmRequest[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        llmCalls.push(req)
        yield { type: "text_delta", delta: "x" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const events: AgentEvent[] = []
    const outcome = await runAgent(
      { sessionId: "ses_1", history: [], system: "sys", userText: "hi" },
      {
        llm,
        model: "m",
        hooks: chainOf(),
        onEvent: (e) => events.push(e),
        onMessage: () => { throw new Error("jsonl write failed") },
      },
    )
    expect(outcome.stopReason).toBe("error")
    expect(events.map(label)).toEqual(["run.started", "message.created:user", "run.failed"])
    expect(events.at(-1)!.payload).toEqual({
      error: { code: "user_message_failed", message: "jsonl write failed" },
    })
    expect(llmCalls).toHaveLength(0) // the run died before any model call
  })
})

describe("runAgent with a caller-supplied user message", () => {
  it("uses the provided message verbatim and does not re-persist it", async () => {
    // Daemon-side shape: the caller built the user message (to attach memory
    // notes) and already appended it to the session log.
    const userMessage = newMessage("ses_1", "user", [
      { id: newBlockId(), type: "text", text: "hi" },
      { id: newBlockId(), type: "note", kind: "memory", text: "相关记忆: 用户在上海" },
    ])
    const requests: LlmRequest[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield { type: "text_delta", delta: "ok" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const events: AgentEvent[] = []
    const messages: Message[] = []

    const outcome = await runAgent(
      { sessionId: "ses_1", history: [], system: "sys", userText: "ignored", userMessage },
      { llm, model: "m", hooks: chainOf(), onEvent: (e) => events.push(e), onMessage: (m) => messages.push(m) },
    )

    // the run's user message IS the provided one (notes included), and
    // onMessage fired for the assistant only — no duplicate user line.
    expect(outcome.messages[0]).toBe(userMessage)
    expect(messages.map((m) => m.role)).toEqual(["assistant"])

    // notes ride along to the provider: text + the <system-reminder> wrapper.
    expect(requests[0]!.messages).toEqual([
      { role: "user", content: "hi\n<system-reminder kind=\"memory\">相关记忆: 用户在上海</system-reminder>" },
    ])
  })
})
