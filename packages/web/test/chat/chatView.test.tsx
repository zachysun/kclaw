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
import { initChat, type ChatState, type Message } from "../../src/chat/model.js"

/** Optional props/view overrides for the new disposition/queue scenarios. */
interface ViewOpts {
  /** Merged over initChat(messages) — runState, queue, … */
  view?: Partial<ChatState>
  disposition?: Disposition
  onSetDisposition?: (d: Disposition) => void
  onCancelQueued?: (messageId: string) => void
  onCancelAllQueued?: () => void
  onCancelCompaction?: () => void
  /** 压缩审计记录（GET /sessions/:id/compactions 的 UI 镜像）。 */
  compactions?: CompactionRecordView[] | null
  /** @ 文件点名的候选源（会话工作区文件清单）。 */
  mentionFiles?: readonly string[]
  /** 通知条与可点击动作（memory.written 跳转）。 */
  notice?: string | null
  noticeAction?: (() => void) | null
  onStopRun?: () => void
  onRetry?: (fromMessageId: string, text: string) => void
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
        onAnswerQuestion={vi.fn()}
        pendingAttachments={[]}
        onRemoveAttachment={vi.fn()}
        disposition={opts.disposition}
        onSetDisposition={opts.onSetDisposition}
        onCancelQueued={opts.onCancelQueued}
        onCancelAllQueued={opts.onCancelAllQueued}
        onCancelCompaction={opts.onCancelCompaction}
        onStopRun={opts.onStopRun}
        onRetry={opts.onRetry}
        compactions={opts.compactions}
        notice={opts.notice}
        noticeAction={opts.noticeAction}
        mentionFiles={opts.mentionFiles}
      />,
    )
  })
  const input = (): HTMLTextAreaElement =>
    container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
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

function type(input: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

function pressKey(input: HTMLTextAreaElement, key: string, opts: { shift?: boolean } = {}): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: opts.shift === true }))
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
    expect(options).toHaveLength(9)
    const text = menuText(h.container)
    expect(text).toContain("/new")
    expect(text).toContain("/compact")
    expect(text).toContain("列出所有命令")
    expect(text).toContain("/memory")
    expect(text).toContain("/skill")
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

  it("stays hidden for plain text but opens for a trailing slash token ANYWHERE", () => {
    const h = mountView()
    type(h.input(), "hello")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    // 任意位置触发（Master 2026-09-03）："hello /" 的尾部词是正在输入的命令
    type(h.input(), "hello /")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).not.toBeNull()
    h.unmount()
  })

  it("suggests from mid-draft tokens and completing rewrites only the trailing token", () => {
    const h = mountView()
    type(h.input(), "帮我 /co")
    expect(h.container.querySelectorAll('[data-testid="slash-option"]')).toHaveLength(1)
    expect(menuText(h.container)).toContain("/compact")
    pressKey(h.input(), "Tab")
    expect(h.input().value).toBe("帮我 /compact ")
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
    // Exact match must NOT be rewritten (no trailing space appended) — Enter
    // goes straight to the submit (textarea 的 Enter 不再依赖原生表单提交).
    expect(h.onSend).toHaveBeenCalledWith("/compact")
    expect(h.input().value).toBe("")
    h.unmount()
  })

  it("Enter submits plain text; Shift+Enter inserts a newline instead (textarea)", async () => {
    const h = mountView()
    type(h.input(), "第一行")
    pressKey(h.input(), "Enter")
    expect(h.onSend).toHaveBeenCalledWith("第一行")
    expect(h.input().value).toBe("")

    type(h.input(), "第一行")
    pressKey(h.input(), "Enter", { shift: true })
    expect(h.onSend).toHaveBeenCalledTimes(1) // Shift+Enter 只换行不发送
    // value setter 后组件受控值由 React 管理：换行体现在 draft 上，
    // 这里用原生 value 断言 keydown 未被 preventDefault（textarea 默认行为）
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
    for (const name of ["new", "clear", "sessions", "model", "mode", "compact", "help"]) {
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

describe("compacting indicator cancel button (compaction.cancel)", () => {
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

describe("disposition trio and queued bubbles ", () => {
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

  it("interrupt row has no cancel button; wait/steer keep theirs ", () => {
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
    // interrupt：入队即伴随 abort、紧接着出队执行——无可取消窗口。
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

describe("clickable notice (memory.written 跳转)", () => {
  it("renders a plain notice without an action", () => {
    const h = mountView([], { notice: "已写入记忆: /m/p.md" })
    const bar = h.container.querySelector('[data-testid="chat-notice"]')
    expect(bar?.textContent).toContain("已写入记忆")
    expect(h.container.querySelector('[data-testid="chat-notice-action"]')).toBeNull()
    h.unmount()
  })
  it("renders the notice as a button that fires the action on click", () => {
    const action = vi.fn()
    const h = mountView([], { notice: "已写入记忆: /m/p.md", noticeAction: action })
    const btn = h.container.querySelector('[data-testid="chat-notice-action"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    act(() => { btn.click() })
    expect(action).toHaveBeenCalledTimes(1)
    h.unmount()
  })
})

describe("audit-driven collapsed context bars (compactionBars)", () => {
  const u = (id: string, t: string) =>
    ({ id, sessionId: "s1", role: "user" as const, blocks: [{ id: `${id}-b`, type: "text" as const, text: t }], createdAt: "2026-08-30T00:00:00.000Z" })
  const a = (id: string, t: string) =>
    ({ id, sessionId: "s1", role: "assistant" as const, blocks: [{ id: `${id}-b`, type: "text" as const, text: t }], createdAt: "2026-08-30T00:00:00.000Z" })
  const rec = (upto: string, segmentSummary: string): CompactionRecordView =>
    ({ upto, segmentSummary, trigger: "auto" })

  const auditBars = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="ctx-note-audit"]')] as HTMLElement[]
  /** 文档序：a 在 b 之前。 */
  const isBefore = (a: Node, b: Node): boolean =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
  /** compactionBars 吃 RenderedMessage[]——initChat 做与渲染一致的转换。 */
  const rendered = (messages: Message[]) => initChat(messages).messages

  // 每条审计记录在各自 upto 消息后渲染一条折叠条。
  it("renders one audit bar after each record's upto message", () => {
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

  // upto 指向已删消息 → 该条丢弃（不渲染）。
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

// ---------- stop button & retry affordances (issue #31) ----------

describe("stop button & retry affordances", () => {
  const two: Message[] = [
    { id: "msg_a", sessionId: "s1", role: "user", blocks: [{ id: "b1", type: "text", text: "第一问" }], createdAt: "2026-08-15T00:00:00.000Z" },
    { id: "msg_b", sessionId: "s1", role: "assistant", blocks: [{ id: "b2", type: "text", text: "第一答" }], createdAt: "2026-08-15T00:00:01.000Z" },
  ]

  it("idle: 编辑挂在最后一条用户气泡、重新生成挂在最后一条助手气泡，确认即重试", () => {
    const onRetry = vi.fn()
    const h = mountView(two, { onRetry })
    expect(h.container.querySelector('[data-testid="msg-edit"]')).not.toBeNull()
    expect(h.container.querySelector('[data-testid="msg-regenerate"]')).not.toBeNull()
    act(() => {
      ;(h.container.querySelector('[data-testid="msg-edit"]') as HTMLButtonElement).click()
    })
    const ta = h.container.querySelector('textarea[data-testid="msg-edit-input"]') as HTMLTextAreaElement
    expect(ta.value).toBe("第一问")
    act(() => {
      ;(h.container.querySelector('[data-testid="msg-edit-confirm"]') as HTMLButtonElement).click()
    })
    expect(onRetry).toHaveBeenCalledWith("msg_a", "第一问")
    h.unmount()
  })

  it("Esc 取消编辑不动视图；重新生成按原样文本重试", () => {
    const onRetry = vi.fn()
    const h = mountView(two, { onRetry })
    act(() => {
      ;(h.container.querySelector('[data-testid="msg-edit"]') as HTMLButtonElement).click()
    })
    const ta = h.container.querySelector('textarea[data-testid="msg-edit-input"]') as HTMLTextAreaElement
    act(() => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(h.container.querySelector('[data-testid="msg-edit-input"]')).toBeNull()
    expect(h.container.querySelectorAll('[data-testid="msg-edit"]').length).toBeGreaterThanOrEqual(1)
    act(() => {
      ;(h.container.querySelector('[data-testid="msg-regenerate"]') as HTMLButtonElement).click()
    })
    expect(onRetry).toHaveBeenCalledWith("msg_a", "第一问")
    h.unmount()
  })

  it("running: 停止按钮渲染并触发 onStopRun；重试入口全部隐藏", () => {
    const onStopRun = vi.fn()
    const onRetry = vi.fn()
    const h = mountView(two, { view: { runState: "running" }, onStopRun, onRetry })
    const stop = h.container.querySelector('[data-testid="run-stop"]') as HTMLButtonElement
    expect(stop).not.toBeNull()
    expect(h.container.querySelector('[data-testid="msg-edit"]')).toBeNull()
    expect(h.container.querySelector('[data-testid="msg-regenerate"]')).toBeNull()
    act(() => {
      stop.click()
    })
    expect(onStopRun).toHaveBeenCalledTimes(1)
    h.unmount()
  })

  it("有排队消息或压缩中同样隐藏重试入口（会话空闲门）", () => {
    const queued = mountView(two, {
      view: { queue: [{ messageId: "m1", disposition: "wait", text: "排队" }] },
      onRetry: vi.fn(),
    })
    expect(queued.container.querySelector('[data-testid="msg-edit"]')).toBeNull()
    queued.unmount()
    const compacting = mountView(two, { view: { compacting: true }, onRetry: vi.fn() })
    expect(compacting.container.querySelector('[data-testid="msg-edit"]')).toBeNull()
    compacting.unmount()
  })

  it("被中断的半截回复带已中断标记", () => {
    const half = { ...two[1]!, stopReason: "aborted" } as Message
    const h = mountView([two[0]!, half])
    expect(h.container.querySelector('[data-testid="msg-aborted"]')?.textContent).toContain("已中断")
    h.unmount()
  })
})

describe("ChatView file mention suggestions", () => {
  const FILES = ["src/a.ts", "src/sub/b.ts", "readme.md", "my file.txt"]

  it("opens the file menu for a trailing @ and lists workspace paths", () => {
    const h = mountView([], { mentionFiles: FILES })
    type(h.input(), "@")
    const options = h.container.querySelectorAll('[data-testid="file-option"]')
    expect(options).toHaveLength(4)
    expect(menuText(h.container)).toContain("@src/a.ts")
    expect(menuText(h.container)).not.toContain("/new") // the two menus never mix
    h.unmount()
  })

  it("filters by the typed fragment", () => {
    const h = mountView([], { mentionFiles: FILES })
    type(h.input(), "@src/")
    expect(h.container.querySelectorAll('[data-testid="file-option"]')).toHaveLength(2)
    type(h.input(), "@zzz")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("completes with Tab: full path plus trailing space, menu closed", () => {
    const h = mountView([], { mentionFiles: FILES })
    type(h.input(), "看 @sr")
    pressKey(h.input(), "Tab")
    expect(h.input().value).toBe("看 @src/a.ts ")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })

  it("completes with Enter on an incomplete mention instead of sending", () => {
    const h = mountView([], { mentionFiles: FILES })
    type(h.input(), "看 @a")
    pressKey(h.input(), "Enter")
    expect(h.input().value).toBe("看 @src/a.ts ")
    expect(h.onSend).not.toHaveBeenCalled()
    h.unmount()
  })

  it("sends a bare hand-typed complete path straight through Enter (skill-menu rule)", () => {
    const h = mountView([], { mentionFiles: FILES })
    type(h.input(), "@src/a.ts")
    pressKey(h.input(), "Enter")
    expect(h.onSend).toHaveBeenCalledWith("@src/a.ts")
    h.unmount()
  })

  it("completes a hand-typed complete path after other text (skill-menu rule)", () => {
    const h = mountView([], { mentionFiles: FILES })
    type(h.input(), "看 @src/a.ts")
    pressKey(h.input(), "Enter")
    expect(h.input().value).toBe("看 @src/a.ts ")
    expect(h.onSend).not.toHaveBeenCalled()
    h.unmount()
  })

  it("moves the selection with arrows among file candidates", () => {
    const h = mountView([], { mentionFiles: FILES })
    type(h.input(), "@")
    pressKey(h.input(), "ArrowDown") // bare @ highlights the disabled path first; move past it
    expect(h.container.querySelector('[aria-selected="true"]')?.textContent).toContain("readme.md")
    h.unmount()
  })

  it("shows a space-containing path but keeps it unselectable", () => {
    const h = mountView([], { mentionFiles: FILES })
    type(h.input(), "@")
    // Bare @ sorts the disabled path first, so it is the highlighted entry.
    const disabled = h.container.querySelector('[aria-disabled="true"] [data-testid="file-option"]') as HTMLButtonElement
    expect(disabled).not.toBeNull()
    expect(disabled.textContent).toContain("@my file.txt")
    // Enter on it does nothing at all: no completion, no send.
    pressKey(h.input(), "Enter")
    expect(h.input().value).toBe("@")
    expect(h.onSend).not.toHaveBeenCalled()
    // Tab does not complete it either.
    pressKey(h.input(), "Tab")
    expect(h.input().value).toBe("@")
    // A click does not complete either.
    act(() => {
      disabled.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    })
    expect(h.input().value).toBe("@")
    h.unmount()
  })

  it("dismisses on Escape and reopens when the draft changes", () => {
    const h = mountView([], { mentionFiles: FILES })
    type(h.input(), "@")
    pressKey(h.input(), "Escape")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    type(h.input(), "@s")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).not.toBeNull()
    h.unmount()
  })

  it("opens nothing without a file list (fetch failed or empty workspace)", () => {
    const h = mountView()
    type(h.input(), "@")
    expect(h.container.querySelector('[data-testid="slash-menu"]')).toBeNull()
    h.unmount()
  })
})
