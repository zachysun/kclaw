import { describe, it, expect } from "vitest"
import { toProviderMessages } from "../../src/agent/context.js"
import { newAssistantMessage, newMessage } from "../../src/protocol/messages.js"
import { newMessage as nm, newAssistantMessage as na } from "../../src/protocol/messages.js"

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

describe("toProviderMessages attachment rendering", () => {
  it("renders a base64 image attachment as multimodal content parts", () => {
    const m = newMessage("s", "user", [
      { id: "blk_1", type: "text", text: "看看这张图" },
      { id: "blk_2", type: "attachment", mimeType: "image/png", name: "shot.png", source: { type: "base64", data: "aGVsbG8=" } },
    ])
    const out = toProviderMessages([m], 10)
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      },
    ])
  })

  it("renders an inline-text attachment as a labelled text block", () => {
    const m = newMessage("s", "user", [
      { id: "blk_1", type: "attachment", mimeType: "text/markdown", name: "todo.md", text: "- 买菜\n- 健身", source: { type: "file", path: "/home/x/attachments/s1/todo.md" } },
    ])
    const out = toProviderMessages([m], 10)
    expect(out).toEqual([{ role: "user", content: "[附件 todo.md]\n- 买菜\n- 健身" }])
  })

  it("renders a large/other attachment as metadata for on-demand fs_read", () => {
    const m = newMessage("s", "user", [
      { id: "blk_1", type: "attachment", mimeType: "application/pdf", name: "report.pdf", source: { type: "file", path: "/home/x/attachments/s1/report.pdf" } },
    ])
    const out = toProviderMessages([m], 10)
    expect(out).toEqual([
      { role: "user", content: "[附件 report.pdf（application/pdf，仅元数据）已保存，路径 /home/x/attachments/s1/report.pdf，可用 fs_read 读取]" },
    ])
  })

  it("keeps string content for messages without images", () => {
    const m = newMessage("s", "user", [
      { id: "blk_1", type: "text", text: "纯文本" },
      { id: "blk_2", type: "attachment", mimeType: "text/plain", name: "a.txt", text: "hi", source: { type: "file", path: "/p/a.txt" } },
    ])
    const out = toProviderMessages([m], 10)
    expect(out).toEqual([{ role: "user", content: "纯文本\n[附件 a.txt]\nhi" }])
  })
})

describe("toProviderMessages tool-result eviction", () => {
  const big = (id: string, callId: string, name: string) => {
    const a = na("s", "m", [
      { id: `t-${id}`, type: "text", text: `第${id}步` },
      { id: `c-${id}`, type: "tool_call", callId, name, args: {}, argsJson: "{}" },
    ])
    a.stopReason = "tool_use"
    const t = nm("s", "tool", [
      { id: `r-${id}`, type: "tool_result", callId, status: "ok", output: `${id}的完整输出`.repeat(200), durationMs: 1 },
    ])
    return [a, t]
  }

  it("replaces tool results older than toolResultKeep with a placeholder", () => {
    const msgs = [...big("一", "c1", "fs_read"), ...big("二", "c2", "exec"), ...big("三", "c3", "fs_read")]
    const out = toProviderMessages(msgs, 50, { toolResultKeep: 1 })
    const tools = out.filter((m) => m.role === "tool")
    expect(tools.length).toBe(3)
    expect(tools[0]!.content).toContain("此工具输出已省略")
    expect(tools[0]!.content).toContain("fs_read")
    expect(tools[1]!.content).toContain("此工具输出已省略")
    expect(tools[2]!.content).toContain("三的完整输出") // newest kept verbatim
    // pairing intact: every tool message still follows its assistant tool_call
    expect(out.filter((m) => m.role === "assistant").length).toBe(3)
  })

  it("marks evicted failed calls as failed", () => {
    const a = na("s", "m", [
      { id: "c1", type: "tool_call", callId: "x", name: "exec", args: {}, argsJson: "{}" },
    ])
    a.stopReason = "tool_use"
    const t = nm("s", "tool", [
      { id: "r1", type: "tool_result", callId: "x", status: "error", output: "boom", durationMs: 1 },
    ])
    const newer = big("新", "y", "exec")
    const out = toProviderMessages([a, t, ...newer], 50, { toolResultKeep: 1 })
    const evicted = out.find((m) => m.role === "tool" && m.content.includes("已省略"))
    expect(evicted!.content).toContain("该次调用失败")
  })

  it("keeps everything when results are fewer than toolResultKeep", () => {
    const msgs = big("一", "c1", "fs_read")
    const out = toProviderMessages(msgs, 50, { toolResultKeep: 8 })
    expect(out.find((m) => m.role === "tool")!.content).toContain("一的完整输出")
  })
})
