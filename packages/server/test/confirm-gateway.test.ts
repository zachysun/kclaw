/**
 * Confirmation gateway tests: the ConfirmationBroker bridging
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import WebSocket from "ws"
import { ConfirmationBroker, EventBus, SessionStore, loadConfig, loadDecidedRules, resolvePaths, AutoLearnCounter } from "@kclaw/core"
import type {
  AgentEvent,
  ConfirmationRequestedPayload,
  KclawConfig,
  KclawPaths,
  LlmClient,
  LlmRequest,
  LlmStreamEvent,
  MemorySystem,
  ToolCallBlock,
  ToolMessage,
  ToolResultBlock,
} from "@kclaw/core"
import type { FastifyInstance } from "fastify"
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

    expect(broker.resolve("conf_2", "once")).toBe(true)
    await expect(resolution).resolves.toEqual({ decision: "once", by: "cli" })

    expect(broker.resolve("conf_2", "once")).toBe(false)
    expect(broker.pending()).toEqual([])
  })

  it("keeps the web actor field on the resolution", async () => {
    const broker = new ConfirmationBroker()
    const resolution = broker.create("conf_w", CALL, "sensitive", 60_000)
    expect(broker.resolve("conf_w", "reject", "web")).toBe(true)
    await expect(resolution).resolves.toEqual({ decision: "reject", by: "web" })
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

    broker.resolve("conf_5", "once", "web")
    await expect(waited).resolves.toEqual({ decision: "once", by: "web" })
    await expect(created).resolves.toEqual({ decision: "once", by: "web" })

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

function askToolTurn(callId: string, questions: unknown): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name: "ask_user_questions" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ questions }) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

interface GwEnv {
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

/** Minimal MemorySystem stand-in: the gateway tests never touch memory, so
 *  injection seams return nothing (a full fake would mask nothing here). */
function makeMemoryFake(): MemorySystem {
  return {
    searchEpisodes: async () => [],
    cognitionPrompt: () => "",
  } as unknown as MemorySystem
}

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
  // These tests drive the confirmation gateway over a real WS server; the
  // host may have an exec sandbox (macOS Seatbelt / Linux bwrap) that would
  // auto-pass exec instead of confirming. Disable it — this suite is about
  // the confirmation flow, not the sandbox.
  config.sandbox = { enabled: false, writeRoots: [] }
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  // permissions.allow stays EMPTY (the config default) → exec requires a confirmation

  const sessions = new SessionStore(paths.sessionsDir)
  const memory = makeMemoryFake()
  const bus = new EventBus()
  const manager = new RunManager({
    config, paths, sessions, memory, bus, llm, workspace,
    // auto induction (batch C) rides the run assembly seam, wired here like
    // the daemon does; threshold from config (default 3).
    autoLearn: { counter: new AutoLearnCounter(config.permissions.autoLearnThreshold ?? 3) },
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

/**
 * The Nth confirmation.requested event (0-based), waiting only for events
 * BEYOND the ones already seen — unlike waitFor, this cannot match a frame
 * from an earlier run of the same script.
 */
async function waitRequested(frames: Frame[], index: number, timeoutMs = 5000): Promise<ConfirmationRequestedPayload> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const events = frames.filter(isAgentEvent).filter((e) => e.type === "confirmation.requested")
    if (events.length > index) return events[index]!.payload as ConfirmationRequestedPayload
    if (Date.now() > deadline) throw new Error(`confirmation.requested #${index} not observed within ${timeoutMs}ms`)
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
      type: "confirmation.resolve", confirmationId: payload.confirmationId, decision: "once",
    }))
    expect(await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")).toEqual({
      type: "confirmation.resolved_ack", confirmationId: payload.confirmationId, ok: true,
    })

    // a second resolve of the same id answers an error frame (entry settled)
    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId: payload.confirmationId, decision: "reject",
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
    expect(resolved[0]!.payload).toEqual({ confirmationId: payload.confirmationId, decision: "once", by: "cli" })

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
    ws.send(JSON.stringify({ type: "confirmation.resolve", confirmationId, decision: "reject" }))
    await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")

    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")

    const events = frames.filter(isAgentEvent)
    expect(events.find((e) => e.type === "confirmation.resolved")!.payload).toEqual({
      confirmationId, decision: "reject", by: "cli",
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
      type: "confirmation.resolve", confirmationId, decision: "once", client: "web",
    }))
    await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")

    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")

    const events = frames.filter(isAgentEvent)
    expect(events.find((e) => e.type === "confirmation.resolved")!.payload).toEqual({
      confirmationId, decision: "once", by: "web",
    })

    // the web-approved granted reason landed on the tool message
    expect((env.sessions.readMessages(session.id)[2] as ToolMessage).grantedBy).toEqual({ call_w: "confirmed" })
  })

  it("rejects a resolve frame whose client is neither cli nor web", async () => {
    const { url } = await makeGateway(scriptClient([textTurn("好")]))
    const ws = await openAuthed(url)
    const frames = collectFrames(ws)

    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId: "conf_x", decision: "once", client: "mobile",
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

    ws.send(JSON.stringify({ type: "confirmation.resolve", confirmationId: "conf_missing", decision: "once" }))
    await waitFor(frames, (f) => f.type === "error" && f.message === "unknown confirmation")

    // malformed variants likewise error instead of crashing the connection
    ws.send(JSON.stringify({ type: "confirmation.resolve", confirmationId: "conf_x" }))
    await waitFor(frames, (f) => f.type === "error" && typeof f.message === "string"
      && (f.message as string).includes("decision"))
    ws.send(JSON.stringify({ type: "confirmation.resolve", decision: "once" }))
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

    ws.send(JSON.stringify({ type: "confirmation.resolve", confirmationId: "conf_x", decision: "once" }))
    await waitFor(frames, (f) => f.type === "error" && /confirmation/.test(String(f.message)))
  })

  it("persists a decided rule when the verdict is always-allow, not for once/reject", async () => {
    const { env, url } = await makeGateway(
      scriptClient([
        execToolTurn("call_1", "git push origin main"),
        execToolTurn("call_2", "git push origin dev"),
        execToolTurn("call_3", "git fetch"),
        execToolTurn("call_4", "echo done"),
        textTurn("完成"),
      ]),
    )
    const session = env.sessions.create("沉淀会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })

    // call_1: always allow in this project → the narrowed prefix lands in the
    // project file (which is born gitignored inside the workspace)
    const requested1 = (await waitFor(frames, (f) => f.type === "confirmation.requested")) as AgentEvent
    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId: (requested1.payload as ConfirmationRequestedPayload).confirmationId,
      decision: "project",
    }))
    await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")

    // call_2: matched by the just-decided `exec:git push*` rule? No — the
    // gate was built at run start, so this still asks; allow once.
    const requested2 = (await waitFor(frames, (f) =>
      f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === "call_2")) as AgentEvent
    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId: (requested2.payload as ConfirmationRequestedPayload).confirmationId,
      decision: "once",
    }))
    await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")

    // call_3: always allow globally
    const requested3 = (await waitFor(frames, (f) =>
      f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === "call_3")) as AgentEvent
    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId: (requested3.payload as ConfirmationRequestedPayload).confirmationId,
      decision: "global",
    }))
    await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")

    // call_4: rejected — a reject verdict must persist nothing
    const requested4 = (await waitFor(frames, (f) =>
      f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === "call_4")) as AgentEvent
    ws.send(JSON.stringify({
      type: "confirmation.resolve", confirmationId: (requested4.payload as ConfirmationRequestedPayload).confirmationId,
      decision: "reject",
    }))
    await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")

    await run

    // project scope: narrowed prefix + provenance, gitignored, inside the workspace
    const projectRules = loadDecidedRules(join(env.config.workspace, ".kclaw", "permissions.yaml"))
    expect(projectRules).toHaveLength(1)
    expect(projectRules[0]!.rule).toBe("exec:git push*")
    expect(projectRules[0]!.origin.tool).toBe("exec")
    expect(projectRules[0]!.origin.sessionId).toBe(session.id)
    expect(readFileSync(join(env.config.workspace, ".gitignore"), "utf8")).toContain(".kclaw/permissions.yaml")

    // global scope: the call_3 rule landed in <home>/permissions.yaml
    const globalRules = loadDecidedRules(join(env.paths.home, "permissions.yaml"))
    expect(globalRules).toHaveLength(1)
    expect(globalRules[0]!.rule).toBe("exec:git fetch*")
  }, 30_000)

  it("a verdict arriving after the run aborted persists no decided rule", async () => {
    const { env, url } = await makeGateway(
      scriptClient([execToolTurn("call_1", "git push origin main"), textTurn("完成")]),
    )
    const session = env.sessions.create("中止迟到判决会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })

    const requested = (await waitFor(frames, (f) => f.type === "confirmation.requested")) as AgentEvent
    const confirmationId = (requested.payload as ConfirmationRequestedPayload).confirmationId

    // the user cancels the run while the confirmation is still pending
    ws.send(JSON.stringify({ type: "run.cancel", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "run_cancel_ack")
    await run

    // the late "always allow" finds no live confirmation: the abort expired
    // the broker entry, so the gateway errors instead of acking a verdict
    // nothing will act on
    ws.send(JSON.stringify({ type: "confirmation.resolve", confirmationId, decision: "project" }))
    await waitFor(frames, (f) => f.type === "error" && f.message === "unknown confirmation")

    // and the verdict wrote NOTHING: no project rule file was even created,
    // and the global file stays empty
    expect(existsSync(join(env.config.workspace, ".kclaw", "permissions.yaml"))).toBe(false)
    expect(loadDecidedRules(join(env.paths.home, "permissions.yaml"))).toHaveLength(0)
  }, 30_000)

  it("auto mode inducts a source:'auto' project rule after N consecutive once approvals", async () => {
    const { env, url } = await makeGateway(
      scriptClient([
        execToolTurn("call_1", "git push origin main"),
        execToolTurn("call_2", "git push origin main"),
        execToolTurn("call_3", "git push origin main"),
        textTurn("完成"),
      ]),
    )
    const session = env.sessions.create("自动学习会话")
    env.sessions.updateMeta(session.id, { mode: "auto" }) // the induction gate

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })

    // three identical once approvals (the same narrowed key `exec:git push*`)
    for (let i = 1; i <= 3; i++) {
      const requested = (await waitFor(frames, (f) =>
        f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === `call_${i}`)) as AgentEvent
      ws.send(JSON.stringify({
        type: "confirmation.resolve",
        confirmationId: (requested.payload as ConfirmationRequestedPayload).confirmationId,
        decision: "once",
      }))
      await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")
    }
    await run

    // Direct guard for the batch D decision: in `auto` mode the gate must NOT
    // consult run-scoped grants, so every repeated call still surfaces a real
    // confirmation — three identical calls, three confirmation.requested
    // frames (a swallowed one would hide the repetition induction needs).
    expect(frames.filter((f) => f.type === "confirmation.requested")).toHaveLength(3)

    const projectRules = loadDecidedRules(join(env.config.workspace, ".kclaw", "permissions.yaml"))
    expect(projectRules).toHaveLength(1)
    expect(projectRules[0]!.rule).toBe("exec:git push*")
    expect(projectRules[0]!.source).toBe("auto")
  }, 30_000)

  it("a reject resets the streak: approvals split by a 'no' never reach the threshold", async () => {
    const { env, url } = await makeGateway(
      scriptClient([
        execToolTurn("call_1", "git push origin main"),
        execToolTurn("call_2", "git push origin main"),
        execToolTurn("call_3", "git push origin main"),
        execToolTurn("call_4", "git push origin main"),
        execToolTurn("call_5", "git push origin main"),
        textTurn("完成"),
      ]),
    )
    const session = env.sessions.create("自动学习拒绝会话")
    env.sessions.updateMeta(session.id, { mode: "auto" })

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })

    const resolve = async (callId: string, decision: "once" | "reject") => {
      const requested = (await waitFor(frames, (f) =>
        f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === callId)) as AgentEvent
      ws.send(JSON.stringify({
        type: "confirmation.resolve",
        confirmationId: (requested.payload as ConfirmationRequestedPayload).confirmationId,
        decision,
      }))
      await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")
    }

    // once, once → streak 2; reject → reset; once, once → streak 2 again
    await resolve("call_1", "once")
    await resolve("call_2", "once")
    await resolve("call_3", "reject")
    await resolve("call_4", "once")
    await resolve("call_5", "once")
    await run

    const projectRules = loadDecidedRules(join(env.config.workspace, ".kclaw", "permissions.yaml"))
    expect(projectRules).toHaveLength(0) // 2+2 < 3 — the reject's reset held
  }, 30_000)

  it("project/global verdicts never count toward induction, and mix cleanly with auto rules", async () => {
    const { env, url } = await makeGateway(
      scriptClient([
        execToolTurn("call_1", "git push origin main"),
        execToolTurn("call_2", "git push origin main"),
        execToolTurn("call_3", "git fetch"),
        execToolTurn("call_4", "git push origin main"),
        textTurn("完成"),
      ]),
    )
    const session = env.sessions.create("自动学习混合会话")
    env.sessions.updateMeta(session.id, { mode: "auto" })

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })

    const resolve = async (callId: string, decision: "once" | "project") => {
      const requested = (await waitFor(frames, (f) =>
        f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === callId)) as AgentEvent
      ws.send(JSON.stringify({
        type: "confirmation.resolve",
        confirmationId: (requested.payload as ConfirmationRequestedPayload).confirmationId,
        decision,
      }))
      await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")
    }

    // once, once → streak 2; project (does NOT advance nor reset); once → streak 3 → induct
    await resolve("call_1", "once")
    await resolve("call_2", "once")
    await resolve("call_3", "project")
    await resolve("call_4", "once")
    await run

    const projectRules = loadDecidedRules(join(env.config.workspace, ".kclaw", "permissions.yaml"))
    expect(projectRules).toHaveLength(2)
    // the hand-written "always allow" lands unmarked (manual)…
    const manual = projectRules.find((r) => r.rule === "exec:git fetch*")
    expect(manual?.source).toBeUndefined()
    // …while the auto-inducted one is marked
    const auto = projectRules.find((r) => r.rule === "exec:git push*")
    expect(auto?.source).toBe("auto")
  }, 30_000)

  it("a TIMEOUT deny resets the streak: approvals split by a timeout never reach the threshold", async () => {
    // 200ms confirmation window so a verdict-less confirmation times out
    // inside the run (the assembly seam sees the timeout and resets).
    const { env, url } = await makeGateway(
      scriptClient([
        execToolTurn("call_1", "git push origin main"),
        execToolTurn("call_2", "git push origin main"),
        execToolTurn("call_3", "git push origin main"),
        execToolTurn("call_4", "git push origin main"),
        execToolTurn("call_5", "git push origin main"),
        textTurn("完成"),
      ]),
    )
    env.config.permissions.confirmTimeoutMs = 200
    const session = env.sessions.create("自动学习超时会话")
    env.sessions.updateMeta(session.id, { mode: "auto" })

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })

    const resolve = async (callId: string) => {
      const requested = (await waitFor(frames, (f) =>
        f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === callId)) as AgentEvent
      ws.send(JSON.stringify({
        type: "confirmation.resolve",
        confirmationId: (requested.payload as ConfirmationRequestedPayload).confirmationId,
        decision: "once",
      }))
      await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")
    }

    // once, once → streak 2; call_3 is left unanswered → times out (a "no"
    // by silence) → resets; once, once → streak 2 again → no induction
    await resolve("call_1")
    await resolve("call_2")
    await resolve("call_4")
    await resolve("call_5")
    await run

    const projectRules = loadDecidedRules(join(env.config.workspace, ".kclaw", "permissions.yaml"))
    expect(projectRules).toHaveLength(0) // 2 + timeout + 2 < 3 — the reset held
  }, 30_000)
})

// --- question gateway over /ws (issue #21) -----------------------------------
// ask_user_questions rides the SAME broker and gateway path as confirmations:
// the tool executor registers the pending question and emits question.requested
// (stamped with the run context), the ws question.resolve frame settles it, and
// the tool's race produces the tool result. Exactly one requested/resolved pair
// per question — the broker emits nothing.

describe("question gateway over /ws", () => {
  it("answers a question end to end: requested → resolve → resolved → tool result carries the answers", async () => {
    const { env, url } = await makeGateway(
      scriptClient([
        askToolTurn("call_q1", [
          { text: "用哪个方案?", options: ["方案A", "方案B"] },
          { text: "补充说明?" },
        ]),
        textTurn("好，按方案A做"),
      ]),
    )
    const session = env.sessions.create("提问会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "问我用哪个方案", trigger: "user" })

    const requested = (await waitFor(frames, (f) => f.type === "question.requested")) as AgentEvent
    const payload = requested.payload as { questionId: string; questions: Array<{ text: string; options?: string[] }>; expiresAt: string }
    expect(payload.questionId).toMatch(/^q_/)
    expect(payload.questions).toEqual([
      { text: "用哪个方案?", options: ["方案A", "方案B"] },
      { text: "补充说明?" },
    ])
    expect(typeof payload.expiresAt).toBe("string")

    ws.send(JSON.stringify({
      type: "question.resolve", questionId: payload.questionId, answers: [["方案A"], []], client: "web",
    }))
    expect(await waitFor(frames, (f) => f.type === "question.resolved_ack")).toEqual({
      type: "question.resolved_ack", questionId: payload.questionId, ok: true,
    })

    // a second resolve of the same id answers an error frame (entry settled)
    ws.send(JSON.stringify({
      type: "question.resolve", questionId: payload.questionId, answers: [["方案B"]],
    }))
    expect(await waitFor(frames, (f) => f.type === "error" && f.message === "unknown question")).toMatchObject({
      type: "error", message: "unknown question",
    })

    await run
    // exactly one requested/resolved pair reached the subscriber
    expect(frames.filter((f) => f.type === "question.requested")).toHaveLength(1)
    expect(frames.filter((f) => f.type === "question.resolved")).toHaveLength(1)
    const resolved = frames.find((f) => f.type === "question.resolved") as AgentEvent
    expect(resolved.payload).toMatchObject({ questionId: payload.questionId, answers: [["方案A"], []], by: "web" })

    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const result = msgs[2]!.blocks[0] as ToolResultBlock
    expect(result).toMatchObject({ type: "tool_result", callId: "call_q1", status: "ok" })
    expect(result.output).toContain("1. 用哪个方案?\n   → 方案A")
    expect(result.output).toContain("2. 补充说明?\n   → （未回答）")
  }, 15_000)

  it("rejects a malformed answers payload with an error frame", async () => {
    const { env, url } = await makeGateway(scriptClient([textTurn("hi")]))
    const session = env.sessions.create("坏载荷会话")
    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "question.resolve", questionId: "q_x", answers: "nope" }))
    expect(await waitFor(frames, (f) => f.type === "error")).toMatchObject({
      type: "error", message: expect.stringContaining("string[][]"),
    })
    await env.manager.enqueue(session.id, { userText: "hi", trigger: "user" })
  })

  it("answers an error frame for an unknown question id", async () => {
    const { env, url } = await makeGateway(scriptClient([textTurn("hi")]))
    const session = env.sessions.create("未知问题会话")
    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "question.resolve", questionId: "q_missing", answers: [["a"]] }))
    expect(await waitFor(frames, (f) => f.type === "error")).toMatchObject({
      type: "error", message: "unknown question",
    })
    await env.manager.enqueue(session.id, { userText: "hi", trigger: "user" })
  })
})

// --- sessionGrants run 级接线（批次 D）-----------------------------------------
// 引擎的 session_grant 判定批次一就绪；本块验收 run 装配的真实接线：一次
// once 确认把同一收窄规则写入本次 run 的 grant store，同一 run 内同操作
// 不再弹确认（reason session_grant）；reject 不写；config 关闭特性时不接线。

describe("sessionGrants run 级接线", () => {
  it("a once approval grants the SAME call within this run — the repeat call auto-passes, no second confirmation", async () => {
    const { env, url } = await makeGateway(
      scriptClient([
        execToolTurn("call_1", "git push origin main"),
        execToolTurn("call_2", "git push origin main"),
        textTurn("完成"),
      ]),
    )
    const session = env.sessions.create("会话级豁免会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })

    // the first identical call is confirmed once...
    const requested = (await waitFor(frames, (f) =>
      f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === "call_1")) as AgentEvent
    ws.send(JSON.stringify({
      type: "confirmation.resolve",
      confirmationId: (requested.payload as ConfirmationRequestedPayload).confirmationId,
      decision: "once",
    }))
    await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")
    await run

    // ...the second identical call in the SAME run hit the run-scoped grant
    // store (reason session_grant): exactly ONE confirmation was requested.
    const events = frames.filter(isAgentEvent)
    expect(events.filter((e) => e.type === "confirmation.requested")).toHaveLength(1)

    const tools = env.sessions.readMessages(session.id).filter((m) => m.role === "tool") as ToolMessage[]
    expect(tools).toHaveLength(2)
    expect(tools[0]!.grantedBy).toEqual({ call_1: "confirmed" })
    expect(tools[1]!.grantedBy).toEqual({ call_2: "session_grant" })
  }, 30_000)

  it("a reject grants nothing — the same call re-confirms within the run", async () => {
    const { env, url } = await makeGateway(
      scriptClient([
        execToolTurn("call_1", "git push origin main"),
        execToolTurn("call_2", "git push origin main"),
        textTurn("完成"),
      ]),
    )
    const session = env.sessions.create("会话级豁免拒绝会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })

    const resolve = async (callId: string, decision: "once" | "reject") => {
      const requested = (await waitFor(frames, (f) =>
        f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === callId)) as AgentEvent
      ws.send(JSON.stringify({
        type: "confirmation.resolve",
        confirmationId: (requested.payload as ConfirmationRequestedPayload).confirmationId,
        decision,
      }))
      await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")
    }

    await resolve("call_1", "reject")
    await resolve("call_2", "once")
    await run

    // the reject granted nothing: call_2 still needed a human confirmation
    const events = frames.filter(isAgentEvent)
    expect(events.filter((e) => e.type === "confirmation.requested")).toHaveLength(2)
  }, 30_000)

  it("config disables sessionGrants: a once approval does not suppress the repeat confirm", async () => {
    const { env, url } = await makeGateway(
      scriptClient([
        execToolTurn("call_1", "git push origin main"),
        execToolTurn("call_2", "git push origin main"),
        textTurn("完成"),
      ]),
    )
    env.config.permissions.sessionGrants = false // the daemon switched the feature off
    const session = env.sessions.create("会话级豁免关闭会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })

    const resolve = async (callId: string) => {
      const requested = (await waitFor(frames, (f) =>
        f.type === "confirmation.requested" && (f.payload as ConfirmationRequestedPayload).toolCall.callId === callId)) as AgentEvent
      ws.send(JSON.stringify({
        type: "confirmation.resolve",
        confirmationId: (requested.payload as ConfirmationRequestedPayload).confirmationId,
        decision: "once",
      }))
      await waitFor(frames, (f) => f.type === "confirmation.resolved_ack")
    }

    await resolve("call_1")
    await resolve("call_2")
    await run

    const events = frames.filter(isAgentEvent)
    expect(events.filter((e) => e.type === "confirmation.requested")).toHaveLength(2)
  }, 30_000)

  it("a once grant dies with its run: the NEXT run re-confirms the same call", async () => {
    const { env, url } = await makeGateway(
      scriptClient([
        execToolTurn("call_1", "git push origin main"),
        textTurn("第一轮完成"),
        execToolTurn("call_1", "git push origin main"),
        textTurn("第二轮完成"),
      ]),
    )
    const session = env.sessions.create("豁免不跨轮会话")

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    // two identical runs over the same call: each asks once. A grant that
    // outlived its run would silently auto-pass the second one.
    for (let round = 0; round < 2; round++) {
      const run = env.manager.enqueue(session.id, { userText: "执行 git 操作", trigger: "user" })
      const requested = await waitRequested(frames, round)
      ws.send(JSON.stringify({
        type: "confirmation.resolve",
        confirmationId: requested.confirmationId,
        decision: "once",
      }))
      await run
    }

    const events = frames.filter(isAgentEvent)
    expect(events.filter((e) => e.type === "confirmation.requested")).toHaveLength(2)
  }, 30_000)
})

describe("readonly tool visibility", () => {
  it("a readonly run shows the model no sensitive tool; safe tools stay listed", async () => {
    const seen: string[][] = []
    const inner = scriptClient([textTurn("好")])
    const llm: LlmClient = {
      async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
        seen.push(req.tools.map((d) => d.name))
        yield* inner.stream(req)
      },
    }
    const { env, url } = await makeGateway(llm)
    const session = env.sessions.create("只读可见性会话")
    env.sessions.updateMeta(session.id, { mode: "readonly" })

    const ws = await openAuthed(url)
    const frames = collectFrames(ws)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }))
    await waitFor(frames, (f) => f.type === "subscribed")

    await env.manager.enqueue(session.id, { userText: "你好", trigger: "user" })

    expect(seen.length).toBeGreaterThan(0)
    for (const names of seen) {
      // every tool the readonly gate would deny wholesale is gone from the
      // model's view (sensitive today: exec, fs_write, fs_edit)
      expect(names).not.toContain("exec")
      expect(names).not.toContain("fs_write")
      expect(names).not.toContain("fs_edit")
      // safe tools the gate would allow stay visible
      expect(names).toContain("fs_read")
    }
  })
})
