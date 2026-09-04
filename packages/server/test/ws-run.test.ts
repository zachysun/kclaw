/**
 * WS run-command tests: `send_message` and `run.cancel` over the
 * REAL /ws route on an ephemeral port — real app, real RunManager on real
 * stores, mock LlmClient — plus the error-event plumb-through these commands
 * rely on (run.failed on a provider throw, run.completed aborted after cancel).
 *
 * Pinned semantics:
 * - send_message acks IMMEDIATELY (the ack must never wait for the run; a
 *   long run streams run.* events over the bus instead of the command channel).
 * - validation order: run availability → field shape → session existence
 *   (`sessions.meta`), each answered by an error frame that keeps the
 *   connection open.
 * - per-session queueing is visible on the wire: a second send_message acks
 *   right away, but its run.started only appears after the first run.completed.
 */
import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import WebSocket from "ws"
import { EventBus, SessionStore, loadConfig, newAssistantMessage, newMessage, resolvePaths } from "@kclaw/core"
import type {
  AgentEvent,
  AssistantMessage,
  KclawConfig,
  KclawPaths,
  LlmClient,
  LlmStreamEvent,
  MemorySystem,
  Message,
  MessageCreatedPayload,
  MessageQueuedPayload,
  RunCompletedPayload,
  RunFailedPayload,
  ToolExecutor,
} from "@kclaw/core"
import type { FastifyInstance } from "fastify"
import { RunManager } from "../src/run.js"
import { createApp } from "../src/app.js"
import { gateLlm, gateTool, makeGate } from "./helpers/gate.js"

const TOKEN = "t1"

/** Any decoded ws frame (event envelope, ack or error). */
type Frame = Record<string, unknown>

const isAgentEvent = (f: Frame): f is Frame & AgentEvent =>
  typeof f.type === "string" && "id" in f && "payload" in f

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** A stream gated on a manual release: the run hangs inside llm.stream until freed. */
function gatedTextClient(text: string): { llm: LlmClient; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const llm: LlmClient = {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      await gate
      yield { type: "text_delta", delta: text }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
  return { llm, release }
}

/** A stream that never yields and never settles; only an abort frees the loop. */
function hangingClient(): LlmClient {
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      await new Promise<never>(() => {})
    },
  }
}

/** Plain end_turn text turn (usage far below any line). */
function textTurn(text: string): LlmStreamEvent[] {
  return [
    { type: "text_delta", delta: text },
    { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

/**
 * tool_use round whose usage anchors the NEXT waterline check — inputTokens is
 * picked to push the estimate over the red line (the in-run compaction trigger).
 */
function execToolTurnWithUsage(callId: string, command: string, inputTokens: number): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name: "exec" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ command }) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens, outputTokens: 2 } },
  ]
}

/**
 * Seed n user/assistant history pairs (历史问题i / 历史回答i). Assistant
 * messages carry a real usage anchor (inputTokens 10_000) so the waterline
 * estimate reads the seeded history as over-budget, not trivially empty.
 */
function seedHistory(sessions: SessionStore, sessionId: string, pairs: number): Message[] {
  const seeded: Message[] = []
  for (let i = 1; i <= pairs; i++) {
    const u = newMessage(sessionId, "user", [{ id: `seed-u-${i}`, type: "text", text: `历史问题${i}` }])
    const a = newAssistantMessage(
      sessionId, "mock-model", [{ id: `seed-a-${i}`, type: "text", text: `历史回答${i}` }],
      { inputTokens: 10_000, outputTokens: 0 },
    )
    sessions.appendMessage(sessionId, u)
    sessions.appendMessage(sessionId, a)
    seeded.push(u, a)
  }
  return seeded
}

interface Env {
  paths: KclawPaths
  config: KclawConfig
  sessions: SessionStore
  memory: MemorySystem
  bus: EventBus
  manager: RunManager
}

const apps: FastifyInstance[] = []
const clients: WebSocket[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ws of clients.splice(0)) await closeClient(ws)
  for (const app of apps.splice(0)) await app.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Minimal MemorySystem stand-in: these ws tests never touch memory, so the
 *  injection seams return nothing (a full fake would mask nothing here). */
function makeMemoryFake(): MemorySystem {
  return {
    searchEpisodes: async () => [],
    cognitionPrompt: () => "",
  } as unknown as MemorySystem
}

/** Real stores + RunManager + app (ephemeral port); `wireRun: false` omits the app↔run seam. */
async function makeWsRun(
  llm: LlmClient,
  opts: {
    wireRun?: boolean
    defaultDisposition?: "steer" | "wait" | "interrupt"
    /** Per-name executor overrides handed straight to the RunManager (test seam). */
    tools?: Map<string, ToolExecutor>
    /** Config patch applied before the RunManager is built (run.test.ts patchConfig twin). */
    configure?: (c: KclawConfig) => void
  } = {},
): Promise<{ env: Env; url: string }> {
  const home = mkdtempSync(join(tmpdir(), "kclaw-wsr-home-"))
  const workspace = mkdtempSync(join(tmpdir(), "kclaw-wsr-ws-"))
  dirs.push(home, workspace)

  const paths = resolvePaths(home)
  const config = loadConfig(paths)
  config.workspace = workspace
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  // Test-injection seam: the disposition a no-disposition send_message
  // resolves to (spec §6 chain: explicit > session override > config default).
  if (opts.defaultDisposition !== undefined) config.sessions.defaultDisposition = opts.defaultDisposition
  // Test-injection seam: config patch before the manager locks it in (e.g.
  // tiny contextTokens to drive the compaction waterlines deterministically).
  opts.configure?.(config)

  const sessions = new SessionStore(paths.sessionsDir)
  const memory = makeMemoryFake()
  const bus = new EventBus()
  const manager = new RunManager({
    config, paths, sessions, memory, bus, llm, workspace,
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
  })

  const app = await createApp({
    home,
    token: TOKEN,
    stores: { sessions, config, paths },
    bus,
    ...(opts.wireRun === false ? {} : { run: manager }),
  })
  apps.push(app)
  await app.listen({ host: "127.0.0.1", port: 0 })
  const addr = app.server.address()
  if (addr === null || typeof addr === "string") throw new Error("expected an AddressInfo")
  return {
    env: { paths, config, sessions, memory, bus, manager },
    url: `ws://127.0.0.1:${(addr as AddressInfo).port}/ws`,
  }
}

function collectFrames(ws: WebSocket): Frame[] {
  const frames: Frame[] = []
  ws.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as Frame)
  })
  return frames
}

async function waitFor(frames: Frame[], pred: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = frames.find(pred)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`frame not observed within ${timeoutMs}ms`)
    await sleep(5)
  }
}

/** Wait until `pred` holds for the WHOLE frame list (negative observations). */
async function waitUntilFrames(frames: Frame[], pred: (fs: Frame[]) => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (pred(frames)) return
    if (Date.now() > deadline) throw new Error(`frame condition not met within ${timeoutMs}ms`)
    await sleep(5)
  }
}

/** The nth (1-based, default first) frame of `type` on the ordered command channel. */
async function frameOf(frames: Frame[], type: string, nth = 1, timeoutMs = 3000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = frames.filter((f) => f.type === type)[nth - 1]
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`frame "${type}" #${nth} not observed within ${timeoutMs}ms`)
    await sleep(5)
  }
}

/** The nth (1-based) bus event of `type` (AgentEvent envelope with id/payload). */
async function eventOf(frames: Frame[], type: string, nth = 1, timeoutMs = 3000): Promise<Frame & AgentEvent> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = frames.filter((f): f is Frame & AgentEvent => isAgentEvent(f) && f.type === type)[nth - 1]
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`event "${type}" #${nth} not observed within ${timeoutMs}ms`)
    await sleep(5)
  }
}

function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url)
  clients.push(ws)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 2000)
    ws.once("open", () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.once("error", (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function openAuthed(url: string): Promise<WebSocket> {
  const ws = await connect(url)
  ws.send(JSON.stringify({ type: "auth", token: TOKEN }))
  return ws
}

async function closeClient(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve())
    ws.terminate()
  })
}

describe("ws run commands (send_message / run.cancel)", () => {
  it("acks send_message immediately while the run is still executing, then streams it to completion", async () => {
    const { llm, release } = gatedTextClient("延迟的回答")
    const { env, url } = await makeWsRun(llm)
    const session = env.sessions.create("发送会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "打个招呼" }))

    // the ack is PROMPT (1s budget) and lands before the run produced anything,
    // and carries the server-side message identity (idle direct-run → queued:false)
    const ack = await waitFor(frames, (f) => f.type === "send_message_ack", 1000)
    expect(ack.type).toBe("send_message_ack")
    expect(ack.sessionId).toBe(session.id)
    expect(String(ack.messageId)).toMatch(/^msg_/)
    expect(ack.queued).toBe(false)

    // the run is now live but cannot finish (the llm is manually gated): the
    // ack demonstrably arrived while the run was still pending
    const started = (await waitFor(frames, (f) => f.type === "run.started")) as AgentEvent
    expect(started.payload).toEqual({ trigger: "user" })
    expect(frames.some((f) => f.type === "run.completed")).toBe(false)

    release()
    const completed = (await waitFor(frames, (f) => f.type === "run.completed")) as AgentEvent
    expect((completed.payload as RunCompletedPayload).stopReason).toBe("end_turn")

    // the run streamed through the bus: started < text deltas < completed
    const events = frames.filter(isAgentEvent)
    expect(events[0]!.type).toBe("run.started")
    expect(events.some((e) => e.type === "text.delta")).toBe(true)
    expect(events.at(-1)!.type).toBe("run.completed")

    // JSONL: the user message the command carried, then the assistant reply
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(msgs[0]!.blocks[0]).toMatchObject({ type: "text", text: "打个招呼" })
    expect((msgs[1] as AssistantMessage).blocks[0]).toMatchObject({ type: "text", text: "延迟的回答" })
  })

  it("rejects send_message with a bad text or an unknown session (error frames, connection stays open)", async () => {
    const { env, url } = await makeWsRun(gatedTextClient("不会跑到这里").llm)
    const session = env.sessions.create("校验会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "" }))
    const empty = await waitFor(frames, (f) => f.type === "error" && String(f.message).includes("text"))
    expect(empty.type).toBe("error")

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id }))
    await waitUntilFrames(
      frames,
      (fs) => fs.filter((f) => f.type === "error" && String(f.message).includes("text")).length === 2,
    )

    ws.send(JSON.stringify({ type: "send_message", sessionId: "ses_missing", text: "你好" }))
    expect(await waitFor(frames, (f) => f.type === "error" && f.message === "session not found")).toMatchObject({
      type: "error", message: "session not found",
    })

    // nothing was enqueued anywhere
    expect(env.sessions.readMessages(session.id)).toEqual([])
    expect(env.sessions.readMessages("ses_missing")).toEqual([])

    // the command channel still works afterwards
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_probe" }))
    await waitFor(frames, (f) => f.type === "subscribed")
  })

  it("serializes two queued send_messages: the second run starts only after the first completes", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        const call = ++calls
        if (call === 1) await gate // the first run hangs on a manual gate
        yield { type: "text_delta", delta: `答${call}` }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { env, url } = await makeWsRun(llm)
    const session = env.sessions.create("排队会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "第一句" }))
    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "第二句" }))

    // both commands ack promptly — queueing never blocks the command channel
    await waitUntilFrames(frames, (fs) => fs.filter((f) => f.type === "send_message_ack").length === 2, 1000)

    // the first run is live; the second is QUEUED: exactly one run.started so far
    await waitFor(frames, (f) => f.type === "run.started")
    await waitUntilFrames(frames, (fs) => fs.filter((f) => f.type === "run.started").length === 1)
    expect(frames.filter((f) => f.type === "run.completed")).toHaveLength(0)
    expect(calls).toBe(1)

    release()

    // both runs complete; on the wire the second run.started trails the first
    // run.completed (per-session serialization, visible to the subscriber)
    await waitUntilFrames(frames, (fs) => fs.filter((f) => f.type === "run.completed").length === 2)
    const events = frames.filter(isAgentEvent)
    const firstCompletedAt = events.findIndex((e) => e.type === "run.completed")
    const startsAt = events.map((e) => e.type === "run.started").lastIndexOf(true)
    expect(startsAt).toBeGreaterThan(firstCompletedAt)
    expect(calls).toBe(2)

    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(msgs[0]!.blocks[0]).toMatchObject({ text: "第一句" })
    expect(msgs[2]!.blocks[0]).toMatchObject({ text: "第二句" })
  })

  it("cancels a hanging run: run.cancel acks and the run completes aborted; a second cancel reports no active run", async () => {
    const { env, url } = await makeWsRun(hangingClient())
    const session = env.sessions.create("取消会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "别回了" }))
    await waitFor(frames, (f) => f.type === "send_message_ack")
    await waitFor(frames, (f) => f.type === "llm.started") // the run is live inside the stream

    ws.send(JSON.stringify({ type: "run.cancel", sessionId: session.id }))
    expect(await waitFor(frames, (f) => f.type === "run_cancel_ack")).toEqual({
      type: "run_cancel_ack", sessionId: session.id,
    })

    const completed = (await waitFor(frames, (f) => f.type === "run.completed")) as AgentEvent
    expect((completed.payload as RunCompletedPayload).stopReason).toBe("aborted")

    // nothing is active anymore; only the user message got persisted
    ws.send(JSON.stringify({ type: "run.cancel", sessionId: session.id }))
    expect(await waitFor(frames, (f) => f.type === "error")).toMatchObject({
      type: "error", message: "no active run",
    })
    expect(env.sessions.readMessages(session.id).map((m) => m.role)).toEqual(["user"])
  })

  it("plumbs a provider throw into run.failed and persists the partial assistant message with stopReason error", async () => {
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield { type: "text_delta", delta: "半截回答" }
        throw new Error("provider exploded")
      },
    }
    const { env, url } = await makeWsRun(llm)
    const session = env.sessions.create("故障会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "会挂的请求" }))
    await waitFor(frames, (f) => f.type === "send_message_ack")

    // the error lifecycle reaches the subscriber: llm.failed then run.failed
    const failed = (await waitFor(frames, (f) => f.type === "run.failed")) as AgentEvent
    const { error } = failed.payload as RunFailedPayload
    expect(error).toMatchObject({ code: "llm_error" })
    expect(error.message).toContain("provider exploded")

    const events = frames.filter(isAgentEvent)
    const llmFailedAt = events.findIndex((e) => e.type === "llm.failed")
    expect(llmFailedAt).toBeGreaterThanOrEqual(0)
    expect(llmFailedAt).toBeLessThan(events.findIndex((e) => e.type === "run.failed"))
    // a failed run terminates through run.failed — no run.completed follows
    expect(events.some((e) => e.type === "run.completed")).toBe(false)

    // JSONL: the partial assistant message is persisted, stamped stopReason error
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    const assistant = msgs[1] as AssistantMessage
    expect(assistant.stopReason).toBe("error")
    expect(assistant.blocks[0]).toMatchObject({ type: "text", text: "半截回答" })
  })

  it("answers run manager not available for both commands when no run manager is wired", async () => {
    const { env, url } = await makeWsRun(gatedTextClient("不该执行").llm, { wireRun: false })
    const session = env.sessions.create("未接线会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "你好" }))
    expect(await waitFor(frames, (f) => f.type === "error")).toMatchObject({
      type: "error", message: "run manager not available",
    })

    ws.send(JSON.stringify({ type: "run.cancel", sessionId: session.id }))
    expect(await waitFor(frames, (f) => f.type === "error" && f.message === "run manager not available")).toMatchObject({
      type: "error", message: "run manager not available",
    })

    // the connection still serves other commands
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_probe" }))
    await waitFor(frames, (f) => f.type === "subscribed")
  })
})

describe("ws queue steering (disposition / queue.cancel)", () => {
  it("send_message while busy enqueues as wait (config default), ack carries messageId+queued", async () => {
    const { llm, release } = gatedTextClient("慢回答")
    // 锁定「配置默认」这一环：本测试把缺省处置置为 wait（出厂默认是 steer）
    const { env, url } = await makeWsRun(llm, { defaultDisposition: "wait" })
    const session = env.sessions.create("排队默认会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await frameOf(frames, "subscribed")

    // 先让第一条消息占住会话（llm 闸门挂起），再发第二条（不带 disposition → 配置默认 wait）
    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "first" }))
    await frameOf(frames, "send_message_ack")
    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "second" }))
    const ack = await frameOf(frames, "send_message_ack", 2)
    expect(ack.messageId).toMatch(/^msg_/)
    expect(ack.queued).toBe(true)
    const payload = (await eventOf(frames, "message.queued")).payload as MessageQueuedPayload
    expect(payload.disposition).toBe("wait")
    expect(payload.position).toBe(0)

    release()
    await frameOf(frames, "run.completed", 2) // 两条都跑完，干净收尾
  })

  it("disposition=steer while busy buffers; queue.cancel withdraws before injection", async () => {
    const { llm, release } = gatedTextClient("被转向前的对话")
    const { env, url } = await makeWsRun(llm)
    const session = env.sessions.create("steer 取消会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await frameOf(frames, "subscribed")

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "first" }))
    await frameOf(frames, "send_message_ack")
    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "turn", disposition: "steer" }))
    const payload = (await eventOf(frames, "message.queued")).payload as MessageQueuedPayload
    expect(payload.disposition).toBe("steer")

    // 注入前取消：ack 携带被撤条目，并广播 message.queue_cancelled
    ws.send(JSON.stringify({ type: "queue.cancel", sessionId: session.id, messageId: payload.messageId }))
    const cancelAck = await frameOf(frames, "queue.cancel_ack")
    expect(cancelAck.sessionId).toBe(session.id)
    expect(cancelAck.cancelled).toEqual([payload.messageId])
    await eventOf(frames, "message.queue_cancelled")

    release()
    await frameOf(frames, "run.completed") // 仅第一条跑完
  })

  it("queue full answers an error frame with the spec message", async () => {
    const { llm, release } = gatedTextClient("堵住会话")
    const { env, url } = await makeWsRun(llm)
    const session = env.sessions.create("挤满会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await frameOf(frames, "subscribed")

    // 占住 run 后连发 10 条 wait（上限 10）：1 占位 + 10 排队 = 11 个 ack
    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "占位" }))
    for (let i = 0; i < 10; i++) {
      ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: `排${i}`, disposition: "wait" }))
    }
    await waitUntilFrames(frames, (fs) => fs.filter((f) => f.type === "send_message_ack").length === 11, 1000)

    // 第 11 条 wait（总第 12 条）→ error frame「队列已满（10 条）」、无 ack
    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "超限", disposition: "wait" }))
    const err = await frameOf(frames, "error")
    expect(err.message).toBe("队列已满（10 条）")
    await sleep(50) // 无 ack：错误帧之后 ack 计数不再增长
    expect(frames.filter((f) => f.type === "send_message_ack")).toHaveLength(11)

    release()
    await frameOf(frames, "run.completed", 11, 10_000) // 释放后排空队列，干净收尾
  })

  it("invalid disposition is an error frame", async () => {
    const { url } = await makeWsRun(gatedTextClient("不该执行").llm)
    const ws = await openAuthed(url)
    const frames = collectFrames(ws)

    // 校验先于会话存在性：不存在的会话也能先拿到 disposition 错误
    ws.send(JSON.stringify({ type: "send_message", sessionId: "ses_nope", text: "x", disposition: "asap" }))
    const err = await frameOf(frames, "error")
    expect(String(err.message)).toContain("disposition")

    // 连接保持可用
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_probe" }))
    await frameOf(frames, "subscribed")
  })
})

/**
 * Spec §8 end-to-end event sequences: each disposition's full wire story on a
 * REAL app + RunManager, from send_message through the ack, the message.queued
 * broadcast and the eventual arrival of the SAME messageId in message.created
 * (steer: injected at an iteration boundary with message.steered; wait: the
 * next run after the current completes; interrupt: after the current run ends
 * aborted). Ordering is asserted only where the wire guarantees it — the ack
 * and the bus broadcast travel independently, so queued/ack may interleave.
 */
describe("ws spec §8 event sequences (steer / wait / interrupt end-to-end)", () => {
  /** The message.created event carrying `id`, if it has arrived. */
  const createdFor = (frames: Frame[], id: unknown): Frame | undefined =>
    frames.find((f) =>
      isAgentEvent(f) && f.type === "message.created"
      && (f.payload as MessageCreatedPayload).message.id === id
    )

  it("steer: ack+queued(steer) → injected at the boundary as created+steered → the SAME run completes", async () => {
    // The gate pins the injection window: call 1 emits a tool_use whose
    // executor hangs until released; the steering drain then runs at the
    // iteration boundary (after the tool batch, before the next llm.stream)
    // and call 2 ends the run.
    const gate = makeGate()
    const tools = new Map([["gate", gateTool(gate)]])
    const { env, url } = await makeWsRun(gateLlm(gate, false), { tools })
    const session = env.sessions.create("引导时序会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await frameOf(frames, "subscribed")

    // Occupy the session: the first run parks INSIDE the tool batch.
    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "先跑着" }))
    await frameOf(frames, "send_message_ack")
    await gate.toolEntered

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "转向", disposition: "steer" }))
    const ack = await frameOf(frames, "send_message_ack", 2)
    expect(ack.messageId).toMatch(/^msg_/)
    expect(ack.queued).toBe(true)
    const queuedPayload = (await eventOf(frames, "message.queued")).payload as MessageQueuedPayload
    expect(queuedPayload.messageId).toBe(ack.messageId)
    expect(queuedPayload.disposition).toBe("steer")
    expect(queuedPayload.position).toBeUndefined() // steer 不适用 position（spec §4.2）

    // Release the tool batch → the boundary injects the buffered message:
    // message.created {同一 id} … message.steered {messageId, runId=当前 run}
    gate.releaseTool()
    const created = await waitFor(frames, (f) => createdFor(frames, ack.messageId) === f)
    const steered = await eventOf(frames, "message.steered")
    expect(steered.payload).toEqual({ messageId: ack.messageId })
    const started = await eventOf(frames, "run.started")
    expect(started.runId).toMatch(/^run_/)
    expect(steered.runId).toBe(started.runId) // 注入的是当前 run，不产生新 run
    expect(frames.indexOf(steered)).toBeGreaterThan(frames.indexOf(created))

    // The same run carries on to completion: exactly ONE started/completed pair.
    const completed = await eventOf(frames, "run.completed")
    expect((completed.payload as RunCompletedPayload).stopReason).toBe("end_turn")
    expect(frames.filter((f) => f.type === "run.started")).toHaveLength(1)
    expect(frames.filter((f) => f.type === "run.completed")).toHaveLength(1)

    // The injected message landed in the JSONL history under its queued id.
    expect(env.sessions.readMessages(session.id).some((m) => m.id === ack.messageId)).toBe(true)
  })

  it("wait: ack+queued(wait,position) → after the current run completes, the next run starts with the SAME id", async () => {
    const { llm, release } = gatedTextClient("慢回答")
    const { env, url } = await makeWsRun(llm)
    const session = env.sessions.create("等待时序会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await frameOf(frames, "subscribed")

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "first" }))
    await frameOf(frames, "send_message_ack")
    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "second", disposition: "wait" }))
    const ack = await frameOf(frames, "send_message_ack", 2)
    expect(ack.messageId).toMatch(/^msg_/)
    expect(ack.queued).toBe(true)
    const queuedPayload = (await eventOf(frames, "message.queued")).payload as MessageQueuedPayload
    expect(queuedPayload.messageId).toBe(ack.messageId)
    expect(queuedPayload.disposition).toBe("wait")
    expect(queuedPayload.position).toBe(0) // 队列里唯一条目 → 序位 0

    // The current run is still going: exactly one run.started, no completed yet.
    const firstStarted = await eventOf(frames, "run.started")
    await waitUntilFrames(frames, (fs) => fs.filter((f) => f.type === "run.started").length === 1)
    expect(frames.filter((f) => f.type === "run.completed")).toHaveLength(0)

    release()
    const firstCompleted = await eventOf(frames, "run.completed")
    expect((firstCompleted.payload as RunCompletedPayload).stopReason).toBe("end_turn")
    // The driver dequeues the wait entry: run.started #2 trails the first completed.
    const secondStarted = await eventOf(frames, "run.started", 2)
    expect(frames.indexOf(secondStarted)).toBeGreaterThan(frames.indexOf(firstCompleted))
    expect(secondStarted.runId).not.toBe(firstStarted.runId) // 确是新 run
    expect(secondStarted.payload).toEqual({ trigger: "user" })

    // message.created arrives under the PRE-ALLOCATED queued id (原地升级，无新 id).
    await waitFor(frames, (f) => createdFor(frames, ack.messageId) === f)
    expect(env.sessions.readMessages(session.id).some((m) => m.id === ack.messageId)).toBe(true)
    await frameOf(frames, "run.completed", 2) // 干净收尾
  })

  it("interrupt: queued(interrupt,position:0) → current run completes aborted → new run starts with the SAME id", async () => {
    // Call 1 hangs forever INSIDE llm.stream (only an abort frees it — the
    // loop's guardedStream races the signal); call 2 finishes immediately.
    let calls = 0
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        calls += 1
        if (calls === 1) await new Promise<never>(() => {})
        yield { type: "text_delta", delta: "新方向" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { env, url } = await makeWsRun(llm)
    const session = env.sessions.create("中断时序会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await frameOf(frames, "subscribed")

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "被掐的" }))
    await frameOf(frames, "send_message_ack")
    await frameOf(frames, "llm.started") // 第一个 run 已进入 stream

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "换方向", disposition: "interrupt" }))
    const ack = await frameOf(frames, "send_message_ack", 2)
    expect(ack.messageId).toMatch(/^msg_/)
    expect(ack.queued).toBe(true)
    const queuedPayload = (await eventOf(frames, "message.queued")).payload as MessageQueuedPayload
    expect(queuedPayload.messageId).toBe(ack.messageId)
    expect(queuedPayload.disposition).toBe("interrupt")
    expect(queuedPayload.position).toBe(0) // 插队首（spec §5.3）

    // The abort lands: the current run terminates aborted (not failed).
    const aborted = await eventOf(frames, "run.completed")
    expect((aborted.payload as RunCompletedPayload).stopReason).toBe("aborted")

    // The driver dequeues the interrupt entry into a NEW run that announces
    // message.created under the pre-allocated id.
    const secondStarted = await eventOf(frames, "run.started", 2)
    expect(frames.indexOf(secondStarted)).toBeGreaterThan(frames.indexOf(aborted))
    await waitFor(frames, (f) => createdFor(frames, ack.messageId) === f)
    expect(env.sessions.readMessages(session.id).some((m) => m.id === ack.messageId)).toBe(true)
    await frameOf(frames, "run.completed", 2) // 新 run 正常收尾
  })
})

/**
 * `compaction.cancel` over the wire (Task 8): rides RunManager.cancelCompaction.
 * Pinned semantics:
 * - ack `compaction_cancel_ack {sessionId, active}` — active mirrors whether an
 *   auto compaction was REALLY in flight at cancel time;
 * - no in-flight compaction is a normal no-op ack (active:false), never an
 *   error frame — the UI button races the compaction's own completion;
 * - the cancel takes effect on the bus: the parked in-run compaction ends as
 *   compaction.completed {result:"cancelled"} and the run itself carries on.
 */
describe("ws compaction.cancel", () => {
  it("acks active:true and cuts an in-flight in-run compaction; the run itself carries on", async () => {
    // 水位顶线手法（T7 run.test.ts 同款）：contextTokens=10 → 红线 8.5；
    // 第一轮 exec 轮 usage 9 顶过红线 → 迭代边界发起中途压缩，压缩自己的
    // 摘要请求（第 2 次调用）挂在 gate 上，compaction.cancel 从 ws 掐它。
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let n = 0
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        n += 1
        if (n === 1) {
          yield* execToolTurnWithUsage("c1", "echo hi", 9) // anchors over the red line (8.5)
          return
        }
        if (n === 2) {
          // the in-run compaction's segment summary parks here; cancel lands meanwhile
          yield { type: "text_delta", delta: "段摘要（半截）" }
          await gate
          yield { type: "text_delta", delta: "（后半）" }
          return
        }
        yield* textTurn("完成") // the run continues past the cancelled compaction
      },
    }
    const { env, url } = await makeWsRun(llm, {
      configure: (c) => {
        c.sessions.contextTokens = 10
        c.permissions.allow = ["exec:echo*"]
      },
    })
    const session = env.sessions.create("ws 取消压缩会话")
    seedHistory(env.sessions, session.id, 2)

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await frameOf(frames, "subscribed")

    ws.send(JSON.stringify({ type: "send_message", sessionId: session.id, text: "执行一下" }))
    await frameOf(frames, "send_message_ack")
    const started = await eventOf(frames, "compaction.started") // the compaction is parked on the gate
    expect(started.payload).toEqual({ phase: "in-run" })

    ws.send(JSON.stringify({ type: "compaction.cancel", sessionId: session.id }))
    expect(await frameOf(frames, "compaction_cancel_ack")).toEqual({
      type: "compaction_cancel_ack", sessionId: session.id, active: true,
    })
    release()

    // the cut is visible on the bus: cancelled compaction, then the run ends normally
    const completed = await eventOf(frames, "compaction.completed")
    expect(completed.payload).toEqual({ segments: 0, kept: 0, phase: "in-run", result: "cancelled" })
    const done = await eventOf(frames, "run.completed")
    expect((done.payload as RunCompletedPayload).stopReason).toBe("end_turn")
  })

  it("acks active:false as a plain no-op when nothing is in flight (button race, not an error)", async () => {
    const { env, url } = await makeWsRun(gatedTextClient("不该执行").llm)
    const session = env.sessions.create("ws 空取消会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)

    ws.send(JSON.stringify({ type: "compaction.cancel", sessionId: session.id }))
    expect(await frameOf(frames, "compaction_cancel_ack")).toEqual({
      type: "compaction_cancel_ack", sessionId: session.id, active: false,
    })
    await sleep(50)
    expect(frames.filter((f) => f.type === "error")).toEqual([]) // 前端按钮竞态下不报错

    // the command channel still works afterwards
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_probe" }))
    await frameOf(frames, "subscribed")
    expect(env.sessions.readMessages(session.id)).toEqual([]) // nothing ran
  })
})
