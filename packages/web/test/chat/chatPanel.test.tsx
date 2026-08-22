/**
 * ChatPanel integration tests — real reducer + real createWsClient wiring with
 * fake sockets and a fake API client (no browser needed). Covers subscribe,
 * streaming render, send_message, inline confirmation resolve, error frames,
 * and the reconnect path (close → re-pull + re-subscribe + notice).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { createWsClient, type WsClient, type WsLikeSocket } from "../../src/ws.js"
import type { ApiClient } from "../../src/api.js"
import { ChatPanel } from "../../src/chat/ChatPanel.js"
import type { AgentEvent, Message } from "../../src/chat/model.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface FakeSocket extends WsLikeSocket {
  sent: string[]
  _open: boolean
  /** Flip the socket to OPEN (browser CONNECTING semantics) and fire onopen. */
  open(): void
}

function makeFakeSocket(): FakeSocket {
  return {
    sent: [],
    _open: false,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data: string) {
      // Browser semantics: send() on a CONNECTING socket throws. Frames sent
      // before open must be buffered by createWsClient and flushed on open.
      if (!this._open) throw new DOMException("WebSocket is not open", "InvalidStateError")
      this.sent.push(data)
    },
    close(code?: number) {
      this.onclose?.({ code })
    },
    open() {
      this._open = true
      this.onopen?.()
    },
  }
}

const WS_URL = "ws://daemon.local/ws"

function makeApi(getMessages: Message[]): ApiClient & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => getMessages),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn> }
}

function setup() {
  const sockets: FakeSocket[] = []
  const socketFactory = vi.fn(() => {
    const fake = makeFakeSocket()
    sockets.push(fake)
    return fake
  })
  const createWs = (): WsClient =>
    createWsClient(WS_URL, "tok-1", socketFactory as unknown as (url: string) => WsLikeSocket)
  return { sockets, socketFactory, createWs }
}

function msg(id: string, role: "user" | "assistant" | "tool", blocks: Message["blocks"]): Message {
  return { id, sessionId: "s1", role, blocks, createdAt: "2026-08-15T00:00:00.000Z" }
}

function ev(type: AgentEvent["type"], payload: unknown): AgentEvent {
  return { id: `evt-${type}`, ts: "2026-08-15T00:00:00.000Z", type, sessionId: "s1", payload } as AgentEvent
}

/** Flush the async frame loop + React updates (microtasks + one macrotask). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * Run `fn` (which pushes ws frames / triggers sockets) and give the async
 * event loop a full macrotask turn INSIDE the same act block, so every state
 * update it causes is wrapped.
 */
async function drive(fn: () => void): Promise<void> {
  await act(async () => {
    fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

interface Harness {
  container: HTMLElement
  root: Root
  sockets: FakeSocket[]
  socketFactory: ReturnType<typeof vi.fn>
  api: ApiClient & { get: ReturnType<typeof vi.fn> }
  unmount: () => void
}

async function mount(
  opts: { sessionId?: string; initialMessages?: Message[] } = {},
): Promise<Harness> {
  const sessionId = opts.sessionId ?? "s1"
  const api = makeApi(opts.initialMessages ?? [])
  const { sockets, socketFactory, createWs } = setup()
  const ws = createWs()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ChatPanel sessionId={sessionId} api={api} ws={ws} createWs={createWs} initialMessages={opts.initialMessages ?? []} />)
  })
  // Open the first socket so the buffered subscribe is flushed (auth then subscribe).
  await act(async () => {
    sockets[0]!.open()
  })
  await flush()
  return {
    container,
    root,
    sockets,
    socketFactory,
    api,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function pushFrame(socket: FakeSocket, frame: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(frame) })
}

function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("ChatPanel", () => {
  beforeEach(() => {
    localStorage.clear()
    history.replaceState({}, "", "/")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("subscribes to the session over the ws on connect", async () => {
    const h = await mount()
    expect(h.sockets[0]!.sent).toContain(JSON.stringify({ type: "subscribe", sessionId: "s1" }))
    h.unmount()
  })

  it("renders the initial message list", async () => {
    const h = await mount({
      initialMessages: [msg("m1", "user", [{ id: "b1", type: "text", text: "hi" }])],
    })
    expect(h.container.textContent).toContain("hi")
    expect(h.container.querySelector('[data-testid="msg-user"]')).not.toBeNull()
    h.unmount()
  })

  it("renders streamed events live (skeleton → block → delta)", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.started", { trigger: "user" }))
      pushFrame(h.sockets[0]!, ev("message.created", { message: msg("m2", "assistant", []) }))
      pushFrame(h.sockets[0]!, ev("text.created", { messageId: "m2", block: { id: "b1", type: "text", text: "" } }))
      pushFrame(h.sockets[0]!, ev("text.delta", { messageId: "m2", blockId: "b1", delta: "Hel" }))
      pushFrame(h.sockets[0]!, ev("text.delta", { messageId: "m2", blockId: "b1", delta: "lo" }))
    })
    expect(h.container.textContent).toContain("Hello")
    expect(h.container.querySelector('[data-testid="run-indicator"]')).not.toBeNull()
    // Streamed assistant bubble present.
    expect(h.container.querySelectorAll('[data-testid="msg-assistant"]')).toHaveLength(1)
    h.unmount()
  })

  it("sends send_message over the ws from the composer", async () => {
    const h = await mount()
    const input = h.container.querySelector('input[data-testid="chat-input"]') as HTMLInputElement
    typeInto(input, "hello world")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    expect(h.sockets[0]!.sent).toContain(
      JSON.stringify({ type: "send_message", sessionId: "s1", text: "hello world" }),
    )
    // Input clears after send; input stays enabled during a run (queued input).
    expect(input.value).toBe("")
    h.unmount()
  })

  it("renders a confirmation card and resolves it inline", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("confirmation.requested", {
        confirmationId: "conf_1",
        toolCall: { id: "b5", type: "tool_call", callId: "c1", name: "exec", args: {}, argsJson: "{\"cmd\":\"ls\"}" },
        risk: "sensitive",
        expiresAt: "2026-08-15T00:02:00.000Z",
      }))
    })
    const card = h.container.querySelector('[data-testid="confirm-card"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain("exec")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="confirm-allow"]') as HTMLButtonElement).click()
    })
    expect(h.sockets[0]!.sent).toContain(
      JSON.stringify({ type: "confirmation.resolve", confirmationId: "conf_1", approved: true, client: "web" }),
    )
    // The daemon's confirmation.resolved event removes the card.
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("confirmation.resolved", { confirmationId: "conf_1", approved: true, by: "web" }))
    })
    expect(h.container.querySelector('[data-testid="confirm-card"]')).toBeNull()
    h.unmount()
  })

  it("deny button resolves with approved=false", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("confirmation.requested", {
        confirmationId: "conf_2",
        toolCall: { id: "b5", type: "tool_call", callId: "c1", name: "exec", args: {}, argsJson: "{}" },
        risk: "safe",
        expiresAt: "t",
      }))
    })
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="confirm-deny"]') as HTMLButtonElement).click()
    })
    expect(h.sockets[0]!.sent).toContain(
      JSON.stringify({ type: "confirmation.resolve", confirmationId: "conf_2", approved: false, client: "web" }),
    )
    h.unmount()
  })

  it("run indicator clears on run.completed", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.started", { trigger: "user" }))
    })
    expect(h.container.querySelector('[data-testid="run-indicator"]')).not.toBeNull()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.completed", { stopReason: "end_turn" }))
    })
    expect(h.container.querySelector('[data-testid="run-indicator"]')).toBeNull()
    h.unmount()
  })

  it("surfaces run.failed errors in the error banner", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.failed", { error: { code: "llm_error", message: "boom" } }))
    })
    expect(h.container.querySelector('[data-testid="chat-error"]')?.textContent).toContain("boom")
    h.unmount()
  })

  it("reconnects on an unexpected close: re-pulls messages and re-subscribes", async () => {
    const h = await mount({ initialMessages: [msg("m1", "user", [{ id: "b1", type: "text", text: "hi" }])] })
    expect(h.api.get).toHaveBeenCalledTimes(0) // initial messages come from props
    await drive(() => {
      h.sockets[0]!.onclose?.({ code: 1006 })
    })
    expect(h.sockets).toHaveLength(2)
    expect(h.api.get).toHaveBeenCalledWith("/sessions/s1/messages")
    expect(h.container.textContent).toContain("已重连")
    // The new socket is CONNECTING when subscribe is queued; once it opens, the
    // auth frame goes first and the buffered subscribe is flushed after it.
    await drive(() => {
      h.sockets[1]!.open()
    })
    const [auth, subscribe] = h.sockets[1]!.sent
    expect(auth).toBe(JSON.stringify({ type: "auth", token: "tok-1" }))
    expect(subscribe).toBe(JSON.stringify({ type: "subscribe", sessionId: "s1" }))
    h.unmount()
  })

  it("resets the reconnect budget after a successful reconnect", async () => {
    const h = await mount()
    // Two unexpected closes, each followed by a successful reconnect (fresh
    // socket created and opened) — the cap must never trip.
    await drive(() => {
      h.sockets[0]!.onclose?.({ code: 1006 })
    })
    await drive(() => {
      h.sockets[1]!.open()
    })
    expect(h.sockets).toHaveLength(2)
    expect(h.container.textContent).toContain("已重连")
    await drive(() => {
      h.sockets[1]!.onclose?.({ code: 1006 })
    })
    await drive(() => {
      h.sockets[2]!.open()
    })
    expect(h.sockets).toHaveLength(3)
    expect(h.socketFactory).toHaveBeenCalledTimes(3) // initial + 2 reconnects
    expect(h.container.textContent).toContain("已重连")
    h.unmount()
  })

  it("stops reconnecting after repeated failed attempts", async () => {
    const h = await mount()
    // The daemon refuses to rebuild the socket — every reconnect attempt fails.
    h.socketFactory.mockImplementation(() => {
      throw new Error("no daemon")
    })
    await drive(() => {
      h.sockets[0]!.onclose?.({ code: 1006 })
    })
    // 1 (mount) + 3 bounded attempts; the 4th close stops before createWs.
    expect(h.socketFactory).toHaveBeenCalledTimes(4)
    expect(h.sockets).toHaveLength(1)
    expect(h.container.textContent).toContain("重连失败，请刷新页面")
    h.unmount()
  })

  it("keeps streaming after a malformed frame (per-frame resilience)", async () => {
    const h = await mount()
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await drive(() => {
      // message.completed with a missing message would throw inside applyEvent.
      pushFrame(h.sockets[0]!, { id: "evt-bad", ts: "t", type: "message.completed", payload: {} })
      pushFrame(h.sockets[0]!, ev("confirmation.requested", {
        confirmationId: "conf_1",
        toolCall: { id: "b5", type: "tool_call", callId: "c1", name: "exec", args: {}, argsJson: "{}" },
        risk: "sensitive",
        expiresAt: "2026-08-15T00:02:00.000Z",
      }))
    })
    expect(errSpy).toHaveBeenCalled()
    // The loop survived the bad frame and rendered the next one.
    expect(h.container.querySelector('[data-testid="confirm-card"]')).not.toBeNull()
    errSpy.mockRestore()
    h.unmount()
  })

  it("shows an auth notice on close 4001 and does not reconnect", async () => {
    const h = await mount()
    await drive(() => {
      h.sockets[0]!.onclose?.({ code: 4001 })
    })
    expect(h.sockets).toHaveLength(1)
    expect(h.api.get).not.toHaveBeenCalled()
    expect(h.container.textContent).toContain("认证")
    h.unmount()
  })

  it("surfaces command error frames in the error banner", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, { type: "error", message: "send_message failed: nope" })
    })
    expect(h.container.querySelector('[data-testid="chat-error"]')?.textContent).toContain("nope")
    h.unmount()
  })

  it("shows a retry hint while the provider retries and clears it on llm.completed", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.started", { trigger: "user" }))
      pushFrame(h.sockets[0]!, ev("llm.failed", {
        error: { code: "llm_retry", message: "llm http 503: storm" }, willRetry: true, attempt: 1,
      }))
    })
    const hint = h.container.querySelector('[data-testid="run-retry"]')
    expect(hint).not.toBeNull()
    expect(hint!.textContent).toContain("重试中")
    // the run indicator still shows running (the run is NOT over)
    expect(h.container.querySelector('[data-testid="run-indicator"]')).not.toBeNull()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("llm.completed", { usage: {}, stopReason: "end_turn" }))
    })
    expect(h.container.querySelector('[data-testid="run-retry"]')).toBeNull()
    h.unmount()
  })
})
