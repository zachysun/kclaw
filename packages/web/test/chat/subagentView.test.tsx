/**
 * Subagent rendering on the web seam: the executor-attached childSessionId
 * rides the persisted tool_result (model passthrough), and the chat view
 * renders the spawn row as a live-status line with an audit-jump link.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot } from "react-dom/client"
import { act } from "react"
import { ChatView } from "../../src/chat/ChatView.js"
import { applyEvent, initChat, type ChatState, type Message } from "../../src/chat/model.js"

function mountWith(view: ChatState, onOpenAudit?: (sessionId: string) => void, opts: { readOnly?: boolean } = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <ChatView
        view={view}
        onSend={vi.fn()}
        onResolveConfirmation={vi.fn()}
        pendingAttachments={[]}
        onRemoveAttachment={vi.fn()}
        onOpenAudit={onOpenAudit}
        readOnly={opts.readOnly}
      />,
    )
  })
  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

/** A settled parent conversation holding one subagent spawn round. */
function spawnConversation(): Message[] {
  const now = new Date().toISOString()
  const user: Message = { id: "m1", sessionId: "s", role: "user", createdAt: now, updatedAt: now, blocks: [{ id: "b1", type: "text", text: "去扫 TODO" }] } as Message
  const assistant: Message = {
    id: "m2", sessionId: "s", role: "assistant", createdAt: now, updatedAt: now, model: "m",
    blocks: [{ id: "b2", type: "tool_call", callId: "c1", name: "subagent_run", args: { task: "扫 TODO" }, argsJson: JSON.stringify({ task: "扫 TODO" }) }],
  } as Message
  const tool: Message = {
    id: "m3", sessionId: "s", role: "tool", createdAt: now, updatedAt: now,
    blocks: [{
      id: "b3", type: "tool_result", callId: "c1", status: "ok", output: "▸ 调用工具 exec\n共 3 处 TODO", durationMs: 1200,
      data: { childSessionId: "ses_child_1" },
    }],
  } as unknown as Message
  return [user, assistant, tool]
}

describe("subagent chat rendering", () => {
  it("model: the tool_result's data (childSessionId) survives rendering", () => {
    const state = initChat(spawnConversation())
    const toolMsg = state.messages.find((m) => m.role === "tool")!
    const block = toolMsg.blocks.find((b) => b.kind === "tool_result")
    expect(block && block.kind === "tool_result" && block.data).toEqual({ childSessionId: "ses_child_1" })
  })

  it("model: a streamed subagent status line appends to the live row", () => {
    const state = initChat(spawnConversation().slice(0, 2)) // tool message not yet landed
    // The tool message arrives via message.completed carrying the spawn result.
    const withTool = applyEvent(state, {
      id: "e1", ts: new Date().toISOString(), type: "message.completed", sessionId: "s",
      payload: { message: spawnConversation()[2]! },
    } as Parameters<typeof applyEvent>[1])
    const block = withTool.messages.find((m) => m.role === "tool")!.blocks.find((b) => b.kind === "tool_result")
    expect(block && block.kind === "tool_result" && block.output).toContain("共 3 处 TODO")
  })

  it("view: the spawn row shows the latest status line and jumps to the child's audit", () => {
    const onOpenAudit = vi.fn()
    const { container, unmount } = mountWith(initChat(spawnConversation()), onOpenAudit)
    const row = container.querySelector('[data-testid="blk-tool-result-subagent"]')
    expect(row).not.toBeNull()
    expect(row!.querySelector("summary")!.textContent).toContain("共 3 处 TODO") // latest line, not the head
    const link = row!.querySelector('[data-testid="subagent-audit-link"]') as HTMLButtonElement
    expect(link).not.toBeNull()
    act(() => {
      link.click()
    })
    expect(onOpenAudit).toHaveBeenCalledWith("ses_child_1")
    unmount()
  })

  it("view: a plain tool result (no data) keeps the ordinary row", () => {
    const { container, unmount } = mountWith(initChat(spawnConversation()))
    // Rewrite the tool block without data: an exec-style result.
    const state = initChat(spawnConversation())
    state.messages = state.messages.map((m) =>
      m.role !== "tool"
        ? m
        : { ...m, blocks: m.blocks.map((b) => (b.kind === "tool_result" ? { ...b, data: undefined } : b)) })
    unmount()
    const second = mountWith(state)
    expect(second.container.querySelector('[data-testid="blk-tool-result-subagent"]')).toBeNull()
    expect(second.container.querySelector('[data-testid="blk-tool-result"]')).not.toBeNull()
    second.unmount()
  })

  it("view: readOnly replaces the composer with the child-session hint", () => {
    const { container, unmount } = mountWith(initChat(spawnConversation()), undefined, { readOnly: true })
    expect(container.querySelector('[data-testid="subagent-readonly-hint"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="chat-input"]')).toBeNull()
    expect(container.querySelector('[data-testid="send-button"]')).toBeNull()
    expect(container.querySelector('[data-testid="mode-select"]')).toBeNull()
    unmount()
  })
})
