/**
 * AuditView — the trail page (轨迹页, reads the session's event stream via
 * GET /sessions + GET /sessions/:id/events). Covers the session dropdown,
 * flattening message events' blocks into one row per block (event array order
 * — the stream is append-only, oldest first, so array order is time order),
 * the one-line summary per block type, click-to-expand full content, the
 * "压缩" compaction rows, the "记忆" memory rows, the "系统提示词" system
 * rows (snippet + char count, click-to-expand full text, "已变化" badge when
 * the text differs from the previous system row), and the "暂无轨迹" empty
 * state.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import type { ApiClient } from "../../src/api.js"
import { AuditView } from "../../src/audit/AuditView.js"
import type { Message, SessionEvent, SessionMeta } from "../../src/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function session(id: string, title: string): SessionMeta {
  return { id, title, createdAt: "2026-08-19T09:00:00.000Z", updatedAt: "2026-08-19T09:00:00.000Z" }
}

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

/** A message event: `{ type: "message" } & Message`. */
function messageEvent(overrides: Partial<Message> = {}): SessionEvent {
  return { type: "message", ...message(overrides) }
}

/** A compaction event (defaults mirror core CompactionEvent). */
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

/** A memory event (defaults mirror core MemoryEvent). */
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

/** A system event (defaults mirror core SystemEvent). */
function systemEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "system",
    at: "2026-08-19T10:06:00.000Z",
    text: "你是 kclaw 助手。",
    ...overrides,
  } as unknown as SessionEvent
}

/** A sandbox.checked event (defaults mirror core SandboxCheckedEvent). */
function sandboxEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "sandbox.checked",
    at: "2026-08-19T10:07:00.000Z",
    enabled: true,
    attempted: true,
    available: true,
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

async function mount(api: ApiClient): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<AuditView api={api} />)
  })
  await act(async () => {}) // flush the GET /sessions effect
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

/** Drive a <select> through React's onChange (jsdom has no user agent). */
function selectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!
  act(() => {
    setter.call(select, value)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("AuditView (trail)", () => {
  it("loads sessions then renders flattened message blocks after selecting one", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") {
        return [session("s1", "会话1"), session("s2", "会话2")]
      }
      if (path === "/sessions/s1/events") {
        return [
          messageEvent({ id: "m1", role: "user", blocks: [{ id: "b1", type: "text", text: "你好" }], createdAt: "2026-08-19T10:00:00.000Z" }),
          messageEvent({ id: "m2", role: "assistant", blocks: [{ id: "b2", type: "text", text: "好的收到" }], createdAt: "2026-08-19T10:01:00.000Z" }),
        ]
      }
      if (path === "/sessions/s2/events") return []
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    expect(api.get).toHaveBeenCalledWith("/sessions")

    // Nothing selected yet → empty state.
    expect(container.querySelector('[data-testid="trail-empty"]')?.textContent).toContain("暂无轨迹")

    const select = container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement
    expect(select.options).toHaveLength(3) // placeholder + s1 + s2

    selectValue(select, "s1")
    await flush()

    expect(api.get).toHaveBeenCalledWith("/sessions/s1/events")
    expect(container.querySelector('[data-testid="trail-empty"]')).toBeNull()
    // One row per block (two messages × one text block each).
    expect(container.querySelectorAll('[data-testid^="trail-row-"]')).toHaveLength(2)
    expect(container.textContent).toContain("你好")
    expect(container.textContent).toContain("好的收到")
    unmount(root, container)
  })

  it("renders rows in event-array order (oldest first, newest at the bottom)", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [
          messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "早的" }], createdAt: "2026-08-19T09:00:00.000Z" }),
          messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "晚的" }], createdAt: "2026-08-19T11:00:00.000Z" }),
        ]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    const rows = Array.from(container.querySelectorAll('[data-testid^="trail-row-"]'))
    const texts = rows.map((r) => r.textContent ?? "")
    expect(texts[0]).toContain("早的")
    expect(texts[1]).toContain("晚的")
    unmount(root, container)
  })

  it("flattens multiple blocks of one message into separate rows", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [
          messageEvent({
            id: "m1",
            blocks: [
              { id: "b1", type: "text", text: "正文" },
              { id: "b2", type: "tool_call", callId: "c1", name: "fs.read", args: { path: "/a" }, argsJson: JSON.stringify({ path: "/a" }) },
              { id: "b3", type: "tool_result", callId: "c1", status: "ok", output: "file contents", durationMs: 12 },
              { id: "b4", type: "note", kind: "system", text: "系统提示" },
            ],
          }),
        ]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    expect(container.querySelectorAll('[data-testid^="trail-row-"]')).toHaveLength(4)
    expect(container.textContent).toContain("正文")
    // tool_call summary: name + args summary
    expect(container.textContent).toContain("fs.read")
    expect(container.textContent).toContain('{"path":"/a"}')
    // tool_result summary: output
    expect(container.textContent).toContain("file contents")
    // note summary: text
    expect(container.textContent).toContain("系统提示")
    unmount(root, container)
  })

  it("shows the grant reason (grantedBy) on tool_call and tool_result rows", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [
          messageEvent({
            id: "m1",
            role: "assistant",
            blocks: [
              { id: "b1", type: "tool_call", callId: "c1", name: "fs.read", args: { path: "/a" }, argsJson: JSON.stringify({ path: "/a" }) },
            ],
            createdAt: "2026-08-19T10:00:00.000Z",
          }),
          // The tool message carries the message-level grantedBy map, keyed by callId.
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
        ]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    // The grant reason renders on both the tool_call row and the tool_result row,
    // resolved by callId across the assistant + tool messages.
    const grants = Array.from(container.querySelectorAll('[data-testid^="trail-grant-"]'))
    expect(grants).toHaveLength(2)
    for (const grant of grants) {
      expect(grant.textContent).toContain("whitelist")
    }
    unmount(root, container)
  })

  it("expands a row on click to reveal the full block content", async () => {
    const longText = "A".repeat(120)
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: longText }] })]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    // Collapsed: full content not present, only the 80-char summary.
    expect(container.querySelector('[data-testid="trail-full-m1-0"]')).toBeNull()

    await act(async () => {
      ;(container.querySelector('button[data-testid="trail-row-m1-0"]') as HTMLButtonElement).click()
    })

    const full = container.querySelector('[data-testid="trail-full-m1-0"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain(longText)
    unmount(root, container)
  })

  it("renders message, compaction, and memory events in stream order in one trail", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        // Stream order: session.created → message → compaction → memory.
        return [
          { type: "session.created", at: "2026-08-19T09:00:00.000Z", title: "会话1" },
          messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "第一条" }], createdAt: "2026-08-19T10:00:00.000Z" }),
          compactionEvent({ at: "2026-08-19T10:01:30.000Z", from: "m1", upto: "m1", messages: 1 }),
          memoryEvent(),
        ]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    // All three row kinds sit inside the single trail list, in stream order;
    // the session.created metadata event renders nothing.
    const list = container.querySelector('[data-testid="trail-list"]')!
    const rowIds = Array.from(list.querySelectorAll("button[data-testid]")).map((el) => el.getAttribute("data-testid"))
    expect(rowIds).toEqual(["trail-row-m1-0", "compaction-row-cp-0", "memory-row-mem-0"])
    expect(container.textContent).toContain("第一条")
    unmount(root, container)
  })

  it("renders memory events as 记忆 rows with a trigger/kind/op/target summary", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") return [memoryEvent()]
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    const row = container.querySelector('[data-testid="memory-row-mem-0"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain("记忆")
    // summary carries trigger · kind · op · target (topic / file)
    expect(row!.textContent).toContain("interval")
    expect(row!.textContent).toContain("episode")
    expect(row!.textContent).toContain("append")
    expect(row!.textContent).toContain("kclaw 会话持久化")
    expect(row!.textContent).toContain("memory/episodes.md")

    // Collapsed: full detail not shown yet.
    expect(container.querySelector('[data-testid="memory-full-mem-0"]')).toBeNull()

    // Click-to-expand reveals the full field dump.
    await act(async () => {
      ;(container.querySelector('button[data-testid="memory-row-mem-0"]') as HTMLButtonElement).click()
    })
    const full = container.querySelector('[data-testid="memory-full-mem-0"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain("trigger: interval")
    expect(full!.textContent).toContain("topic: kclaw 会话持久化")
    unmount(root, container)
  })

  it("inserts compaction rows into the trail at the time they happened", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [
          messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "第一条" }], createdAt: "2026-08-19T10:00:00.000Z" }),
          messageEvent({ id: "m2", blocks: [{ id: "b2", type: "text", text: "第二条" }], createdAt: "2026-08-19T10:01:00.000Z" }),
          compactionEvent({ at: "2026-08-19T10:01:30.000Z", from: "m1", upto: "m2", messages: 2 }),
          messageEvent({ id: "m3", blocks: [{ id: "b3", type: "text", text: "第三条" }], createdAt: "2026-08-19T10:02:00.000Z" }),
        ]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    // No standalone "压缩记录" section above the trail anymore.
    expect(container.querySelector('[data-testid="compactions-section"]')).toBeNull()

    // The compaction sits between m2 and m3 inside the single trail list,
    // not pinned to the top.
    const list = container.querySelector('[data-testid="trail-list"]')!
    const rowIds = Array.from(list.querySelectorAll("button[data-testid]")).map((el) => el.getAttribute("data-testid"))
    expect(rowIds).toEqual(["trail-row-m1-0", "trail-row-m2-0", "compaction-row-cp-0", "trail-row-m3-0"])

    // Click-to-expand still shows the segment + top summaries.
    await act(async () => {
      ;(list.querySelector('button[data-testid="compaction-row-cp-0"]') as HTMLButtonElement).click()
    })
    const full = container.querySelector('[data-testid="compaction-full-cp-0"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain("段摘要内容")
    expect(full!.textContent).toContain("总摘要内容")
    unmount(root, container)
  })

  it("labels compaction rows by trigger (收尾/运行中/手动) and appends 超限急救", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [
          compactionEvent({ trigger: "auto" }),
          compactionEvent({ trigger: "in-run", at: "2026-08-19T10:02:30.000Z" }),
          compactionEvent({ trigger: "manual", focus: "api 设计", at: "2026-08-19T10:03:30.000Z" }),
          compactionEvent({ trigger: "auto", emergency: true, at: "2026-08-19T10:04:30.000Z" }),
        ]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    const summary = (i: number): string =>
      container.querySelector(`[data-testid="compaction-row-cp-${i}"]`)?.textContent ?? ""
    // auto → 收尾, in-run → 运行中, manual → 手动（focus）现状不变。
    expect(summary(0)).toContain("自动（收尾）")
    expect(summary(1)).toContain("自动（运行中）")
    expect(summary(2)).toContain("手动（api 设计）")
    // emergency 追加在 trigger 标签之后。
    expect(summary(3)).toContain("自动（收尾）·超限急救")
    unmount(root, container)
  })

  it("renders system events as 系统提示词 rows with a truncated snippet and char count", async () => {
    const longText = "系统提示词全文".repeat(30) // 210 chars, no whitespace runs
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") return [systemEvent({ text: longText })]
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    const row = container.querySelector('[data-testid="system-row-sys-0"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain("系统提示词")
    // Collapsed summary: first ~60 chars + ellipsis + total char count.
    expect(row!.textContent).toContain(longText.slice(0, 60))
    expect(row!.textContent).toContain("…")
    expect(row!.textContent).not.toContain(longText)
    expect(row!.textContent).toContain(`· ${longText.length} 字`)
    // Collapsed: the full text is not rendered yet.
    expect(container.querySelector('[data-testid="system-full-sys-0"]')).toBeNull()
    unmount(root, container)
  })

  it("shows short system text (≤60 chars) in full without ellipsis", async () => {
    const shortText = "你是 kclaw 助手，遵守仓库规则。"
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") return [systemEvent({ text: shortText })]
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    const row = container.querySelector('[data-testid="system-row-sys-0"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain(shortText)
    expect(row!.textContent).not.toContain("…")
    unmount(root, container)
  })

  it("does not badge the first system row of a session", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") return [systemEvent()]
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    expect(container.querySelector('[data-testid="system-changed-sys-0"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid^="system-changed-"]')).toHaveLength(0)
    unmount(root, container)
  })

  it("shows no 已变化 badge when consecutive system rows carry identical text", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [
          systemEvent({ at: "2026-08-19T10:06:00.000Z" }),
          systemEvent({ at: "2026-08-19T11:06:00.000Z" }),
        ]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    expect(container.querySelectorAll('[data-testid^="system-changed-"]')).toHaveLength(0)
    unmount(root, container)
  })

  it("badges a system row 已变化 when its text differs from the previous system row", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [
          systemEvent({ text: "第一版系统提示词", at: "2026-08-19T10:06:00.000Z" }),
          systemEvent({ text: "第二版系统提示词", at: "2026-08-19T11:06:00.000Z" }),
        ]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    expect(container.querySelector('[data-testid="system-changed-sys-0"]')).toBeNull()
    const badge = container.querySelector('[data-testid="system-changed-sys-1"]')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toContain("已变化")
    unmount(root, container)
  })

  it("compares adjacent system rows across interleaved message rows", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [
          systemEvent({ text: "第一版系统提示词", at: "2026-08-19T10:06:00.000Z" }),
          messageEvent({ id: "m1", blocks: [{ id: "b1", type: "text", text: "中间的对话" }], createdAt: "2026-08-19T10:07:00.000Z" }),
          systemEvent({ text: "第二版系统提示词", at: "2026-08-19T11:06:00.000Z" }),
        ]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    expect(container.querySelector('[data-testid="system-changed-sys-0"]')).toBeNull()
    expect(container.querySelector('[data-testid="system-changed-sys-1"]')).not.toBeNull()
    unmount(root, container)
  })

  it("keeps session metadata events skipped while rendering the system row", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        // Stream order: session.created → system → session.renamed/set/deleted/restored.
        return [
          { type: "session.created", at: "2026-08-19T09:00:00.000Z", title: "会话1" },
          systemEvent(),
          { type: "session.renamed", at: "2026-08-19T10:10:00.000Z", title: "改名" },
          { type: "session.set", at: "2026-08-19T10:11:00.000Z", model: "m" },
          { type: "session.deleted", at: "2026-08-19T10:12:00.000Z" },
          { type: "session.restored", at: "2026-08-19T10:13:00.000Z" },
        ] as SessionEvent[]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    const list = container.querySelector('[data-testid="trail-list"]')!
    const rowIds = Array.from(list.querySelectorAll("button[data-testid]")).map((el) => el.getAttribute("data-testid"))
    expect(rowIds).toEqual(["system-row-sys-0"])
    unmount(root, container)
  })

  it("expands a system row on click to reveal the full prompt text", async () => {
    const longText = "系统提示词全文".repeat(30)
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") return [systemEvent({ text: longText })]
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    await act(async () => {
      ;(container.querySelector('button[data-testid="system-row-sys-0"]') as HTMLButtonElement).click()
    })

    const full = container.querySelector('[data-testid="system-full-sys-0"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain(longText)
    unmount(root, container)
  })

  it("shows the empty state when the selected session has no events", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") return []
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    expect(container.querySelector('[data-testid="trail-empty"]')?.textContent).toContain("暂无轨迹")
    unmount(root, container)
  })

  it("renders a sandbox.checked event as a 沙箱 row: available", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") return [sandboxEvent()]
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    const row = container.querySelector('[data-testid="sandbox-row-sb-0"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain("沙箱")
    expect(row!.textContent).toContain("可用")
    // Collapsed: the raw fields are not rendered.
    expect(container.querySelector('[data-testid="sandbox-full-sb-0"]')).toBeNull()
    unmount(root, container)
  })

  it("renders an unavailable sandbox row with the reason", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [sandboxEvent({ available: false, unavailableReason: "bwrap not found on PATH" })]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    const row = container.querySelector('[data-testid="sandbox-row-sb-0"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain("不可用")
    expect(row!.textContent).toContain("bwrap not found on PATH")
    unmount(root, container)
  })

  it("renders a disabled sandbox row as 已关闭 and expands to the raw fields", async () => {
    const api = makeApi()
    api.get.mockImplementation(async (path: string) => {
      if (path === "/sessions") return [session("s1", "会话1")]
      if (path === "/sessions/s1/events") {
        return [sandboxEvent({ enabled: false, attempted: false, available: false })]
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = await mount(api)
    selectValue(container.querySelector('[data-testid="trail-session-select"]') as HTMLSelectElement, "s1")
    await flush()

    const row = container.querySelector('[data-testid="sandbox-row-sb-0"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain("已关闭")

    await act(async () => {
      ;(container.querySelector('button[data-testid="sandbox-row-sb-0"]') as HTMLButtonElement).click()
    })
    const full = container.querySelector('[data-testid="sandbox-full-sb-0"]')
    expect(full).not.toBeNull()
    expect(full!.textContent).toContain("enabled: false")
    expect(full!.textContent).toContain("attempted: false")
    expect(full!.textContent).toContain("available: false")
    unmount(root, container)
  })
})
