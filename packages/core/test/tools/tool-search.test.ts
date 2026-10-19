import { describe, it, expect } from "vitest"
import { createToolSearchTool } from "../../src/tools/tool-search.js"
import type { ToolDefinition, ToolExecutor } from "../../src/index.js"

const call = (t: { execute: ToolExecutor["execute"] }, args: unknown) => t.execute(args, { onOutput: () => {} })

const def = (name: string, description: string, params: string[] = []): ToolDefinition => ({
  name,
  description,
  parameters: {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p, { type: "string", description: p }])),
    required: params.slice(0, 1),
  },
})

const POOL = [
  def("subagent_run", "Dispatch a subagent to run a self-contained task in a child session", ["task", "label"]),
  def("cron_create", "Create a scheduled cron task that fires a prompt on a schedule", ["name", "prompt", "cron"]),
  def("cron_list", "List scheduled crons with next run and last result", []),
  def("send_message", "Send a message to a teammate via the durable mailbox", ["text"]),
  def("memory_search", "Search long-term memory across projects (keywords plus vectors)", ["query"]),
  def("memory_save", "立即把当前这轮对话沉淀进长期记忆（触发记忆写入 pipeline）", ["text"]),
  def("mcp__playwright__browser_click", "Click an element on the web page", ["target"]),
]

describe("tool_search", () => {
  const mk = (pool = POOL, sources = ["mcp:playwright", "builtin"]) => createToolSearchTool({ pool, sources })

  it("exact-name match ranks first and returns a complete card", async () => {
    const r = await call(mk(), { query: "cron_create" })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("【cron_create】")
    expect(r.output).toContain("来源：builtin")
    expect(r.output).toContain("prompt")
    expect((r.data as { names: string[] }).names[0]).toBe("cron_create")
  })

  it("intent words find the right tool (BM25 over name+description+params)", async () => {
    const r = await call(mk(), { query: "schedule a prompt on a recurring basis" })
    const names = (r.data as { names: string[] }).names
    expect(names[0]).toBe("cron_create")
    const r2 = await call(mk(), { query: "mailbox teammate note" })
    expect((r2.data as { names: string[] }).names).toContain("send_message")
    const r3 = await call(mk(), { query: "click element page" })
    expect((r3.data as { names: string[] }).names[0]).toBe("mcp__playwright__browser_click")
    // CJK bigrams: a Chinese query hits the Chinese-description tool
    const r4 = await call(mk(), { query: "沉淀记忆" })
    expect((r4.data as { names: string[] }).names[0]).toBe("memory_save")
  })

  it("promotes hit defs through the run context (real promotion, not a bridge)", async () => {
    const promoted: string[] = []
    const t = mk()
    const wrapped: ToolExecutor = {
      ...t,
      execute(args, ctx) {
        return t.execute(args, {
          ...ctx,
          promote: (defs) => defs.forEach((d) => promoted.push(d.name)),
        })
      },
    }
    const r = await call(wrapped, { query: "cron_list" })
    expect(r.status).toBe("ok")
    expect(promoted).toContain("cron_list")
  })

  it("a rare-term gate keeps common-word queries from flooding slots", async () => {
    // "schedule" appears in one tool only — it must gate the query so the
    // result is exactly that tool, not every description with filler words.
    const r = await call(mk(), { query: "schedule something for me please" })
    const names = (r.data as { names: string[] }).names
    expect(names).toEqual(["cron_create"])
  })

  it("no match lists available sources instead of a bare empty", async () => {
    const r = await call(mk(), { query: "zzz nothing like this" })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("没有匹配")
    expect(r.output).toContain("mcp:playwright")
  })

  it("empty pool reports no searchable tools", async () => {
    const r = await call(mk([], []), { query: "anything" })
    expect(r.output).toContain("无可检索工具")
  })

  it("risk/concurrency: safe + parallel", () => {
    const t = mk()
    expect(t.risk).toBe("safe")
    expect(t.concurrency).toBe("parallel")
  })
})
