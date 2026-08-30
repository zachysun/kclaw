/**
 * ChatView composer suggestion tests — the slash menu derives from the shared
 * core table filtered to the web surface (no /attach, no /exit); arrow keys
 * move the selection, Tab and clicks complete with a trailing space, Escape
 * dismisses until the draft changes, and /help opens the command panel
 * instead of being sent.
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { ChatView, availableSlashMenuMaxHeight, compactionBars, type CompactionRecordView, type Disposition } from "../../src/chat/ChatView.js"
import { initChat, type Block, type ChatState, type Message } from "../../src/chat/model.js"

/** Optional props/view overrides for the new disposition/queue scenarios. */
interface ViewOpts {
  /** Merged over initChat(messages) — runState, queue, … */
  view?: Partial<ChatState>
  disposition?: Disposition
  onSetDisposition?: (d: Disposition) => void
  onCancelQueued?: (messageId: string) => void
  onCancelAllQueued?: () => void
  onCancelCompaction?: () => void
  /** v3 压缩审计记录（GET /sessions/:id/compactions 的 UI 镜像）。 */
  compactions?: CompactionRecordView[] | null
}

function mountView(messages: Message[] = [], opts: ViewOpts = {}) {
  const onSend = vi.fn()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <ChatView
        view={{ ...initChat(messages), ...opts.view }}
        onSend={onSend}
        onResolveConfirmation={vi.fn()}
        pendingAttachments={[]}
        onRemoveAttachment={vi.fn()}
        disposition={opts.disposition}
        onSetDisposition={opts.onSetDisposition}
        onCancelQueued={opts.onCancelQueued}
        onCancelAllQueued={opts.onCancelAllQueued}
        onCancelCompaction={opts.onCancelCompaction}
        compactions={opts.compactions}
      />,
    )
  })
  const input = (): HTMLInputElement =>
    container.querySelector('input[data-testid="chat-input"]') as HTMLInputElement
  const send = async (): Promise<void> => {
    await act(async () => {
      ;(container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  return {
    container,
    root,
    onSend,
    input,
    send,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function pressKey(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
}

function menuText(container: HTMLElement): string {
  return container.querySelector('[data-testid="slash-menu"]')?.textContent ?? ""
}

describe("ChatView slash suggestions", () => {
  it("lists the web-surface commands for a bare slash, without attach/exit", () => {
    const h = mountView()
    type(h.input(), "/")
    const options = h.container.querySelectorAll('[data-testid="slash-option"]')
    expect(options).toHaveLength(8)
    const text = menuText(h.container)
    expect(text).toContain("/new")
    expect(text).toContain("/compact")
    expect(text).toContain("列出所有命令")
    expect(text).toContain("/memory")
    expect(text).not.toContain("/attach")
    expect(text).not.toContain("/exit")
    h.unmount()
  })

  it("filters by the typed prefix and hides itself for unknown words", () => {
    const h = mountView()
    type(h.input(), "/co")
    expect(h.container.querySelectorAll('[data-testid="slash-option"]')).toHaveLength(1)
    expect(menuText(h.container)).toContain("/compact")
    type(h.input(), "/zz")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("stays hidden for plain text", () => {
    const h = mountView()
    type(h.input(), "hello /")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("moves the selection with arrows and completes with Tab (trailing space, menu closes)", () => {
    const h = mountView()
    type(h.input(), "/")
    pressKey(h.input(), "ArrowDown")
    expect(h.container.querySelector('[aria-selected="true"]')?.textContent).toContain("/clear")
    pressKey(h.input(), "Tab")
    expect(h.input().value).toBe("/clear ")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("completes on click without stealing the input focus", () => {
    const h = mountView()
    type(h.input(), "/co")
    const option = h.container.querySelector('[data-testid="slash-option"]') as HTMLButtonElement
    act(() => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    })
    expect(h.input().value).toBe("/compact ")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("dismisses on Escape and reopens when the draft changes", () => {
    const h = mountView()
    type(h.input(), "/")
    pressKey(h.input(), "Escape")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    type(h.input(), "/c")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).not.toBeNull()
    h.unmount()
  })

  it("accepts the highlighted suggestion on Enter instead of submitting a half-typed word", () => {
    const h = mountView()
    type(h.input(), "/co")
    pressKey(h.input(), "Enter")
    expect(h.input().value).toBe("/compact ")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    expect(h.onSend).not.toHaveBeenCalled()
    h.unmount()
  })

  it("Enter accepts the arrow-selected candidate, not the raw draft", () => {
    const h = mountView()
    type(h.input(), "/")
    pressKey(h.input(), "ArrowDown")
    pressKey(h.input(), "Enter")
    expect(h.input().value).toBe("/clear ")
    expect(h.onSend).not.toHaveBeenCalled()
    h.unmount()
  })

  it("submits on Enter when the draft is already the complete command word", async () => {
    const h = mountView()
    type(h.input(), "/compact")
    pressKey(h.input(), "Enter")
    // Exact match must NOT be rewritten (no trailing space appended) — the
    // native form submit then runs it (jsdom does not submit on Enter, so the
    // send button stands in for the submission here).
    expect(h.input().value).toBe("/compact")
    await h.send()
    expect(h.onSend).toHaveBeenCalledWith("/compact")
    h.unmount()
  })

  it("opens the help panel for /help instead of sending", async () => {
    const h = mountView()
    type(h.input(), "/help")
    await h.send()
    expect(h.onSend).not.toHaveBeenCalled()
    const help = h.container.querySelector('[data-testid="slash-help"]')
    expect(help).not.toBeNull()
    const text = help!.textContent ?? ""
    for (const name of ["new", "clear", "sessions", "model", "readonly", "compact", "help"]) {
      expect(text).toContain(`/${name}`)
    }
    expect(text).not.toContain("/attach")
    act(() => {
      ;(h.container.querySelector('[data-testid="slash-help-close"]') as HTMLButtonElement).click()
    })
    expect(h.container.querySelector('[data-testid="slash-help"]')).toBeNull()
    h.unmount()
  })

  it("still sends plain messages through onSend", async () => {
    const h = mountView()
    type(h.input(), "hello")
    await h.send()
    expect(h.onSend).toHaveBeenCalledWith("hello")
    expect(h.input().value).toBe("")
    h.unmount()
  })
})

describe("availableSlashMenuMaxHeight", () => {
  it("keeps the full 280px cap when the composer has plenty of room above", () => {
    expect(availableSlashMenuMaxHeight(600)).toBe(280)
  })

  it("clamps to the room above the composer when it sits high in the viewport", () => {
    expect(availableSlashMenuMaxHeight(200)).toBe(200 - 6 - 8)
  })

  it("stays uncapped exactly at the boundary of 280px + gap + margin", () => {
    expect(availableSlashMenuMaxHeight(294)).toBe(280)
  })

  it("never collapses below a floor so a couple options stay reachable", () => {
    expect(availableSlashMenuMaxHeight(10)).toBe(48)
    expect(availableSlashMenuMaxHeight(0)).toBe(48)
  })

  it("accounts for a fixed top bar so the menu never slides under it", () => {
    // topBoundary = topbar bottom; menu must stay below it, not just above 0.
    expect(availableSlashMenuMaxHeight(161, 47.5)).toBe(161 - 47.5 - 6 - 8)
    expect(availableSlashMenuMaxHeight(200, 47.5)).toBe(200 - 47.5 - 6 - 8)
  })
})

describe("compacting indicator cancel button (v3 compaction.cancel)", () => {
  it("renders the cancel button inside the compacting indicator and fires onCancelCompaction on click", () => {
    const onCancelCompaction = vi.fn()
    const h = mountView([], { view: { compacting: true }, onCancelCompaction })
    const indicator = h.container.querySelector('[data-testid="compacting-indicator"]')
    expect(indicator).not.toBeNull()
    // 按钮只在指示行内渲染（指示行本身就在 compacting 条件内）。
    const btn = indicator!.querySelector('[data-testid="compaction-cancel"]') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain("取消")
    act(() => {
      btn!.click()
    })
    expect(onCancelCompaction).toHaveBeenCalledTimes(1)
    h.unmount()
  })

  it("no cancel button when not compacting (idle view)", () => {
    const h = mountView([], { onCancelCompaction: vi.fn() })
    expect(h.container.querySelector('[data-testid="compacting-indicator"]')).toBeNull()
    expect(h.container.querySelector('[data-testid="compaction-cancel"]')).toBeNull()
    h.unmount()
  })

  it("hides the cancel button for a manual compaction (user-initiated, not cancellable)", () => {
    // Important-2: cancelCompaction 不作用于 manual 压缩——manual 阶段不渲染按钮。
    // 指示行本身仍显示（"正在压缩早期对话…"对 manual 同样成立）。
    const h = mountView([], { view: { compacting: true, compactingPhase: "manual" }, onCancelCompaction: vi.fn() })
    const indicator = h.container.querySelector('[data-testid="compacting-indicator"]')
    expect(indicator).not.toBeNull()
    expect(indicator!.querySelector('[data-testid="compaction-cancel"]')).toBeNull()
    h.unmount()
  })

  it("shows the cancel button for automatic compaction phases (in-run / post-run)", () => {
    for (const phase of ["in-run", "post-run"]) {
      const h = mountView([], { view: { compacting: true, compactingPhase: phase }, onCancelCompaction: vi.fn() })
      expect(h.container.querySelector('[data-testid="compaction-cancel"]')).not.toBeNull()
      h.unmount()
    }
  })
})

describe("compact context block", () => {
  const ctxNote = (segments: number, kept: number): Block => ({
    id: `note-${segments}-${kept}-${Math.random().toString(36).slice(2, 6)}`,
    type: "note",
    kind: "compact",
    text: `早期对话已压缩为 ${segments} 段（保留最近 ${kept} 条原文；可用 session_search 检索早期细节）。摘要：\n总摘要${segments}`,
    compact: { segments, kept },
  })
  const u = (id: string, t: string, blocks: Block[] = []) =>
    ({ id, sessionId: "s1", role: "user" as const, blocks: [{ id: `${id}-b`, type: "text" as const, text: t }, ...blocks], createdAt: "2026-08-28T00:00:00.000Z" })
  const a = (id: string, t: string) =>
    ({ id, sessionId: "s1", role: "assistant" as const, blocks: [{ id: `${id}-b`, type: "text" as const, text: t }], createdAt: "2026-08-28T00:00:00.000Z" })

  it("renders the compact note as a collapsed block ABOVE the user message, not inline below", () => {
    const h = mountView([
      u("m0", "早期问题"), a("m1", "早期回答"),
      u("m2", "1 + 1 =?", [ctxNote(2, 2)]),
    ])
    const bar = h.container.querySelector('[data-testid="ctx-note"]')
    expect(bar).not.toBeNull()
    expect(bar!.textContent).toContain("已压缩为 2 段")
    expect(bar!.textContent).toContain("保留最近 2 条")
    // the summary lives inside the expandable block
    expect(bar!.textContent).toContain("总摘要2")
    // the note is not ALSO rendered inline below the message
    expect(h.container.querySelectorAll('[data-testid="blk-note"]')).toHaveLength(0)
    // the bar sits before its message bubble in document order
    const bubble = h.container.querySelector('[data-testid="msg-user"]:last-of-type')!
    expect(bar!.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    h.unmount()
  })

  it("lists the kept verbatim messages inside the expanded block", () => {
    // kept counts the user's own message (server: active.length), so two
    // preceding verbatim messages + this one = kept 3.
    const h = mountView([
      u("m0", "早期问题"), a("m1", "早期回答"),
      u("m2", "1 + 1 =?", [ctxNote(2, 3)]),
    ])
    const kept = h.container.querySelector('[data-testid="ctx-note-kept"]')
    expect(kept).not.toBeNull()
    expect(kept!.textContent).toContain("早期问题")
    expect(kept!.textContent).toContain("早期回答")
    h.unmount()
  })

  it("shows the bar once per compaction: carried notes on later messages do not repeat it", () => {
    const h = mountView([
      u("m0", "早期问题"), a("m1", "早期回答"),
      u("m2", "第一条", [ctxNote(2, 2)]), a("m3", "答一"),
      u("m4", "第二条", [ctxNote(2, 4)]), a("m5", "答二"),
    ])
    // same segment count = no new compaction → the bar appears exactly once
    expect(h.container.querySelectorAll('[data-testid="ctx-note"]')).toHaveLength(1)
    h.unmount()
  })

  it("shows a new bar when a new compaction raises the segment count", () => {
    const h = mountView([
      u("m0", "早期问题"), a("m1", "早期回答"),
      u("m2", "第一条", [ctxNote(2, 2)]), a("m3", "答一"),
      u("m4", "第二条", [ctxNote(3, 4)]), a("m5", "答二"),
    ])
    expect(h.container.querySelectorAll('[data-testid="ctx-note"]')).toHaveLength(2)
    const bars = [...h.container.querySelectorAll('[data-testid="ctx-note"]')]
    expect(bars[1]!.textContent).toContain("已压缩为 3 段")
    h.unmount()
  })
})

describe("disposition trio and queued bubbles (spec §7.1)", () => {
  const userMsg = (id: string, text: string): Message => ({
    id,
    sessionId: "s1",
    role: "user",
    blocks: [{ id: `${id}-b`, type: "text", text }],
    createdAt: "2026-08-29T00:00:00.000Z",
  })

  it("renders the disposition trio only while running; initial selection follows props", () => {
    const onSetDisposition = vi.fn()
    const h = mountView([], { view: { runState: "running" }, disposition: "wait", onSetDisposition })
    const trio = h.container.querySelector('[data-testid="disposition-trio"]')
    expect(trio).not.toBeNull()
    expect(trio!.getAttribute("role")).toBe("radiogroup")
    const checked = (d: Disposition): string | null =>
      trio!.querySelector(`[data-testid="disposition-${d}"]`)?.getAttribute("aria-checked") ?? null
    // props.disposition="wait" → wait 选中，其余未选
    expect(checked("wait")).toBe("true")
    expect(checked("steer")).toBe("false")
    expect(checked("interrupt")).toBe("false")
    // 点击可选
    act(() => {
      ;(trio!.querySelector('[data-testid="disposition-steer"]') as HTMLButtonElement).click()
    })
    expect(onSetDisposition).toHaveBeenCalledWith("steer")
    // 方向键也可（wait → 下一个是 interrupt）
    act(() => {
      trio!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
    })
    expect(onSetDisposition).toHaveBeenCalledWith("interrupt")
    h.unmount()

    // view.runState "idle" → trio 不渲染
    const idle = mountView([], { disposition: "wait", onSetDisposition })
    expect(idle.container.querySelector('[data-testid="disposition-trio"]')).toBeNull()
    idle.unmount()
  })

  it("queued messages render as list rows at the notice spot, not bubbles (Master 2026-08-30)", () => {
    // 队列 FIFO：下标序 = 发送序，先排队的渲染在上面；每行有处置标签 + 单条取消。
    const onCancelQueued = vi.fn()
    const h = mountView([], {
      view: {
        queue: [
          { messageId: "m2", disposition: "wait", text: "排队消息" },
          { messageId: "m3", disposition: "steer", text: "引导消息" },
        ],
      },
      onCancelQueued,
    })
    const rows = [...h.container.querySelectorAll('[data-testid="queue-row"]')]
    expect(rows.map((r) => r.textContent)).toEqual(["等待排队消息取消", "引导引导消息取消"])
    // 排队消息不进消息流：气泡区没有任何用户气泡。
    expect(h.container.querySelectorAll('[data-testid="msg-user"]')).toHaveLength(0)
    // 头部计数 + 全部取消
    expect(h.container.querySelector('[data-testid="queue-list"]')!.textContent).toContain("2 条排队中")
    expect(h.container.querySelector('[data-testid="queue-cancel-all"]')).not.toBeNull()
    // 单条取消带 messageId
    act(() => {
      ;(rows[0]!.querySelector('[data-testid="queue-cancel"]') as HTMLButtonElement).click()
    })
    expect(onCancelQueued).toHaveBeenCalledWith("m2")
    h.unmount()
  })

  it("interrupt row has no cancel button; wait/steer keep theirs (spec §5.6)", () => {
    const h = mountView([], {
      view: {
        queue: [
          { messageId: "m1", disposition: "interrupt", text: "插队消息" },
          { messageId: "m2", disposition: "wait", text: "排队消息" },
          { messageId: "m3", disposition: "steer", text: "引导消息" },
        ],
      },
      onCancelQueued: vi.fn(),
    })
    const row = (text: string): HTMLElement | undefined =>
      ([...h.container.querySelectorAll('[data-testid="queue-row"]')] as HTMLElement[]).find((r) => r.textContent?.includes(text))
    // interrupt：入队即伴随 abort、紧接着出队执行（spec §5.6）——无可取消窗口。
    expect(row("插队消息")!.querySelector('[data-testid="queue-cancel"]')).toBeNull()
    expect(row("插队消息")!.textContent).toContain("中断")
    // wait / steer：取消按钮在。
    expect(row("排队消息")!.querySelector('[data-testid="queue-cancel"]')).not.toBeNull()
    expect(row("引导消息")!.querySelector('[data-testid="queue-cancel"]')).not.toBeNull()
    h.unmount()
  })

  it("no queue list when the queue is empty", () => {
    const h = mountView([userMsg("m1", "正常消息")], {})
    expect(h.container.querySelector('[data-testid="queue-list"]')).toBeNull()
    expect(h.container.querySelectorAll('[data-testid="msg-user"]')).toHaveLength(1)
    h.unmount()
  })
})

describe("audit-driven collapsed context bars (v3 compactionBars)", () => {
  const ctxNote = (segments: number, kept: number): Block => ({
    id: `note-${segments}-${kept}-${Math.random().toString(36).slice(2, 6)}`,
    type: "note",
    kind: "compact",
    text: `早期对话已压缩为 ${segments} 段（保留最近 ${kept} 条原文；可用 session_search 检索早期细节）。摘要：\n总摘要${segments}`,
    compact: { segments, kept },
  })
  const u = (id: string, t: string, blocks: Block[] = []) =>
    ({ id, sessionId: "s1", role: "user" as const, blocks: [{ id: `${id}-b`, type: "text" as const, text: t }, ...blocks], createdAt: "2026-08-30T00:00:00.000Z" })
  const a = (id: string, t: string) =>
    ({ id, sessionId: "s1", role: "assistant" as const, blocks: [{ id: `${id}-b`, type: "text" as const, text: t }], createdAt: "2026-08-30T00:00:00.000Z" })
  const rec = (upto: string, segmentSummary: string): CompactionRecordView =>
    ({ upto, segmentSummary, trigger: "auto" })

  const auditBars = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="ctx-note-audit"]')] as HTMLElement[]
  const noteBars = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="ctx-note"]')] as HTMLElement[]
  /** 文档序：a 在 b 之前。 */
  const isBefore = (a: Node, b: Node): boolean =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
  /** compactionBars 吃 RenderedMessage[]——initChat 做与渲染一致的转换。 */
  const rendered = (messages: Message[]) => initChat(messages).messages

  // 组 1：纯新会话（v3，无 compact note）——每条审计记录在各自 upto 消息后渲染一条折叠条。
  it("a note-free session renders one audit bar after each record's upto message", () => {
    const messages = [
      u("m0", "问题一"), a("m1", "回答一"),
      u("m2", "问题二"), a("m3", "回答二"),
      u("m4", "问题三"), a("m5", "回答三"),
    ]
    const records = [rec("m1", "第一段：聊了环境搭建"), rec("m3", "第二段：讨论了压缩方案")]

    // 纯函数：insertIdx = upto 下标 + 1，segments = 记录序号 + 1。
    expect(compactionBars(rendered(messages), records)).toEqual([
      { key: expect.any(String), insertIdx: 2, segments: 1, summary: "第一段：聊了环境搭建" },
      { key: expect.any(String), insertIdx: 4, segments: 2, summary: "第二段：讨论了压缩方案" },
    ])

    const h = mountView(messages, { compactions: records })
    expect(auditBars(h.container)).toHaveLength(2)
    // 旧 note 路径一条都不出（纯新会话没有 note）。
    expect(noteBars(h.container)).toHaveLength(0)
    const [bar1, bar2] = auditBars(h.container)
    expect(bar1!.textContent).toContain("已压缩为 1 段")
    expect(bar1!.textContent).toContain("第一段：聊了环境搭建")
    expect(bar2!.textContent).toContain("已压缩为 2 段")
    expect(bar2!.textContent).toContain("第二段：讨论了压缩方案")
    // 位置：第一条在 m1 气泡之后、m2 气泡之前；第二条在 m3 之后、m4 之前。
    const bubbles = [...h.container.querySelectorAll('[data-testid^="msg-"]')] as HTMLElement[]
    expect(isBefore(bubbles[1]!, bar1!)).toBe(true) // m1 → bar1
    expect(isBefore(bar1!, bubbles[2]!)).toBe(true) // bar1 → m2
    expect(isBefore(bubbles[3]!, bar2!)).toBe(true) // m3 → bar2
    expect(isBefore(bar2!, bubbles[4]!)).toBe(true) // bar2 → m4
    h.unmount()
  })

  it("renders an audit bar whose upto is the LAST message (post-run compaction tail)", () => {
    const messages = [u("m0", "问题"), a("m1", "回答")]
    const h = mountView(messages, { compactions: [rec("m1", "收尾压缩的摘要")] })
    expect(auditBars(h.container)).toHaveLength(1)
    const log = h.container.querySelector('[data-testid="chat-log"]')!
    // upto 是最后一条消息 → 折叠条挂在消息流末尾（chat-log 的最后一个子节点）。
    expect(log.lastElementChild!.getAttribute("data-testid")).toBe("ctx-note-audit")
    h.unmount()
  })

  // 组 2：旧（v2）会话——note 条与记录指同一次压缩，只显示 note 条。
  it("a legacy session whose note coincides with the record shows ONLY the note bar (empty kept window)", () => {
    // kept=1（只有 note 所在消息自己）→ note 条渲染在 m2 上方，恰与记录条
    // 的插入位（m1 之后 = m2 之前）重合——同一次压缩不得出现两个折叠条。
    const messages = [
      u("m0", "早期问题"), a("m1", "早期回答"),
      u("m2", "压缩后的新话题", [ctxNote(1, 1)]), a("m3", "新回答"),
    ]
    const records = [rec("m1", "第一段：旧摘要")]
    expect(compactionBars(rendered(messages), records)).toEqual([]) // 去重后为空
    const h = mountView(messages, { compactions: records })
    expect(auditBars(h.container)).toHaveLength(0)
    expect(noteBars(h.container)).toHaveLength(1)
    expect(noteBars(h.container)[0]!.textContent).toContain("总摘要1")
    h.unmount()
  })

  it("dedup works even when the note bar sits further down (non-empty kept window)", () => {
    // v2 的 note 挂在压缩后新一轮的用户消息上，与 upto 之间隔着一个保留
    // 窗口——note 条（m4 上方）与记录条（m1 之后）位置并不重合，但指同一
    // 次压缩：记录仍须跳过。
    const messages = [
      u("m0", "早期问题"), a("m1", "早期回答"),
      u("m2", "保留一"), a("m3", "保留二"),
      u("m4", "压缩后的新话题", [ctxNote(1, 3)]), a("m5", "新回答"),
    ]
    const records = [rec("m1", "第一段：旧摘要")]
    expect(compactionBars(rendered(messages), records)).toEqual([])
    const h = mountView(messages, { compactions: records })
    expect(auditBars(h.container)).toHaveLength(0)
    expect(noteBars(h.container)).toHaveLength(1) // note 条照常
    h.unmount()
  })

  it("an old session continued under v3: the old compaction keeps its note bar, the new one gets an audit bar", () => {
    // 同一条消息流里：第 1 次压缩是 v2 时代（有 note）→ 只显 note 条；
    // 第 2 次压缩是 v3 时代（无 note）→ 审计条照常渲染。
    const messages = [
      u("m0", "早期问题"), a("m1", "早期回答"),
      u("m2", "保留一"), a("m3", "保留二"),
      u("m4", "旧时代的新话题", [ctxNote(1, 3)]), a("m5", "旧回答"),
      u("m6", "v3 时代的话题"), a("m7", "新回答"),
    ]
    const records = [rec("m1", "第一段：旧摘要"), rec("m5", "第二段：新摘要")]
    const h = mountView(messages, { compactions: records })
    expect(noteBars(h.container)).toHaveLength(1)
    expect(auditBars(h.container)).toHaveLength(1)
    expect(auditBars(h.container)[0]!.textContent).toContain("已压缩为 2 段")
    expect(auditBars(h.container)[0]!.textContent).toContain("第二段：新摘要")
    h.unmount()
  })

  // 组 3：upto 指向已删消息 → 该条丢弃（不渲染）。
  it("drops records whose upto message no longer exists", () => {
    const messages = [
      u("m0", "问题一"), a("m1", "回答一"),
      u("m2", "问题二"), a("m3", "回答二"),
    ]
    const records = [rec("m-deleted", "指向已删消息的记录"), rec("m3", "有效的记录")]
    const bars = compactionBars(rendered(messages), records)
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ insertIdx: 4, segments: 2, summary: "有效的记录" })
    const h = mountView(messages, { compactions: records })
    expect(auditBars(h.container)).toHaveLength(1)
    expect(auditBars(h.container)[0]!.textContent).toContain("有效的记录")
    h.unmount()
  })
})
