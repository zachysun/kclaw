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
import { ChatView } from "../../src/chat/ChatView.js"
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
