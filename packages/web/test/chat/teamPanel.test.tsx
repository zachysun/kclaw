/**
 * Agent team panel tests (agent-team spec §12): the TeamPanelCard component
 * (badges, board, callbacks), the ChatView integration (panel slot + the
 * "→ 组员 X" composer chip), and the ChatPanel wiring (panel fetch, targeted
 * send carrying `target` without an optimistic echo, per-member stop).
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { TeamPanelCard, type TeamPanelData } from "../../src/chat/TeamPanel.js"
import { ChatView } from "../../src/chat/ChatView.js"
import { ChatPanel } from "../../src/chat/ChatPanel.js"
import { initChat, type Message } from "../../src/chat/model.js"
import { createWsClient, type WsClient, type WsLikeSocket } from "../../src/ws.js"
import { ApiError, type ApiClient } from "../../src/api.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PANEL: TeamPanelData = {
  team: { teamId: "team_1", name: "登录攻坚", leadSessionId: "s1" },
  identity: "lead",
  members: [
    { name: "alice", status: "active", busy: true, role: "前端", model: "deepseek/deepseek-chat", sessionId: "s2", currentTask: "实现登录页" },
    { name: "bob", status: "provisioning" },
    { name: "carol", status: "failed", failReason: "模型不可用", sessionId: "s4" },
  ],
  tasks: [
    { id: 3, subject: "实现登录页", status: "in_progress", assignee: "alice", dependencies: [1], attempt: 2 },
    { id: 4, subject: "写样式", status: "pending", assignee: null, dependencies: [], attempt: 0 },
    { id: 1, subject: "拆需求", status: "completed", assignee: null, dependencies: [], attempt: 1 },
  ],
}

// ---------- TeamPanelCard ----------

function mountPanel(panel: TeamPanelData, target: string | null = null) {
  const onTalkTo = vi.fn()
  const onStopMember = vi.fn()
  const onOpenAudit = vi.fn()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TeamPanelCard panel={panel} target={target} onTalkTo={onTalkTo} onStopMember={onStopMember} onOpenAudit={onOpenAudit} />,
    )
  })
  const q = (testid: string): HTMLElement | null => container.querySelector(`[data-testid="${testid}"]`)
  const click = (el: Element | null): void => {
    act(() => { (el as HTMLButtonElement | null)?.click() })
  }
  return {
    container, q, click, onTalkTo, onStopMember, onOpenAudit,
    unmount: () => { root.unmount(); container.remove() },
  }
}

describe("TeamPanelCard", () => {
  it("renders head meta, member badges, and the board with stats", () => {
    const h = mountPanel(PANEL)
    const head = h.q("team-panel")?.textContent ?? ""
    expect(head).toContain("团队 登录攻坚")
    expect(head).toContain("3 名组员 · 1 人干活中 · 任务 1/3 完成")
    // 徽标：干活中 / 生成中 / 失败（含原因）
    const alice = h.q("team-member-card-alice")?.textContent ?? ""
    expect(alice).toContain("干活中")
    expect(alice).toContain("正在做：实现登录页")
    expect(h.q("team-member-card-bob")?.textContent).toContain("生成中")
    expect(h.q("team-member-card-carol")?.textContent).toContain("失败")
    expect(h.q("team-member-card-carol")?.textContent).toContain("模型不可用")
    // 任务板：统计 chips + 行内容（状态/认领人/尝试/依赖）
    const stats = h.q("team-board-stats")?.textContent ?? ""
    expect(stats).toContain("待办 1")
    expect(stats).toContain("进行中 1")
    expect(stats).toContain("完成 1")
    const row = h.q("team-task-row-3")?.textContent ?? ""
    expect(row).toContain("#3 实现登录页")
    expect(row).toContain("进行中 · alice · 第 2 次尝试 · 依赖 #1")
    h.unmount()
  })

  it("点选说话 fires with the member name; the lead row fires with null", () => {
    const h = mountPanel(PANEL)
    // 默认目标 = 组长；点 alice 切目标
    h.click(h.q("team-talk-alice"))
    expect(h.onTalkTo).toHaveBeenCalledWith("alice")
    // 只有 active 的组员有说话按钮：bob 生成中、carol 失败都没有
    expect(h.q("team-talk-bob")).toBeNull()
    expect(h.q("team-talk-carol")).toBeNull()
    // 点组长行切回
    h.click(h.q("team-talk-lead"))
    expect(h.onTalkTo).toHaveBeenCalledWith(null)
    h.unmount()
  })

  it("the targeted member's row is highlighted and its button reads 对话中", () => {
    const h = mountPanel(PANEL, "alice")
    expect(h.q("team-talk-alice")?.textContent).toContain("对话中")
    expect(h.q("team-member-card-alice")?.className).toContain("active")
    h.unmount()
  })

  it("stop renders only for busy members and fires with their session id; 轨迹 deep-links", () => {
    const h = mountPanel(PANEL)
    expect(h.q("team-stop-alice")).not.toBeNull()
    h.click(h.q("team-stop-alice"))
    expect(h.onStopMember).toHaveBeenCalledWith("s2")
    // bob 生成中未挂会话、carol 空闲（不 busy）→ 没有停止按钮
    expect(h.q("team-stop-bob")).toBeNull()
    expect(h.q("team-stop-carol")).toBeNull()
    h.click(h.q("team-trail") ?? h.container.querySelector(".team-trail"))
    expect(h.onOpenAudit).toHaveBeenCalledWith("s2")
    h.unmount()
  })
})

// ---------- ChatView integration: panel slot + target chip ----------

function mountChatView(team?: Parameters<typeof ChatView>[0]["team"]) {
  const onSend = vi.fn()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <ChatView
        view={initChat([])}
        onSend={onSend}
        onResolveConfirmation={vi.fn()}
        onAnswerQuestion={vi.fn()}
        pendingAttachments={[]}
        onRemoveAttachment={vi.fn()}
        team={team}
      />,
    )
  })
  return {
    container, onSend,
    q: (testid: string): HTMLElement | null => container.querySelector(`[data-testid="${testid}"]`),
    unmount: () => { root.unmount(); container.remove() },
  }
}

describe("ChatView team wiring", () => {
  it("no team prop → no panel, no chip", () => {
    const h = mountChatView(undefined)
    expect(h.q("team-panel")).toBeNull()
    expect(h.q("team-target-chip")).toBeNull()
    h.unmount()
  })

  it("renders the panel and the composer chip while a member is targeted", () => {
    const onTalkTo = vi.fn()
    const h = mountChatView({ panel: PANEL, target: "alice", onTalkTo, onStopMember: vi.fn() })
    expect(h.q("team-panel")).not.toBeNull()
    const chip = h.q("team-target-chip")
    expect(chip?.textContent).toContain("→ 组员 alice")
    act(() => { (h.q("team-target-clear") as HTMLButtonElement).click() })
    expect(onTalkTo).toHaveBeenCalledWith(null)
    h.unmount()
  })
})

// ---------- ChatPanel integration: fetch / targeted send / stop ----------

interface FakeSocket extends WsLikeSocket {
  sent: string[]
  _open: boolean
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

function makeApi(team: unknown | ApiError): ApiClient & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/team")) {
        if (team instanceof ApiError) throw team
        return team
      }
      if (path === "/skills") return []
      if (path === "/fs/files") return { files: [], truncated: false }
      if (path.endsWith("/queue")) return []
      if (path === "/config") return {}
      if (path.endsWith("/messages")) return [] satisfies Message[]
      if (path.endsWith("/compactions")) return []
      return {} // GET /sessions/:id meta
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(), del: vi.fn(), upload: vi.fn(),
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mountChatPanel(api: ApiClient, teamFixture: unknown) {
  const sockets: FakeSocket[] = []
  const createWs = (): WsClient => {
    const fake = makeFakeSocket()
    sockets.push(fake)
    return createWsClient("ws://daemon", "tok", () => fake as unknown as WsLikeSocket)
  }
  const ws = createWs()
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ChatPanel
        sessionId="s1"
        api={api}
        ws={ws}
        createWs={createWs}
        initialMessages={[]}
        onCreateSession={async () => {}}
        onOpenSessions={() => {}}
      />,
    )
  })
  // 打开 socket（订阅帧冲出）并等首轮拉取落定
  await act(async () => {
    sockets[0]!.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  void teamFixture
  const q = (testid: string): HTMLElement | null => container.querySelector(`[data-testid="${testid}"]`)
  return {
    container, sockets, q,
    frames: (): Array<Record<string, unknown>> => sockets.flatMap((s) => s.sent).map((raw) => JSON.parse(raw) as Record<string, unknown>),
    unmount: () => { root.unmount(); container.remove() },
  }
}

describe("ChatPanel team wiring", () => {
  it("拉到团队面板即渲染；普通会话（404）不渲染", async () => {
    const h = await mountChatPanel(makeApi(PANEL), PANEL)
    await flush()
    expect(h.q("team-panel")?.textContent).toContain("团队 登录攻坚")
    h.unmount()

    const h2 = await mountChatPanel(makeApi(new ApiError(404, "no team")), PANEL)
    await flush()
    expect(h2.q("team-panel")).toBeNull()
    h2.unmount()
  })

  it("点选组员后发送：帧带 target，且不做乐观回显（防与 message.created 双份）", async () => {
    const h = await mountChatPanel(makeApi(PANEL), PANEL)
    await flush()
    act(() => { (h.q("team-talk-alice") as HTMLButtonElement).click() })
    expect(h.q("team-target-chip")?.textContent).toContain("→ 组员 alice")
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(input, "帮我看看登录页")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const send = h.frames().find((f) => f.type === "send_message")
    expect(send).toMatchObject({ sessionId: "s1", text: "帮我看看登录页", target: "alice" })
    // 无乐观回显：气泡由 daemon 的 message.created 回流
    expect(h.container.querySelectorAll('[data-testid="msg-user"]')).toHaveLength(0)
    h.unmount()
  })

  it("组长路径发送：帧不带 target，保留乐观回显", async () => {
    const h = await mountChatPanel(makeApi(PANEL), PANEL)
    await flush()
    const input = h.container.querySelector('textarea[data-testid="chat-input"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!
    await act(async () => {
      setter.call(input, "继续推进")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      ;(h.container.querySelector('button[data-testid="send-button"]') as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const send = h.frames().find((f) => f.type === "send_message")
    expect(send).toMatchObject({ sessionId: "s1", text: "继续推进" })
    expect(send && "target" in send).toBe(false)
    expect(h.container.querySelectorAll('[data-testid="msg-user"]')).toHaveLength(1)
    h.unmount()
  })

  it("成员卡的停止：run.cancel 打到组员自己的会话上", async () => {
    const h = await mountChatPanel(makeApi(PANEL), PANEL)
    await flush()
    act(() => { (h.q("team-stop-alice") as HTMLButtonElement).click() })
    const cancel = h.frames().find((f) => f.type === "run.cancel")
    expect(cancel).toMatchObject({ sessionId: "s2" })
    h.unmount()
  })
})
