import { describe, it, expect } from "vitest"
import { toProviderMessages } from "../../src/agent/context.js"
import { newAssistantMessage, newMessage } from "../../src/protocol/messages.js"

describe("toProviderMessages", () => {
  it("maps user text and note blocks", () => {
    const m = newMessage("s", "user", [
      { id: "blk_1", type: "text", text: "查一下天气" },
      { id: "blk_2", type: "note", kind: "memory", text: "用户在上海" },
    ])
    expect(toProviderMessages([m], 10)).toEqual([
      { role: "user", content: "查一下天气\n[system note] 用户在上海" },
    ])
  })

  it("maps assistant tool_calls and tool results pairwise", () => {
    const a = newAssistantMessage("s", "glm", [
      { id: "blk_1", type: "text", text: "我来查" },
      { id: "blk_2", type: "tool_call", callId: "call_1", name: "exec", args: { command: "ls" }, argsJson: "{\"command\":\"ls\"}" },
    ])
    a.stopReason = "tool_use"
    const t = newMessage("s", "tool", [
      { id: "blk_3", type: "tool_result", callId: "call_1", status: "ok", output: "a.txt", durationMs: 10 },
    ])
    const out = toProviderMessages([a, t], 10)
    expect(out).toEqual([
      { role: "assistant", content: "我来查", toolCalls: [{ callId: "call_1", name: "exec", argsJson: "{\"command\":\"ls\"}" }] },
      { role: "tool", toolCallId: "call_1", content: "a.txt" },
    ])
  })

  it("marks error results", () => {
    const a = newAssistantMessage("s", "glm", [
      { id: "blk_0", type: "tool_call", callId: "call_9", name: "exec", args: {}, argsJson: "{}" },
    ])
    const t = newMessage("s", "tool", [
      { id: "blk_1", type: "tool_result", callId: "call_9", status: "error", output: "boom", durationMs: 1 },
    ])
    expect(toProviderMessages([a, t], 10)[1].content).toBe("[error] boom")
  })

  it("applies sliding window", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => newMessage("s", "user", [{ id: `blk_${i}`, type: "text", text: String(i) }]))
    const out = toProviderMessages(msgs, 3)
    expect(out.map((m) => m.role === "user" ? m.content : "")).toEqual(["2", "3", "4"])
  })

  it("drops orphan tool messages at window edge", () => {
    const a = newAssistantMessage("s", "glm", [
      { id: "blk_1", type: "tool_call", callId: "call_1", name: "exec", args: { command: "ls" }, argsJson: "{\"command\":\"ls\"}" },
    ])
    a.stopReason = "tool_use"
    const t = newMessage("s", "tool", [
      { id: "blk_2", type: "tool_result", callId: "call_1", status: "ok", output: "a.txt", durationMs: 10 },
    ])
    const u = newMessage("s", "user", [{ id: "blk_3", type: "text", text: "hi" }])
    const out = toProviderMessages([a, t, u], 2)
    expect(out[0].role).not.toBe("tool")
    expect(out).toEqual([{ role: "user", content: "hi" }])
  })

  it("drops tool_calls whose tool message is missing from the window", () => {
    // defense in depth: a dangling tool_call (no tool message at all) must not
    // reach the provider — OpenAI-compat APIs 400 on unpaired tool_calls
    const a = newAssistantMessage("s", "glm", [
      { id: "blk_1", type: "text", text: "let me run" },
      { id: "blk_2", type: "tool_call", callId: "call_1", name: "exec", args: {}, argsJson: "{}" },
    ])
    const u = newMessage("s", "user", [{ id: "blk_3", type: "text", text: "next" }])
    const out = toProviderMessages([a, u], 10)
    expect(out).toEqual([
      { role: "assistant", content: "let me run" },
      { role: "user", content: "next" },
    ])
  })

  it("keeps only the tool_calls that are answered inside the window", () => {
    const a = newAssistantMessage("s", "glm", [
      { id: "blk_1", type: "tool_call", callId: "call_1", name: "exec", args: {}, argsJson: "{}" },
      { id: "blk_2", type: "tool_call", callId: "call_2", name: "exec", args: {}, argsJson: "{}" },
    ])
    const t = newMessage("s", "tool", [
      { id: "blk_3", type: "tool_result", callId: "call_2", status: "ok", output: "ok", durationMs: 1 },
    ])
    const out = toProviderMessages([a, t], 10)
    expect(out).toEqual([
      { role: "assistant", content: null, toolCalls: [{ callId: "call_2", name: "exec", argsJson: "{}" }] },
      { role: "tool", toolCallId: "call_2", content: "ok" },
    ])
  })
})
