/**
 * MarkdownText rendering tests: structured Markdown becomes elements (GFM
 * tables included), code fences carry a copy button whose copied text is
 * exactly the code, raw HTML stays inert (no second injection channel),
 * links open in a new tab — and only assistant bubbles render Markdown at
 * all (user text stays literal).
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act, type ReactElement } from "react"
import { MarkdownText } from "../../src/chat/Markdown.js"
import { ChatView } from "../../src/chat/ChatView.js"
import { initChat, type Message } from "../../src/chat/model.js"

function mount(ui: ReactElement) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(ui)
  })
  return {
    container,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

const textMsg = (id: string, role: "user" | "assistant", text: string): Message => ({
  id,
  sessionId: "s1",
  role,
  blocks: [{ id: `${id}-b`, type: "text", text }],
  createdAt: "2026-09-13T00:00:00.000Z",
})

describe("MarkdownText", () => {
  it("renders headings, emphasis and lists as elements", () => {
    const h = mount(<MarkdownText text={"# Title\n\n**bold** and *em*\n\n- a\n- b\n"} />)
    expect(h.container.querySelector("h1")?.textContent).toBe("Title")
    expect(h.container.querySelector("strong")?.textContent).toBe("bold")
    expect(h.container.querySelector("em")).not.toBeNull()
    expect(h.container.querySelectorAll("li")).toHaveLength(2)
    h.unmount()
  })

  it("renders GFM tables", () => {
    const h = mount(<MarkdownText text={"| a | b |\n| - | - |\n| 1 | 2 |\n"} />)
    expect(h.container.querySelector("table")?.textContent).toContain("1")
    expect(h.container.querySelectorAll("th")).toHaveLength(2)
    h.unmount()
  })

  it("renders a code fence with a copy button that copies exactly the code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    const h = mount(<MarkdownText text={"```js\nconst x = 1\n```"} />)
    expect(h.container.querySelector("pre code")).not.toBeNull()
    const btn = h.container.querySelector('[data-testid="code-copy"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    // Exactly the code — the button is a sibling of the <pre>, not a child,
    // so its label never leaks into the copied text.
    expect(writeText).toHaveBeenCalledWith("const x = 1")
    expect(btn.textContent).toBe("已复制")
    h.unmount()
  })

  it("keeps raw HTML inert — no elements, no execution", () => {
    const h = mount(
      <MarkdownText text={'hello <img src=x onerror="alert(1)"> <script>alert(2)</script>'} />,
    )
    expect(h.container.querySelector("img")).toBeNull()
    expect(h.container.querySelector("script")).toBeNull()
    expect(h.container.textContent).toContain("hello")
    h.unmount()
  })

  it("opens links in a new tab with noopener", () => {
    const h = mount(<MarkdownText text={"[x](https://example.com)"} />)
    const a = h.container.querySelector("a")
    expect(a?.getAttribute("target")).toBe("_blank")
    expect(a?.getAttribute("rel")).toContain("noreferrer")
    h.unmount()
  })
})

describe("chat markdown gating", () => {
  function mountChat(messages: Message[]) {
    return mount(
      <ChatView
        view={initChat(messages)}
        onSend={vi.fn()}
        onResolveConfirmation={vi.fn()}
        onAnswerQuestion={vi.fn()}
        pendingAttachments={[]}
        onRemoveAttachment={vi.fn()}
      />,
    )
  }

  it("assistant text renders as markdown elements", () => {
    const h = mountChat([textMsg("m1", "assistant", "**loud** point")])
    expect(h.container.querySelector('[data-testid="msg-assistant"] strong')?.textContent).toBe("loud")
    h.unmount()
  })

  it("user text stays literal — a typed asterisk never becomes markup", () => {
    const h = mountChat([textMsg("m1", "user", "**not bold** a_1")])
    const bubble = h.container.querySelector('[data-testid="msg-user"]')
    expect(bubble?.querySelector("strong")).toBeNull()
    expect(bubble?.textContent).toContain("**not bold**")
    h.unmount()
  })
})
