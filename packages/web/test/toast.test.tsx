/**
 * Toast stack — the global feedback layer. Covers: render + auto-dismiss per
 * tone, early dismissal on click, the visible-count cap (oldest drops), and
 * the empty state rendering nothing. Timed behavior uses fake timers.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { ToastStack, useToasts } from "../src/toast.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.useRealTimers()
})

function Harness({ onReady }: { onReady: (api: ReturnType<typeof useToasts>) => void }): React.ReactElement {
  const api = useToasts()
  onReady(api)
  return <ToastStack toasts={api.toasts} onDismiss={api.dismiss} />
}

function mount(): { container: HTMLElement; root: Root; api: ReturnType<typeof useToasts> } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  let captured: ReturnType<typeof useToasts> | undefined
  act(() => {
    root.render(<Harness onReady={(api) => { captured = api }} />)
  })
  return { container, root, api: captured! }
}

function toastTexts(container: HTMLElement): string[] {
  // .toast-text only — the .toast container would also pick up the × close button
  return [...container.querySelectorAll(".toast-text")].map((el) => el.textContent ?? "")
}

describe("ToastStack", () => {
  it("renders a toast on notify and auto-dismisses it after the info delay", () => {
    vi.useFakeTimers()
    const { container, root, api } = mount()
    act(() => {
      api.notify("验证成功：deepseek 可达")
    })
    expect(toastTexts(container)).toEqual(["验证成功：deepseek 可达"])
    act(() => {
      vi.advanceTimersByTime(5999)
    })
    expect(toastTexts(container)).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(container.querySelector("[data-testid='toast-stack']")).toBeNull()
    root.unmount()
    container.remove()
  })

  it("errors linger longer than info toasts", () => {
    vi.useFakeTimers()
    const { container, root, api } = mount()
    act(() => {
      api.notify("坏了", "error")
    })
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(toastTexts(container)).toEqual(["坏了"])
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(container.querySelector("[data-testid='toast-stack']")).toBeNull()
    root.unmount()
    container.remove()
  })

  it("clicking the toast text dismisses it early", () => {
    vi.useFakeTimers()
    const { container, root, api } = mount()
    act(() => {
      api.notify("点我消失")
    })
    const text = container.querySelector(".toast-text") as HTMLButtonElement
    act(() => {
      text.click()
    })
    expect(container.querySelector("[data-testid='toast-stack']")).toBeNull()
    root.unmount()
    container.remove()
  })

  it("the × close button dismisses the toast", () => {
    vi.useFakeTimers()
    const { container, root, api } = mount()
    act(() => {
      api.notify("记忆写入完成")
    })
    const close = container.querySelector(".toast-close") as HTMLButtonElement
    expect(close).not.toBeNull()
    act(() => {
      close.click()
    })
    expect(container.querySelector("[data-testid='toast-stack']")).toBeNull()
    root.unmount()
    container.remove()
  })

  it("caps the visible stack and drops the oldest", () => {
    vi.useFakeTimers()
    const { container, root, api } = mount()
    act(() => {
      for (let i = 1; i <= 5; i++) api.notify(`t${i}`)
    })
    expect(toastTexts(container)).toEqual(["t2", "t3", "t4", "t5"])
    root.unmount()
    container.remove()
  })
})
