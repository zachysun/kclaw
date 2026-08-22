/**
 * SessionList — pure presentational sidebar list. No I/O: sessions arrive
 * through props, selection/create escape through callbacks. Covers list
 * rendering, click-to-select, the new-session button, and the empty state.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { SessionList } from "../../src/sessions/SessionList.js"
import type { SessionMeta } from "../../src/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function session(id: string, title: string, updatedAt: string): SessionMeta {
  return { id, title, createdAt: "2026-08-15T00:00:00.000Z", updatedAt }
}

function mount(props: Parameters<typeof SessionList>[0]): { container: HTMLElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<SessionList {...props} />)
  })
  return { container, root }
}

function unmount(root: Root, container: HTMLElement): void {
  root.unmount()
  container.remove()
}

function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("SessionList", () => {
  it("renders the session titles", () => {
    const sessions = [session("s1", "第一会话", "2026-08-15T10:00:00.000Z"), session("s2", "第二会话", "2026-08-15T11:00:00.000Z")]
    const { container, root } = mount({ sessions, selectedId: null, loading: false, onSelect: () => {}, onCreate: () => {}, onRename: () => {}, onDelete: () => {} })
    expect(container.querySelector('[data-testid="session-item-s1"]')?.textContent).toContain("第一会话")
    expect(container.querySelector('[data-testid="session-item-s2"]')?.textContent).toContain("第二会话")
    unmount(root, container)
  })

  it("marks the selected session", () => {
    const sessions = [session("s1", "第一会话", "t"), session("s2", "第二会话", "t")]
    const { container, root } = mount({ sessions, selectedId: "s2", loading: false, onSelect: () => {}, onCreate: () => {}, onRename: () => {}, onDelete: () => {} })
    expect(container.querySelector('[data-testid="session-item-s2"]')?.getAttribute("data-selected")).toBe("true")
    expect(container.querySelector('[data-testid="session-item-s1"]')?.getAttribute("data-selected")).toBe("false")
    unmount(root, container)
  })

  it("calls onSelect with the id when a session is clicked", () => {
    const onSelect = vi.fn()
    const sessions = [session("s1", "第一会话", "t")]
    const { container, root } = mount({ sessions, selectedId: null, loading: false, onSelect, onCreate: () => {}, onRename: () => {}, onDelete: () => {} })
    act(() => {
      ;(container.querySelector('[data-testid="session-item-s1"]') as HTMLButtonElement).click()
    })
    expect(onSelect).toHaveBeenCalledWith("s1")
    unmount(root, container)
  })

  it("shows the empty-state hint when there are no sessions", () => {
    const { container, root } = mount({ sessions: [], selectedId: null, loading: false, onSelect: () => {}, onCreate: () => {}, onRename: () => {}, onDelete: () => {} })
    expect(container.querySelector('[data-testid="session-empty"]')).not.toBeNull()
    expect(container.textContent).toContain("新建一个会话开始")
    unmount(root, container)
  })

  it("does not show the empty-state hint while loading", () => {
    const { container, root } = mount({ sessions: [], selectedId: null, loading: true, onSelect: () => {}, onCreate: () => {}, onRename: () => {}, onDelete: () => {} })
    expect(container.querySelector('[data-testid="session-empty"]')).toBeNull()
    unmount(root, container)
  })

  it("calls onCreate with the default workdir from the new-session button", () => {
    const onCreate = vi.fn()
    const { container, root } = mount({ sessions: [], selectedId: null, loading: false, onSelect: () => {}, onCreate, onRename: () => {}, onDelete: () => {} })
    act(() => {
      ;(container.querySelector('button[data-testid="new-session"]') as HTMLButtonElement).click()
    })
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith("home")
    unmount(root, container)
  })

  it("calls onCreate with the typed workdir from the new-session button", () => {
    const onCreate = vi.fn()
    const { container, root } = mount({ sessions: [], selectedId: null, loading: false, onSelect: () => {}, onCreate, onRename: () => {}, onDelete: () => {} })
    const input = container.querySelector('[data-testid="session-workdir-input"]') as HTMLInputElement
    expect(input.value).toBe("home")
    typeInto(input, "/tmp/工作目录")
    act(() => {
      ;(container.querySelector('button[data-testid="new-session"]') as HTMLButtonElement).click()
    })
    expect(onCreate).toHaveBeenCalledWith("/tmp/工作目录")
    unmount(root, container)
  })

  it("calls onRename with the id and new title after inline editing", () => {
    const onRename = vi.fn()
    const sessions = [session("s1", "第一会话", "t")]
    const { container, root } = mount({ sessions, selectedId: null, loading: false, onSelect: () => {}, onCreate: () => {}, onRename, onDelete: () => {} })
    act(() => {
      ;(container.querySelector('[data-testid="session-rename-s1"]') as HTMLButtonElement).click()
    })
    const input = container.querySelector('[data-testid="session-rename-input-s1"]') as HTMLInputElement
    typeInto(input, "新标题")
    act(() => {
      ;(container.querySelector('[data-testid="session-rename-confirm-s1"]') as HTMLButtonElement).click()
    })
    expect(onRename).toHaveBeenCalledWith("s1", "新标题")
    unmount(root, container)
  })

  it("calls onDelete with the id from the delete button", () => {
    const onDelete = vi.fn()
    const sessions = [session("s1", "第一会话", "t")]
    const { container, root } = mount({ sessions, selectedId: null, loading: false, onSelect: () => {}, onCreate: () => {}, onRename: () => {}, onDelete })
    act(() => {
      ;(container.querySelector('[data-testid="session-delete-s1"]') as HTMLButtonElement).click()
    })
    expect(onDelete).toHaveBeenCalledWith("s1")
    unmount(root, container)
  })
})
