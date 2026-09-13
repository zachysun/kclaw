/**
 * IconButton — icon-only button with the label in a hover/focus bubble.
 * Covers the bubble lifecycle (hover shows, leave hides, click doesn't leave
 * a stale bubble) and the click-through to onClick.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { IconButton } from "../../src/ui/IconButton.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mount(extra: Partial<Parameters<typeof IconButton>[0]> = {}): { container: HTMLElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <IconButton
        label="删除"
        icon={<svg data-testid="icon-glyph" />}
        testid="btn-under-test"
        {...extra}
      />,
    )
  })
  return { container, root }
}

function unmount(root: Root, container: HTMLElement): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

describe("IconButton", () => {
  it("shows the label bubble on hover and hides on leave", () => {
    const { container, root } = mount()
    const btn = container.querySelector('[data-testid="btn-under-test"]') as HTMLElement
    expect(btn.getAttribute("aria-label")).toBe("删除")
    expect(container.querySelector(".icon-tip")).toBeNull()

    act(() => {
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    })
    expect(container.querySelector(".icon-tip")?.textContent).toBe("删除")

    act(() => {
      btn.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
    })
    expect(container.querySelector(".icon-tip")).toBeNull()
    unmount(root, container)
  })

  it("shows the bubble on keyboard focus and hides on blur", () => {
    const { container, root } = mount()
    const btn = container.querySelector('[data-testid="btn-under-test"]') as HTMLElement
    act(() => {
      btn.focus()
    })
    expect(container.querySelector(".icon-tip")?.textContent).toBe("删除")
    act(() => {
      btn.blur()
    })
    expect(container.querySelector(".icon-tip")).toBeNull()
    unmount(root, container)
  })

  it("hides the bubble on mousedown so clicking leaves nothing behind", () => {
    const { container, root } = mount()
    const btn = container.querySelector('[data-testid="btn-under-test"]') as HTMLElement
    act(() => {
      btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    })
    expect(container.querySelector(".icon-tip")).not.toBeNull()
    act(() => {
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    })
    expect(container.querySelector(".icon-tip")).toBeNull()
    unmount(root, container)
  })

  it("passes clicks through and applies the danger styling", () => {
    const onClick = vi.fn()
    const { container, root } = mount({ onClick, danger: true })
    const btn = container.querySelector('[data-testid="btn-under-test"]') as HTMLButtonElement
    expect(btn.className).toContain("danger")
    act(() => {
      btn.click()
    })
    expect(onClick).toHaveBeenCalledTimes(1)
    unmount(root, container)
  })
})
