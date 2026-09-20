/**
 * Feishu channel integration (#45): a REAL RunManager + SessionStore under a
 * temp home, a FAKE transport (the only seam), scripted LLMs. Assertions see
 * only what crosses the transport — cards sent, stream calls, replies — never
 * channel internals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus, SessionStore, loadConfig, resolvePaths, makeEvent } from "@kclaw/core"
import type {
  AgentEvent, KclawConfig, KclawPaths, LlmClient, LlmStreamEvent, MemorySystem, ToolExecutor,
} from "@kclaw/core"
import { RunManager } from "../../src/run.js"
import { createFeishuChannel } from "../../src/feishu/channel.js"
import type { FeishuChannel } from "../../src/feishu/channel.js"
import type { FeishuConfig } from "../../src/feishu/config.js"
import type { FeishuTransport, OutboundCard, TransportHandlers } from "../../src/feishu/transport.js"

// --- fixtures ---------------------------------------------------------------

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class FakeTransport implements FeishuTransport {
  handlers?: TransportHandlers
  started = false
  stopped = false
  reactions: string[] = []
  replies: Array<{ openId: string; text: string }> = []
  cards: Array<{ openId: string; card: OutboundCard }> = []
  cardUpdates: Array<{ cardId: string; card: OutboundCard }> = []
  streams: Array<{ openId: string; initial: string; cardId: string }> = []
  appends: Array<{ cardId: string; text: string }> = []
  finishes: Array<{ cardId: string; markdown: string }> = []
  #nextCardId = 0

  async start(h: TransportHandlers): Promise<void> { this.handlers = h; this.started = true }
  async stop(): Promise<void> { this.stopped = true }
  async reactTyping(messageId: string): Promise<void> { this.reactions.push(messageId) }
  async replyText(openId: string, text: string): Promise<void> { this.replies.push({ openId, text }) }
  async sendCard(openId: string, card: OutboundCard): Promise<string> {
    const id = `card_${++this.#nextCardId}`
    this.cards.push({ openId, card })
    return id
  }
  async updateCard(cardId: string, card: OutboundCard): Promise<void> { this.cardUpdates.push({ cardId, card }) }
  async startStream(openId: string, initial: string): Promise<string> {
    const id = `stream_${++this.#nextCardId}`
    this.streams.push({ openId, initial, cardId: id })
    return id
  }
  async appendStream(cardId: string, text: string): Promise<void> { this.appends.push({ cardId, text }) }
  async finishStream(cardId: string, markdown: string): Promise<void> { this.finishes.push({ cardId, markdown }) }

  /** Test-side triggers (the SDK would call these from its event loop). */
  inbound(openId: string, text: string): void {
    this.handlers!.onMessage({ openId, messageId: `m_${this.reactions.length + 1}`, text })
  }
  cardAction(openId: string, value: string): void {
    this.handlers!.onCardAction({ openId, value })
  }
}

const CONFIG: FeishuConfig = {
  enabled: true, appId: "cli_test", appSecret: "k",
  allowlist: ["ou_master"], primaryOpenId: "ou_master",
}

interface ChannelEnv {
  home: string
  config: KclawConfig
  sessions: SessionStore
  bus: EventBus
  manager: RunManager
  allEvents: AgentEvent[]
  transport: FakeTransport
  channel: FeishuChannel
}

function textTurn(text: string): LlmStreamEvent[] {
  return [
    { type: "text_delta", delta: text },
    { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

function execTurn(callId: string, command: string): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name: "exec" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ command }) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

function makeMemoryFake(): MemorySystem {
  return {
    searchEpisodes: vi.fn(async () => []),
    searchAll: vi.fn(async () => []),
    triggerImmediate: vi.fn(async () => undefined),
    triggerManual: vi.fn(async () => undefined),
    triggerClear: vi.fn(async () => undefined),
    triggerInterval: vi.fn(async () => undefined),
    triggerFollow: vi.fn(async () => undefined),
    triggerNightly: vi.fn(async () => undefined),
    consolidate: vi.fn(async () => undefined),
    recentSessionId: vi.fn(() => undefined),
    cognitionPrompt: () => "",
    scheduleFollowCheck: vi.fn(() => undefined),
  } as unknown as MemorySystem

}

async function makeEnv(llm: LlmClient): Promise<ChannelEnv> {
  const home = mkdtempSync(join(tmpdir(), "kclaw-feishu-ch-"))
  const workspace = mkdtempSync(join(tmpdir(), "kclaw-feishu-ws-"))
  dirs.push(home, workspace)

  const paths: KclawPaths = resolvePaths(home)
  const config = loadConfig(paths)
  config.workspace = workspace
  config.sandbox = { enabled: false, writeRoots: [] }
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }

  const sessions = new SessionStore(paths.sessionsDir)
  const bus = new EventBus()
  const allEvents: AgentEvent[] = []
  const realEmit = bus.emit.bind(bus)
  bus.emit = (e: AgentEvent) => { allEvents.push(e); realEmit(e) }

  const manager = new RunManager({
    config, paths, sessions,
    memory: makeMemoryFake(), bus, llm, workspace,
  })

  const transport = new FakeTransport()
  const channel = createFeishuChannel({
    transport, config: CONFIG, run: manager, sessions, bus, home,
    log: () => undefined,
  })
  await channel.start()
  return { home, config, sessions, bus, manager, allEvents, transport, channel }
}

async function until(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const mainMessages = (env: ChannelEnv): string[] =>
  env.sessions.list().filter((m) => m.parentSessionId === undefined).map((m) => m.id)

// --- tests ------------------------------------------------------------------

describe("feishu channel", () => {
  let env: ChannelEnv
  let llmQueue: LlmStreamEvent[][]
  beforeEach(() => { llmQueue = [] })
  afterEach(async () => { await env.channel.stop() })

  const makeScriptedEnv = async (): Promise<ChannelEnv> => {
    let i = 0
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield* llmQueue[Math.min(i++, llmQueue.length - 1)] ?? textTurn("(空)")
      },
    }
    env = await makeEnv(llm)
    return env
  }

  it("silently ignores senders outside the allowlist", async () => {
    env = await makeScriptedEnv()
    env.transport.inbound("ou_stranger", "你好")
    await new Promise((r) => setTimeout(r, 50))
    expect(mainMessages(env)).toHaveLength(0)
    expect(env.transport.reactions).toHaveLength(0)
    expect(env.transport.cards).toHaveLength(0)
    expect(env.transport.replies).toHaveLength(0)
  })

  it("records rejected senders (message and card action) for the admin page, still silent", async () => {
    env = await makeScriptedEnv()

    env.transport.inbound("ou_stranger", "你好")
    await new Promise((r) => setTimeout(r, 20))
    env.transport.inbound("ou_stranger", "再试一次")
    env.transport.cardAction("ou_other", "confirm:x")
    await new Promise((r) => setTimeout(r, 20))

    const recorded = env.channel.pendingSenders()
    // 顺序不断言：两条记录可能落进同一毫秒，稳定排序的先后就不定；
    // “最新在前”的排序归 normalizePendingSenders 自己的测试管（离散时间戳）
    expect([...recorded.map((p) => p.openId)].sort()).toEqual(["ou_other", "ou_stranger"])
    const stranger = recorded.find((p) => p.openId === "ou_stranger")!
    expect(stranger.count).toBe(2)
    expect(stranger.lastSeen).toBeGreaterThan(0)

    // Persisted for the admin page across restarts, alongside bindings.
    const state = JSON.parse(readFileSync(join(env.home, "feishu-state.json"), "utf8")) as {
      pendingSenders: Array<{ openId: string; count: number }>
    }
    expect(state.pendingSenders).toContainEqual(expect.objectContaining({ openId: "ou_stranger", count: 2 }))

    // Silence is untouched: no reply, no reaction, no card, no submit.
    expect(env.transport.replies).toHaveLength(0)
    expect(env.transport.reactions).toHaveLength(0)
    expect(env.transport.cards).toHaveLength(0)
    expect(mainMessages(env)).toHaveLength(0)

    // Clearing (after allowlisting) removes it and persists the removal.
    env.channel.clearPendingSender("ou_stranger")
    expect(env.channel.pendingSenders().map((p) => p.openId)).toEqual(["ou_other"])
    const after = JSON.parse(readFileSync(join(env.home, "feishu-state.json"), "utf8")) as {
      pendingSenders: Array<{ openId: string }>
    }
    expect(after.pendingSenders.map((p) => p.openId)).toEqual(["ou_other"])

    // After stop, a late transport callback must not touch the state file
    // (it would overwrite the next channel's bindings with stale memory).
    const stateBefore = readFileSync(join(env.home, "feishu-state.json"), "utf8")
    await env.channel.stop()
    env.transport.inbound("ou_late", "迟到消息")
    await new Promise((r) => setTimeout(r, 20))
    expect(env.channel.pendingSenders().map((p) => p.openId)).toEqual(["ou_other"])
    expect(readFileSync(join(env.home, "feishu-state.json"), "utf8")).toBe(stateBefore)
  })

  it("allowlisted senders never enter the pending list", async () => {
    llmQueue.push(textTurn("回复"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "你好")
    await until(() => env.transport.finishes.length > 0, "run settled")
    expect(env.channel.pendingSenders()).toEqual([])
  })

  it("binds a persistent session on first message and mirrors the run as cards", async () => {
    llmQueue.push(textTurn("回复正文"))
    env = await makeScriptedEnv()

    env.transport.inbound("ou_master", "你好")
    await until(() => !readNonChildBusy(env), "run settled")
    await until(() => env.transport.finishes.length > 0, "final card")

    // One top-level session was created and titled after the channel.
    const ids = mainMessages(env)
    expect(ids).toHaveLength(1)
    expect(env.sessions.meta(ids[0]!)!.title).toContain("飞书")

    // Receipt + card sequence: thinking → stream → final.
    expect(env.transport.reactions).toHaveLength(1)
    expect(env.transport.cards.map((c) => c.card.kind)).toEqual(["thinking"])
    expect(env.transport.streams).toHaveLength(1)
    expect(env.transport.appends.map((a) => a.text)).toContain("回复正文")
    expect(env.transport.finishes[0]!.markdown).toContain("回复正文")

    // The binding persists (0600) so a restart reuses the session.
    const statePath = join(env.home, "feishu-state.json")
    expect(existsSync(statePath)).toBe(true)
    expect(statSync(statePath).mode & 0o777).toBe(0o600)
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { bindings: Record<string, string> }
    expect(state.bindings["ou_master"]).toBe(ids[0])
  })

  it("reuses the bound session after a restart (new channel, same home)", async () => {
    llmQueue.push(textTurn("第一轮"), textTurn("第二轮"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "一")
    await until(() => env.transport.finishes.length > 0, "first run")

    // A fresh channel over the same home = the daemon-restart shape.
    const transport2 = new FakeTransport()
    const channel2 = createFeishuChannel({
      transport: transport2, config: CONFIG, run: env.manager, sessions: env.sessions,
      bus: env.bus, home: env.home, log: () => undefined,
    })
    await channel2.start()
    transport2.inbound("ou_master", "二")
    await until(() => transport2.finishes.length > 0, "second run")
    await channel2.stop()

    expect(mainMessages(env)).toHaveLength(1)
  })

  it("settles in-flight run cards with an interrupted final when the channel stops", async () => {
    const gate: { open?: () => void } = {}
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        await new Promise<void>((resolve) => { gate.open = resolve })
        yield* textTurn("不该到达")
      },
    }
    env = await makeEnv(llm)
    env.transport.inbound("ou_master", "长任务")
    await until(() => env.transport.cards.some((c) => c.card.kind === "thinking"), "thinking card")
    // sendCard 已返回卡片 id（视图登记是它的 .then 微任务），等它落地再停
    await new Promise((r) => setTimeout(r, 20))
    await until(() => readNonChildBusy(env), "run active")

    await env.channel.stop()

    // 卡片拿到诚实的终稿，而不是永远停在「思考中…」；无流卡 → 走 updateCard
    await until(() => env.transport.cardUpdates.length > 0, "interrupted final")
    const final = env.transport.cardUpdates[0]!
    expect(final.card.kind).toBe("complete")
    expect((final.card as Extract<OutboundCard, { kind: "complete" }>).markdown).toContain("WebUI")
    expect(env.transport.finishes).toHaveLength(0)

    // 收尾：放行挂着的 run（结果不再镜像），让会话落回空闲
    gate.open!()
    await until(() => !readNonChildBusy(env), "run settled")
  })

  it("rebinds when the bound session is soft-deleted mid-flight", async () => {
    llmQueue.push(textTurn("旧会话"), textTurn("新会话"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "一")
    await until(() => env.transport.finishes.length > 0, "first run")
    const boundId = mainMessages(env)[0]!

    // User deletes the bound session in the WebUI (soft delete) without
    // restarting the daemon — the next message must NOT run in the recycle bin.
    env.sessions.delete(boundId)

    env.transport.inbound("ou_master", "二")
    await until(() => env.transport.finishes.length >= 2, "second run")
    const live = mainMessages(env)
    expect(live).toHaveLength(1)
    expect(live[0]).not.toBe(boundId)
    // The second reply must have landed in the fresh session.
    const freshMsgs = env.sessions.readMessages(live[0]!).map((m: { blocks: Array<{ type: string; text?: string }> }) =>
      m.blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
    )
    expect(freshMsgs.some((t: string) => t.includes("新会话"))).toBe(true)
  })

  it("replies with the refusal reason when the queue is full", { timeout: 20_000 }, async () => {
    // Pre-created deferred: release() must work even if it fires before the
    // first stream() call assigns its await side.
    let release!: () => void
    const gated = new Promise<void>((r) => { release = r })
    // Hold an active run so every further message queues; then fill the queue.
    let held = 0
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        held++
        if (held === 1) await gated
        yield* textTurn("占位")
      },
    }
    env = await makeEnv(llm)
    env.transport.inbound("ou_master", "占住")
    await until(() => env.manager.busy(topSessionId(env)), "run active")
    // QUEUE_LIMIT=10: the 11th submit hits `queue >= 10` and is refused.
    for (let i = 0; i < 11; i++) env.transport.inbound("ou_master", `排队${i}`)
    await until(() => env.transport.replies.some((r) => r.text.includes("消息未受理") && r.text.includes("队列已满")), "refusal receipt")
    release()
    await until(() => !env.manager.busy(topSessionId(env)), "session idle")
  })

  it("runs consecutive messages strictly in sent order (busy → wait queue)", async () => {
    llmQueue.push(textTurn("答一"), textTurn("答二"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "一")
    env.transport.inbound("ou_master", "二")
    await until(() => env.transport.finishes.length >= 2, "both runs settled")

    const started: number[] = []
    const completed: number[] = []
    for (const [idx, e] of env.allEvents.entries()) {
      if (e.sessionId !== undefined && e.type === "run.started") started.push(idx)
      if (e.sessionId !== undefined && e.type === "run.completed") completed.push(idx)
    }
    expect(started).toHaveLength(2)
    expect(completed).toHaveLength(2)
    // FIFO: the second run starts only after the first completed.
    expect(started[1]!).toBeGreaterThan(completed[0]!)
  })

  it("answers /help with the help card and starts no run", async () => {
    llmQueue.push(textTurn("不该被调用"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "/help")
    await until(() => env.transport.cards.some((c) => c.card.kind === "help"), "help card")
    expect(env.allEvents.filter((e) => e.type === "run.started")).toHaveLength(0)
  })

  it("/stop aborts the active run and reports the dropped counts", async () => {
    const gate: { open?: () => void } = {}
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        await new Promise<void>((resolve) => { gate.open = resolve })
        yield* textTurn("不该到达")
      },
    }
    env = await makeEnv(llm)
    env.transport.inbound("ou_master", "长任务")
    await until(() => env.manager.busy(topSessionId(env)), "run active")

    env.transport.inbound("ou_master", "/stop")
    await until(() => env.transport.replies.some((r) => r.text.includes("已停止")), "stop receipt")
    await until(() => !env.manager.busy(topSessionId(env)), "session idle")
    expect(env.transport.replies[0]!.text).toContain("已停止")
  })

  it("/new rotates to a fresh session and keeps the old one", async () => {
    llmQueue.push(textTurn("旧会话的回答"), textTurn("新会话的回答"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "旧消息")
    await until(() => env.transport.finishes.length > 0, "first run")

    env.transport.inbound("ou_master", "/new")
    await until(() => env.transport.replies.some((r) => r.text.includes("新会话")), "new-session receipt")

    env.transport.inbound("ou_master", "新消息")
    await until(() => env.transport.finishes.length >= 2, "second run")
    expect(mainMessages(env)).toHaveLength(2)
  })

  it("delivers permission confirmations as approval cards and resolves them", async () => {
    llmQueue.push(execTurn("c1", "echo hi"), textTurn("批准后继续"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "跑个命令")

    await until(() => env.transport.cards.some((c) => c.card.kind === "approval"), "approval card")
    const approval = env.transport.cards.find((c) => c.card.kind === "approval")!
      .card as Extract<OutboundCard, { kind: "approval" }>
    expect(approval.toolName).toBe("exec")

    env.transport.cardAction("ou_master", `confirm:${approval.confirmationId}`)
    await until(() => env.transport.finishes.length > 0, "run finished after approval")
    const settled = env.transport.cardUpdates.map((u) => u.card)
      .find((c): c is Extract<OutboundCard, { kind: "approval-settled" }> => c.kind === "approval-settled")
    expect(settled?.outcome).toBe("approved")
  })

  it("rejecting the approval card rejects the tool call", async () => {
    llmQueue.push(execTurn("c1", "echo hi"), textTurn("拒绝后继续"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "跑个命令")
    await until(() => env.transport.cards.some((c) => c.card.kind === "approval"), "approval card")
    const approval = env.transport.cards.find((c) => c.card.kind === "approval")!
      .card as Extract<OutboundCard, { kind: "approval" }>

    env.transport.cardAction("ou_master", `reject:${approval.confirmationId}`)
    await until(() => env.transport.finishes.length > 0, "run finished after rejection")
    const settled = env.transport.cardUpdates.map((u) => u.card)
      .find((c): c is Extract<OutboundCard, { kind: "approval-settled" }> => c.kind === "approval-settled")
    expect(settled?.outcome).toBe("rejected")
  })

  it("marks the card invalid when the confirmation settled elsewhere first", async () => {
    llmQueue.push(execTurn("c1", "echo hi"), textTurn("继续"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "跑个命令")
    await until(() => env.transport.cards.some((c) => c.card.kind === "approval"), "approval card")
    const approval = env.transport.cards.find((c) => c.card.kind === "approval")!
      .card as Extract<OutboundCard, { kind: "approval" }>

    // 另一处（如 WebUI）先把这条确认裁决掉：broker 里它已不存在
    expect(env.manager.broker.resolve(approval.confirmationId, "reject", "cli")).toBe(true)

    // 再按我们的卡片按钮：broker 拒绝（unknown）→ 卡片标记为已失效
    env.transport.cardAction("ou_master", `confirm:${approval.confirmationId}`)
    await until(() => env.transport.cardUpdates.some((u) =>
      u.card.kind === "approval-settled" && u.card.outcome === "invalid"), "invalid marking")
  })

  it("approval cards survive a hot restart: the click still resolves", async () => {
    llmQueue.push(execTurn("c1", "echo hi"), textTurn("批准后继续"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "跑个命令")
    await until(() => env.transport.cards.some((c) => c.card.kind === "approval"), "approval card")
    const approval = env.transport.cards.find((c) => c.card.kind === "approval")!
      .card as Extract<OutboundCard, { kind: "approval" }>

    // 审批卡已落盘（requested 即持久化），热重启后按钮有人认领
    const state = JSON.parse(readFileSync(join(env.home, "feishu-state.json"), "utf8")) as {
      pendingApprovals?: Record<string, { cardId: string; openId: string }>
    }
    expect(state.pendingApprovals?.[approval.confirmationId])
      .toEqual({ cardId: expect.any(String), openId: "ou_master" })

    // 热重启形态：旧实例 stop、新实例 start（同一 home、同一 manager/bus）
    await env.channel.stop()
    const transport2 = new FakeTransport()
    const channel2 = createFeishuChannel({
      transport: transport2, config: CONFIG, run: env.manager, sessions: env.sessions,
      bus: env.bus, home: env.home, log: () => undefined,
    })
    await channel2.start()

    transport2.cardAction("ou_master", `confirm:${approval.confirmationId}`)
    await until(() => transport2.cardUpdates.some((u) =>
      u.card.kind === "approval-settled" && u.card.outcome === "approved"), "approved after restart")
    await until(() => !readNonChildBusy(env), "run finished after approval")
    await channel2.stop()
  })

  it("an approval click after the confirmation settled while the channel was down marks the card invalid", async () => {
    llmQueue.push(execTurn("c1", "echo hi"), textTurn("继续"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "跑个命令")
    await until(() => env.transport.cards.some((c) => c.card.kind === "approval"), "approval card")
    const approval = env.transport.cards.find((c) => c.card.kind === "approval")!
      .card as Extract<OutboundCard, { kind: "approval" }>

    // 通道先停（守护进程重启窗口），裁决发生在停机期间（如 WebUI）
    await env.channel.stop()
    expect(env.manager.broker.resolve(approval.confirmationId, "reject", "cli")).toBe(true)

    const transport2 = new FakeTransport()
    const channel2 = createFeishuChannel({
      transport: transport2, config: CONFIG, run: env.manager, sessions: env.sessions,
      bus: env.bus, home: env.home, log: () => undefined,
    })
    await channel2.start()

    // 重启后在旧卡上再点：确认已不存在 → 卡片标记为已失效
    transport2.cardAction("ou_master", `confirm:${approval.confirmationId}`)
    await until(() => transport2.cardUpdates.some((u) =>
      u.card.kind === "approval-settled" && u.card.outcome === "invalid"), "invalid after restart")
    await until(() => !readNonChildBusy(env), "run settled")
    await channel2.stop()
  })

  it("ignores card actions from non-allowlisted senders", async () => {
    llmQueue.push(execTurn("c1", "echo hi"), textTurn("继续"))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "跑个命令")
    await until(() => env.transport.cards.some((c) => c.card.kind === "approval"), "approval card")
    const before = env.transport.cardUpdates.length

    env.transport.cardAction("ou_stranger", "confirm:whatever")
    await new Promise((r) => setTimeout(r, 30))
    expect(env.transport.cardUpdates).toHaveLength(before)
  })

  it("pushes a summary card to the primary user on job terminal broadcasts", async () => {
    env = await makeScriptedEnv()
    env.bus.emit(makeEvent("job.completed", { jobId: "j1", summary: "end_turn" }))
    env.bus.emit(makeEvent("job.failed", { jobId: "j2", error: { code: "job_failed", message: "boom" } }))
    await until(() => env.transport.cards.filter((c) => c.card.kind === "summary").length >= 2, "push cards")
    const summaries = env.transport.cards.filter((c) => c.card.kind === "summary")
    expect(summaries.every((c) => c.openId === "ou_master")).toBe(true)
  })

  it("pushes a summary card when a background subagent settles", async () => {
    env = await makeScriptedEnv()
    env.channel.onBackgroundSettled({
      parentId: "ses_p", childId: "ses_c", who: "爬虫", ok: true, excerpt: "结论：一切正常",
    })
    await until(() => env.transport.cards.some((c) => c.card.kind === "summary"), "push card")
    const card = env.transport.cards.find((c) => c.card.kind === "summary")!
    expect(card.openId).toBe("ou_master")
    expect((card.card as Extract<OutboundCard, { kind: "summary" }>).title).toContain("爬虫")
    expect((card.card as Extract<OutboundCard, { kind: "summary" }>).body).toContain("结论：一切正常")
  })

  it("strips system-reminder markers from outbound markdown", async () => {
    llmQueue.push(textTurn('<system-reminder kind="memory">注入</system-reminder>干净正文'))
    env = await makeScriptedEnv()
    env.transport.inbound("ou_master", "你好")
    await until(() => env.transport.finishes.length > 0, "final card")
    expect(env.transport.finishes[0]!.markdown).not.toContain("system-reminder")
    expect(env.transport.finishes[0]!.markdown).toContain("干净正文")
  })
})

// --- helpers ----------------------------------------------------------------

function topSessionId(env: ChannelEnv): string {
  const ids = mainMessages(env)
  if (ids.length === 0) throw new Error("no top-level session yet")
  return ids.at(-1)!
}

function readNonChildBusy(env: ChannelEnv): boolean {
  const ids = mainMessages(env)
  return ids.length > 0 && env.manager.busy(ids[0]!)
}
