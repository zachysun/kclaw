/**
 * ToolCards registry tests — cross-message pairing (a tool_call streams into
 * the assistant message, its tool_result lands in the follow-up tool
 * message), each card's settled states, and the fallbacks: unregistered
 * tools and renderers that can't build from their args keep the plain
 * collapse rows.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { MessageBubble } from "../../src/chat/MessageBubble.js"
import { buildToolPairing, type RenderedMessage } from "../../src/chat/model.js"

let seq = 0
function assistantMsg(blocks: RenderedMessage["blocks"]): RenderedMessage {
  return { id: `ma${++seq}`, role: "assistant", pending: false, blocks }
}
function toolMsg(blocks: RenderedMessage["blocks"]): RenderedMessage {
  return { id: `mt${++seq}`, role: "tool", pending: false, blocks }
}
function callBlock(name: string, argsJson: string, callId = "c1"): RenderedMessage["blocks"][number] {
  return { kind: "tool_call", blockId: `b-${callId}-c`, callId, name, argsJson }
}
function resultBlock(opts: { status?: "ok" | "error"; output?: string; durationMs?: number; data?: unknown; callId?: string }): RenderedMessage["blocks"][number] {
  return {
    kind: "tool_result", blockId: `b-${opts.callId ?? "c1"}-r`, callId: opts.callId ?? "c1",
    status: opts.status ?? ("ok" as const), output: opts.output ?? "done", durationMs: opts.durationMs ?? 42, data: opts.data,
  }
}

/** Mount one bubble from the list; pairing is built across all of them. */
function mount(messages: RenderedMessage[], renderIdx: number, props: { onOpenAudit?: (id: string) => void } = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <MessageBubble message={messages[renderIdx]!} toolPairing={buildToolPairing(messages)} onOpenAudit={props.onOpenAudit} />,
    )
  })
  return { container, unmount: () => act(() => root.unmount()) }
}

describe("bash card", () => {
  it("running call shows the spinner", () => {
    const { container, unmount } = mount([assistantMsg([callBlock("bash", JSON.stringify({ command: "pnpm test" }))])], 0)
    expect(container.querySelector('[data-testid="tool-card-bash-running"]')).not.toBeNull()
    unmount()
  })

  it("settled call merges into one card: check/cross, duration, exit code", () => {
    const messages = [
      assistantMsg([callBlock("bash", JSON.stringify({ command: "pnpm test" }))]),
      toolMsg([resultBlock({ status: "error", output: "exit code 1\nfail", data: { exitCode: 1 } })]),
    ]
    const { container, unmount } = mount(messages, 0)
    const card = container.querySelector('[data-testid="tool-card-bash"]')
    expect(card).not.toBeNull()
    expect(card!.querySelector("summary")!.textContent).toContain("exit 1")
    expect(card!.querySelector("summary")!.textContent).toContain("42ms")
    expect(card!.querySelector(".tool-card-error")).not.toBeNull()
    unmount()

    // The tool message's plain result row is consumed by the call card.
    const side = mount(messages, 1)
    expect(side.container.querySelector('[data-testid="blk-tool-result"]')).toBeNull()
    side.unmount()
  })

  it("fully absorbed tool message renders no bubble shell (no stray empty pill)", () => {
    const messages = [
      assistantMsg([callBlock("bash", JSON.stringify({ command: "pnpm test" }))]),
      toolMsg([resultBlock({ output: "all good", data: { exitCode: 0 } })]),
    ]
    const { container, unmount } = mount(messages, 1)
    expect(container.querySelector(".message-tool")).toBeNull()
    unmount()

    // Result-card tools keep their bubble (the card lives inside it).
    const keep = [
      assistantMsg([callBlock("todo_list_write", "{}")]),
      toolMsg([resultBlock({ data: { items: [] } })]),
    ]
    const kept = mount(keep, 1)
    expect(kept.container.querySelector(".message-tool")).not.toBeNull()
    kept.unmount()
  })

  it("ok result shows the green check and exit 0", () => {
    const { container, unmount } = mount([
      assistantMsg([callBlock("bash", "{}")]),
      toolMsg([resultBlock({ output: "all good", data: { exitCode: 0 } })]),
    ], 0)
    const card = container.querySelector('[data-testid="tool-card-bash"]')!
    expect(card.querySelector(".tool-card-ok")).not.toBeNull()
    expect(card.querySelector("summary")!.textContent).toContain("exit 0")
    unmount()
  })
})

describe("fs cards", () => {
  it("fs_edit renders the red/green diff from call args", () => {
    const { container, unmount } = mount([
      assistantMsg([callBlock("fs_edit", JSON.stringify({ path: "src/a.ts", old: "const a = 1", new: "const a = 2" }))]),
      toolMsg([resultBlock({ output: "replaced 1 occurrence" })]),
    ], 0)
    const card = container.querySelector('[data-testid="tool-card-fs-edit"]')!
    expect(card.querySelectorAll(".diff-del")).toHaveLength(1)
    expect(card.querySelectorAll(".diff-add")).toHaveLength(1)
    expect(card.querySelector("summary")!.textContent).toContain("src/a.ts")
    unmount()
  })

  it("fs_write renders byte count and a collapsed content preview — no fake diff", () => {
    const { container, unmount } = mount([
      assistantMsg([callBlock("fs_write", JSON.stringify({ path: "out.txt", content: "hello\nworld" }))]),
      toolMsg([resultBlock({ output: "wrote 11 bytes" })]),
    ], 0)
    const card = container.querySelector('[data-testid="tool-card-fs-write"]')!
    expect(card.querySelector("summary")!.textContent).toContain("11 B")
    expect(card.querySelector(".diff-del")).toBeNull()
    unmount()
  })

  it("unparseable args fall back to the plain row", () => {
    const { container, unmount } = mount([
      assistantMsg([callBlock("fs_edit", "not-json{")]),
      toolMsg([resultBlock({ output: "replaced" })]),
    ], 0)
    expect(container.querySelector('[data-testid="tool-card-fs-edit"]')).toBeNull()
    expect(container.querySelector('[data-testid="blk-tool-call"]')).not.toBeNull()
    unmount()
  })
})

describe("result-side cards", () => {
  it("todo progress card shows done/total with a bar", () => {
    const { container, unmount } = mount([
      assistantMsg([callBlock("todo_list_write", "{}")]),
      toolMsg([resultBlock({ data: { count: 7, remaining: 4 }, output: "3 项完成" })]),
    ], 1)
    const card = container.querySelector('[data-testid="tool-card-todo"]')!
    expect(card.textContent).toContain("3/7 完成")
    expect(card.querySelector(".tool-card-progress-fill")).not.toBeNull()
    unmount()
  })

  it("cron card shows schedule; todo without data falls back to the plain row", () => {
    const cronMsgs = [
      assistantMsg([callBlock("cron_create", "{}")]),
      toolMsg([resultBlock({ data: { name: "夜审", cron: "0 3 * * *", nextRunAt: "2026-10-31T03:00:00Z", enabled: true }, output: "已创建" })]),
    ]
    const cron = mount(cronMsgs, 1)
    expect(cron.container.querySelector('[data-testid="tool-card-cron"] summary')!.textContent).toContain("0 3 * * *")
    cron.unmount()

    const bare = mount([
      assistantMsg([callBlock("todo_list_write", "{}")]),
      toolMsg([resultBlock({ output: "ok" })]),
    ], 1)
    expect(bare.container.querySelector('[data-testid="tool-card-todo"]')).toBeNull()
    expect(bare.container.querySelector('[data-testid="blk-tool-result"]')).not.toBeNull()
    bare.unmount()
  })

  it("subagent card keeps the settled audit jump (old anchor testid)", () => {
    const onOpenAudit = vi.fn()
    const { container, unmount } = mount([
      assistantMsg([callBlock("subagent_run", JSON.stringify({ task: "扫 TODO" }))]),
      toolMsg([resultBlock({ output: "▸ 干活\n结论已出", data: { childSessionId: "ses_c" } })]),
    ], 0, { onOpenAudit })
    const card = container.querySelector('[data-testid="blk-tool-result-subagent"]')!
    expect(card.querySelector("summary")!.textContent).toContain("扫 TODO") // name from call args
    const link = card.querySelector('[data-testid="subagent-audit-link"]') as HTMLButtonElement
    act(() => link.click())
    expect(onOpenAudit).toHaveBeenCalledWith("ses_c")
    unmount()
  })

  it("unregistered tools keep the plain collapse rows", () => {
    const messages = [
      assistantMsg([callBlock("grep", JSON.stringify({ pattern: "x" }))]),
      toolMsg([resultBlock({ output: "3 hits" })]),
    ]
    const call = mount(messages, 0)
    expect(call.container.querySelector('[data-testid="blk-tool-call"]')).not.toBeNull()
    call.unmount()
    const result = mount(messages, 1)
    expect(result.container.querySelector('[data-testid="blk-tool-result"]')).not.toBeNull()
    result.unmount()
  })
})
