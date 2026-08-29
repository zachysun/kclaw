/**
 * ChatView composer suggestion tests — the slash menu derives from the shared
 * core table filtered to the web surface (no /attach, no /exit); arrow keys
 * move the selection, Tab and clicks complete with a trailing space, Escape
 * dismisses until the draft changes, and /help opens the command panel
 * instead of being sent.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { ChatView, availableSlashMenuMaxHeight } from "../../src/chat/ChatView.js"
import { initChat } from "../../src/chat/model.js"

function mountView() {
  const onSend = vi.fn()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <ChatView
        view={initChat([])}
        onSend={onSend}
        onResolveConfirmation={vi.fn()}
        pendingAttachments={[]}
        onRemoveAttachment={vi.fn()}
      />,
    )
  })
  const input = (): HTMLInputElement =>
    container.querySelector('input[data-testid="chat-input"]') as HTMLInputElement
  const send = async (): Promise<void> => {
    await act(async () => {
      ;(container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  return {
    container,
    root,
    onSend,
    input,
    send,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function pressKey(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
}

function menuText(container: HTMLElement): string {
  return container.querySelector('[data-testid="slash-menu"]')?.textContent ?? ""
}

describe("ChatView slash suggestions", () => {
  it("lists the web-surface commands for a bare slash, without attach/exit", () => {
    const h = mountView()
    type(h.input(), "/")
    const options = h.container.querySelectorAll('[data-testid="slash-option"]')
    expect(options).toHaveLength(7)
    const text = menuText(h.container)
    expect(text).toContain("/new")
    expect(text).toContain("/compact")
    expect(text).toContain("列出所有命令")
    expect(text).not.toContain("/attach")
    expect(text).not.toContain("/exit")
    h.unmount()
  })

  it("filters by the typed prefix and hides itself for unknown words", () => {
    const h = mountView()
    type(h.input(), "/co")
    expect(h.container.querySelectorAll('[data-testid="slash-option"]')).toHaveLength(1)
    expect(menuText(h.container)).toContain("/compact")
    type(h.input(), "/zz")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("stays hidden for plain text", () => {
    const h = mountView()
    type(h.input(), "hello /")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("moves the selection with arrows and completes with Tab (trailing space, menu closes)", () => {
    const h = mountView()
    type(h.input(), "/")
    pressKey(h.input(), "ArrowDown")
    expect(h.container.querySelector('[aria-selected="true"]')?.textContent).toContain("/clear")
    pressKey(h.input(), "Tab")
    expect(h.input().value).toBe("/clear ")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("completes on click without stealing the input focus", () => {
    const h = mountView()
    type(h.input(), "/co")
    const option = h.container.querySelector('[data-testid="slash-option"]') as HTMLButtonElement
    act(() => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    })
    expect(h.input().value).toBe("/compact ")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("dismisses on Escape and reopens when the draft changes", () => {
    const h = mountView()
    type(h.input(), "/")
    pressKey(h.input(), "Escape")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    type(h.input(), "/c")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).not.toBeNull()
    h.unmount()
  })

  it("opens the help panel for /help instead of sending", async () => {
    const h = mountView()
    type(h.input(), "/help")
    await h.send()
    expect(h.onSend).not.toHaveBeenCalled()
    const help = h.container.querySelector('[data-testid="slash-help"]')
    expect(help).not.toBeNull()
    const text = help!.textContent ?? ""
    for (const name of ["new", "clear", "sessions", "model", "readonly", "compact", "help"]) {
      expect(text).toContain(`/${name}`)
    }
    expect(text).not.toContain("/attach")
    act(() => {
      ;(h.container.querySelector('[data-testid="slash-help-close"]') as HTMLButtonElement).click()
    })
    expect(h.container.querySelector('[data-testid="slash-help"]')).toBeNull()
    h.unmount()
  })

  it("still sends plain messages through onSend", async () => {
    const h = mountView()
    type(h.input(), "hello")
    await h.send()
    expect(h.onSend).toHaveBeenCalledWith("hello")
    expect(h.input().value).toBe("")
    h.unmount()
  })
})

describe("availableSlashMenuMaxHeight", () => {
  it("keeps the full 280px cap when the composer has plenty of room above", () => {
    expect(availableSlashMenuMaxHeight(600)).toBe(280)
  })

  it("clamps to the room above the composer when it sits high in the viewport", () => {
    expect(availableSlashMenuMaxHeight(200)).toBe(200 - 6 - 8)
  })

  it("stays uncapped exactly at the boundary of 280px + gap + margin", () => {
    expect(availableSlashMenuMaxHeight(294)).toBe(280)
  })

  it("never collapses below a floor so a couple options stay reachable", () => {
    expect(availableSlashMenuMaxHeight(10)).toBe(48)
    expect(availableSlashMenuMaxHeight(0)).toBe(48)
  })

  it("accounts for a fixed top bar so the menu never slides under it", () => {
    // topBoundary = topbar bottom; menu must stay below it, not just above 0.
    expect(availableSlashMenuMaxHeight(161, 47.5)).toBe(161 - 47.5 - 6 - 8)
    expect(availableSlashMenuMaxHeight(200, 47.5)).toBe(200 - 47.5 - 6 - 8)
  })

  it("accepts the highlighted suggestion on Enter instead of submitting a half-typed word", () => {
    const h = mountView()
    type(h.input(), "/co")
    pressKey(h.input(), "Enter")
    expect(h.input().value).toBe("/compact ")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    expect(h.onSend).not.toHaveBeenCalled()
    h.unmount()
  })

  it("Enter accepts the arrow-selected candidate, not the raw draft", () => {
    const h = mountView()
    type(h.input(), "/")
    pressKey(h.input(), "ArrowDown")
    pressKey(h.input(), "Enter")
    expect(h.input().value).toBe("/clear ")
    expect(h.onSend).not.toHaveBeenCalled()
    h.unmount()
  })

  it("submits on Enter when the draft is already the complete command word", async () => {
    const h = mountView()
    type(h.input(), "/compact")
    pressKey(h.input(), "Enter")
    // Exact match must NOT be rewritten (no trailing space appended) — the
    // native form submit then runs it (jsdom does not submit on Enter, so the
    // send button stands in for the submission here).
    expect(h.input().value).toBe("/compact")
    await h.send()
    expect(h.onSend).toHaveBeenCalledWith("/compact")
    h.unmount()
  })
})
