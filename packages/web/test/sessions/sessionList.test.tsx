/**
 * SessionList — the sidebar's session list. No HTTP: sessions arrive
 * through props, selection/create/browse escape through callbacks. Covers
 * list rendering, click-to-select, the per-workdir-group ＋ button, the
 * 选择工作目录 picker flow, the workdir display-name rename, and the
 * empty state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { SessionList, type SessionListProps } from "../../src/sessions/SessionList.js"
import type { SessionMeta } from "../../src/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  localStorage.clear()
})

function session(id: string, title: string, updatedAt: string): SessionMeta {
  return { id, title, createdAt: "2026-08-15T00:00:00.000Z", updatedAt }
}

function mount(overrides: Partial<SessionListProps>): { container: HTMLElement; root: Root } {
  const props: SessionListProps = {
    sessions: [],
    selectedId: null,
    loading: false,
    onSelect: () => {},
    onCreate: () => {},
    onRename: () => {},
    onDelete: () => {},
    onBrowse: () => Promise.reject(new Error("onBrowse not stubbed")),
    ...overrides,
  }
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<SessionList {...props} />)
  })
  return { container, root }
}

function unmount(root: Root, container: HTMLElement): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function click(container: HTMLElement, testid: string): void {
  ;(container.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement).click()
}

describe("SessionList", () => {
  it("renders the session titles", () => {
    const sessions = [session("s1", "第一会话", "2026-08-15T10:00:00.000Z"), session("s2", "第二会话", "2026-08-15T11:00:00.000Z")]
    const { container, root } = mount({ sessions })
    expect(container.querySelector('[data-testid="session-item-s1"]')?.textContent).toContain("第一会话")
    expect(container.querySelector('[data-testid="session-item-s2"]')?.textContent).toContain("第二会话")
    unmount(root, container)
  })

  it("marks the selected session", () => {
    const sessions = [session("s1", "第一会话", "t"), session("s2", "第二会话", "t")]
    const { container, root } = mount({ sessions, selectedId: "s2" })
    expect(container.querySelector('[data-testid="session-item-s2"]')?.getAttribute("data-selected")).toBe("true")
    expect(container.querySelector('[data-testid="session-item-s1"]')?.getAttribute("data-selected")).toBe("false")
    unmount(root, container)
  })

  it("calls onSelect with the id when a session is clicked", () => {
    const onSelect = vi.fn()
    const sessions = [session("s1", "第一会话", "t")]
    const { container, root } = mount({ sessions, onSelect })
    act(() => click(container, "session-item-s1"))
    expect(onSelect).toHaveBeenCalledWith("s1")
    unmount(root, container)
  })

  it("shows the empty-state hint when there are no sessions", () => {
    const { container, root } = mount({ sessions: [] })
    expect(container.querySelector('[data-testid="session-empty"]')).not.toBeNull()
    expect(container.textContent).toContain("新建一个会话开始")
    unmount(root, container)
  })

  it("does not show the empty-state hint while loading", () => {
    const { container, root } = mount({ sessions: [], loading: true })
    expect(container.querySelector('[data-testid="session-empty"]')).toBeNull()
    unmount(root, container)
  })

  it("shows a session's workdir under its title (CLI-launched sessions stay visible)", () => {
    const withDir = { ...session("s1", "CLI 会话", "t"), workdir: "/Users/x/coding/kclaw" }
    const without = session("s2", "普通会话", "t")
    const { container, root } = mount({ sessions: [withDir, without] })
    expect(container.querySelector('[data-testid="session-workdir-s1"]')?.textContent).toBe("/Users/x/coding/kclaw")
    expect(container.querySelector('[data-testid="session-workdir-s2"]')).toBeNull()
    unmount(root, container)
  })

  it("groups sessions by workdir: header defaults to the path, unassigned sessions get a muted group", () => {
    const s1 = { ...session("s1", "会话一", "t1"), workdir: "/ws/a" }
    const s2 = { ...session("s2", "会话二", "t2"), workdir: "/ws/a" }
    const s3 = { ...session("s3", "会话三", "t3"), workdir: "/ws/b" }
    const s4 = session("s4", "无目录会话", "t4")
    const { container, root } = mount({ sessions: [s3, s1, s2, s4] })

    // Group order follows first appearance; rows keep their order within a group.
    const headers = [...container.querySelectorAll(".workdir-group-name")].map((el) => el.textContent)
    expect(headers).toEqual(["/ws/b", "/ws/a", "未指定工作目录"])
    expect(container.querySelector('[data-testid="workdir-group-name-"]')?.className).toContain("muted")
    unmount(root, container)
  })

  it("creates a session directly in a workdir from the group ＋ button; the unassigned group has none", () => {
    const onCreate = vi.fn()
    const s1 = { ...session("s1", "会话一", "t"), workdir: "/ws/project" }
    const s2 = session("s2", "无目录会话", "t")
    const { container, root } = mount({ sessions: [s1, s2], onCreate })
    act(() => click(container, "group-new-/ws/project"))
    expect(onCreate).toHaveBeenCalledWith("/ws/project")
    // The unassigned group (empty workdir) offers no direct create button.
    expect(container.querySelector('[data-testid="group-new-"]')).toBeNull()
    unmount(root, container)
  })

  it("opens the picker from the daemon root, navigates, and creates a session in the picked directory", async () => {
    const onBrowse = vi.fn((path?: string) =>
      Promise.resolve(
        path === undefined
          ? { path: "/Users/x", parent: "/", dirs: ["coding"] }
          : { path: "/Users/x/coding", parent: "/Users/x", dirs: [] },
      ),
    )
    const onCreate = vi.fn()
    const { container, root } = mount({ onBrowse, onCreate })
    await act(async () => click(container, "pick-workdir"))
    expect(onBrowse).toHaveBeenCalledWith(undefined) // starts at the daemon workspace
    expect(container.querySelector('[data-testid="picker-item-coding"]')).not.toBeNull()

    await act(async () => click(container, "picker-item-coding"))
    expect(onBrowse).toHaveBeenCalledWith("/Users/x/coding")
    expect(container.querySelector('[data-testid="picker-current"]')?.textContent).toBe("/Users/x/coding")

    act(() => click(container, "picker-confirm"))
    expect(container.querySelector('[data-testid="picker-overlay"]')).toBeNull()
    expect(onCreate).toHaveBeenCalledWith("/Users/x/coding")
    unmount(root, container)
  })

  it("closes the picker on cancel without creating anything", async () => {
    const onBrowse = vi.fn(() => Promise.resolve({ path: "/a", parent: null, dirs: [] }))
    const onCreate = vi.fn()
    const { container, root } = mount({ onBrowse, onCreate })
    await act(async () => click(container, "pick-workdir"))
    act(() => click(container, "picker-cancel"))
    expect(container.querySelector('[data-testid="picker-overlay"]')).toBeNull()
    expect(onCreate).not.toHaveBeenCalled()
    unmount(root, container)
  })

  it("shows the error inside the picker when browsing fails", async () => {
    const onBrowse = vi.fn(() => Promise.reject(new Error("目录读取失败: boom")))
    const { container, root } = mount({ onBrowse })
    await act(async () => click(container, "pick-workdir"))
    expect(container.querySelector('[data-testid="picker-error"]')?.textContent).toContain("boom")
    unmount(root, container)
  })

  it("renames a workdir group inline and keeps the per-row workdir text", () => {
    const s1 = { ...session("s1", "会话一", "t"), workdir: "/ws/project" }
    const { container, root } = mount({ sessions: [s1] })
    expect(container.querySelector('[data-testid="workdir-group-name-/ws/project"]')?.textContent).toBe("/ws/project")

    act(() => click(container, "group-rename-/ws/project"))
    const input = container.querySelector('[data-testid="group-rename-input"]') as HTMLInputElement
    typeInto(input, "项目 Alpha")
    act(() => click(container, "group-rename-confirm"))

    expect(container.querySelector('[data-testid="workdir-group-name-/ws/project"]')?.textContent).toBe("项目 Alpha")
    // The rename is persisted for the next mount.
    expect(JSON.parse(localStorage.getItem("kclaw_workdir_names")!)).toEqual({ "/ws/project": "项目 Alpha" })
    // The small workdir line under the session title is untouched.
    expect(container.querySelector('[data-testid="session-workdir-s1"]')?.textContent).toBe("/ws/project")
    unmount(root, container)
  })

  it("calls onRename with the id and new title after inline editing", () => {
    const onRename = vi.fn()
    const sessions = [session("s1", "第一会话", "t")]
    const { container, root } = mount({ sessions, onRename })
    act(() => click(container, "session-rename-s1"))
    const input = container.querySelector('[data-testid="session-rename-input-s1"]') as HTMLInputElement
    typeInto(input, "新标题")
    act(() => click(container, "session-rename-confirm-s1"))
    expect(onRename).toHaveBeenCalledWith("s1", "新标题")
    unmount(root, container)
  })

  it("calls onDelete with the id from the delete button", () => {
    const onDelete = vi.fn()
    const sessions = [session("s1", "第一会话", "t")]
    const { container, root } = mount({ sessions, onDelete })
    act(() => click(container, "session-delete-s1"))
    expect(onDelete).toHaveBeenCalledWith("s1")
    unmount(root, container)
  })
})
