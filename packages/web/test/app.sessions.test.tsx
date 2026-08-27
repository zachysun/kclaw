/**
 * App integration — full shell with a fake HTTP API and fake WebSockets
 * (jsdom has no WebSocket, so the client's socket factory is driven by a
 * stubbed global). Covers tab navigation, the new-session flow (POST then the
 * fresh empty session is selected and subscribed), and preserving the selected
 * session across tab switches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { App } from "../src/App.js"
import type { SessionMeta } from "../src/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Browser-shaped fake socket; CONNECTING sends throw until `open()`. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly url: string
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code?: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private openState = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    if (!this.openState) throw new DOMException("WebSocket is not open", "InvalidStateError")
    this.sent.push(data)
  }

  close(code?: number): void {
    this.onclose?.({ code })
  }

  open(): void {
    this.openState = true
    this.onopen?.()
  }
}

interface RouteHandler { status?: number; body: unknown }
type Routes = Record<string, RouteHandler | (() => RouteHandler)>

function session(id: string, title: string): SessionMeta {
  return { id, title, createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T09:00:00.000Z" }
}

function mockFetch(fetchMock: ReturnType<typeof vi.fn>, routes: Routes): void {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const url = String(input).split("?")[0]
    const key = `${method} ${url}`
    const handler = routes[key]
    if (handler === undefined) throw new Error(`unexpected fetch: ${method} ${url}`)
    const { status = 200, body } = typeof handler === "function" ? handler() : handler
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (status === 204 ? "" : JSON.stringify(body)),
    } as unknown as Response
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function mountApp(): { container: HTMLElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root }
}

describe("App (sessions + tabs)", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    history.replaceState({}, "", "/")
    FakeWebSocket.instances.length = 0
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("WebSocket", FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("switches between the chat / jobs / audit tabs", async () => {
    mockFetch(fetchMock, {
      "GET /status": { body: { ok: true } },
      "GET /sessions": { body: [session("s1", "第一会话")] },
      "GET /jobs": { body: [] },
      "GET /audit": { body: [] },
    })
    localStorage.setItem("kclaw_token", "tok-1")
    const { container, root } = mountApp()
    await act(async () => {
      root.render(<App />)
    })
    await flush()
    await flush()
    // Sidebar lists the session.
    expect(container.querySelector('[data-testid="session-item-s1"]')).not.toBeNull()

    await act(async () => {
      ;(container.querySelector('button[data-testid="tab-jobs"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="jobs-view"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="chat-view"]')).toBeNull() // chat hidden on jobs tab

    await act(async () => {
      ;(container.querySelector('button[data-testid="tab-audit"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="audit-view"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="jobs-view"]')).toBeNull()

    await act(async () => {
      ;(container.querySelector('button[data-testid="tab-chat"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="chat-empty"]')).not.toBeNull()
    root.unmount()
    container.remove()
  })

  it("creates a session: pick a workdir then POST selects and subscribes the empty session", async () => {
    const newMeta = session("ses_new", "新会话")
    mockFetch(fetchMock, {
      "GET /status": { body: { ok: true } },
      "GET /sessions": { body: [] },
      "GET /fs/browse": { body: { path: "/ws/picked", parent: "/", dirs: [] } },
      "GET /sessions/ses_new/messages": { body: [] },
      "POST /sessions": { body: newMeta },
    })
    localStorage.setItem("kclaw_token", "tok-1")
    const { container, root } = mountApp()
    await act(async () => {
      root.render(<App />)
    })
    await flush()
    await flush()
    expect(container.querySelector('[data-testid="session-empty"]')).not.toBeNull()

    // The only create entry left: 选择工作目录 → picker loads the daemon root
    // → confirming picks that directory and POSTs a session there.
    await act(async () => {
      ;(container.querySelector('button[data-testid="pick-workdir"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="picker-overlay"]')).not.toBeNull()
    await act(async () => {
      ;(container.querySelector('button[data-testid="picker-confirm"]') as HTMLButtonElement).click()
    })
    await flush()
    await flush()
    expect(fetchMock).toHaveBeenCalledWith(
      "/sessions",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ workdir: "/ws/picked" }) }),
    )
    // The new session is selected in the sidebar.
    const item = container.querySelector('[data-testid="session-item-ses_new"]')
    expect(item).not.toBeNull()
    expect(item!.getAttribute("data-selected")).toBe("true")
    expect(container.querySelector('[data-testid="session-empty"]')).toBeNull()

    // A ws client was created for the new session; open it and check subscribe.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0)
    await act(async () => {
      FakeWebSocket.instances[0]!.open()
    })
    await flush()
    const socket = FakeWebSocket.instances[0]!
    expect(socket.sent).toContain(JSON.stringify({ type: "auth", token: "tok-1" }))
    expect(socket.sent).toContain(JSON.stringify({ type: "subscribe", sessionId: "ses_new" }))
    // Empty chat renders for the fresh session.
    expect(container.querySelector('[data-testid="chat-view"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="chat-empty"]')).toBeNull()
    root.unmount()
    container.remove()
  })

  it("preselects the session named by ?session= once the list loads", async () => {
    mockFetch(fetchMock, {
      "GET /status": { body: { ok: true } },
      "GET /sessions": { body: [session("s1", "第一会话"), session("s2", "第二会话")] },
      "GET /sessions/s2/messages": { body: [] },
    })
    localStorage.setItem("kclaw_token", "tok-1")
    history.replaceState({}, "", "/?session=s2")
    const { container, root } = mountApp()
    await act(async () => {
      root.render(<App />)
    })
    await flush()
    await flush()
    // The deep-linked session is selected and its messages are pulled.
    expect(container.querySelector('[data-testid="session-item-s2"]')?.getAttribute("data-selected")).toBe("true")
    expect(fetchMock).toHaveBeenCalledWith("/sessions/s2/messages", expect.anything())
    // The consumed query param is stripped from the URL.
    expect(window.location.search).toBe("")
    root.unmount()
    container.remove()
  })

  it("falls back to normal selection when ?session= is unknown", async () => {
    mockFetch(fetchMock, {
      "GET /status": { body: { ok: true } },
      "GET /sessions": { body: [session("s1", "第一会话")] },
    })
    localStorage.setItem("kclaw_token", "tok-1")
    history.replaceState({}, "", "/?session=nonexistent")
    const { container, root } = mountApp()
    await act(async () => {
      root.render(<App />)
    })
    await flush()
    await flush()
    // Default behavior: nothing selected, no error, query still cleared.
    expect(container.querySelector('[data-testid="chat-empty"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="session-notice"]')).toBeNull()
    expect(window.location.search).toBe("")
    root.unmount()
    container.remove()
  })

  it("keeps the selected session when switching tabs and back", async () => {
    mockFetch(fetchMock, {
      "GET /status": { body: { ok: true } },
      "GET /sessions": { body: [session("s1", "第一会话")] },
      "GET /sessions/s1/messages": { body: [] },
      "GET /jobs": { body: [] },
    })
    localStorage.setItem("kclaw_token", "tok-1")
    const { container, root } = mountApp()
    await act(async () => {
      root.render(<App />)
    })
    await flush()
    await flush()
    await act(async () => {
      ;(container.querySelector('[data-testid="session-item-s1"]') as HTMLButtonElement).click()
    })
    await flush()
    await flush()
    expect(fetchMock).toHaveBeenCalledWith("/sessions/s1/messages", expect.anything())
    expect(container.querySelector('[data-testid="chat-view"]')).not.toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Switch to jobs and back — one socket only, chat state survives.
    await act(async () => {
      ;(container.querySelector('button[data-testid="tab-jobs"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="jobs-view"]')).not.toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(1)

    await act(async () => {
      ;(container.querySelector('button[data-testid="tab-chat"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="chat-view"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="chat-empty"]')).toBeNull()
    expect(container.querySelector('[data-testid="session-item-s1"]')?.getAttribute("data-selected")).toBe("true")
    expect(FakeWebSocket.instances).toHaveLength(1)
    root.unmount()
    container.remove()
  })
})
