/**
 * Goal panel wiring tests: the ChatPanel-level glue the hook tests cannot
 * see — mount fetch + render, goal.* appended frames re-fetching the view,
 * and no-goal sessions staying blank. (The poll condition itself —
 * active && armed — is locked at the hook layer; asserting a 5s tick here
 * would need real-clock waiting.)
 */
import { describe, it, expect, vi } from "vitest"
import { createRoot } from "react-dom/client"
import { act } from "react"
import { ChatPanel } from "../../src/chat/ChatPanel.js"
import type { Message } from "../../src/chat/model.js"
import { createWsClient, type WsClient, type WsLikeSocket } from "../../src/ws.js"
import type { ApiClient } from "../../src/api.js"
import type { GoalView } from "@kclaw/core/protocol"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ACTIVE_GOAL: GoalView = {
  goal: {
    text: "修复登录 bug",
    acceptance: ["pnpm -r test"],
    state: "active",
    setAt: "2026-10-16T00:00:00.000Z",
    rounds: 2,
    totalRounds: 3,
    tokensUsed: 12_000,
  },
  derived: {
    totalRounds: 3,
    rounds: 2,
    tokensUsed: 12_000,
    noProgressStreak: 0,
    gateFailStreak: 0,
    parseFails: 0,
    transportFails: 0,
    approvalTimeoutStreak: 0,
    lastRun: undefined,
  },
  armed: true,
  limits: { maxRounds: 10, tokenBudget: 200_000 },
}

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

/** api mock serving one /goal answer; every other ChatPanel endpoint stays quiet. */
function makeApi(goal: GoalView | null): ApiClient & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/goal")) return { goal }
      if (path === "/skills") return []
      if (path === "/fs/files") return { files: [], truncated: false }
      if (path.endsWith("/queue")) return []
      if (path === "/config") return {}
      if (path.endsWith("/messages")) return [] satisfies Message[]
      if (path.endsWith("/compactions")) return []
      if (path.endsWith("/team")) throw new Error("not a team session")
      return {}
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(),
    del: vi.fn(),
    upload: vi.fn(),
  } as unknown as ApiClient & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }
}

async function mountChatPanel(api: ApiClient) {
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
  await act(async () => {
    sockets[0]!.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const q = (testid: string): HTMLElement | null => container.querySelector(`[data-testid="${testid}"]`)
  const pushFrame = (frame: Record<string, unknown>): void => {
    act(() => {
      sockets[0]!.onmessage?.({ data: JSON.stringify(frame) })
    })
  }
  const goalFetches = (): number =>
    (api.get as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) =>
      String(call[0]).endsWith("/goal"),
    ).length
  return {
    container, q, pushFrame, goalFetches,
    unmount: () => {
      root.unmount()
      container.remove()
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("ChatPanel goal wiring", () => {
  it("renders the panel for an active armed goal served on mount", async () => {
    const h = await mountChatPanel(makeApi(ACTIVE_GOAL))
    await flush()
    expect(h.q("goal-panel")).not.toBeNull()
    expect(h.q("goal-text")?.textContent).toContain("修复登录 bug")
    h.unmount()
  })

  it("stays blank when the session has no goal (goal: null)", async () => {
    const h = await mountChatPanel(makeApi(null))
    await flush()
    expect(h.q("goal-panel")).toBeNull()
    h.unmount()
  })

  it("re-fetches the view when a goal.* appended frame arrives, not for other event types", async () => {
    const h = await mountChatPanel(makeApi(ACTIVE_GOAL))
    await flush()
    const before = h.goalFetches()
    expect(before).toBeGreaterThanOrEqual(1)
    h.pushFrame({ type: "session.appended", sessionId: "s1", payload: { eventType: "goal.judged" } })
    await flush()
    expect(h.goalFetches()).toBe(before + 1)
    h.pushFrame({ type: "session.appended", sessionId: "s1", payload: { eventType: "memory.written" } })
    await flush()
    expect(h.goalFetches()).toBe(before + 1)
    h.unmount()
  })
})
