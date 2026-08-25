import { describe, it, expect, vi, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { OfflineBanner } from "../src/offlineBanner.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe("OfflineBanner", () => {
  let root: Root
  afterEach(() => {
    root?.unmount()
    document.body.innerHTML = ""
    ;(globalThis as { onLine?: boolean }).onLine = true
  })

  it("renders nothing while online and shows the banner on offline events", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
    root = createRoot(document.body.appendChild(document.createElement("div")))
    await act(async () => {
      root.render(<OfflineBanner />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.querySelector('[data-testid="offline-banner"]')).toBeNull()
    await act(async () => {
      window.dispatchEvent(new Event("offline"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.querySelector('[data-testid="offline-banner"]')).not.toBeNull()
    await act(async () => {
      window.dispatchEvent(new Event("online"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.querySelector('[data-testid="offline-banner"]')).toBeNull()
  })
})
