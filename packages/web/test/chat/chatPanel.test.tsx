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
import type { AgentEvent, MemoryWrittenInfo, Message } from "../../src/chat/model.js"

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

/** Path-routed GET fixtures for the fake API client. */
interface ApiRoutes {
  /** GET /sessions/:id/queue — the daemon's queue snapshot (default: empty). */
  queue?: Array<{ messageId: string; disposition: string; text: string }>
  /** GET /sessions/:id — the session meta, the initial-disposition source (default: {}). */
  meta?: unknown
  /** GET /config — daemon config (default: {}). */
  config?: unknown
  /** GET /sessions/:id/compactions — the compaction audit log (default: []). */
  compactions?: unknown
  /** Make GET /sessions/:id/compactions reject (the silent-failure path). */
  compactionsFail?: boolean
  /** GET /skills fixture — the dynamic slash-command source (default: []). */
  skills?: Array<{ name: string; description: string; origin: string; visibility: string }>
}

function makeApi(getMessages: Message[], routes: ApiRoutes = {}): ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/skills") return routes.skills ?? []
      if (path.endsWith("/queue")) return routes.queue ?? []
      if (path === "/config") return routes.config ?? {}
      if (path.endsWith("/messages")) return getMessages
      if (path.endsWith("/compactions")) {
        if (routes.compactionsFail === true) throw new Error("compactions down")
        return routes.compactions ?? []
      }
      // GET /sessions/:id — session meta (initial-disposition resolution).
      return routes.meta ?? {}
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(),
    del: vi.fn(), upload: vi.fn(),
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }
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

/** Type into the composer and click Send (the full send path). */
async function sendText(h: Harness, text: string): Promise<void> {
  const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
  typeInto(input, text)
  await act(async () => {
    ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
  })
}

/** The user bubble carrying `text` (queued/optimistic lookups), null when absent. */
function findUserBubble(container: HTMLElement, text: string): HTMLElement | null {
  return (
    ([...container.querySelectorAll('[data-testid="msg-user"]')] as HTMLElement[])
      .find((b) => b.textContent?.includes(text)) ?? null
  )
}

/** The reconnect resync pulls (messages + queue) — the mount-time disposition fetch is /sessions/:id itself. */
function isDataPull(call: unknown[]): boolean {
  const path = String(call[0])
  return path.endsWith("/messages") || path.endsWith("/queue")
}

interface Harness {
  container: HTMLElement
  root: Root
  sockets: FakeSocket[]
  socketFactory: ReturnType<typeof vi.fn>
  api: ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }
  /** The original props handed to the panel — rerenders reuse them. */
  apiProp: ApiClient
  ws: WsClient
  createWs: () => WsClient
  unmount: () => void
}

async function mount(
  opts: {
    sessionId?: string
    initialMessages?: Message[]
    onSessionRenamed?: (sessionId: string, title: string) => void
    onCreateSession?: (title?: string) => Promise<void>
    onOpenSessions?: () => void
    /** GET /sessions/:id/queue fixture. */
    queue?: Array<{ messageId: string; disposition: string; text: string }>
    /** GET /sessions/:id (meta) fixture. */
    meta?: unknown
    /** GET /config fixture. */
    config?: unknown
    /** GET /sessions/:id/compactions fixture (the compaction audit log). */
    compactions?: unknown
    /** Make the compactions pull reject (silent-failure path). */
    compactionsFail?: boolean
    /** GET /skills fixture (dynamic slash commands). */
    skills?: Array<{ name: string; description: string; origin: string; visibility: string }>
    /** memory.written 通知条点击的回调。 */
    onOpenMemoryWritten?: (info: MemoryWrittenInfo) => void
  } = {},
): Promise<Harness> {
  const sessionId = opts.sessionId ?? "s1"
  const api = makeApi(opts.initialMessages ?? [], { queue: opts.queue, meta: opts.meta, config: opts.config, compactions: opts.compactions, compactionsFail: opts.compactionsFail, skills: opts.skills })
  const { sockets, socketFactory, createWs } = setup()
  const ws = createWs()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ChatPanel
        sessionId={sessionId}
        api={api}
        ws={ws}
        createWs={createWs}
        initialMessages={opts.initialMessages ?? []}
        onSessionRenamed={opts.onSessionRenamed}
        onCreateSession={opts.onCreateSession ?? (async () => {})}
        onOpenSessions={opts.onOpenSessions ?? (() => {})}
        onOpenMemoryWritten={opts.onOpenMemoryWritten}
      />,
    )
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
    apiProp: api,
    ws,
    createWs,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function pushFrame(socket: FakeSocket, frame: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(frame) })
}

function typeInto(input: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!
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

  it("escapes session.renamed to the owner (autoname reaches the sidebar)", async () => {
    const onSessionRenamed = vi.fn()
    const h = await mount({ onSessionRenamed })
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("session.renamed", { title: "自动生成的标题" }))
    })
    expect(onSessionRenamed).toHaveBeenCalledWith("s1", "自动生成的标题")
    // List-level metadata never touches the chat view.
    expect(h.container.textContent).not.toContain("自动生成的标题")
    h.unmount()
  })

  it("shows a notice when the daemon writes memory (memory.written)", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("memory.written", { path: "persona.md", kind: "persona", scope: "global" }))
    })
    // 落盘反馈走 ChatView 的一次性 notice（写入通知）。
    expect(h.container.querySelector('[data-testid="chat-notice"]')!.textContent).toContain("已写入记忆: persona.md")
    h.unmount()
  })

  it("clicks the memory.written notice to open the written memory", async () => {
    const onOpenMemoryWritten = vi.fn()
    const h = await mount({ onOpenMemoryWritten })
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("memory.written", { path: "/global/persona/persona.md", kind: "cognition", scope: "global" }))
    })
    // 有回调 → 通知渲染为按钮。
    const btn = h.container.querySelector('[data-testid="chat-notice-action"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toContain("已写入记忆: /global/persona/persona.md")
    await act(async () => { btn.click() })
    expect(onOpenMemoryWritten).toHaveBeenCalledTimes(1)
    expect(onOpenMemoryWritten).toHaveBeenCalledWith({ path: "/global/persona/persona.md", kind: "cognition", scope: "global" })
    h.unmount()
  })

  it("merges a refreshed message base into the live view (same session)", async () => {
    const h = await mount({
      initialMessages: [msg("m0", "user", [{ id: "b0", type: "text", text: "旧消息" }])],
    })
    // Live stream a bubble that exists only in this panel's state.
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("message.created", { message: msg("m1", "assistant", []) }))
      pushFrame(h.sockets[0]!, ev("text.created", { messageId: "m1", block: { id: "b1", type: "text", text: "" } }))
      pushFrame(h.sockets[0]!, ev("text.delta", { messageId: "m1", blockId: "b1", delta: "直播" }))
    })
    expect(h.container.textContent).toContain("直播")

    // The App hands down a refreshed base for the SAME session (its
    // re-pull-on-select union): merge must keep the live bubble.
    const refreshed = [
      msg("m0", "user", [{ id: "b0", type: "text", text: "旧消息" }]),
      msg("m2", "assistant", [{ id: "b2", type: "text", text: "服务器上的新消息" }]),
    ]
    await act(async () => {
      h.root.render(
        <ChatPanel sessionId="s1" api={h.apiProp} ws={h.ws} createWs={h.createWs} initialMessages={refreshed} onCreateSession={async () => {}} onOpenSessions={() => {}} />,
      )
    })
    await flush()
    expect(h.container.textContent).toContain("直播") // live view survived
    expect(h.container.textContent).toContain("服务器上的新消息")
    expect(h.container.textContent).toContain("旧消息")
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

  it("pulls the compaction audit log on session select and renders audit bars", async () => {
    const h = await mount({
      initialMessages: [
        msg("m0", "user", [{ id: "b0", type: "text", text: "问题一" }]),
        msg("m1", "assistant", [{ id: "b1", type: "text", text: "回答一" }]),
        msg("m2", "user", [{ id: "b2", type: "text", text: "问题二" }]),
      ],
      // 服务端原样记录（含 UI 不用的字段）——面板只挑 UI 字段。
      compactions: [{
        at: "2026-08-30T00:00:01.000Z",
        trigger: "auto",
        from: "m0",
        upto: "m1",
        messages: 2,
        segmentSummary: "第一段：聊了环境搭建",
        top: "总摘要",
      }],
    })
    try {
      expect(h.api.get).toHaveBeenCalledWith("/sessions/s1/compactions")
      const bars = h.container.querySelectorAll('[data-testid="ctx-note-audit"]')
      expect(bars).toHaveLength(1)
      expect(bars[0]!.textContent).toContain("已压缩为 1 段")
      expect(bars[0]!.textContent).toContain("第一段：聊了环境搭建")
    } finally {
      // 失败也要卸载：残留的 panel 会串到后面 document.querySelector 的用例。
      h.unmount()
    }
  })

  it("a failed compactions pull stays silent: no audit bars, no notice, no error", async () => {
    const h = await mount({
      initialMessages: [msg("m1", "user", [{ id: "b1", type: "text", text: "hi" }])],
      compactionsFail: true,
    })
    try {
      expect(h.api.get).toHaveBeenCalledWith("/sessions/s1/compactions")
      expect(h.container.querySelectorAll('[data-testid="ctx-note-audit"]')).toHaveLength(0)
      expect(h.container.querySelector('[data-testid="chat-notice"]')).toBeNull()
      expect(h.container.querySelector('[data-testid="chat-error"]')).toBeNull()
    } finally {
      h.unmount()
    }
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
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "hello world")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    expect(h.sockets[0]!.sent).toContain(
      JSON.stringify({ type: "send_message", sessionId: "s1", text: "hello world", disposition: "steer" }),
    )
    // Input clears after send; input stays enabled during a run (queued input).
    expect(input.value).toBe("")
    h.unmount()
  })

  it("runs a slash command instead of sending it to the model (/new)", async () => {
    const onCreateSession = vi.fn(async () => {})
    const h = await mount({ onCreateSession })
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "/new 重构讨论")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    expect(onCreateSession).toHaveBeenCalledWith("重构讨论")
    expect(h.sockets[0]!.sent.some((frame) => frame.includes("send_message"))).toBe(false)
    expect(input.value).toBe("")
    h.unmount()
  })

  it("compacts through the slash command with a focus argument", async () => {
    const h = await mount()
    h.api.post.mockResolvedValueOnce({ message: "压缩了 3 段" })
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "/compact 保留工具调用")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    expect(h.api.post).toHaveBeenCalledWith("/sessions/s1/compact", { focus: "保留工具调用" })
    await flush()
    expect(h.container.querySelector('[data-testid="chat-notice"]')!.textContent).toContain("压缩了 3 段")
    expect(h.sockets[0]!.sent.some((frame) => frame.includes("send_message"))).toBe(false)
    h.unmount()
  })

  it("hints on an unknown command without sending anything", async () => {
    const h = await mount()
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "/zzz")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(h.container.querySelector('[data-testid="chat-notice"]')!.textContent).toContain("没有这个命令，/help 看看")
    expect(h.sockets[0]!.sent.some((frame) => frame.includes("send_message"))).toBe(false)
    h.unmount()
  })

  it("renders the notice just above the composer, not at the panel top", async () => {
    const h = await mount()
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "/zzz")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    await flush()
    const notice = h.container.querySelector('[data-testid="chat-notice"]')!
    const composer = h.container.querySelector("form.chat-composer")!
    const log = h.container.querySelector('[data-testid="chat-log"]')!
    // Document order: the notice sits AFTER the conversation log (feedback
    // lives next to the input that triggered it) and directly BEFORE the
    // composer. compareDocumentPosition: FOLLOWING = the argument comes after
    // the receiver.
    expect(notice.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeFalsy()
    expect(notice.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    h.unmount()
  })

  it("clears a stale notice once the user starts typing a new message", async () => {
    const h = await mount()
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "/zzz")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(h.container.querySelector('[data-testid="chat-notice"]')).not.toBeNull()
    typeInto(input, "新的消息")
    expect(h.container.querySelector('[data-testid="chat-notice"]')).toBeNull()
    h.unmount()
  })

  it("shows a compacting indicator on compaction.started and clears it on completed/run.started", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("compaction.started", {}))
    })
    expect(h.container.querySelector('[data-testid="compacting-indicator"]')!.textContent).toContain("正在压缩")
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("compaction.completed", { segments: 1, kept: 4 }))
    })
    expect(h.container.querySelector('[data-testid="compacting-indicator"]')).toBeNull()
    // backstop: a run lifecycle event clears a stuck compacting state
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("compaction.started", {}))
    })
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.started", { trigger: "user" }))
    })
    expect(h.container.querySelector('[data-testid="compacting-indicator"]')).toBeNull()
    h.unmount()
  })

  it("compacting indicator offers a cancel button that sends compaction.cancel over the ws", async () => {
    const h = await mount()
    try {
      await drive(() => {
        pushFrame(h.sockets[0]!, ev("compaction.started", { phase: "post-run" }))
      })
      const btn = h.container.querySelector('[data-testid="compaction-cancel"]') as HTMLButtonElement | null
      expect(btn).not.toBeNull()
      await act(async () => {
        btn!.click()
      })
      // T8 协议：取消在飞的自动压缩 → ws 帧 {type:"compaction.cancel", sessionId}。
      expect(h.sockets[0]!.sent).toContain(
        JSON.stringify({ type: "compaction.cancel", sessionId: "s1" }),
      )
      // completed（任意 result）到达后指示行连同按钮一起消失。
      await drive(() => {
        pushFrame(h.sockets[0]!, ev("compaction.completed", { segments: 0, kept: 0, phase: "post-run", result: "cancelled" }))
      })
      expect(h.container.querySelector('[data-testid="compacting-indicator"]')).toBeNull()
      expect(h.container.querySelector('[data-testid="compaction-cancel"]')).toBeNull()
    } finally {
      // 失败也要卸载：残留的 panel 会串到后面 document.querySelector 的用例。
      h.unmount()
    }
  })

  it("echoes a sent message optimistically, then replaces it with the server twin", async () => {
    const h = await mount()
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "在吗")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    // The bubble is visible IMMEDIATELY — no frame needed (the pre-run
    // compaction may delay the server echo by seconds).
    const bubbles = h.container.querySelectorAll('[data-testid="msg-user"]')
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]!.textContent).toContain("在吗")
    // The server twin replaces the local one instead of duplicating.
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("message.created", {
        message: { id: "m1", sessionId: "s1", role: "user", blocks: [{ id: "b1", type: "text", text: "在吗" }], createdAt: "2026-08-15T00:00:00.000Z" },
      }))
    })
    expect(h.container.querySelectorAll('[data-testid="msg-user"]')).toHaveLength(1)
    h.unmount()
  })

  it("a busy-session send never renders a bubble: it goes straight to the queue list", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("compaction.started", {}))
    })
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "排队消息")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    await flush()
    // 压缩中（忙会话）发送：无一次性 notice、无乐观气泡——消息从第一帧起就
    // 是本地列表行（Master 2026-08-30 第二轮），ack/queued 到达后原地转正。
    expect(h.container.querySelector('[data-testid="chat-notice"]')).toBeNull()
    expect(h.container.querySelectorAll('[data-testid="msg-user"]')).toHaveLength(0)
    const row = h.container.querySelector('[data-testid="queue-row"]')
    expect(row?.textContent).toContain("排队消息")
    h.unmount()
  })

  it("an idle send still echoes optimistically as a bubble (free-send path untouched)", async () => {
    const h = await mount()
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "普通消息")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(h.container.querySelector('[data-testid="chat-notice"]')).toBeNull()
    expect(h.container.querySelector('[data-testid="msg-user"]')!.textContent).toContain("普通消息")
    expect(h.container.querySelector('[data-testid="queue-list"]')).toBeNull()
    h.unmount()
  })

  it("no queued hint when the session is idle", async () => {
    const h = await mount()
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "普通消息")
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(h.container.querySelector('[data-testid="chat-notice"]')).toBeNull()
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
      ;(h.container.querySelector('button[data-testid="confirm-once"]') as HTMLButtonElement).click()
    })
    expect(h.sockets[0]!.sent).toContain(
      JSON.stringify({ type: "confirmation.resolve", confirmationId: "conf_1", decision: "once", client: "web" }),
    )
    // The daemon's confirmation.resolved event removes the card.
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("confirmation.resolved", { confirmationId: "conf_1", decision: "once", by: "web" }))
    })
    expect(h.container.querySelector('[data-testid="confirm-card"]')).toBeNull()
    h.unmount()
  })

  it("project/global persist a rule; reject denies without one", async () => {
    const h = await mount()
    const request = async (confirmationId: string, callId: string, id: string): Promise<void> => {
      await drive(() => {
        pushFrame(h.sockets[0]!, ev("confirmation.requested", {
          confirmationId,
          toolCall: { id, type: "tool_call", callId, name: "exec", args: {}, argsJson: "{}" },
          risk: "safe",
          expiresAt: "t",
        }))
      })
    }
    const settle = async (confirmationId: string, decision: string, testid: string): Promise<void> => {
      await act(async () => {
        ;(h.container.querySelector(`button[data-testid="${testid}"]`) as HTMLButtonElement).click()
      })
      expect(h.sockets[0]!.sent).toContain(
        JSON.stringify({ type: "confirmation.resolve", confirmationId, decision, client: "web" }),
      )
      // The daemon removes the card on confirmation.resolved; without this the
      // next request would stack a second card and its buttons would shadow.
      await drive(() => {
        pushFrame(h.sockets[0]!, ev("confirmation.resolved", { confirmationId, decision, by: "web" }))
      })
      expect(h.container.querySelector('[data-testid="confirm-card"]')).toBeNull()
    }
    await request("conf_2", "c1", "b5")
    await settle("conf_2", "project", "confirm-project")
    await request("conf_3", "c2", "b6")
    await settle("conf_3", "global", "confirm-global")
    await request("conf_4", "c3", "b7")
    await settle("conf_4", "reject", "confirm-reject")
    h.unmount()
  })

  it("the mode selector mirrors session meta and POSTs on change", async () => {
    const h = await mount({ meta: { mode: "readonly" } })
    await flush()
    const select = h.container.querySelector('[data-testid="mode-select"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(select.value).toBe("readonly")
    await act(async () => {
      select.value = "acceptEdits"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(h.api.post).toHaveBeenCalledWith("/sessions/s1/mode", { mode: "acceptEdits" })
    expect(select.value).toBe("acceptEdits")
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
    // Only the /config + /sessions/:id disposition fetches may have happened —
    // no message/queue pulls yet.
    expect(h.api.get.mock.calls.filter(isDataPull)).toHaveLength(0)
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

  it("resends an undelivered message after a reconnect (issue #8)", async () => {
    const h = await mount({ initialMessages: [] })
    await drive(() => { h.sockets[0]!.open() })
    // Sent while connected, but the daemon never answers (no ack / queued
    // frame fed) — then the socket dies. The frame went out on a socket that
    // (from the daemon's point of view) never received it.
    await sendText(h, "没到")
    await drive(() => { h.sockets[0]!.onclose?.({ code: 1006 }) })
    // Reconnect resync finds neither the queue row nor a message with the
    // text → the send is presumed undelivered and resent.
    expect(h.container.textContent).toContain("已重连，补发 1 条断线期间未送达的消息")
    expect(findUserBubble(h.container, "没到")).not.toBeNull()
    await drive(() => { h.sockets[1]!.open() })
    const frames = h.sockets[1]!.sent.map((f) => JSON.parse(f) as { type: string; text?: string })
    expect(frames[0]).toEqual({ type: "auth", token: "tok-1" })
    const resent = frames.filter((f) => f.type === "send_message")
    expect(resent).toHaveLength(1)
    expect(resent[0]!.text).toBe("没到")
    h.unmount()
  })

  it("does NOT resend a message the reconnect resync proves delivered", async () => {
    const h = await mount({ initialMessages: [msg("m1", "user", [{ id: "b1", type: "text", text: "到了" }])] })
    await drive(() => { h.sockets[0]!.open() })
    await sendText(h, "到了")
    await drive(() => { h.sockets[0]!.onclose?.({ code: 1006 }) })
    // The resync pull returns the same persisted message — the optimistic
    // twin merges away and the send is presumed delivered: no resend.
    expect(h.container.textContent).toContain("已重连")
    expect(h.container.textContent).not.toContain("补发")
    await drive(() => { h.sockets[1]!.open() })
    const resent = h.sockets[1]!.sent.map((f) => JSON.parse(f) as { type: string }).filter((f) => f.type === "send_message")
    expect(resent).toHaveLength(0)
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
    expect(h.api.get.mock.calls.filter(isDataPull)).toHaveLength(0)
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

  it("send while running carries the selected disposition and writes the sticky override", async () => {
    // 初始 meta 无覆盖、config defaultDisposition "steer"
    const h = await mount({ meta: {}, config: { sessions: { defaultDisposition: "steer" } } })
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.started", { trigger: "user" }))
    })
    // 运行中 → 三选可见，默认选中 = 解析出的当前处置（config 默认 steer）
    const steerBtn = h.container.querySelector('[data-testid="disposition-steer"]') as HTMLButtonElement
    expect(steerBtn).not.toBeNull()
    expect(steerBtn.getAttribute("aria-checked")).toBe("true")
    // 运行中发送 → send_message 帧带 disposition:"steer"
    await sendText(h, "第一条")
    const sent = h.sockets[0]!.sent.filter((f) => f.includes("send_message"))
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ type: "send_message", text: "第一条", disposition: "steer" })
    // 点三选"等待" → POST /sessions/:id/disposition {disposition:"wait"}
    await act(async () => {
      ;(h.container.querySelector('[data-testid="disposition-wait"]') as HTMLButtonElement).click()
    })
    expect(h.api.post).toHaveBeenCalledWith("/sessions/s1/disposition", { disposition: "wait" })
    expect((h.container.querySelector('[data-testid="disposition-wait"]') as HTMLButtonElement).getAttribute("aria-checked")).toBe("true")
    // 再发送 → 帧带 disposition:"wait"（sticky）
    await sendText(h, "第二条")
    const sentAfter = h.sockets[0]!.sent.filter((f) => f.includes("send_message"))
    expect(JSON.parse(sentAfter.at(-1)!)).toMatchObject({ type: "send_message", text: "第二条", disposition: "wait" })
    h.unmount()
  })

  it("interrupt is one-shot: no sticky override, sends with interrupt, then the trio resets", async () => {
    // 初始 meta 无覆盖、config defaultDisposition "steer"（中断不再 sticky，发完切回基础处置）。
    const h = await mount({ meta: {}, config: { sessions: { defaultDisposition: "steer" } } })
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.started", { trigger: "user" }))
    })
    // 点三选「中断」→ 本地高亮，但不写会话级覆盖（无 POST /disposition）
    await act(async () => {
      ;(h.container.querySelector('[data-testid="disposition-interrupt"]') as HTMLButtonElement).click()
    })
    expect(h.api.post).not.toHaveBeenCalledWith("/sessions/s1/disposition", { disposition: "interrupt" })
    expect((h.container.querySelector('[data-testid="disposition-interrupt"]') as HTMLButtonElement).getAttribute("aria-checked")).toBe("true")
    // 发送 → send_message 帧带 disposition:"interrupt"
    await sendText(h, "中断这条")
    const sent = h.sockets[0]!.sent.filter((f) => f.includes("send_message"))
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ type: "send_message", text: "中断这条", disposition: "interrupt" })
    // 发送后三选切回基础处置（steer），且全程无 sticky 覆盖写入
    expect(h.api.post).not.toHaveBeenCalledWith("/sessions/s1/disposition", { disposition: "interrupt" })
    expect((h.container.querySelector('[data-testid="disposition-steer"]') as HTMLButtonElement).getAttribute("aria-checked")).toBe("true")
    expect((h.container.querySelector('[data-testid="disposition-interrupt"]') as HTMLButtonElement).getAttribute("aria-checked")).toBe("false")
    // 再发一条普通消息 → 帧回到 steer（一次性语义，不会继续掐 run）
    await sendText(h, "下一条")
    const sentAgain = h.sockets[0]!.sent.filter((f) => f.includes("send_message"))
    expect(JSON.parse(sentAgain.at(-1)!)).toMatchObject({ type: "send_message", text: "下一条", disposition: "steer" })
    h.unmount()
  })

  it("ack + message.queued moves the bubble into a list row; cancel hits queue.cancel", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.started", { trigger: "user" }))
    })
    await sendText(h, "帮我看看")
    // fake ws 回 send_message_ack{messageId:"msg_1", queued:true} + message.queued 事件
    await drive(() => {
      pushFrame(h.sockets[0]!, { type: "send_message_ack", sessionId: "s1", messageId: "msg_1", queued: true })
      pushFrame(h.sockets[0]!, ev("message.queued", { messageId: "msg_1", disposition: "wait", position: 1 }))
    })
    // 排队消息不进消息流（气泡被收走），列表行是唯一视图（Master 2026-08-30）
    expect(findUserBubble(h.container, "帮我看看")).toBeNull()
    const row = h.container.querySelector('[data-testid="queue-row"]')!
    expect(row.textContent).toContain("帮我看看")
    expect(row.textContent).toContain("等待")
    // 点单条取消 → ws 收到 {type:"queue.cancel", sessionId, messageId:"msg_1"}
    await act(async () => {
      ;(row.querySelector('[data-testid="queue-cancel"]') as HTMLButtonElement).click()
    })
    expect(h.sockets[0]!.sent).toContain(
      JSON.stringify({ type: "queue.cancel", sessionId: "s1", messageId: "msg_1" }),
    )
    h.unmount()
  })

  it("reconnect pulls GET /queue and rebuilds the queued rows", async () => {
    // api 的 GET /queue 返回一条 wait 条目
    const h = await mount({
      queue: [{ messageId: "q1", disposition: "wait", text: "断线前排队的话" }],
    })
    // 触发既有断线路径重连
    await drive(() => {
      h.sockets[0]!.onclose?.({ code: 1006 })
    })
    expect(h.api.get).toHaveBeenCalledWith("/sessions/s1/queue")
    // 重连后列表行恢复（消息流里没有排队消息）
    expect(findUserBubble(h.container, "断线前排队的话")).toBeNull()
    const list = h.container.querySelector('[data-testid="queue-list"]')!
    expect(list.textContent).toContain("1 条排队中")
    expect(list.querySelector('[data-testid="queue-row"]')!.textContent).toContain("断线前排队的话")
    h.unmount()
  })

  it("queue list shows rows in send order and all-cancel; typing does NOT clear it", async () => {
    const h = await mount()
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("run.started", { trigger: "user" }))
    })
    // 两条排队（各自 ack 收养 + message.queued）
    for (const [text, id] of [["甲", "qa"], ["乙", "qb"]] as const) {
      await sendText(h, text)
      await drive(() => {
        pushFrame(h.sockets[0]!, { type: "send_message_ack", sessionId: "s1", messageId: id, queued: true })
        pushFrame(h.sockets[0]!, ev("message.queued", { messageId: id, disposition: "wait" }))
      })
    }
    expect(h.container.querySelector('[data-testid="queue-list"]')!.textContent).toContain("2 条排队中")
    // FIFO：先发的"甲"渲染在上面
    const rows = [...h.container.querySelectorAll('[data-testid="queue-row"]')]
    expect(rows.map((r) => r.textContent)).toEqual(["等待甲取消", "等待乙取消"])
    // 排队列表是状态：打字不清除（一次性 notice 才随输入清除）
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    typeInto(input, "继续输入")
    expect(h.container.querySelector('[data-testid="queue-list"]')).not.toBeNull()
    // 点"全部取消" → ws 收到不带 messageId 的 queue.cancel
    await act(async () => {
      ;(h.container.querySelector('[data-testid="queue-cancel-all"]') as HTMLButtonElement).click()
    })
    const cancelFrame = JSON.parse(h.sockets[0]!.sent.at(-1)!) as { type?: string; sessionId?: string; messageId?: unknown }
    expect(cancelFrame.type).toBe("queue.cancel")
    expect(cancelFrame.sessionId).toBe("s1")
    expect("messageId" in cancelFrame).toBe(false)
    h.unmount()
  })

  it("resyncs the queue even when the message pull fails (independent directions)", async () => {
    const queueFixture = [{ messageId: "q1", disposition: "wait", text: "排队的话" }]
    const h = await mount({ queue: queueFixture })
    // 消息拉取失败、队列拉取成功：列表行仍要重建（两个方向互不阻塞）。
    ;(h.api.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path.endsWith("/queue")) return queueFixture
      if (path.endsWith("/messages")) throw new Error("pull failed")
      return {}
    })
    await drive(() => {
      h.sockets[0]!.onclose?.({ code: 1006 })
    })
    expect(h.container.textContent).toContain("无法同步消息")
    expect(h.container.querySelector('[data-testid="queue-row"]')?.textContent).toContain("排队的话")
    h.unmount()
  })

  it("fills a cross-client empty-text row by resyncing GET /queue", async () => {
    // 别的客户端（CLI/另一浏览器）排队的消息：message.queued 载荷不带文本，
    // 本端落地空文本行 → 自动拉一次队列快照把文本补上。
    const h = await mount()
    ;(h.api.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path.endsWith("/queue")) return [{ messageId: "q9", disposition: "wait", text: "CLI 发的排队消息" }]
      return {}
    })
    await drive(() => {
      pushFrame(h.sockets[0]!, ev("message.queued", { messageId: "q9", disposition: "wait" }))
    })
    await flush()
    const row = h.container.querySelector('[data-testid="queue-row"]')
    expect(row?.textContent).toContain("CLI 发的排队消息")
    h.unmount()
  })
})

describe("ChatPanel drag-and-drop attachments", () => {
  it("uploads a dropped file, shows a chip, and carries it on send_message", async () => {
    const { sockets, api, root } = await setupWithApi(0)
    const upload = api.upload as ReturnType<typeof vi.fn>
    upload.mockResolvedValue({ path: "/att/x.md", name: "x.md", size: 7 })
    act(() => {
      sockets[0]!.open()
    })
    // jsdom Event cannot carry dataTransfer; drive the handler through React's
    // synthetic drop with a custom event.
    const file = new File(["# 备忘"], "x.md", { type: "text/markdown" })
    const dataTransfer = { files: [file] } as unknown as DataTransfer
    const custom = new Event("drop", { bubbles: true, cancelable: true })
    Object.defineProperty(custom, "dataTransfer", { value: dataTransfer })
    const panel = document.querySelector('[data-testid="chat-panel"]')!
    await act(async () => {
      panel.dispatchEvent(custom)
      await new Promise((resolve) => setTimeout(resolve, 0)) // upload .then
    })
    expect(upload).toHaveBeenCalledWith("ses_1", file)
    expect(document.querySelectorAll('[data-testid="attachment-chip"]').length).toBe(1)

    const input = document.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement
    const sendBtn = document.querySelector('[data-testid="send-button"]') as HTMLButtonElement
    typeInto(input, "看附件")
    await act(async () => {
      sendBtn.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const lastSend = sockets[0]!.sent.at(-1)!
    const frame = JSON.parse(lastSend) as { type: string; text: string; attachments?: unknown[] }
    expect(frame.type).toBe("send_message")
    expect(frame.attachments).toHaveLength(1)
    expect((frame.attachments as Array<{ name: string }>)[0]!.name).toBe("x.md")
    expect(document.querySelectorAll('[data-testid="attachment-chip"]').length).toBe(0)
    root.unmount()
  })
})

async function setupWithApi(messageCount: number, getImpl?: (path: string) => unknown) {
  const sockets: FakeSocket[] = []
  const socketFactory = vi.fn(() => {
    const fake = makeFakeSocket()
    sockets.push(fake)
    return fake
  })
  const messages: Message[] = []
  for (let i = 0; i < messageCount; i++) {
    messages.push({ id: `m${i}`, role: "assistant", blocks: [{ id: `b${i}`, type: "text", text: "hi" }], createdAt: new Date().toISOString(), sessionId: "ses_1" })
  }
  const api = makeApi(messages)
  if (getImpl !== undefined) {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => getImpl(path))
  }
  const createWs = (): WsClient =>
    createWsClient(WS_URL, "tok", socketFactory as unknown as (url: string) => WsLikeSocket)
  const ws = createWs()
  const root = createRoot(document.body.appendChild(document.createElement("div")))
  act(() => {
    root.render(
      <ChatPanel sessionId="ses_1" api={api} ws={ws} createWs={createWs} initialMessages={messages} onCreateSession={async () => {}} onOpenSessions={() => {}} />,
    )
  })
  // Settle the /config model fetch inside act so its state update cannot
  // leak into a later test (it fires on mount, keyed on [api]).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { sockets, api, root }
}

describe("ChatPanel model selector", () => {
  it("renders provider models and posts the switch on change", async () => {
    const { sockets, api, root } = await setupWithApi(0, (path) =>
      path === "/config" ? { providers: { entries: { a: {}, b: {} } } } : [],
    )
    const post = api.post as ReturnType<typeof vi.fn>
    post.mockResolvedValue({ model: "b" })
    act(() => {
      sockets[0]!.open()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const select = document.querySelector('[data-testid="model-select"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(select.options.length).toBe(3) // 默认 + a + b
    await act(async () => {
      select.value = "b"
      select.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(post).toHaveBeenCalledWith("/sessions/ses_1/model", { model: "b" })
    root.unmount()
  })
})

describe("ChatPanel skill slash commands", () => {
  it("registered skills appear in the slash menu and /name sends the RAW text (daemon wraps)", async () => {
    const h = await mount({
      skills: [
        { name: "test", description: "验收技能", visibility: "all", origin: "global" },
        { name: "deploy", description: "部署", visibility: "user-only", origin: "project" },
      ],
    })
    try {
      await h.sockets[0]!.open()
      // 打开 socket 后已拉到 /skills 清单；输入前缀，动态命令进建议菜单
      const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
      typeInto(input, "/tes")
      await flush()
      const menu = h.container.querySelector('[data-testid="slash-menu"]')
      expect(menu?.textContent).toContain("/test")

      // 提交 /test <要求>：send_message 帧原文直发——隐式包装在 daemon 侧，
      // 气泡/轨迹所见即所发（Master 2026-09-03）
      await sendText(h, "/test 把 README 翻译成英文")
      const frame = JSON.parse(h.sockets[0]!.sent.at(-1)!) as { type?: string; text?: string }
      expect(frame).toMatchObject({
        type: "send_message",
        text: "/test 把 README 翻译成英文",
      })
    } finally {
      h.unmount()
    }
  })

  it("a skill named like a builtin does not shadow the builtin", async () => {
    const h = await mount({ skills: [{ name: "help", description: "撞内置名", visibility: "all", origin: "global" }] })
    try {
      // /help 在 ChatView 是本地视图拦截（打开命令面板），不会作为消息发出
      await sendText(h, "/help")
      const sends = h.sockets[0]!.sent.map((f) => JSON.parse(f) as { type?: string }).filter((f) => f.type === "send_message")
      expect(sends).toEqual([])
    } finally {
      h.unmount()
    }
  })
})
