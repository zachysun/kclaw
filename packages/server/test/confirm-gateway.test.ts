/**
 * Confirmation gateway tests (P3 Task 6): the ConfirmationBroker bridging
 * websocket verdicts onto the loop's resolver, driven through a REAL app on
 * an ephemeral port (real /ws route, real RunManager on real stores, mock
 * LlmClient). Config keeps `permissions.allow` EMPTY so an exec call falls
 * through to a confirmation.
 *
 * Composition pinned by these tests (verified against core agent/loop.ts):
 * the LOOP emits both confirmation.requested and confirmation.resolved via
 * its onEvent → RunManager fans them onto the bus → subscribers receive
 * them. The broker therefore emits NOTHING — a gateway-resolved run must
 * show exactly one of each event, never a duplicate from the broker side.
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
  ConfirmationRequestedPayload,
  KclawConfig,
  KclawPaths,
  LlmClient,
  LlmStreamEvent,
  ToolCallBlock,
  ToolMessage,
  ToolResultBlock,
} from "@kclaw/core"
import type { FastifyInstance } from "fastify"
import { ConfirmationBroker } from "../src/confirm.js"
import { EventBus } from "../src/bus.js"
import { RunManager } from "../src/run.js"
import { createApp } from "../src/app.js"

const TOKEN = "t1"

/** Any decoded ws frame (event envelope, ack or error). */
type Frame = Record<string, unknown>

const isAgentEvent = (f: Frame): f is Frame & AgentEvent =>
  typeof f.type === "string" && "id" in f && "payload" in f

// --- broker unit tests -------------------------------------------------------

const CALL: ToolCallBlock = {
  id: "blk_1", type: "tool_call", callId: "call_1", name: "exec",
  args: { command: "echo hi" }, argsJson: "{\"command\":\"echo hi\"}",
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe("ConfirmationBroker", () => {
  it("registers a pending entry and lists it as the wire payload", () => {
    const broker = new ConfirmationBroker()
    broker.create("conf_1", CALL, "sensitive", 60_000, "ses_1")

    const listed: ConfirmationRequestedPayload[] = broker.pending()
    expect(listed).toEqual([{
      confirmationId: "conf_1",
      toolCall: CALL,
      risk: "sensitive",
      expiresAt: expect.any(String),
    }])
    expect(Date.parse(listed[0]!.expiresAt)).toBeGreaterThan(Date.now())
  })

  it("settles create's promise on resolve; a second resolve returns false", async () => {
    const broker = new ConfirmationBroker()
    const resolution = broker.create("conf_2", CALL, "sensitive", 60_000)

    expect(broker.resolve("conf_2", true)).toBe(true)
    await expect(resolution).resolves.toEqual({ approved: true, by: "cli" })

    expect(broker.resolve("conf_2", true)).toBe(false)
    expect(broker.pending()).toEqual([])
  })

  it("keeps the web actor field on the resolution", async () => {
    const broker = new ConfirmationBroker()
    const resolution = broker.create("conf_w", CALL, "sensitive", 60_000)
    expect(broker.resolve("conf_w", false, "web")).toBe(true)
    await expect(resolution).resolves.toEqual({ approved: false, by: "web" })
  })

  it("resolves an unknown id to false without side effects", () => {
    const broker = new ConfirmationBroker()
    expect(broker.resolve("conf_nope", true)).toBe(false)
  })

  it("expire marks the entry stale: a later resolve returns false, the promise stays pending", async () => {
    const broker = new ConfirmationBroker()
    const resolution = broker.create("conf_3", CALL, "sensitive", 60_000)

    broker.expire("conf_3")
    expect(broker.resolve("conf_3", true)).toBe(false)
    expect(broker.pending()).toEqual([])
    // never settles — the surrounding loop race already denied by timeout
    const won = await Promise.race([
      resolution.then(() => "settled" as const),
      sleep(30).then(() => "pending" as const),
    ])
    expect(won).toBe("pending")
  })

  it("pending() prunes entries whose expiry has passed", async () => {
    const broker = new ConfirmationBroker()
    broker.create("conf_4", CALL, "sensitive", 1)
    await sleep(20)
    expect(broker.pending()).toEqual([])
  })

  it("wait() hands out the same settlement and never settles for unknown ids", async () => {
    const broker = new ConfirmationBroker()
    const created = broker.create("conf_5", CALL, "sensitive", 60_000)
    const waited = broker.wait("conf_5")

    broker.resolve("conf_5", true, "web")
    await expect(waited).resolves.toEqual({ approved: true, by: "web" })
    await expect(created).resolves.toEqual({ approved: true, by: "web" })

    // unknown id: pending forever; the loop's own timeout race owns the denial
    const won = await Promise.race([
      broker.wait("conf_missing").then(() => "settled" as const),
      sleep(30).then(() => "pending" as const),
    ])
    expect(won).toBe("pending")
  })
})

// --- gateway integration (real app + ws client + RunManager) ----------------

/** Scripted LlmClient: one array of stream events per llm call, last one repeats. */
function scriptClient(script: LlmStreamEvent[][]): LlmClient {
  let i = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield* script[Math.min(i++, script.length - 1)]!
    },
  }
}

function textTurn(text: string): LlmStreamEvent[] {
  return [
    { type: "text_delta", delta: text },
    { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

function execToolTurn(callId: string, command: string): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name: "exec" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ command }) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

interface GwEnv {
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
async function makeGateway(
  llm: LlmClient,
  opts: { wireRun?: boolean } = {},
): Promise<{ env: GwEnv; url: string }> {
  const home = mkdtempSync(join(tmpdir(), "kclaw-cgw-home-"))
  const workspace = mkdtempSync(join(tmpdir(), "kclaw-cgw-ws-"))
  dirs.push(home, workspace)

  const paths = resolvePaths(home)
  const config = loadConfig(paths)
  config.workspace = workspace
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  // permissions.allow stays EMPTY (the config default) → exec requires a confirmation

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
  return { env: { paths, config, sessions, memory, bus, manager }, url: `ws://127.0.0.1:${(addr as AddressInfo).port}/ws` }
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

describe("confirmation gateway over /ws", () => {
  it("approves a confirmation end to end: requested → resolve → resolved → tool runs", async () => {
    const { env, url } = await makeGateway(
      scriptClient([execToolTurn("call_1", "echo ok"), textTurn("完成")]),
    )
    expect(env.manager.broker).toBeInstanceOf(ConfirmationBroker)
    const session = env.sessions.create("网关批准会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 echo ok", trigger: "user" })

    // the loop's own confirmation.requested reaches the subscriber
    const requested = (await waitFor(frames, (f) => f.type === "confirmation.requested")) as AgentEvent
    const payload = requested.payload as ConfirmationRequestedPayload
    expect(payload.confirmationId).toMatch(/^conf_/)
    expect(payload.toolCall).toMatchObject({ type: "tool_call", name: "exec", callId: "call_1" })
    expect(payload.risk).toBe("sensitive")
    expect(typeof payload.expiresAt).toBe("string")

    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId: payload.confirmationId, approved: true,
    }))
    expect(await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")).toEqual({
      type: "confirmation.resolved_ack", confirmationId: payload.confirmationId, ok: true,
    })

    // a second resolve of the same id answers an error frame (entry settled)
    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId: payload.confirmationId, approved: false,
    }))
    const dup = await waitFor(frames, (f) => f.type === "error" && f.message === "unknown confirmation")
    expect(dup.message).toBe("unknown confirmation")

    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")

    // exactly one requested/resolved pair — the loop emitted both, the broker none
    const events = frames.filter(isAgentEvent)
    expect(events.filter((e) => e.type === "confirmation.requested")).toHaveLength(1)
    const resolved = events.filter((e) => e.type === "confirmation.resolved")
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.payload).toEqual({ confirmationId: payload.confirmationId, approved: true, by: "cli" })

    // order on the wire: requested < resolved < tool_result.created
    const at = (type: string): number => events.findIndex((e) => e.type === type)
    expect(at("confirmation.requested")).toBeGreaterThanOrEqual(0)
    expect(at("confirmation.requested")).toBeLessThan(at("confirmation.resolved"))
    expect(at("confirmation.resolved")).toBeLessThan(at("tool_result.created"))

    // the confirmed granted reason landed on the tool message
    expect((env.sessions.readMessages(session.id)[2] as ToolMessage).grantedBy).toEqual({ call_1: "confirmed" })

    // JSONL: user, assistant(tool_call), tool, assistant
    expect(env.sessions.readMessages(session.id).map((m) => m.role)).toEqual([
      "user", "assistant", "tool", "assistant",
    ])
    const result = env.sessions.readMessages(session.id)[2]!.blocks[0] as ToolResultBlock
    expect(result).toMatchObject({ type: "tool_result", callId: "call_1", status: "ok" })
  })

  it("denies a confirmation over the gateway: tool_result errors, denied note recorded", async () => {
    const { env, url } = await makeGateway(
      scriptClient([execToolTurn("call_2", "echo no"), textTurn("好的")]),
    )
    const session = env.sessions.create("网关拒绝会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 echo no", trigger: "user" })

    const requested = (await waitFor(frames, (f) => f.type === "confirmation.requested")) as AgentEvent
    const { confirmationId } = requested.payload as ConfirmationRequestedPayload
    ws.send(JSON.stringify({ type: "confirmation.resolve", confirmationId, approved: false }))
    await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")

    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")

    const events = frames.filter(isAgentEvent)
    expect(events.find((e) => e.type === "confirmation.resolved")!.payload).toEqual({
      confirmationId, approved: false, by: "cli",
    })

    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const result = msgs[2]!.blocks[0] as ToolResultBlock
    expect(result.status).toBe("error")
    expect(result.output).toContain("用户拒绝了该操作")

    const toolMsg = msgs[2] as ToolMessage
    expect(toolMsg.grantedBy).toBeUndefined()
    expect(toolMsg.blocks.some((b) => b.type === "note" && b.kind === "denied")).toBe(true)
  })

  it("carries a web-sourced verdict through to the resolution", async () => {
    const { env, url } = await makeGateway(
      scriptClient([execToolTurn("call_w", "echo web"), textTurn("完成")]),
    )
    const session = env.sessions.create("web 网关会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 echo web", trigger: "user" })
    const requested = (await waitFor(frames, (f) => f.type === "confirmation.requested")) as AgentEvent
    const { confirmationId } = requested.payload as ConfirmationRequestedPayload

    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId, approved: true, client: "web",
    }))
    await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")

    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")

    const events = frames.filter(isAgentEvent)
    expect(events.find((e) => e.type === "confirmation.resolved")!.payload).toEqual({
      confirmationId, approved: true, by: "web",
    })

    // the web-approved granted reason landed on the tool message
    expect((env.sessions.readMessages(session.id)[2] as ToolMessage).grantedBy).toEqual({ call_w: "confirmed" })
  })

  it("rejects a resolve frame whose client is neither cli nor web", async () => {
    const { url } = await makeGateway(scriptClient([textTurn("好")]))
    const ws = await openAuthed(url)
    const frames = collectFrames(ws)

    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId: "conf_x", approved: true, client: "mobile",
    }))
    await waitFor(frames, (f) => f.type === "error" && (f.message as string).includes("client"))

    // an omitted client stays valid (defaults to cli) and the connection lives on
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_probe" }))
    await waitFor(frames, (f) => f.type === "subscribed")
  })

  it("answers an error frame for an unknown confirmation, and stays open", async () => {
    const { url } = await makeGateway(scriptClient([textTurn("好")]))
    const ws = await openAuthed(url)
    const frames = collectFrames(ws)

    ws.send(JSON.stringify({ type: "confirmation.resolve", confirmationId: "conf_missing", approved: true }))
    await waitFor(frames, (f) => f.type === "error" && f.message === "unknown confirmation")

    // malformed variants likewise error instead of crashing the connection
    ws.send(JSON.stringify({ type: "confirmation.resolve", confirmationId: "conf_x" }))
    await waitFor(frames, (f) => f.type === "error" && typeof f.message === "string"
      && (f.message as string).includes("approved"))
    ws.send(JSON.stringify({ type: "confirmation.resolve", approved: true }))
    await waitFor(frames, (f) => f.type === "error" && typeof f.message === "string"
      && (f.message as string).includes("confirmationId"))

    // the connection still serves ordinary commands afterwards
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_probe" }))
    await waitFor(frames, (f) => f.type === "subscribed")
  })

  it("answers an error frame when no run manager is wired into the app", async () => {
    const { url } = await makeGateway(scriptClient([textTurn("好")]), { wireRun: false })
    const ws = await openAuthed(url)
    const frames = collectFrames(ws)

    ws.send(JSON.stringify({ type: "confirmation.resolve", confirmationId: "conf_x", approved: true }))
    await waitFor(frames, (f) => f.type === "error" && /confirmation/.test(String(f.message)))
  })
})
