/**
 * AuditView — the audit page (审计页). Reads the session's event stream via
 * GET /sessions/:id/events (following the shell's selected session) and tails
 * it live over a private ws connection (session.appended → ?since= refetch).
 *
 * The virtualized list is wrapped thinly: react-virtuoso is mocked with a
 * plain map + a recording scrollToIndex, so these tests exercise the DATA
 * flow (flattening, filtering, jumping, live append, states) rather than the
 * library. jsdom has no real layout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { AuditView } from "../../src/audit/AuditView.js"
import type { WsClient } from "../../src/ws.js"
import type { Message, SessionEvent } from "../../src/types.js"
import { fireAtBottom, fireRangeChanged, scrollCalls, virtuosoProps, type ScrollCall } from "../helpers/virtuosoMock.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no layout: flatten the virtualized list into a plain map (test
// data flow, not the library); scrollToIndex calls are recorded for jumps.
vi.mock("react-virtuoso", async () => await import("../helpers/virtuosoMock.js"))

// ---------------------------------------------------------------------------
// Fake ws client: frames arrive via push(); the iterator pends until then.
// ---------------------------------------------------------------------------

function makeWsFactory() {
  const clients: Array<{ client: WsClient; push: (frame: unknown) => void; finish: () => void }> = []
  const factory = (): WsClient => {
    const waiters: Array<(result: IteratorResult<unknown>) => void> = []
    const queued: unknown[] = []
    let closed = false
    const settle = (): void => {
      while (queued.length > 0 && waiters.length > 0) {
        waiters.shift()!({ value: queued.shift(), done: false })
      }
    }
    const client: WsClient = {
      send: vi.fn(),
      close: vi.fn(() => {
        closed = true
        for (const w of waiters.splice(0)) w({ value: undefined, done: true })
      }),
      onClose: vi.fn(),
      frames: {
        [Symbol.asyncIterator]() {
          return {
            next: (): Promise<IteratorResult<unknown>> => {
              if (queued.length > 0) return Promise.resolve({ value: queued.shift(), done: false })
              if (closed) return Promise.resolve({ value: undefined, done: true })
              return new Promise((resolve) => waiters.push(resolve))
            },
          }
        },
      },
    }
    const entry = {
      client,
      push: (frame: unknown): void => {
        queued.push(frame)
        settle()
      },
      finish: (): void => {
        closed = true
        for (const w of waiters.splice(0)) w({ value: undefined, done: true })
      },
    }
    clients.push(entry)
    return client
  }
  return { factory, clients }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    sessionId: "s1",
    role: "user",
    blocks: [{ id: "b1", type: "text", text: "你好" }],
    createdAt: "2026-08-19T10:00:00.000Z",
    ...overrides,
  }
}

function messageEvent(overrides: Partial<Message> = {}): SessionEvent {
  return { type: "message", ...message(overrides) }
}

function assistantEvent(overrides: Partial<Message> & Record<string, unknown> = {}): SessionEvent {
  return {
    type: "message",
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    blocks: [{ id: "b1", type: "text", text: "回答" }],
    createdAt: "2026-08-19T10:00:00.000Z",
    model: "test-model",
    usage: { inputTokens: 100, outputTokens: 20 },
    stopReason: "end_turn",
    ...overrides,
  } as unknown as SessionEvent
}

function compactionEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "compaction",
    at: "2026-08-19T10:01:30.000Z",
    trigger: "auto",
    from: null,
    upto: "m2",
    messages: 2,
    segmentSummary: "段摘要内容",
    top: "总摘要内容",
    ...overrides,
  } as unknown as SessionEvent
}

function memoryEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "memory",
    at: "2026-08-19T10:05:00.000Z",
    trigger: "interval",
    kind: "episode",
    op: "append",
    topic: "kclaw 会话持久化",
    file: "memory/episodes.md",
    ...overrides,
  } as unknown as SessionEvent
}

function systemEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "system",
    at: "2026-08-19T10:06:00.000Z",
    stable: "你是 kclaw 助手。",
    live: "",
    ...overrides,
  } as unknown as SessionEvent
}

function sandboxEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "sandbox.checked",
    at: "2026-08-19T10:07:00.000Z",
    enabled: true,
    available: true,
    ...overrides,
  } as unknown as SessionEvent
}

function runStartedEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "run.started",
    at: "2026-08-19T10:10:00.000Z",
    trigger: "user",
    ...overrides,
  } as unknown as SessionEvent
}

function runEndedEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "run.ended",
    at: "2026-08-19T10:11:00.000Z",
    stopReason: "end_turn",
    usage: { inputTokens: 120, outputTokens: 45 },
    ...overrides,
  } as unknown as SessionEvent
}

function permissionDecidedEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "permission.decided",
    at: "2026-08-19T10:10:30.000Z",
    confirmationId: "conf_1",
    decision: "once",
    by: "cli",
    tool: { callId: "call_1", name: "exec", argsJson: '{"command":"ls"}' },
    ...overrides,
  } as unknown as SessionEvent
}

function makeApi(): ApiClient & {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  del: ReturnType<typeof vi.fn>
} {
  return { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), upload: vi.fn() }
}

/** Static stream: one GET answering `events` regardless of ?since= (single-page streams). */
function staticStream(api: ReturnType<typeof makeApi>, events: SessionEvent[]): void {
  api.get.mockImplementation(async (path: string) => {
    if (path === `/sessions/s1/events` || path.startsWith("/sessions/s1/events?since=")) return events
    throw new Error(`unexpected path: ${path}`)
  })
}

/** A ws client whose frames iterator never yields (no live frames in these cases). */
function neverEndingWs(): WsClient {
  const pending: Array<(result: IteratorResult<never>) => void> = []
  return {
    send: vi.fn(),
    close: vi.fn(),
    onClose: vi.fn(),
    frames: {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<never>>((resolve) => pending.push(resolve)),
        }
      },
    },
  } as unknown as WsClient
}

async function mount(
  api: ApiClient,
  opts: { sessionId?: string | null; createWs?: () => WsClient; sessionTitle?: string | null } = {},
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <AuditView
        api={api}
        createWs={opts.createWs ?? neverEndingWs}
        sessionId={opts.sessionId !== undefined ? opts.sessionId : "s1"}
        sessionTitle={opts.sessionTitle ?? null}
      />,
    )
  })
  await act(async () => {}) // flush the event-stream fetch
  return { container, root }
}

function unmount(root: Root, container: HTMLElement): void {
  root.unmount()
  container.remove()
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** All rendered row buttons, in DOM order. */
function rowIds(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll('[data-testid="audit-list"] button[data-testid]')).map((el) =>
    el.getAttribute("data-testid"),
  )
}

beforeEach(() => {
  scrollCalls().length = 0
})

describe("AuditView (audit)", () => {
  it("fetches the selected session's stream on mount and renders flattened block rows", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({ id: "m1", role: "user", blocks: [{ id: "b1", type: "text", text: "你好" }], createdAt: "2026-08-19T10:00:00.000Z" }),
      messageEvent({ id: "m2", role: "assistant", blocks: [{ id: "b2", type: "text", text: "好的收到" }], createdAt: "2026-08-19T10:01:00.000Z" }),
    ])

    const { container, root } = await mount(api, { sessionTitle: "会话1" })
    expect(api.get).toHaveBeenCalledWith("/sessions/s1/events?since=0")
    expect(container.querySelector('[data-testid="audit-empty"]')).toBeNull()
    // One row per block (two messages × one text block each).
    expect(container.querySelectorAll('[data-testid^="audit-row-"]')).toHaveLength(2)
    expect(container.textContent).toContain("你好")
    expect(container.textContent).toContain("好的收到")
    // The session chip shows the title handed down by the shell.
    expect(container.querySelector('[data-testid="audit-session-chip"]')?.textContent).toContain("会话1")
    unmount(root, container)
  })

  it("renders rows in event-array order (oldest first, newest at the bottom)", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "早的" }], createdAt: "2026-08-19T09:00:00.000Z" }),
      messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "晚的" }], createdAt: "2026-08-19T11:00:00.000Z" }),
    ])

    const { container, root } = await mount(api)
    const rows = Array.from(container.querySelectorAll('[data-testid^="audit-row-"]'))
    const texts = rows.map((r) => r.textContent ?? "")
    expect(texts[0]).toContain("早的")
    expect(texts[1]).toContain("晚的")
    unmount(root, container)
  })

  it("flattens multiple blocks of one message into separate rows", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({
        id: "m1",
        blocks: [
          { id: "b1", type: "text", text: "正文" },
          { id: "b2", type: "tool_call", callId: "c1", name: "fs.read", args: { path: "/a" }, argsJson: JSON.stringify({ path: "/a" }) },
          { id: "b3", type: "tool_result", callId: "c1", status: "ok", output: "file contents", durationMs: 12 },
          { id: "b4", type: "note", kind: "system", text: "系统提示" },
        ],
      }),
    ])

    const { container, root } = await mount(api)
    expect(rowIds(container)).toEqual(["audit-row-0-0", "audit-row-0-1", "audit-row-0-2", "audit-row-0-3"])
    expect(container.textContent).toContain("正文")
    expect(container.textContent).toContain("fs.read")
    expect(container.textContent).toContain('{"path":"/a"}')
    expect(container.textContent).toContain("file contents")
    expect(container.textContent).toContain("系统提示")
    // note 行的类型徽标带具体 NoteKind
    expect(container.textContent).toContain("note:system")
    unmount(root, container)
  })

  it("shows the grant reason (grantedBy) on tool_call and tool_result rows", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({
        id: "m1",
        role: "assistant",
        blocks: [
          { id: "b1", type: "tool_call", callId: "c1", name: "fs.read", args: { path: "/a" }, argsJson: JSON.stringify({ path: "/a" }) },
        ],
        createdAt: "2026-08-19T10:00:00.000Z",
      }),
      {
        type: "message",
        id: "m2",
        sessionId: "s1",
        role: "tool",
        blocks: [
          { id: "b2", type: "tool_result", callId: "c1", status: "ok", output: "file contents", durationMs: 12 },
        ],
        createdAt: "2026-08-19T10:01:00.000Z",
        grantedBy: { c1: "whitelist" },
      } as SessionEvent,
    ])

    const { container, root } = await mount(api)
    const grants = Array.from(container.querySelectorAll('[data-testid^="audit-grant-"]'))
    expect(grants).toHaveLength(2)
    for (const grant of grants) {
      expect(grant.textContent).toContain("whitelist")
    }
    unmount(root, container)
  })

  it("expands a row on click to reveal the full block content", async () => {
    const longText = "A".repeat(120)
    const api = makeApi()
    staticStream(api, [messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: longText }] })])

    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="audit-full-0-0"]')).toBeNull()

    await act(async () => {
      ;(container.querySelector('button[data-testid="audit-row-0-0"]') as HTMLButtonElement).click()
    })

    const full = container.querySelector('[data-testid="audit-full-0-0"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain(longText)
    unmount(root, container)
  })

  it("keeps several rows expanded at the same time", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "第一条全文" }] }),
      messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "第二条全文" }], createdAt: "2026-08-19T10:02:00.000Z" }),
    ])

    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="audit-row-0-0"]') as HTMLButtonElement).click()
      ;(container.querySelector('button[data-testid="audit-row-1-0"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="audit-full-0-0"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="audit-full-1-0"]')).not.toBeNull()
    unmount(root, container)
  })

  it("renders message, session, compaction, and memory rows in stream order", async () => {
    const api = makeApi()
    staticStream(api, [
      { type: "session.created", at: "2026-08-19T09:00:00.000Z", title: "会话1" },
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "第一条" }], createdAt: "2026-08-19T10:00:00.000Z" }),
      compactionEvent({ at: "2026-08-19T10:01:30.000Z", from: "m1", upto: "m1", messages: 1 }),
      memoryEvent(),
    ])

    const { container, root } = await mount(api)
    // ALL persisted events render — session metadata included (十种事件全覆盖).
    expect(rowIds(container)).toEqual(["session-row-0", "audit-row-1-0", "compaction-row-2", "memory-row-3"])
    expect(container.textContent).toContain("第一条")
    unmount(root, container)
  })

  it("renders session metadata events as lightweight 会话 rows", async () => {
    const api = makeApi()
    staticStream(api, [
      { type: "session.created", at: "2026-08-19T09:00:00.000Z", title: "会话1", mode: "acceptEdits" } as SessionEvent,
      { type: "session.renamed", at: "2026-08-19T10:10:00.000Z", title: "改名" } as SessionEvent,
      { type: "session.set", at: "2026-08-19T10:11:00.000Z", model: "gpt-x" } as SessionEvent,
      { type: "session.deleted", at: "2026-08-19T10:12:00.000Z" } as SessionEvent,
      { type: "session.restored", at: "2026-08-19T10:13:00.000Z" } as SessionEvent,
    ])

    const { container, root } = await mount(api)
    expect(rowIds(container)).toEqual([
      "session-row-0",
      "session-row-1",
      "session-row-2",
      "session-row-3",
      "session-row-4",
    ])
    const text = container.textContent ?? ""
    expect(text).toContain("创建 · 会话1")
    expect(text).toContain("acceptEdits")
    expect(text).toContain("改名")
    expect(text).toContain("gpt-x")
    expect(text).toContain("移入回收站")
    expect(text).toContain("从回收站还原")

    // Expand → full field dump.
    await act(async () => {
      ;(container.querySelector('button[data-testid="session-row-2"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="audit-full-2"]')?.textContent).toContain("model: gpt-x")
    unmount(root, container)
  })

  it("renders memory events as 记忆 rows with a trigger/kind/op/target summary", async () => {
    const api = makeApi()
    staticStream(api, [memoryEvent()])

    const { container, root } = await mount(api)
    const row = container.querySelector('[data-testid="memory-row-0"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain("memory")
    expect(row!.textContent).toContain("interval")
    expect(row!.textContent).toContain("episode")
    expect(row!.textContent).toContain("append")
    expect(row!.textContent).toContain("kclaw 会话持久化")
    expect(row!.textContent).toContain("memory/episodes.md")

    expect(container.querySelector('[data-testid="audit-full-0"]')).toBeNull()

    await act(async () => {
      ;(container.querySelector('button[data-testid="memory-row-0"]') as HTMLButtonElement).click()
    })
    const full = container.querySelector('[data-testid="audit-full-0"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain("trigger: interval")
    expect(full!.textContent).toContain("topic: kclaw 会话持久化")
    unmount(root, container)
  })

  it("inserts compaction rows into the stream at the time they happened", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "第一条" }], createdAt: "2026-08-19T10:00:00.000Z" }),
      messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "第二条" }], createdAt: "2026-08-19T10:01:00.000Z" }),
      compactionEvent({ at: "2026-08-19T10:01:30.000Z", from: "m1", upto: "m2", messages: 2 }),
      messageEvent({ id: "m3", blocks: [{ id: "b3", type: "text", text: "第三条" }], createdAt: "2026-08-19T10:02:00.000Z" }),
    ])

    const { container, root } = await mount(api)
    expect(rowIds(container)).toEqual([
      "audit-row-0-0",
      "audit-row-1-0",
      "compaction-row-2",
      "audit-row-3-0",
    ])

    await act(async () => {
      ;(container.querySelector('button[data-testid="compaction-row-2"]') as HTMLButtonElement).click()
    })
    const full = container.querySelector('[data-testid="audit-full-2"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain("段摘要内容")
    expect(full!.textContent).toContain("总摘要内容")
    unmount(root, container)
  })

  it("labels compaction rows by trigger (收尾/运行中/手动) and appends 超限急救", async () => {
    const api = makeApi()
    staticStream(api, [
      compactionEvent({ trigger: "auto" }),
      compactionEvent({ trigger: "in-run", at: "2026-08-19T10:02:30.000Z" }),
      compactionEvent({ trigger: "manual", focus: "api 设计", at: "2026-08-19T10:03:30.000Z" }),
      compactionEvent({ trigger: "auto", emergency: true, at: "2026-08-19T10:04:30.000Z" }),
    ])

    const { container, root } = await mount(api)
    const summary = (i: number): string =>
      container.querySelector(`[data-testid="compaction-row-${i}"]`)?.textContent ?? ""
    expect(summary(0)).toContain("自动（收尾）")
    expect(summary(1)).toContain("自动（运行中）")
    expect(summary(2)).toContain("手动（api 设计）")
    expect(summary(3)).toContain("自动（收尾）·超限急救")
    unmount(root, container)
  })

  it("shows the token drop on compaction rows; legacy records without figures stay plain", async () => {
    const api = makeApi()
    staticStream(api, [
      compactionEvent({ tokensBefore: 94_238, tokensAfter: 31_520 }),
      compactionEvent({ at: "2026-08-19T10:02:30.000Z" }),
    ])

    const { container, root } = await mount(api)
    const summary = (i: number): string =>
      container.querySelector(`[data-testid="compaction-row-${i}"]`)?.textContent ?? ""
    expect(summary(0)).toContain("94.2k → 31.5k token")
    expect(summary(1)).not.toContain("token")
    // 展开区带完整数字与口径说明
    await act(async () => {
      ;(container.querySelector('button[data-testid="compaction-row-0"]') as HTMLButtonElement).click()
    })
    const full = container.querySelector('[data-testid="audit-full-0"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain("94,238")
    expect(full!.textContent).toContain("31,520")
    expect(full!.textContent).toContain("锚定最后一次真实请求")
    unmount(root, container)
  })

  it("renders system events as 系统提示词 rows with a truncated snippet and char count", async () => {
    const longText = "系统提示词全文".repeat(30)
    const api = makeApi()
    staticStream(api, [systemEvent({ stable: longText })])

    const { container, root } = await mount(api)
    const row = container.querySelector('[data-testid="system-row-0"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain("system")
    expect(row!.textContent).toContain(longText.slice(0, 60))
    expect(row!.textContent).toContain("…")
    expect(row!.textContent).not.toContain(longText)
    expect(row!.textContent).toContain(`· ${longText.length} 字`)
    expect(container.querySelector('[data-testid="audit-full-0"]')).toBeNull()
    unmount(root, container)
  })

  it("does not badge the first system row and badges a changed later one (across interleaved rows)", async () => {
    const api = makeApi()
    staticStream(api, [
      systemEvent({ stable: "第一版系统提示词", at: "2026-08-19T10:06:00.000Z" }),
      systemEvent({ stable: "第一版系统提示词", at: "2026-08-19T10:06:30.000Z" }),
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "中间的对话" }], createdAt: "2026-08-19T10:07:00.000Z" }),
      systemEvent({ stable: "第二版系统提示词", at: "2026-08-19T11:06:00.000Z" }),
    ])

    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="audit-changed-0"]')).toBeNull()
    expect(container.querySelector('[data-testid="audit-changed-1"]')).toBeNull()
    const badge = container.querySelector('[data-testid="audit-changed-3"]')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toContain("已变化")
    unmount(root, container)
  })

  it("expands a system row on click to reveal the full prompt text", async () => {
    const longText = "系统提示词全文".repeat(30)
    const api = makeApi()
    staticStream(api, [systemEvent({ stable: longText })])

    const { container, root } = await mount(api)
    await act(async () => {
      ;(container.querySelector('button[data-testid="system-row-0"]') as HTMLButtonElement).click()
    })
    const full = container.querySelector('[data-testid="audit-full-0"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain(longText)
    unmount(root, container)
  })

  it("renders sandbox.checked events as 沙箱 rows in all three states", async () => {
    const api = makeApi()
    staticStream(api, [
      sandboxEvent(),
      sandboxEvent({ available: false, unavailableReason: "bwrap not found on PATH", at: "2026-08-19T10:08:00.000Z" }),
      sandboxEvent({ enabled: false, available: false, at: "2026-08-19T10:09:00.000Z" }),
    ])

    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="sandbox-row-0"]')!.textContent).toContain("可用")
    expect(container.querySelector('[data-testid="sandbox-row-1"]')!.textContent).toContain("不可用")
    expect(container.querySelector('[data-testid="sandbox-row-1"]')!.textContent).toContain("bwrap not found on PATH")
    expect(container.querySelector('[data-testid="sandbox-row-2"]')!.textContent).toContain("已关闭")
    expect(container.querySelector('[data-testid="audit-full-2"]')).toBeNull()

    await act(async () => {
      ;(container.querySelector('button[data-testid="sandbox-row-2"]') as HTMLButtonElement).click()
    })
    const full = container.querySelector('[data-testid="audit-full-2"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain("enabled: false")
    expect(full!.textContent).toContain("available: false")
    unmount(root, container)
  })

  it("renders run boundary and permission decision rows with expandable payload", async () => {
    const api = makeApi()
    staticStream(api, [
      runStartedEvent(),
      permissionDecidedEvent(),
      runEndedEvent(),
      runEndedEvent({
        stopReason: "error",
        usage: undefined,
        error: { code: "llm_error", message: "provider down" },
        at: "2026-08-19T10:12:00.000Z",
      }),
    ])

    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="run-row-0"]')!.textContent).toContain("运行开始")
    expect(container.querySelector('[data-testid="decision-row-1"]')!.textContent).toContain("批准（仅本次）")
    expect(container.querySelector('[data-testid="decision-row-1"]')!.textContent).toContain("exec")
    expect(container.querySelector('[data-testid="run-row-2"]')!.textContent).toContain("end_turn")
    expect(container.querySelector('[data-testid="run-row-3"]')!.textContent).toContain("error")
    expect(container.querySelector('[data-testid="run-row-3"]')!.textContent).toContain("provider down")

    await act(async () => {
      ;(container.querySelector('button[data-testid="decision-row-1"]') as HTMLButtonElement).click()
    })
    const full = container.querySelector('[data-testid="audit-full-1"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain("conf_1")
    expect(full!.textContent).toContain("call_1")
    unmount(root, container)
  })

  it("shows the empty state when the selected session has no events", async () => {
    const api = makeApi()
    staticStream(api, [])

    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="audit-empty"]')?.textContent).toContain("暂无事件")
    unmount(root, container)
  })

  it("shows the no-session state when nothing is selected", async () => {
    const api = makeApi()
    const { container, root } = await mount(api, { sessionId: null })
    expect(api.get).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="audit-empty"]')?.textContent).toContain("选择一个会话")
    unmount(root, container)
  })

  it("shows a distinct loading state while the stream is being fetched", async () => {
    const api = makeApi()
    let resolveGet: ((events: SessionEvent[]) => void) | undefined
    api.get.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveGet = (() => resolve()) as unknown as (events: SessionEvent[]) => void
      }) as never,
    )
    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="audit-loading"]')?.textContent).toContain("加载事件流")
    unmount(root, container)
    resolveGet?.([])
  })

  it("shows an error state with retry, and retry refetches", async () => {
    const api = makeApi()
    let fail = true
    api.get.mockImplementation(async () => {
      if (fail) throw new Error("daemon 不可达")
      return []
    })

    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="audit-error"]')?.textContent).toContain("daemon 不可达")

    fail = false
    await act(async () => {
      ;(container.querySelector('[data-testid="audit-retry"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="audit-error"]')).toBeNull()
    expect(container.querySelector('[data-testid="audit-empty"]')?.textContent).toContain("暂无事件")
    unmount(root, container)
  })

  // ---------- token / latency / duration ----------

  it("shows input/output tokens and LLM latency on the last block of an assistant message", async () => {
    const api = makeApi()
    staticStream(api, [
      assistantEvent({
        blocks: [
          { id: "b1", type: "thinking", text: "思考" },
          { id: "b2", type: "text", text: "回答" },
        ],
        usage: { inputTokens: 1234, outputTokens: 567 },
        latencyMs: 2300,
      }),
    ])

    const { container, root } = await mount(api)
    // Badge once — on the message's LAST block row only.
    expect(container.querySelectorAll('[data-testid^="audit-usage-"]')).toHaveLength(1)
    const badge = container.querySelector('[data-testid="audit-usage-0-1"]')!
    expect(badge.textContent).toContain("入 1,234 · 出 567")
    expect(badge.textContent).toContain("2.3s")
    unmount(root, container)
  })

  it("shows an em dash instead of a made-up latency for historical assistant messages", async () => {
    const api = makeApi()
    staticStream(api, [assistantEvent({})]) // no latencyMs (pre-field history)

    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="audit-usage-0-0"]')!.textContent).toContain("· —")
    unmount(root, container)
  })

  it("shows tool duration on tool_result rows", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({
        id: "m1",
        role: "tool",
        blocks: [{ id: "b1", type: "tool_result", callId: "c1", status: "ok", output: "ok", durationMs: 1250 }],
      }),
    ])

    const { container, root } = await mount(api)
    expect(container.querySelector('[data-testid="audit-duration-0-0"]')!.textContent).toContain("1.3s")
    unmount(root, container)
  })

  // ---------- live tailing ----------

  it("appends new events live when session.appended frames arrive", async () => {
    const api = makeApi()
    const initial: SessionEvent[] = [messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "初始" }] })]
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions/s1/events?since=0") return initial
      if (path === "/sessions/s1/events?since=1") return [messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "追加的" }] })]
      if (path === "/sessions/s1/events?since=2") return []
      throw new Error(`unexpected path: ${path}`)
    })
    const ws = makeWsFactory()

    const { container, root } = await mount(api, { createWs: ws.factory })
    expect(container.textContent).toContain("初始")

    await act(async () => {
      ws.clients[0]!.push({ type: "session.appended", id: "evt_1", ts: "t", payload: { eventType: "message" } })
    })
    await flush()

    expect(api.get).toHaveBeenCalledWith("/sessions/s1/events?since=1")
    expect(container.textContent).toContain("追加的")
    unmount(root, container)
  })

  it("coalesces a burst of appended frames without double-appending", async () => {
    const api = makeApi()
    const initial: SessionEvent[] = [messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "初始" }] })]
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions/s1/events?since=0") return initial
      if (path === "/sessions/s1/events?since=1") {
        return [messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "一次拉回两条之一" }] })]
      }
      return []
    })
    const ws = makeWsFactory()

    const { container, root } = await mount(api, { createWs: ws.factory })
    await act(async () => {
      ws.clients[0]!.push({ type: "session.appended", id: "evt_1", ts: "t", payload: { eventType: "message" } })
      ws.clients[0]!.push({ type: "session.appended", id: "evt_2", ts: "t", payload: { eventType: "message" } })
    })
    await flush()

    // Both rows end up exactly once: the second pull (since=2) is empty.
    expect((container.textContent ?? "").match(/一次拉回两条之一/g)).toHaveLength(1)
    expect(api.get).toHaveBeenCalledWith("/sessions/s1/events?since=2")
    unmount(root, container)
  })

  it("subscribes its own ws connection to the session and closes it on unmount", async () => {
    const api = makeApi()
    staticStream(api, [])
    const ws = makeWsFactory()

    const { root, container } = await mount(api, { createWs: ws.factory })
    expect(ws.clients).toHaveLength(1)
    expect(ws.clients[0]!.client.send).toHaveBeenCalledWith({ type: "subscribe", sessionId: "s1" })
    unmount(root, container)
    expect(ws.clients[0]!.client.close).toHaveBeenCalled()
  })

  // ---------- filtering ----------

  it("filters rows by kind toggles", async () => {
    const api = makeApi()
    staticStream(api, [
      { type: "session.created", at: "2026-08-19T09:00:00.000Z", title: "会话1" } as SessionEvent,
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "对话内容" }] }),
      compactionEvent(),
      memoryEvent(),
    ])

    const { container, root } = await mount(api)
    // Turn "block" off → message rows go, the rest stay.
    await act(async () => {
      const box = container.querySelector('input[data-testid="kind-block"]') as HTMLInputElement
      box.click()
    })
    expect(rowIds(container)).toEqual(["session-row-0", "compaction-row-2", "memory-row-3"])

    // Turn "memory" off too.
    await act(async () => {
      const box = container.querySelector('input[data-testid="kind-memory"]') as HTMLInputElement
      box.click()
    })
    expect(rowIds(container)).toEqual(["session-row-0", "compaction-row-2"])

    // Both back on → everything again.
    await act(async () => {
      ;(container.querySelector('input[data-testid="kind-block"]') as HTMLInputElement).click()
      ;(container.querySelector('input[data-testid="kind-memory"]') as HTMLInputElement).click()
    })
    expect(rowIds(container)).toHaveLength(4)
    unmount(root, container)
  })

  it("filters rows by time preset", async () => {
    const api = makeApi()
    staticStream(api, [
      { type: "session.created", at: "2020-01-01T00:00:00.000Z", title: "很久以前" } as SessionEvent,
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "今天的消息" }], createdAt: new Date().toISOString() }),
    ])

    const { container, root } = await mount(api)
    expect(rowIds(container)).toHaveLength(2)

    // Select "today" — the 2020 session.created row drops out.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!
      const select = container.querySelector('select[data-testid="audit-time-preset"]') as HTMLSelectElement
      setter.call(select, "today")
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(rowIds(container)).toEqual(["audit-row-1-0"])
    unmount(root, container)
  })

  // ---------- keyword filter + jumps ----------

  it("keyword filters rows (AND with the other dimensions); compaction jumps still work", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "first needle" }] }),
      compactionEvent({ at: "2026-08-19T10:01:30.000Z" }),
      messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "second NEEDLE" }], createdAt: "2026-08-19T10:02:00.000Z" }),
    ])

    const { container, root } = await mount(api)
    const kw = container.querySelector('input[data-testid="audit-keyword"]') as HTMLInputElement

    const typeKeyword = async (value: string): Promise<void> => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
        setter.call(kw, value)
        kw.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await flush()
    }

    expect(rowIds(container)).toHaveLength(3)
    await typeKeyword("needle")
    // Case-insensitive substring over full content: only the two needle rows stay.
    expect(rowIds(container)).toEqual(["audit-row-0-0", "audit-row-2-0"])

    // Blank keyword stops filtering.
    await typeKeyword("")
    expect(rowIds(container)).toHaveLength(3)

    // Compaction jump from the top of the list.
    await act(async () => {
      ;(container.querySelector('[data-testid="audit-jump-compaction-next"]') as HTMLButtonElement).click()
    })
    expect(scrollCalls().at(-1)!.index).toBe(1)
    unmount(root, container)
  })

  it("no keyword match shows the filtered-empty state, not the plain empty state", async () => {
    const api = makeApi()
    staticStream(api, [messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "你好" }] })])

    const { container, root } = await mount(api)
    const kw = container.querySelector('input[data-testid="audit-keyword"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
      setter.call(kw, "不存在的词")
      kw.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await flush()
    expect(container.querySelector('[data-testid="audit-empty"]')?.textContent).toContain("当前过滤条件下没有匹配的事件")
    unmount(root, container)
  })

  it("dynamic time presets re-evaluate on the tick: an aged-out row drops without new events", async () => {
    vi.useFakeTimers()
    try {
      const api = makeApi()
      // A message 59 minutes old — inside "1h" now, outside after the tick.
      const createdAt = new Date(Date.now() - 59 * 60_000).toISOString()
      staticStream(api, [messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "快过期的" }], createdAt })])

      const { container, root } = await mount(api)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!
        const select = container.querySelector('select[data-testid="audit-time-preset"]') as HTMLSelectElement
        setter.call(select, "1h")
        select.dispatchEvent(new Event("change", { bubbles: true }))
      })
      expect(rowIds(container)).toHaveLength(1)

      await act(async () => {
        vi.advanceTimersByTime(2 * 60_000) // past the 30s tick, row is now > 1h old
      })
      expect(rowIds(container)).toEqual([])
      unmount(root, container)
    } finally {
      vi.useRealTimers()
    }
  })

  it("the jump anchor follows the viewport: compaction jumps are relative to the first visible row", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "一" }] }),
      compactionEvent({ at: "2026-08-19T10:01:30.000Z" }),
      messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "二" }] }),
      compactionEvent({ at: "2026-08-19T10:03:30.000Z" }),
      messageEvent({ id: "m3", blocks: [{ id: "b3", type: "text", text: "三" }], createdAt: "2026-08-19T10:04:00.000Z" }),
    ])

    const { container, root } = await mount(api)
    // Jump to the first compaction from the top.
    await act(async () => {
      ;(container.querySelector('[data-testid="audit-jump-compaction-next"]') as HTMLButtonElement).click()
    })
    expect(scrollCalls().at(-1)!.index).toBe(1)

    // The user manually scrolls down to the last row: the anchor must follow
    // (rangeChanged reports the visible window), so "prev compaction" jumps
    // from the CURRENT position, not from the stale jump target.
    await act(async () => {
      fireRangeChanged({ startIndex: 4, endIndex: 4 })
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="audit-jump-compaction-prev"]') as HTMLButtonElement).click()
    })
    expect(scrollCalls().at(-1)!.index).toBe(3) // the second compaction, before row 4
    unmount(root, container)
  })
})

describe("AuditView follow semantics & live errors", () => {
  it("starts pinned to the bottom: followOutput on, no back-to-latest bubble", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "一" }] }),
      messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "二" }] }),
    ])

    const { container, root } = await mount(api)
    expect(virtuosoProps().followOutput).toBe("auto")
    expect(virtuosoProps().initialTopMostItemIndex).toBe(1) // last visible row
    expect(container.querySelector('[data-testid="audit-jump-latest"]')).toBeNull()
    unmount(root, container)
  })

  it("pauses following when the user scrolls up; scrolling back to the bottom resumes it", async () => {
    const api = makeApi()
    staticStream(api, [messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "一" }] })])

    const { container, root } = await mount(api)
    await act(async () => {
      fireAtBottom(false) // the user scrolled away from the bottom
    })
    expect(container.querySelector('[data-testid="audit-jump-latest"]')).not.toBeNull()
    expect(virtuosoProps().followOutput).toBe(false)

    await act(async () => {
      fireAtBottom(true) // back at the bottom → following re-engages on its own
    })
    expect(container.querySelector('[data-testid="audit-jump-latest"]')).toBeNull()
    expect(virtuosoProps().followOutput).toBe("auto")
    unmount(root, container)
  })

  it("the back-to-latest bubble re-engages following and scrolls to the last row", async () => {
    const api = makeApi()
    staticStream(api, [
      messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "一" }] }),
      messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "二" }] }),
    ])

    const { container, root } = await mount(api)
    await act(async () => {
      fireAtBottom(false)
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="audit-jump-latest"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="audit-jump-latest"]')).toBeNull()
    expect(virtuosoProps().followOutput).toBe("auto")
    expect(scrollCalls().at(-1)!.index).toBe(1) // the newest row
    unmount(root, container)
  })

  it("a failed live pull shows a slim retry bar without dropping rows; retry recovers", async () => {
    const api = makeApi()
    const initial: SessionEvent[] = [messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "初始" }] })]
    let since1Calls = 0
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions/s1/events?since=0") return initial
      if (path === "/sessions/s1/events?since=1") {
        since1Calls += 1
        if (since1Calls === 1) throw new Error("网络断了")
        return [messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "补上的" }] })]
      }
      return []
    })
    const ws = makeWsFactory()

    const { container, root } = await mount(api, { createWs: ws.factory })
    await act(async () => {
      ws.clients[0]!.push({ type: "session.appended", id: "evt_1", ts: "t", payload: { eventType: "message" } })
    })
    await flush()

    // The failure surfaces near the live area; the loaded rows stay put.
    const bar = container.querySelector('[data-testid="audit-live-error"]')
    expect(bar).not.toBeNull()
    expect(bar?.textContent).toContain("实时更新失败")
    expect(bar?.textContent).toContain("网络断了")
    expect(container.textContent).toContain("初始")
    expect(container.querySelector('[data-testid="audit-error"]')).toBeNull() // full-page error NOT shown

    // Retry re-pulls the same window (cursor never moved) and recovers.
    await act(async () => {
      ;(container.querySelector('[data-testid="audit-live-retry"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(container.querySelector('[data-testid="audit-live-error"]')).toBeNull()
    expect(container.textContent).toContain("补上的")
    unmount(root, container)
  })
})
