import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { App } from "../src/App.js"

// React's act() needs an explicit test environment flag outside test runners
// that set it for us (globals: false, so we do it here).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mount(): { container: HTMLElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
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

/** Every request answers 401 (the daemon rejecting a stale/absent token). */
function mockUnauthorized(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock.mockImplementation(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: "unauthorized" }),
    text: async () => JSON.stringify({ error: "unauthorized" }),
  }))
}

describe("App", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    history.replaceState({}, "", "/")
    fetchMock.mockReset()
    // Route-aware default: /status and /sessions (the shell now loads both on
    // mount). Anything else falls back to a generic ok payload.
    fetchMock.mockImplementation(async (input: unknown, _init?: RequestInit) => {
      const url = String(input)
      const body = url === "/sessions" ? [] : { ok: true }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    })
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders the token form when no token is available", async () => {
    const { container, root } = mount()
    await act(async () => {
      root.render(<App />)
    })
    expect(container.textContent).toContain("kclaw")
    expect(container.querySelector('input[data-testid="token-input"]')).not.toBeNull()
    unmount(root, container)
  })

  it("renders the main shell with a status dot when a token is stored", async () => {
    localStorage.setItem("kclaw_token", "tok-1")
    const { container, root } = mount()
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {}) // flush the /status fetch + state update
    expect(container.querySelector('input[data-testid="token-input"]')).toBeNull()
    expect(container.querySelector('[data-testid="status-dot"]')).not.toBeNull()
    expect(container.textContent).toContain("kclaw")
    expect(fetchMock).toHaveBeenCalledWith("/status", expect.objectContaining({ method: "GET" }))
    unmount(root, container)
  })

  it("bootstraps a token from the URL and lands in the shell", async () => {
    history.replaceState({}, "", "/?token=from-url")
    const { container, root } = mount()
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {})
    expect(container.querySelector('[data-testid="status-dot"]')).not.toBeNull()
    expect(localStorage.getItem("kclaw_token")).toBe("from-url")
    expect(window.location.search).toBe("")
    unmount(root, container)
  })

    it("clears the stale token and returns to the token form on an API 401 (re-entry)", async () => {
    localStorage.setItem("kclaw_token", "stale-tok")
    mockUnauthorized(fetchMock)
    const { container, root } = mount()
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {}) // flush the /status 401 → onUnauthorized → setToken(null)
    expect(localStorage.getItem("kclaw_token")).toBeNull()
    expect(container.querySelector('input[data-testid="token-input"]')).not.toBeNull()
    unmount(root, container)
  })

  it("persists a freshly entered token from the token form (saveToken on submit)", async () => {
    localStorage.setItem("kclaw_token", "stale-tok")
    mockUnauthorized(fetchMock)
    // jsdom cannot navigate: stub reload so the submit's saveToken → reload
    // flow runs without throwing.
    const reload = vi.fn()
    vi.stubGlobal("location", { ...window.location, reload })
    const { container, root } = mount()
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {}) // the 401 drops the shell back to the token form
    const input = container.querySelector('input[data-testid="token-input"]') as HTMLInputElement
    typeInto(input, "fresh-tok")
    await act(async () => {
      const form = container.querySelector("form") as HTMLFormElement
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })
    expect(localStorage.getItem("kclaw_token")).toBe("fresh-tok")
    expect(reload).toHaveBeenCalledTimes(1)
    unmount(root, container)
  })

  it("lists every registered theme in the switcher and applies the selection", async () => {
    localStorage.setItem("kclaw_token", "tok-1")
    const { container, root } = mount()
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {}) // flush the /status fetch + state update
    const select = container.querySelector('select[data-testid="theme-select"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    const labels = Array.from(select.options).map((o) => o.textContent)
    expect(labels).toContain("红黑")
    expect(labels).toContain("琥珀")
    expect(labels).toContain("纸白")
    expect(select.value).toBe("phantom")
    // Selecting a theme applies it (attribute + persistence), like the
    // native change event would.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(select, "paper")
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(document.documentElement.dataset.theme).toBe("paper")
    expect(localStorage.getItem("kclaw_theme")).toBe("paper")
    unmount(root, container)
  })
})
