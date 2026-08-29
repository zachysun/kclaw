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
import { MemoryStore, SessionStore, loadConfig, resolvePaths } from "@kclaw/core"
import type {
  AgentEvent,
  AssistantMessage,
  KclawConfig,
  KclawPaths,
  LlmClient,
  LlmStreamEvent,
  MessageQueuedPayload,
  RunCompletedPayload,
  RunFailedPayload,
} from "@kclaw/core"
import type { FastifyInstance } from "fastify"
import { EventBus } from "../src/bus.js"
import { RunManager } from "../src/run.js"
import { createApp } from "../src/app.js"

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

interface Env {
  paths: KclawPaths
  config: KclawConfig
  sessions: SessionStore
  memory: MemoryStore
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

/** Real stores + RunManager + app (ephemeral port); `wireRun: false` omits the app↔run seam. */
async function makeWsRun(
  llm: LlmClient,
  opts: { wireRun?: boolean; defaultDisposition?: "steer" | "wait" | "interrupt" } = {},
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

  const sessions = new SessionStore(paths.sessionsDir)
  const memory = new MemoryStore({ notesDir: paths.memoryNotesDir, indexDb: paths.memoryIndexDb })
  const bus = new EventBus()
  const manager = new RunManager({ config, paths, sessions, memory, bus, llm, workspace })

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
