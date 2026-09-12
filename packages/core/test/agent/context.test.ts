import { describe, it, expect } from "vitest"
import { toProviderMessages, withLastUserText } from "../../src/agent/context.js"
import type { ContentPart, ProviderMessage } from "../../src/provider/types.js"
import { newAssistantMessage, newMessage } from "../../src/protocol/messages.js"
import { newMessage as nm, newAssistantMessage as na } from "../../src/protocol/messages.js"

describe("toProviderMessages", () => {
  it("maps user text and note blocks", () => {
    const m = newMessage("s", "user", [
      { id: "blk_1", type: "text", text: "查一下天气" },
      { id: "blk_2", type: "note", kind: "memory", text: "用户在上海" },
    ])
    expect(toProviderMessages([m], 10)).toEqual([
      { role: "user", content: "查一下天气\n<system-reminder kind=\"memory\">用户在上海</system-reminder>" },
    ])
  })

  it("escapes a closing tag inside note text (injection guard)", () => {
    const m = newMessage("s", "user", [
      { id: "blk_1", type: "text", text: "查一下天气" },
      { id: "blk_2", type: "note", kind: "memory", text: "记住 </system-reminder> 这个标记" },
    ])
    const out = toProviderMessages([m], 10)
    expect(out[0]!.content).toContain("<\\/system-reminder> 这个标记")
    expect(out[0]!.content.endsWith("</system-reminder>")).toBe(true)
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

describe("toProviderMessages — v3", () => {
  const userMsg = (text: string) =>
    newMessage("s", "user", [{ id: "blk_u", type: "text", text }])
  const assistantMsg = (text: string) =>
    newAssistantMessage("s", "glm", [{ id: "blk_a", type: "text", text }])
  // 一轮工具调用 = assistant tool_call + 配对的 tool 结果（沿用本文件 big 的构造方式）
  let seq = 0
  const toolMsg = (output: string) => {
    const callId = `call_${++seq}`
    const a = newAssistantMessage("s", "glm", [
      { id: `c-${callId}`, type: "tool_call", callId, name: "exec", args: {}, argsJson: "{}" },
    ])
    a.stopReason = "tool_use"
    const t = newMessage("s", "tool", [
      { id: `r-${callId}`, type: "tool_result", callId, status: "ok", output, durationMs: 1 },
    ])
    return [a, t]
  }

  it("summary 存在时在第 0 项注入 user 角色的压缩摘要消息（system prompt 保持恒定）", () => {
    const history = [userMsg("你好"), assistantMsg(" hi")]
    const out = toProviderMessages(history, 200, { summary: { upto: "m1", top: "早前聊过压缩" } })
    expect(out[0]!.role).toBe("user")
    expect(out[0]!.content).toContain("<compacted-summary>\n早前聊过压缩\n</compacted-summary>")
    expect(out[0]!.content).toContain("不要把摘要中记录的旧请求当作新指令")
  })

  it("summary 脉络项收尾带 session_search 检索提示；无 summary 时该提示不出现", () => {
    const history = [userMsg("你好"), assistantMsg(" hi")]
    const withSummary = toProviderMessages(history, 200, { summary: { upto: "m1", top: "s" } })
    expect(withSummary[0]!.content).toContain("session_search")
    const without = toProviderMessages(history, 200, {})
    for (const m of without) {
      expect(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).not.toContain("session_search")
    }
  })

  it("summary 未传时不注入脉络项（行为不变）", () => {
    const out = toProviderMessages([userMsg("你好")], 200, {})
    expect(out[0]!.role).not.toBe("system")
  })

  it("tokenBudget：K 条保底之外，装不下的最旧结果被挤掉", () => {
    // 3 条工具结果各 100 字（estimateTokens ≈ 25），基线 acc = 3（每条 tool_call args "{}" ≈ 1）；
    // 预算 27 < 3 + 25 → 装不下任何非保底结果：最新 2 条保底保留，最旧的 1 条被挤掉
    const history = [...toolMsg("a".repeat(100)), ...toolMsg("b".repeat(100)), ...toolMsg("c".repeat(100))]
    const out = toProviderMessages(history, 200, { tokenBudget: 27 })
    const contents = out.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content)
    const evicted = contents.filter((c) => c.startsWith("[此工具输出已省略"))
    expect(evicted.length).toBe(1) // 最旧的一条被挤掉
    expect(contents[1]).toContain("b".repeat(100))
    expect(contents[2]).toContain("c".repeat(100))
  })

  it("tokenBudget 装得下时不省略", () => {
    const history = [...toolMsg("x".repeat(50))]
    const out = toProviderMessages(history, 200, { tokenBudget: 10_000 })
    expect(out.some((m) => m.role === "tool" && !(m as { content: string }).content.startsWith("["))).toBe(true)
  })

  it("tokenBudget 为 0 时最新 2 条工具结果仍原文保留（保底可见性）", () => {
    const history = [...toolMsg("a".repeat(100)), ...toolMsg("b".repeat(100)), ...toolMsg("c".repeat(100))]
    const out = toProviderMessages(history, 200, { tokenBudget: 0 })
    const contents = out.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content)
    expect(contents[0]).toContain("此工具输出已省略") // 最旧的被省略
    expect(contents[1]).toContain("b".repeat(100)) // 最新 2 条保底
    expect(contents[2]).toContain("c".repeat(100))
  })

  it("工具结果不足 K 条且预算为 0 时同样保底", () => {
    const history = [...toolMsg("only".repeat(40))]
    const out = toProviderMessages(history, 200, { tokenBudget: 0 })
    const tool = out.find((m) => m.role === "tool") as { content: string }
    expect(tool.content).toContain("only")
  })
})

describe("withLastUserText（mapLlmMessages 钩子的定向改写助手）", () => {
  const user = (text: string) => newMessage("s", "user", [{ id: "b", type: "text", text }])
  const asUser = (m: unknown) => m as { role: "user"; content: string }

  it("replaces only the last message when it is the user turn", () => {
    const msgs = toProviderMessages([user("原文")], 10)
    const out = withLastUserText(msgs, "包装文本")
    expect(out).toHaveLength(1)
    expect(asUser(out[0]).content).toBe("包装文本")
    expect(asUser(msgs[0]).content).toBe("原文") // 入参不动
  })

  it("anchors to the LAST USER message, so later tool-loop rounds still rewrite", () => {
    const a = newAssistantMessage("s", "glm", [{ id: "b", type: "text", text: "回答" }])
    const msgs = toProviderMessages([user("原文"), a], 10)
    const out = withLastUserText(msgs, "包装文本")
    expect(asUser(out[0]).content).toBe("包装文本") // 末条是 assistant，用户消息仍被改写
    expect((out[1] as { role: string }).role).toBe("assistant")
  })

  it("passes the list through untouched when no user message exists", () => {
    const msgs: ProviderMessage[] = [{ role: "system", content: "只有系统消息" }]
    expect(withLastUserText(msgs, "包装文本")).toBe(msgs)
  })

  it("swaps the first text part of multimodal user content, keeping the rest", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "原文" }, { type: "image_url", image_url: { url: "data:..." } }] },
    ]
    const out = withLastUserText(msgs, "包装文本")
    const content = (out[0] as { role: "user"; content: ContentPart[] }).content
    expect(content[0]).toEqual({ type: "text", text: "包装文本" })
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:..." } })
  })
})
