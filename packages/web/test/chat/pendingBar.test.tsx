/**
 * PendingBar tests — the unresolved-card strip above the composer: items in
 * the given order (ChatPanel feeds newest first), a click locates the card
 * (never answers it), and beyond the show cap an expander reveals the older
 * entries.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot } from "react-dom/client"
import { act } from "react"
import { PendingBar, type PendingCardItem } from "../../src/chat/PendingBar.js"

function items(n: number): PendingCardItem[] {
  return Array.from({ length: n }, (_, i) => ({
    callId: `c${i}`,
    messageId: `m${i}`,
    title: i === 1 ? undefined : `卡${i}`,
    summary: i % 2 === 0 ? "按钮 ×2" : "表单",
  }))
}

function mount(list: PendingCardItem[], onLocate = vi.fn()) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<PendingBar items={list} onLocate={onLocate} />)
  })
  return {
    container,
    onLocate,
    unmount: () => act(() => root.unmount()),
  }
}

describe("PendingBar", () => {
  it("renders nothing without items", () => {
    const { container, unmount } = mount([])
    expect(container.querySelector('[data-testid="pending-bar"]')).toBeNull()
    unmount()
  })

  it("lists every item and locates on click", () => {
    const onLocate = vi.fn()
    const { container, unmount } = mount(items(3), onLocate)
    expect(container.querySelectorAll('[data-testid="pending-item"]')).toHaveLength(3)
    expect(container.textContent).toContain("待你拍板 · 3 项")
    // 模型没给 title 的卡显示"未命名卡片"。
    expect(container.querySelectorAll('[data-testid="pending-item"]')[1].textContent).toContain("未命名卡片")
    act(() => {
      ;(container.querySelectorAll('[data-testid="pending-item"]')[2] as HTMLButtonElement).click()
    })
    expect(onLocate).toHaveBeenCalledWith("c2")
    unmount()
  })

  it("caps the list and expands the older entries on demand", () => {
    const { container, unmount } = mount(items(10))
    expect(container.querySelectorAll('[data-testid="pending-item"]')).toHaveLength(8)
    expect(container.textContent).toContain("还有 2 项更早的")
    act(() => {
      ;(container.querySelector('[data-testid="pending-more"]') as HTMLButtonElement).click()
    })
    expect(container.querySelectorAll('[data-testid="pending-item"]')).toHaveLength(10)
    expect(container.querySelector('[data-testid="pending-more"]')).toBeNull()
    unmount()
  })
})
