/**
 * Subagent integration suite (issue #16, the server seam): a REAL RunManager
 * + SessionStore under a temp home, a REAL spawner (server/src/subagent.ts)
 * and scripted LLMs — parent and child consume the same script queue in
 * call order (parent tool turn → child answer → parent final).
 *
 * Covers the full delegation contract: child session identity and
 * inheritance, lean prompt + narrowed surface, blocking answer flow-back,
 * live status lines, confirmation forwarding, usage attribution,
 * parent-stop-child-stop, the concurrency cap, list filtering and the
 * delete/purge cascade.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { EventBus, SessionStore, UsageStore, loadConfig, resolvePaths } from "@kclaw/core"
import type {
  AgentEvent, KclawConfig, KclawPaths, LlmClient, LlmRequest, LlmStreamEvent, MemorySystem,
} from "@kclaw/core"
import { RunManager, type RunManagerDeps } from "../src/run.js"
import { createSubagentHost } from "../src/subagent.js"
import { createApp } from "../src/index.js"
import type { FastifyInstance } from "fastify"

// --- fixtures ---------------------------------------------------------------

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class FakeSocket {
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
}

function received(socket: FakeSocket): AgentEvent[] {
  return socket.sent.map((s) => JSON.parse(s) as AgentEvent)
}

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

function spawnTurn(callId: string, task: string, label?: string): LlmStreamEvent[] {
  const args = label === undefined ? { task } : { task, label }
  return [
    { type: "tool_call_started", index: 0, callId, name: "subagent_run" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify(args) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

function spawnBackgroundTurn(callId: string, task: string, label?: string): LlmStreamEvent[] {
  const args = label === undefined ? { task, run_in_background: true } : { task, label, run_in_background: true }
  return [
    { type: "tool_call_started", index: 0, callId, name: "subagent_run" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify(args) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

function collectTurn(callId: string, childSessionId: string): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name: "subagent_collect" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ childSessionId }) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

function execTurn(callId: string, command: string): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name: "exec" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ command }) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

/** A stream that never yields; only the abort signal frees the loop. */
function hangingTurn(): LlmStreamEvent[] {
  // Expressed as a client below — a scripted array can't hang.
  return []
}

function hangingClient(): LlmClient {
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      await new Promise<never>(() => {})
    },
  }
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

interface SubagentEnv {
  paths: KclawPaths
  config: KclawConfig
  sessions: SessionStore
  bus: EventBus
  manager: RunManager
  /** Every bus event, session-scoped included (an own-property emit tap). */
  allEvents: AgentEvent[]
  usage: UsageStore
  host: ReturnType<typeof createSubagentHost>
}

/**
 * The subagent world: RunManager wired with the REAL spawner (late-bound like
 * the daemon), a recording bus and a usage store. `llm` serves every run of
 * both generations in call order.
 */
function makeEnv(llm: LlmClient, patchConfig?: (c: KclawConfig) => void): SubagentEnv {
  const home = mkdtempSync(join(tmpdir(), "kclaw-sub-home-"))
  const workspace = mkdtempSync(join(tmpdir(), "kclaw-sub-ws-"))
  dirs.push(home, workspace)

  const paths = resolvePaths(home)
  const config = loadConfig(paths)
  config.workspace = workspace
  config.sandbox = { enabled: false, writeRoots: [] }
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  patchConfig?.(config)

  const sessions = new SessionStore(paths.sessionsDir)
  const memory = makeMemoryFake()
  const bus = new EventBus()
  const usage = new UsageStore(join(home, "usage.db"))

  const allEvents: AgentEvent[] = []
  const realEmit = bus.emit.bind(bus)
  bus.emit = (e: AgentEvent) => {
    allEvents.push(e)
    realEmit(e)
  }

  let runRef: RunManager | undefined
  const host = createSubagentHost({
    config, sessions, bus, getRun: () => {
      if (runRef === undefined) throw new Error("run manager not ready")
      return runRef
    },
  })
  const manager = new RunManager({
    config, paths, sessions, memory, bus, llm, workspace,
    usageStore: usage,
    subagents: {
      spawner: host.spawner,
      collector: host.collector,
    },
  })
  runRef = manager
  return { paths, config, sessions, bus, manager, allEvents, usage, host }
}

// --- tests ------------------------------------------------------------------

describe("subagent dispatch (integration)", () => {
  it("runs a full delegation: child session identity, lean prompt, answer flow-back", async () => {
    const requests: LlmRequest[] = []
    const inner = scriptClient([
      spawnTurn("call_1", "数到三", "counter"),
      textTurn("一 二 三"),
      textTurn("子代理答复已收到"),
    ])
    const llm: LlmClient = {
      async *stream(req) {
        requests.push(req)
        yield* inner.stream(req)
      },
    }
    const { sessions, manager, allEvents } = makeEnv(llm)
    const parent = sessions.create("主线", undefined, undefined, "acceptEdits")

    const outcome = await manager.enqueue(parent.id, { userText: "派个子代理数到三", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")

    // Child session: identity + inheritance (workdir/mode from the parent).
    const children = sessions.listByParent(parent.id)
    expect(children).toHaveLength(1)
    const child = children[0]!
    expect(child.title).toBe("子代理 · counter")
    expect(child.parentSessionId).toBe(parent.id)
    expect(child.workdir).toBe(sessions.meta(parent.id)!.workdir)
    expect(child.mode).toBe("acceptEdits")

    // The child run announced itself with trigger "agent".
    const childStarted = allEvents.find(
      (e) => e.type === "run.started" && e.sessionId === child.id)
    expect(childStarted?.payload).toEqual({ trigger: "agent" })

    // Child history: exactly the task as the user message + its answer.
    const childMsgs = sessions.readMessages(child.id)
    expect(childMsgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(childMsgs[0]!.blocks[0]).toMatchObject({ type: "text", text: "数到三" })

    // Parent: the spawn's answer rode back as the tool result; no child text leaked.
    const parentMsgs = sessions.readMessages(parent.id)
    const toolMsg = parentMsgs.find((m) => m.role === "tool")!
    expect(toolMsg).toBeDefined()
    const result = toolMsg.blocks.find((b) => b.type === "tool_result") as { status: string; output: string; data?: { childSessionId?: string } }
    expect(result.status).toBe("ok")
    expect(result.output).toBe("一 二 三")
    expect(result.data?.childSessionId).toBe(child.id)

    // Prompt + surface generation gap: parent request 0 carries subagent_run;
    // child request (1) is the lean prompt WITHOUT memory_save/subagent_run.
    const parentReq = requests[0]!
    expect(parentReq.tools.map((t) => t.name)).toContain("subagent_run")
    const childReq = requests[1]!
    expect(childReq.system).toContain("子代理")
    expect(childReq.tools.map((t) => t.name)).not.toContain("memory_save")
    expect(childReq.tools.map((t) => t.name)).not.toContain("subagent_run")
    expect(childReq.tools.map((t) => t.name)).toContain("exec")
    // The parent's follow-up request (2) still has subagent_run available.
    expect(requests[2]!.tools.map((t) => t.name)).toContain("subagent_run")

    // The child's own event stream keeps the full audit (system prompt + sandbox probe).
    const childEvents = sessions.readEvents(child.id)
    expect(childEvents.some((e) => e.type === "system" && e.stable.includes("子代理"))).toBe(true)
    expect(childEvents.some((e) => e.type === "sandbox.checked")).toBe(true)

    // Status lines streamed to the PARENT channel (tool_result.delta).
    const statusDeltas = allEvents.filter(
      (e) => e.type === "tool_result.delta" && e.sessionId === parent.id)
    expect(statusDeltas.length).toBeGreaterThan(0)
  })

  it("forwards child confirmations to the parent channel, labeled, and they resolve via the broker", async () => {
    const requests: LlmRequest[] = []
    const inner = scriptClient([
      spawnTurn("call_1", "跑个命令", "runner"),
      execTurn("call_c", "echo hi"),
      textTurn("命令完成"),
      textTurn("收到"),
    ])
    const llm: LlmClient = {
      async *stream(req) {
        requests.push(req)
        yield* inner.stream(req)
      },
    }
    const { sessions, manager, bus } = makeEnv(llm)
    const parent = sessions.create("主线", undefined, undefined, "default")
    const parentSocket = new FakeSocket()
    bus.subscribe(parent.id, parentSocket)

    const runDone = manager.enqueue(parent.id, { userText: "派子代理跑命令", trigger: "user" })

    // The forwarded card lands on the PARENT channel, labeled with the label.
    const deadline = Date.now() + 5_000
    let card: AgentEvent | undefined
    while (Date.now() < deadline && card === undefined) {
      card = received(parentSocket).find((e) => e.type === "confirmation.requested")
      if (card === undefined) await new Promise((r) => setTimeout(r, 10))
    }
    expect(card).toBeDefined()
    expect(card!.sessionId).toBe(parent.id)
    expect((card!.payload as { noteText?: string }).noteText).toContain("来自子代理 runner")
    expect((card!.payload as { toolCall: { name: string } }).toolCall.name).toBe("exec")

    // A human verdict through the shared broker settles the child's gate.
    expect(manager.broker.resolve(
      (card!.payload as { confirmationId: string }).confirmationId, "once", "web")).toBe(true)

    const outcome = await runDone
    expect(outcome.stopReason).toBe("end_turn")
    // The child's exec was granted by the human verdict.
    const children = sessions.listByParent(parent.id)
    const childToolMsg = sessions.readMessages(children[0]!.id).find((m) => m.role === "tool")!
    expect(childToolMsg.grantedBy).toMatchObject({ call_c: "confirmed" })
  })

  it("attributes the child's tokens to the parent session in the usage ledger", async () => {
    const llm = scriptClient([
      spawnTurn("call_1", "干点活"),
      textTurn("干完了"),
      textTurn("好的"),
    ])
    const { sessions, manager, usage } = makeEnv(llm)
    const parent = sessions.create("主线")

    await manager.enqueue(parent.id, { userText: "去干活", trigger: "user" })

    const bySession = usage.aggregate("session", {})
    const child = sessions.listByParent(parent.id)[0]!
    // Parent key holds BOTH runs' tokens; the child key never appears.
    const parentRow = bySession.find((r) => r.key === parent.id)
    expect(parentRow).toBeDefined()
    expect(bySession.find((r) => r.key === child.id)).toBeUndefined()
  })

  it("parent-stop-child-stop: cancelling the parent aborts the in-flight child", async () => {
    // Parent turn 0 spawns; the child then hangs mid-stream; the parent's
    // abort must cancel the child and settle the whole tree.
    const parentScript = scriptClient([
      spawnTurn("call_1", "慢慢干"),
      textTurn("never reached"),
    ])
    const requests: LlmRequest[] = []
    let childStarted = false
    const llm: LlmClient = {
      async *stream(req) {
        requests.push(req)
        if (!childStarted) {
          childStarted = true // first call is the parent's spawn turn
          yield* parentScript.stream(req)
        } else if (requests.length === 2) {
          // second call = the child's turn: hang until aborted
          yield { type: "text_delta", delta: "半截" }
          await new Promise<never>(() => {})
        } else {
          yield* parentScript.stream(req)
        }
      },
    }
    const { sessions, manager, allEvents } = makeEnv(llm)
    const parent = sessions.create("主线")

    const runDone = manager.enqueue(parent.id, { userText: "派出去", trigger: "user" })
    // Wait until the child run has actually started, then cancel the parent.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !allEvents.some((e) => e.type === "run.started" && e.payload && (e.payload as { trigger?: string }).trigger === "agent")) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(manager.cancel(parent.id)).toBe(true)

    const outcome = await runDone
    expect(outcome.stopReason).toBe("aborted")
    // The child settled aborted too — no orphan run keeps streaming.
    const child = sessions.listByParent(parent.id)[0]!
    const childCompleted = allEvents.find(
      (e) => e.type === "run.completed" && e.sessionId === child.id) as AgentEvent<"run.completed"> | undefined
    expect(childCompleted?.payload.stopReason).toBe("aborted")
    // The half-streamed child text persisted with the abort semantics.
    const childMsgs = sessions.readMessages(child.id)
    const childAssistant = childMsgs.find((m) => m.role === "assistant")!
    expect(childAssistant.stopReason).toBe("aborted")
  })

  it("caps concurrent subagents per parent run; the over-cap spawn errors immediately", async () => {
    // maxConcurrent=1; one batch with two spawns: the first blocks on a
    // hanging child, the second must come back as an immediate cap error.
    const llm = scriptClient([
      [
        { type: "tool_call_started", index: 0, callId: "call_1", name: "subagent_run" },
        { type: "tool_call_delta", index: 0, delta: JSON.stringify({ task: "甲" }) },
        { type: "tool_call_started", index: 1, callId: "call_2", name: "subagent_run" },
        { type: "tool_call_delta", index: 1, delta: JSON.stringify({ task: "乙" }) },
        { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
      ],
      textTurn("never"), // child answer (hanging actually — see below)
    ])
    // Make the child hang so the first spawn stays live while the second is checked.
    const realClient = llm
    let firstCallDone = false
    const wrapped: LlmClient = {
      async *stream(req) {
        if (!firstCallDone) {
          firstCallDone = true
          yield* realClient.stream(req) // parent's spawn turn
        } else {
          // child turn: hang
          yield { type: "text_delta", delta: "…" }
          await new Promise<never>(() => {})
        }
      },
    }
    const { sessions, manager } = makeEnv(wrapped, (c) => {
      c.subagents = { maxConcurrent: 1 }
    })
    const parent = sessions.create("主线")

    const runDone = manager.enqueue(parent.id, { userText: "并行派两个", trigger: "user" })
    // Give the batch a moment to schedule both spawns, then cancel the parent
    // to unwind the hanging child — the run settles aborted either way.
    await new Promise((r) => setTimeout(r, 100))
    manager.cancel(parent.id)
    const outcome = await runDone

    // Only ONE child session was created (the cap held before creation).
    expect(sessions.listByParent(parent.id)).toHaveLength(1)
    // The over-cap spawn returned the cap error in its tool result.
    const toolMsg = sessions.readMessages(parent.id).find((m) => m.role === "tool")!
    const outputs = toolMsg.blocks.filter((b) => b.type === "tool_result") as Array<{ output: string }>
    expect(outputs.some((r) => r.output.includes("并发上限"))).toBe(true)
    expect(["aborted", "error"]).toContain(outcome.stopReason)
  })
})

describe("subagent visibility routes", () => {
  let home: string
  let store: SessionStore
  let app: FastifyInstance

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kclaw-sub-routes-"))
    dirs.push(home)
    store = new SessionStore(join(home, "sessions"))
    const config = loadConfig(resolvePaths(home))
    app = await createApp({ home, token: "t1", stores: { sessions: store, config } })
  })
  afterEach(async () => {
    await app.close()
  })

  it("GET /sessions hides children by default; children=true lists them", async () => {
    const parent = store.create("主线")
    store.create("子代理 · x", undefined, undefined, "default", parent.id)
    const plain = await app.inject({ method: "GET", url: "/sessions", headers: { authorization: "Bearer t1" } })
    expect((plain.json() as Array<{ id: string }>).map((m) => m.id)).toEqual([parent.id])
    const withChildren = await app.inject({ method: "GET", url: "/sessions?children=true", headers: { authorization: "Bearer t1" } })
    expect(withChildren.json()).toHaveLength(2)
    // By-id access stays open (the audit page's entry point).
    const child = store.listByParent(parent.id)[0]!
    const direct = await app.inject({ method: "GET", url: `/sessions/${child.id}`, headers: { authorization: "Bearer t1" } })
    expect(direct.statusCode).toBe(200)
    const events = await app.inject({ method: "GET", url: `/sessions/${child.id}/events`, headers: { authorization: "Bearer t1" } })
    expect(events.statusCode).toBe(200)
  })

  it("deleting the parent soft-deletes children; purging the parent purges them", async () => {
    const parent = store.create("主线")
    const child = store.create("子代理 · x", undefined, undefined, "default", parent.id)
    const AUTH = { authorization: "Bearer t1" }

    const del = await app.inject({ method: "DELETE", url: `/sessions/${parent.id}`, headers: AUTH })
    expect(del.statusCode).toBe(200)
    expect(store.meta(child.id)!.deleted).toBe(true)
    // Restoring the parent does not resurrect children (they left with it).
    await app.inject({ method: "POST", url: `/sessions/${parent.id}/restore`, headers: AUTH })
    expect(store.meta(child.id)!.deleted).toBe(true)

    // Re-delete the parent, then purge: both directories go.
    await app.inject({ method: "DELETE", url: `/sessions/${parent.id}`, headers: AUTH })
    const purge = await app.inject({ method: "POST", url: `/sessions/${parent.id}/purge`, headers: AUTH })
    expect(purge.statusCode).toBe(200)
    expect(store.meta(child.id)).toBeUndefined()
    expect(store.meta(parent.id)).toBeUndefined()
  })
})

// --- background mode (issue #22) ----------------------------------------------

/** Poll until `pred` holds on the parent's messages; throws on timeout. */
async function until(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("subagent background mode", () => {
  it("dispatches immediately, the parent run finishes first, and a completion notice lands without a run", async () => {
    // Parent and child turns are served SEPARATELY (keyed on the lean child
    // prompt) — a global script would be a scheduling race now that the child
    // runs concurrently with its parent's remainder.
    const parentScript = [
      spawnBackgroundTurn("call_1", "慢慢调研", "crawler"),
      textTurn("已派出，先干别的"),
    ]
    const childScript = [textTurn("调研结论：一切正常")]
    let parentCalls = 0
    let childCalls = 0
    const llm: LlmClient = {
      async *stream(req) {
        if (req.system.includes("子代理")) yield* childScript[Math.min(childCalls++, childScript.length - 1)]!
        else yield* parentScript[Math.min(parentCalls++, parentScript.length - 1)]!
      },
    }
    const { sessions, manager, allEvents, host } = makeEnv(llm)
    const parent = sessions.create("主线")

    const outcome = await manager.enqueue(parent.id, { userText: "后台调研一下", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")

    // The dispatch result came back immediately: child id + collect hint, NOT the answer.
    const parentMsgs = sessions.readMessages(parent.id)
    const toolMsg = parentMsgs.find((m) => m.role === "tool")!
    const result = toolMsg.blocks.find((b) => b.type === "tool_result") as { status: string; output: string; data?: { childSessionId?: string } }
    expect(result.status).toBe("ok")
    expect(result.output).toContain("已在后台派出子代理「crawler」")
    expect(result.output).toContain("subagent_collect")
    const childId = result.data!.childSessionId!
    expect(sessions.meta(childId)!.parentSessionId).toBe(parent.id)

    // The child still runs to completion AFTER the parent run has ended.
    await until(() => sessions.readMessages(childId).some((m) => m.role === "assistant"), "child answer")

    // The completion notice: one assistant message with a system note on the parent.
    await until(() => sessions.readMessages(parent.id).some((m) => m.role === "assistant" && m.id !== parentMsgs.find((x) => x.role === "assistant")?.id), "notice message")
    const notice = sessions.readMessages(parent.id).filter((m) => m.role === "assistant").at(-1)!
    const note = notice.blocks[0]! as { type: string; kind: string; text: string }
    expect(note.type).toBe("note")
    expect(note.kind).toBe("system")
    expect(note.text).toContain("后台子代理「crawler」已完成")
    expect(note.text).toContain("调研结论：一切正常")
    expect(note.text).toContain(`childSessionId: ${childId}`)

    // The notice was announced on the parent channel (message.created/completed)…
    const created = allEvents.filter((e) => e.type === "message.created" && e.sessionId === parent.id)
    expect(created.some((e) => e.payload.message.id === notice.id)).toBe(true)
    expect(allEvents.some((e) => e.type === "message.completed" && e.sessionId === parent.id && e.payload.message.id === notice.id)).toBe(true)
    // …but it triggered NO run: the parent started exactly one run (the user's).
    expect(allEvents.filter((e) => e.type === "run.started" && e.sessionId === parent.id)).toHaveLength(1)

    // Collect now returns the child's full answer.
    const collected = await host.collector({ parentSessionId: parent.id, childSessionId: childId })
    expect(collected.status).toBe("ok")
    expect(collected.output).toBe("调研结论：一切正常")
  })

  it("collect is gated to the parent's own children and reports unknown ids", async () => {
    const { sessions, host } = makeEnv(scriptClient([textTurn("hi")]))
    const parent = sessions.create("主线")
    const stranger = sessions.create("别人家")

    expect((await host.collector({ parentSessionId: parent.id, childSessionId: "ses_missing" })).status).toBe("error")
    expect((await host.collector({ parentSessionId: parent.id, childSessionId: "ses_missing" })).output).toContain("不存在")
    // A real session that is NOT this parent's child is refused.
    const foreign = (await host.collector({ parentSessionId: stranger.id, childSessionId: parent.id }))
    expect(foreign.status).toBe("error")
    expect(foreign.output).toContain("不是当前会话派出的子代理")
  })

  it("collect returns a not-yet answer while the child is still producing", async () => {
    const parentScript = [
      spawnBackgroundTurn("call_1", "慢慢跑", "slow"),
      textTurn("好"),
    ]
    const childScript = [textTurn("终于完成")]
    let parentCalls = 0
    let childCalls = 0
    const llm: LlmClient = {
      async *stream(req) {
        if (req.system.includes("子代理")) yield* childScript[Math.min(childCalls++, childScript.length - 1)]!
        else yield* parentScript[Math.min(parentCalls++, parentScript.length - 1)]!
      },
    }
    const { sessions, manager, host } = makeEnv(llm)
    const parent = sessions.create("主线")
    await manager.enqueue(parent.id, { userText: "派后台", trigger: "user" })
    const childId = sessions.listByParent(parent.id)[0]!.id

    // The child may not have produced its answer yet — collect says so, not an error.
    const early = await host.collector({ parentSessionId: parent.id, childSessionId: childId })
    if (early.status === "ok" && early.output.includes("还没有可收集的答复")) return
    // If the child already finished (scheduling), the answer is there instead.
    expect(early.output).toContain("终于完成")
    await until(() => sessions.readMessages(childId).some((m) => m.role === "assistant"), "child answer")
  })

  it("cancelBackgroundForParent stops live background children when the parent dies; a settled child notifies '未正常完成'", async () => {
    const parentScript = [
      spawnBackgroundTurn("call_1", "永跑任务", "zombie"),
      textTurn("派出去了"),
    ]
    let parentCalls = 0
    const llm: LlmClient = {
      async *stream(req) {
        // The child hangs forever (its lean prompt identifies it); only the
        // cancel can free it. The parent consumes its own script in order.
        if (req.system.includes("子代理")) await new Promise<never>(() => {})
        yield* parentScript[Math.min(parentCalls++, parentScript.length - 1)]!
      },
    }
    const { sessions, manager, host } = makeEnv(llm)
    const parent = sessions.create("主线")

    const outcome = await manager.enqueue(parent.id, { userText: "后台永跑", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")

    // Wait for the background child's run to actually start, then cancel it
    // through the parent-delete seam.
    const childId = sessions.listByParent(parent.id)[0]!.id
    await until(() => sessions.readMessages(childId).length > 0, "child run started")

    expect(host.cancelBackgroundForParent(parent.id)).toBe(1)
    // Give the outcome a beat to settle, then check the failure notice.
    await until(() => {
      const msgs = sessions.readMessages(parent.id).filter((m) => m.role === "assistant")
      const last = msgs.at(-1)
      return last !== undefined && last.blocks[0]!.type === "note" && (last.blocks[0] as { text: string }).text.includes("未正常完成")
    }, "failure notice", 8_000)
  }, 20_000)

  it("前台子代理完成不清掉后台记录：两种模式各记各的账", async () => {
    // 同一父会话先后派一个后台子代理（永跑）和一个前台子代理（立刻完成）。
    // 前台的收尾绝不能影响后台的记录——级联取消必须仍能找到后台孩子。
    // （曾经双份按父分组的账本让收尾误删对方的记录，级联取消扑空。）
    const parentScript = [
      spawnBackgroundTurn("call_1", "永跑任务", "bg"),
      spawnTurn("call_2", "快速任务"),
      textTurn("都派出去了"),
    ]
    let parentCalls = 0
    let childCalls = 0
    const llm: LlmClient = {
      async *stream(req) {
        // 子代理的精简提示词里没有任务文本以外的区分——借首条 user 消息里的
        // 任务名分流：前台孩子立刻完成，后台孩子永跑（只有级联取消能终结）。
        if (req.system.includes("子代理")) {
          childCalls++
          if (JSON.stringify(req.messages).includes("快速任务")) yield* [textTurn("干完了")]
          else await new Promise<never>(() => {})
          return
        }
        yield* parentScript[Math.min(parentCalls++, parentScript.length - 1)]!
      },
    }
    const { sessions, manager, host } = makeEnv(llm)
    const parent = sessions.create("主线")

    // 派发是阻塞式的：run 完成即前台子代理（连同它的记账收尾）已结束
    const outcome = await manager.enqueue(parent.id, { userText: "一前一后", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")

    // 前台已收尾；后台仍在册——级联取消恰好找到它并终结
    expect(host.cancelBackgroundForParent(parent.id)).toBe(1)
    await until(() => {
      const msgs = sessions.readMessages(parent.id).filter((m) => m.role === "assistant")
      const last = msgs.at(-1)
      return last !== undefined && last.blocks[0]!.type === "note" && (last.blocks[0] as { text: string }).text.includes("未正常完成")
    }, "failure notice", 8_000)
    // 收尾后账本彻底清空
    expect(host.cancelBackgroundForParent(parent.id)).toBe(0)
  }, 20_000)
})

describe("subagent background card forwarding", () => {
  it("forwards a background child's confirmation card to the parent channel and completes after the verdict", async () => {
    // Default config: allow list empty → the child's exec call needs a
    // confirmation. In background mode the card must STILL reach the parent
    // channel (status lines are muted; cards are not).
    const parentScript = [
      spawnBackgroundTurn("call_1", "跑个命令", "bg-runner"),
      textTurn("派出去了"),
    ]
    const childScript = [execTurn("call_c", "echo hi"), textTurn("命令完成")]
    let parentCalls = 0
    let childCalls = 0
    const llm: LlmClient = {
      async *stream(req) {
        if (req.system.includes("子代理")) yield* childScript[Math.min(childCalls++, childScript.length - 1)]!
        else yield* parentScript[Math.min(parentCalls++, parentScript.length - 1)]!
      },
    }
    const { sessions, manager, bus } = makeEnv(llm)
    const parent = sessions.create("主线")
    const socket = new FakeSocket()
    bus.subscribe(parent.id, socket)

    const outcome = await manager.enqueue(parent.id, { userText: "后台跑命令", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn") // the parent is NOT blocked by the child

    // The card lands on the parent channel, labeled with the background child.
    const deadline = Date.now() + 5_000
    let card: AgentEvent | undefined
    while (Date.now() < deadline && card === undefined) {
      card = received(socket).find((e) => e.type === "confirmation.requested")
      if (card === undefined) await new Promise((r) => setTimeout(r, 10))
    }
    expect(card).toBeDefined()
    expect(card!.sessionId).toBe(parent.id)
    expect((card!.payload as { noteText?: string }).noteText).toContain("来自子代理 bg-runner")
    expect((card!.payload as { toolCall: { name: string } }).toolCall.name).toBe("exec")

    // Approving lets the background child finish; the completion notice follows.
    expect(manager.broker.resolve((card!.payload as { confirmationId: string }).confirmationId, "once", "web")).toBe(true)
    await until(() => {
      const msgs = sessions.readMessages(parent.id).filter((m) => m.role === "assistant")
      const last = msgs.at(-1)
      return last !== undefined && last.blocks[0]!.type === "note" && (last.blocks[0] as { text: string }).text.includes("已完成")
    }, "completion notice", 8_000)
  }, 15_000)
})
