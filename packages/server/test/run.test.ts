/**
 * RunManager integration tests: the daemon-side send_message → runAgent
 * assembly on REAL stores under a temp KCLAW_HOME, driven by a scripted
 * LlmClient (local twin of the scripted-client helpers).
 *
 * Covers: happy text turn (outcome + JSONL + bus fan-out), memory note
 * injection onto the user message, per-session serialization vs cross-session
 * concurrency, the whitelisted tool round, and cancel() of a hanging
 * run.
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ConfirmationBroker, EventBus, SessionStore, UsageStore, loadConfig, newAssistantMessage, newMessage, resolvePaths, withRetry } from "@kclaw/core"
import type {
  AgentEvent, AssistantMessage, KclawConfig, KclawPaths, LlmClient, LlmRequest, LlmStreamEvent, MemorySystem, Message, ToolExecutor, ToolMessage, ToolResultBlock,
} from "@kclaw/core"
import { RunManager, type RunManagerDeps } from "../src/run.js"

// --- fixtures ---------------------------------------------------------------

/** Temp dirs to sweep in afterEach. */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Minimal in-memory stand-in for a subscribed socket (ws.test.ts pattern). */
class FakeSocket {
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
}

function received(socket: FakeSocket): AgentEvent[] {
  return socket.sent.map((s) => JSON.parse(s) as AgentEvent)
}

/** Poll the fake socket until an event of `type` arrives (bounded). */
async function waitForEvent(socket: FakeSocket, type: AgentEvent["type"], timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (received(socket).some((e) => e.type === type)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for event ${type}`)
}

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
  return execToolTurnWithUsage(callId, command, 1)
}

/** tool_use round whose usage anchors the NEXT waterline check (drives the red line). */
function execToolTurnWithUsage(callId: string, command: string, inputTokens: number): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name: "exec" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ command }) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens, outputTokens: 2 } },
  ]
}

function fsReadToolTurn(callId: string, path: string): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name: "fs_read" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ path }) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
  ]
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
  memory: MemorySystem
  bus: EventBus
}

/** A MemorySystem stand-in: injection/tool seams are vi.fn stubs the tests drive. */
function makeMemoryFake(): MemorySystem {
  return {
    searchEpisodes: vi.fn(async () => []),
    searchAll: vi.fn(async () => []),
    triggerImmediate: vi.fn(async () => undefined),
    cognitionPrompt: () => "",
  } as unknown as MemorySystem
}

/** Real stores under a fresh temp home; config defaults + a mock provider entry. */
function makeEnv(
  llm: LlmClient,
  patchConfig?: (c: KclawConfig) => void,
  resolveConfirmation?: RunManagerDeps["resolveConfirmation"],
  extraDeps?: Partial<RunManagerDeps>,
): { env: Env; manager: RunManager } {
  const home = mkdtempSync(join(tmpdir(), "kclaw-run-home-"))
  const workspace = mkdtempSync(join(tmpdir(), "kclaw-run-ws-"))
  dirs.push(home, workspace)

  const paths = resolvePaths(home)
  const config = loadConfig(paths)
  config.workspace = workspace
  // These tests exercise confirmation / queueing semantics on a host that may
  // have an exec sandbox (macOS Seatbelt / Linux bwrap): sandboxed exec would
  // auto-pass instead of confirming. Disable it — the sandbox is exercised in
  // core's provider tests, not here.
  config.sandbox = { enabled: false, writeRoots: [] }
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  patchConfig?.(config)

  const sessions = new SessionStore(paths.sessionsDir)
  const memory = makeMemoryFake()
  const bus = new EventBus()

  const manager = new RunManager({
    config, paths, sessions, memory, bus, llm, workspace, resolveConfirmation, ...extraDeps,
  })
  return { env: { paths, config, sessions, memory, bus }, manager }
}

// --- tests ------------------------------------------------------------------

describe("RunManager.enqueue", () => {
  it("runs a text turn end to end: outcome, JSONL, bus fan-out", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("你好呀")]))
    const session = env.sessions.create("测试会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const outcome = await manager.enqueue(session.id, { userText: "打个招呼", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")

    // JSONL: user (note-less) then assistant
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(msgs[0]!.blocks).toEqual([
      { id: expect.any(String), type: "text", text: "打个招呼" },
    ])
    const assistant = msgs[1] as AssistantMessage
    expect(assistant.model).toBe("mock-model")
    expect(assistant.blocks[0]).toMatchObject({ type: "text", text: "你好呀" })

    // bus: subscribed socket saw run.started … run.completed, all for this session
    const events = received(socket)
    expect(events[0]!.type).toBe("run.started")
    expect(events[0]!.payload).toEqual({ trigger: "user" })
    expect(events.at(-1)!.type).toBe("run.completed")
    expect(events.every((e) => e.sessionId === session.id)).toBe(true)
  })

  it("injects matching memory notes onto the user message", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("好的")]))
    vi.mocked(env.memory.searchEpisodes).mockResolvedValue([
      { topic: "shanghai", title: "用户在上海", date: "2026-08-01", text: "用户在上海，喜欢本帮菜", score: 1 },
    ])
    const session = env.sessions.create("记忆会话")

    await manager.enqueue(session.id, { userText: "上海 本帮菜", trigger: "user" })

    const [user] = env.sessions.readMessages(session.id)
    expect(user!.blocks).toEqual([
      { id: expect.any(String), type: "text", text: "上海 本帮菜" },
      {
        id: expect.any(String), type: "note", kind: "memory",
        text: "相关经历（用户在上海）: 用户在上海，喜欢本帮菜",
      },
    ])
  })

  it("appends a job note block onto the user message when enqueue carries note", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("好的")]))
    const session = env.sessions.create("任务会话")

    await manager.enqueue(session.id, {
      userText: "执行任务",
      trigger: "job",
      note: "本会话由定时任务「早报」触发",
    })

    const [user] = env.sessions.readMessages(session.id)
    expect(user!.blocks).toEqual([
      { id: expect.any(String), type: "text", text: "执行任务" },
      {
        id: expect.any(String), type: "note", kind: "job",
        text: "本会话由定时任务「早报」触发",
      },
    ])
  })

  it("emits user message lifecycle + note.emitted on the bus in wire order", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("好的")]))
    vi.mocked(env.memory.searchEpisodes).mockResolvedValue([
      { topic: "sh", title: "用户在上海", date: "2026-08-01", text: "用户在上海", score: 1 },
    ])
    const session = env.sessions.create("补发会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    await manager.enqueue(session.id, {
      userText: "上海",
      trigger: "job",
      note: "本会话由定时任务「早报」触发",
    })

    // wire order: run.started → message.created(user SKELETON) →
    // note.emitted ×N (job note first, memory notes after) →
    // message.completed(user FULL) → llm.started …
    const events = received(socket)
    expect(events.slice(0, 5).map((e) => e.type)).toEqual([
      "run.started", "message.created", "note.emitted", "note.emitted", "message.completed",
    ])
    expect(events[5]!.type).toBe("llm.started")

    const createdMsg = (events[1]!.payload as { message: { id: string; role: string; blocks: unknown[] } }).message
    expect(createdMsg.role).toBe("user")
    // the skeleton announced by created carries the text block ONLY — notes
    // are appended (and announced) before completed, never before created
    expect(createdMsg.blocks).toEqual([{ id: expect.any(String), type: "text", text: "上海" }])

    const [jobNote, memNote] = events.slice(2, 4)
    expect(jobNote!.payload).toEqual({
      messageId: createdMsg.id,
      block: { id: expect.any(String), type: "note", kind: "job", text: "本会话由定时任务「早报」触发" },
    })
    expect(memNote!.payload).toEqual({
      messageId: createdMsg.id,
      block: { id: expect.any(String), type: "note", kind: "memory", text: "相关经历（用户在上海）: 用户在上海" },
    })
    // note events carry the run context — run.started is always a run's first
    // event and precedes the hook, so runId is already known here
    const started = events[0]!
    for (const e of [jobNote!, memNote!]) {
      expect(e.sessionId).toBe(session.id)
      expect(e.runId).toBe(started.runId)
    }

    // completed carries the FULL message: text + job note + memory note
    const completedMsg = (events[4]!.payload as { message: { blocks: unknown[] } }).message
    expect(completedMsg.blocks).toEqual([
      { id: expect.any(String), type: "text", text: "上海" },
      { id: expect.any(String), type: "note", kind: "job", text: "本会话由定时任务「早报」触发" },
      { id: expect.any(String), type: "note", kind: "memory", text: "相关经历（用户在上海）: 用户在上海" },
    ])

    // persisted exactly once, notes included (no skeleton line in the JSONL)
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(msgs[0]!.blocks).toEqual(completedMsg.blocks)
  })

  it("user message events flow even when there are no notes to inject", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("好的")]))
    const session = env.sessions.create("无记忆会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    await manager.enqueue(session.id, { userText: "你好", trigger: "user" })

    const events = received(socket)
    expect(events.slice(0, 3).map((e) => e.type)).toEqual([
      "run.started", "message.created", "message.completed",
    ])
    expect(events[3]!.type).toBe("llm.started")
    expect(events.filter((e) => e.type === "note.emitted")).toHaveLength(0)
    const createdMsg = (events[1]!.payload as { message: { role: string } }).message
    expect(createdMsg.role).toBe("user")
    expect(env.sessions.readMessages(session.id).map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("terminates with run.failed when user message persistence throws (fix 1)", async () => {
    const { env } = makeEnv(scriptClient([textTurn("好的")]))
    const session = env.sessions.create("炸盘会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    // A SessionStore view whose appendMessage always throws (everything else
    // delegates through the prototype): the realistic server-side throw point
    // is the user-message JSONL append inside the onUserMessage hook.
    const failingStore = Object.create(env.sessions) as SessionStore
    Object.defineProperty(failingStore, "appendMessage", {
      value(): void {
        throw new Error("disk full: cannot append message")
      },
    })
    const manager = new RunManager({
      config: env.config, paths: env.paths, sessions: failingStore,
      memory: env.memory, bus: env.bus,
      llm: scriptClient([textTurn("好的")]), workspace: env.config.workspace,
    })

    // enqueue RESOLVES (never rejects) with the error outcome
    const outcome = await manager.enqueue(session.id, { userText: "写不进去", trigger: "user" })
    expect(outcome.stopReason).toBe("error")

    // Bus invariant: run.started … run.failed (terminal),
    // the user message announced but never completed, no llm call
    const events = received(socket)
    expect(events[0]!.type).toBe("run.started")
    expect(events.at(-1)!.type).toBe("run.failed")
    expect(events.at(-1)!.payload).toEqual({
      error: { code: "user_message_failed", message: "disk full: cannot append message" },
    })
    expect(events.some((e) => e.type === "message.created")).toBe(true)
    expect(events.some((e) => e.type === "message.completed")).toBe(false)
    expect(events.some((e) => e.type === "llm.started")).toBe(false)
    expect(events.every((e) => e.sessionId === session.id)).toBe(true)

    // nothing was persisted, and the session's queue survives the failure —
    // a later enqueue still runs (and fails the same, honest) way
    expect(env.sessions.readMessages(session.id)).toEqual([])
    const again = await manager.enqueue(session.id, { userText: "还是写不进去", trigger: "user" })
    expect(again.stopReason).toBe("error")
  })

  it("serializes enqueues on one session", async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        const call = ++calls
        order.push(`llm-${call}`)
        if (call === 1) await gate // first run hangs on a manual gate
        yield { type: "text_delta", delta: `答${call}` }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { env, manager } = makeEnv(llm)
    const session = env.sessions.create("串行会话")

    const first = manager.enqueue(session.id, { userText: "第一句", trigger: "user" })
    // 排队在新队列模型里是显式处置（默认 steer 进引导缓冲）：测串行化需显式 wait
    const second = manager.enqueue(session.id, { userText: "第二句", trigger: "user", disposition: "wait" })

    // the first run reached its hang; the second has not started at all —
    // not even its user message was appended
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual(["llm-1"])
    expect(env.sessions.readMessages(session.id).map((m) => m.role)).toEqual(["user"])

    release()
    const [outcome1, outcome2] = await Promise.all([first, second])
    expect(outcome1.stopReason).toBe("end_turn")
    expect(outcome2.stopReason).toBe("end_turn")
    expect(order).toEqual(["llm-1", "llm-2"])
    // clean interleave: user,assistant,user,assistant in the JSONL
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(msgs[0]!.blocks[0]).toMatchObject({ text: "第一句" })
    expect(msgs[2]!.blocks[0]).toMatchObject({ text: "第二句" })
  })

  it("runs enqueues on different sessions concurrently", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        if (++calls === 1) await gate // session A hangs, session B completes
        yield { type: "text_delta", delta: "好" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { env, manager } = makeEnv(llm)
    const a = env.sessions.create("会话A")
    const b = env.sessions.create("会话B")

    let aSettled = false
    const runA = manager.enqueue(a.id, { userText: "慢的", trigger: "user" }).then((o) => {
      aSettled = true
      return o
    })
    const runB = manager.enqueue(b.id, { userText: "快的", trigger: "user" })

    expect((await runB).stopReason).toBe("end_turn") // B done while A still hangs
    await new Promise((r) => setTimeout(r, 20))
    expect(aSettled).toBe(false)

    release()
    expect((await runA).stopReason).toBe("end_turn")
    expect(env.sessions.readMessages(b.id).map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("executes a whitelisted tool round and records grantedBy on the tool message", async () => {
    const { env, manager } = makeEnv(
      scriptClient([execToolTurn("call_1", "echo ok"), textTurn("完成")]),
      (c) => {
        c.permissions.allow = ["exec:echo*"]
      },
    )
    const session = env.sessions.create("工具会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const outcome = await manager.enqueue(session.id, { userText: "执行 echo ok", trigger: "job" })

    expect(outcome.stopReason).toBe("end_turn")
    expect(received(socket)[0]!.payload).toEqual({ trigger: "job" })
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const result = msgs[2]!.blocks[0] as ToolResultBlock
    expect(result).toMatchObject({ type: "tool_result", callId: "call_1", status: "ok" })
    expect(result.output).toContain("ok")

    // the granted reason landed on the tool message (whitelisted decision)
    expect((msgs[2] as ToolMessage).grantedBy).toEqual({ call_1: "whitelist" })
  })

  it("runs builtin tools inside the session's workdir when the session has one", async () => {
    const { env, manager } = makeEnv(
      scriptClient([execToolTurn("call_wd", "pwd"), textTurn("完成")]),
      (c) => {
        c.permissions.allow = ["exec:pwd*"]
      },
    )
    const sessionWorkdir = mkdtempSync(join(tmpdir(), "kclaw-session-ws-"))
    dirs.push(sessionWorkdir)
    const session = env.sessions.create("工作目录会话", undefined, sessionWorkdir)

    const outcome = await manager.enqueue(session.id, { userText: "告诉我你在哪", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")
    const result = env.sessions.readMessages(session.id)[2]!.blocks[0] as ToolResultBlock
    expect(result).toMatchObject({ type: "tool_result", callId: "call_wd", status: "ok" })
    // `pwd` prints the resolved path (macOS /var → /private/var), so compare
    // against realpathSync rather than the symlinked tmpdir path.
    expect(result.output).toContain(realpathSync(sessionWorkdir))
  })

  it("answers default-wired confirmations through the internal broker and records grantedBy confirmed", async () => {
    // default config: allow is empty, so exec falls through to confirmation;
    // default deps construct an internal broker (exposed as manager.broker)
    const { env, manager } = makeEnv(scriptClient([execToolTurn("call_2", "echo yes"), textTurn("好")]))
    expect(manager.broker).toBeInstanceOf(ConfirmationBroker)
    const session = env.sessions.create("确认会话")

    const run = manager.enqueue(session.id, { userText: "执行 echo yes", trigger: "user" })

    // the confirmation registers on the broker; answer it like the gateway would
    const deadline = Date.now() + 2000
    while (manager.broker.pending().length === 0) {
      if (Date.now() > deadline) throw new Error("confirmation never became pending")
      await new Promise((r) => setTimeout(r, 5))
    }
    const [listed] = manager.broker.pending()
    expect(listed).toMatchObject({
      confirmationId: expect.stringMatching(/^conf_/),
      toolCall: expect.objectContaining({ name: "exec" }),
      risk: "sensitive",
    })
    expect(manager.broker.resolve(listed!.confirmationId, true, "cli")).toBe(true)

    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(msgs[2]!.blocks[0]).toMatchObject({ type: "tool_result", status: "ok" })

    expect((msgs[2] as ToolMessage).grantedBy).toEqual({ call_2: "confirmed" })
  })

  it("exec with the OS sandbox available auto-passes as sandboxed, no confirmation", async () => {
    // The real run-assembly probe must find a usable sandbox on this host
    // (macOS sandbox-exec / Linux bwrap). Hosts without one (e.g. a CI runner
    // with no bwrap) fall back to confirmation and this assertion cannot hold.
    const hasHostSandbox =
      process.platform === "darwin" ||
      spawnSync("which", ["bwrap"], { encoding: "utf8" }).status === 0
    if (!hasHostSandbox) return

    // makeEnv turns the sandbox OFF by default (the confirmation suites need
    // it); this suite explicitly re-enables it to drive the sandboxed path.
    const { env, manager } = makeEnv(
      scriptClient([execToolTurn("call_sbx", "echo sandboxed"), textTurn("完成")]),
      (c) => { c.sandbox = { enabled: true, writeRoots: [] } },
    )
    const session = env.sessions.create("沙箱会话")
    const outcome = await manager.enqueue(session.id, { userText: "执行 echo sandboxed", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")
    const msgs = env.sessions.readMessages(session.id)
    const toolMsg = msgs.find((m) => m.role === "tool") as ToolMessage
    // grantedBy sandboxed, and NOT confirmed — no human was in the loop
    expect(toolMsg.grantedBy).toEqual({ call_sbx: "sandboxed" })
    const result = toolMsg.blocks[0] as ToolResultBlock
    expect(result.status).toBe("ok")
    expect(result.output).toContain("sandboxed")
    expect(manager.broker.pending()).toEqual([])
  })

  it("fs_read outside the workspace requires confirmation and succeeds when approved", async () => {
    // finding #1: fs.ts no longer hard-rejects escaping paths — the permission
    // gate turns the out-of-workspace target into a confirmation, and after a
    // human approves, fs_read must actually read it (not error out).
    const outside = mkdtempSync(join(tmpdir(), "kclaw-outside-"))
    dirs.push(outside)
    writeFileSync(join(outside, "secret.txt"), "outside secret")

    const { env, manager } = makeEnv(scriptClient([
      fsReadToolTurn("call_fs", join(outside, "secret.txt")),
      textTurn("好的"),
    ]))
    const session = env.sessions.create("越界会话")

    const run = manager.enqueue(session.id, { userText: "读一下外部文件", trigger: "user" })

    const deadline = Date.now() + 2000
    while (manager.broker.pending().length === 0) {
      if (Date.now() > deadline) throw new Error("confirmation never became pending")
      await new Promise((r) => setTimeout(r, 5))
    }
    const [listed] = manager.broker.pending()
    expect(listed).toMatchObject({ toolCall: expect.objectContaining({ name: "fs_read" }) })
    expect(manager.broker.resolve(listed!.confirmationId, true, "cli")).toBe(true)

    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const result = msgs[2]!.blocks[0] as ToolResultBlock
    expect(result).toMatchObject({ type: "tool_result", callId: "call_fs", status: "ok" })
    expect(result.output).toContain("outside secret")
    expect((msgs[2] as ToolMessage).grantedBy).toEqual({ call_fs: "confirmed" })
  })

  it("records an injected resolver's rejection as a denied note, without executing", async () => {
    const { env, manager } = makeEnv(
      scriptClient([execToolTurn("call_3", "echo no"), textTurn("好的")]),
      undefined,
      async () => ({ decision: "reject" as const, by: "web" }),
    )
    const session = env.sessions.create("拒绝会话")

    const outcome = await manager.enqueue(session.id, { userText: "执行 echo no", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")
    const msgs = env.sessions.readMessages(session.id)
    const result = msgs[2]!.blocks[0] as ToolResultBlock
    expect(result.status).toBe("error")
    expect(result.output).toContain("用户拒绝了该操作")

    const toolMsg = msgs[2] as ToolMessage
    expect(toolMsg.grantedBy).toBeUndefined()
    expect(toolMsg.blocks.some((b) => b.type === "note" && b.kind === "denied")).toBe(true)
  })

  it("records a confirmation timeout as a timeout note when the resolver never settles", async () => {
    const { env, manager } = makeEnv(
      scriptClient([execToolTurn("call_4", "echo slow"), textTurn("好的")]),
      (c) => {
        c.permissions.confirmTimeoutMs = 50
      },
      () => new Promise<{ decision: "once" | "reject"; by: "web" }>(() => {}), // never settles
    )
    const session = env.sessions.create("超时会话")

    const outcome = await manager.enqueue(session.id, { userText: "执行 echo slow", trigger: "user" })

    // the loop's own timer refuses the call; the tool message records the timeout
    expect(outcome.stopReason).toBe("end_turn")
    const msgs = env.sessions.readMessages(session.id)
    const result = msgs[2]!.blocks[0] as ToolResultBlock
    expect(result.status).toBe("error")
    expect(result.output).toContain("确认超时")
    const toolMsg = msgs[2] as ToolMessage
    expect(toolMsg.grantedBy).toBeUndefined()
    expect(toolMsg.blocks.some((b) => b.type === "note" && b.kind === "timeout")).toBe(true)
  })

  it("discards a late human verdict that loses the timeout race", async () => {
    const late = new Promise<{ decision: "once"; by: "web" }>((resolve) => {
      setTimeout(() => resolve({ decision: "once", by: "web" }), 250)
    })
    const { env, manager } = makeEnv(
      scriptClient([execToolTurn("call_5", "echo late"), textTurn("好的")]),
      (c) => {
        c.permissions.confirmTimeoutMs = 50
      },
      () => late,
    )
    const session = env.sessions.create("迟到会话")

    const outcome = await manager.enqueue(session.id, { userText: "执行 echo late", trigger: "user" })

    // timeout (50ms) refused the call before the human answered (250ms)
    expect(outcome.stopReason).toBe("end_turn")
    const msgs = env.sessions.readMessages(session.id)
    expect((msgs[2]!.blocks[0] as ToolResultBlock).status).toBe("error")
    const toolMsg = msgs[2] as ToolMessage
    expect(toolMsg.grantedBy).toBeUndefined()
    expect(toolMsg.blocks.some((b) => b.type === "note" && b.kind === "timeout")).toBe(true)

    // the late approval must not execute anything (no new messages appended)
    await new Promise((r) => setTimeout(r, 350))
    expect(env.sessions.readMessages(session.id)).toHaveLength(msgs.length)
  })

  it("uses AGENTS.md as the system prompt, defaulting when absent", async () => {
    // capturing client: records the request, answers with a final text turn
    const requests: Parameters<LlmClient["stream"]>[0][] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield { type: "text_delta", delta: "好" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { env, manager } = makeEnv(llm)
    writeFileSync(env.paths.agentsMd, "# 人设\n你是测试助理。", "utf8")
    const session = env.sessions.create("人设会话")

    await manager.enqueue(session.id, { userText: "嗨", trigger: "user" })
    expect(requests[0]!.system).toContain("# 人设\n你是测试助理。")

    // a second session WITHOUT AGENTS.md… is impossible here (same home), so
    // the default branch is pinned from a fresh home with no file written.
    const fresh = makeEnv(llm)
    const session2 = fresh.env.sessions.create("默认人设会话")
    await fresh.manager.enqueue(session2.id, { userText: "嗨", trigger: "user" })
    // 人格在首位，注入约定作为系统提示词的最后一段恒定存在
    expect(requests.at(-1)!.system).toContain("你是 kclaw，一个务实的个人助理。")
    expect(requests.at(-1)!.system).toContain("<system-reminder>")
  })

  it("aborts a hanging run: cancel() → outcome stopReason aborted", async () => {
    const { env, manager } = makeEnv(hangingClient())
    const session = env.sessions.create("取消会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const run = manager.enqueue(session.id, { userText: "别回了", trigger: "user" })
    await waitForEvent(socket, "llm.started") // the run is live inside the stream

    expect(manager.cancel(session.id)).toBe(true)

    const outcome = await run
    expect(outcome.stopReason).toBe("aborted")
    expect(received(socket).at(-1)!.type).toBe("run.completed")
    expect(received(socket).at(-1)!.payload).toEqual({
      stopReason: "aborted",
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    // nothing active anymore, and only the user message got persisted
    expect(manager.cancel(session.id)).toBe(false)
    expect(env.sessions.readMessages(session.id).map((m) => m.role)).toEqual(["user"])
  })

  it("cancel immediately after enqueue aborts the run (no registration window)", async () => {
    // enqueue returns before #execute's first await; a synchronous cancel must
    // find the controller (or the queued-cancel mark) — the old code answered
    // false here because #active.set ran after several awaits.
    const { env, manager } = makeEnv(scriptClient([textTurn("不该跑到这")]))
    const session = env.sessions.create("窗口会话")

    const outcomePromise = manager.enqueue(session.id, { userText: "hi", trigger: "user" })
    const cancelled = manager.cancel(session.id)
    const outcome = await outcomePromise
    expect(cancelled).toBe(true)
    expect(outcome.stopReason).toBe("aborted")
  })

  it("cancel only aborts the ACTIVE run; a queued run survives and still executes (narrowed semantics)", async () => {
    // run.cancel 不再连带取消排队消息——
    // 第一个 cancel 中止活动 run；排队的 run 照常出队执行到 end_turn。
    const { env, manager } = makeEnv(scriptClient([textTurn("one"), textTurn("two")]))
    const session = env.sessions.create("排队会话")

    const p1 = manager.enqueue(session.id, { userText: "one", trigger: "user" })
    const p2 = manager.enqueue(session.id, { userText: "two", trigger: "user", disposition: "wait" })
    expect(manager.cancel(session.id)).toBe(true) // run1 active → aborted
    const o1 = await p1
    expect(o1.stopReason).toBe("aborted")
    const o2 = await p2 // 排队条目幸存，仍被执行
    expect(o2.stopReason).toBe("end_turn")
    expect(manager.cancel(session.id)).toBe(false) // 全部落定：无活动 run

    // 排队消息确实执行了：run1 被中止（仅 user 落盘，中止不产 assistant 消息），
    // two 的问答齐全 —— 排队条目幸存并完成
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "user", "assistant"])
    expect(msgs[1]!.blocks[0]).toMatchObject({ text: "two" })
  })

  it("surfaces provider retries as llm.failed {willRetry:true} events with run context", async () => {
    // raw client: "llm http 503" twice, then a normal text turn. The retry
    // wrapper is the daemon's default composition: built per run through
    // llmForRun, so its onRetry lands in the run's own visibility closure.
    let calls = 0
    const raw: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        if (++calls <= 2) throw new Error("llm http 503: storm")
        yield* textTurn("恢复")
      },
    }
    const { env, manager } = makeEnv(raw, undefined, undefined, {
      llmForRun: (onRetry) => withRetry(raw, { baseDelayMs: 1, jitter: () => 0, onRetry }),
    })
    const session = env.sessions.create("重试会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const outcome = await manager.enqueue(session.id, { userText: "打起精神", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")
    const events = received(socket)
    const retries = events.filter((e) => e.type === "llm.failed" && e.payload.willRetry)
    expect(retries).toHaveLength(2)
    expect(retries[0]!.payload).toEqual({
      error: { code: "llm_retry", message: "llm http 503: storm" },
      willRetry: true,
    })
    // the retry events carry THIS run's context, learned from run.started
    const started = events.find((e) => e.type === "run.started")!
    for (const r of retries) {
      expect(r.sessionId).toBe(session.id)
      expect(r.runId).toBe(started.runId)
    }
    // complete stream: llm.started → (retries) → llm.completed → run.completed
    const idx = (e: AgentEvent) => events.indexOf(e)
    expect(idx(events.find((e) => e.type === "llm.started")!)).toBeLessThan(idx(retries[0]!))
    expect(idx(retries.at(-1)!)).toBeLessThan(idx(events.find((e) => e.type === "llm.completed")!))
    expect(events.at(-1)).toMatchObject({ type: "run.completed", payload: { stopReason: "end_turn" } })
    // the run still produced its assistant turn after the retries
    expect(env.sessions.readMessages(session.id).at(-1)!.blocks[0]).toMatchObject({ text: "恢复" })
  })

  it("resets the attempt counter between llm calls: every llm.started reports its own attempt", async () => {
    // invocation 1-2: 503 (retried); 3: tool_use; 4: final text turn — so the
    // FIRST llm call retries twice before succeeding, and the run continues
    // into a second llm call.
    let inv = 0
    const raw: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        inv++
        if (inv <= 2) throw new Error("llm http 503: x")
        yield* inv === 3 ? execToolTurn("call_r", "echo hi") : textTurn("done")
      },
    }
    const { env, manager } = makeEnv(raw, (c) => {
      c.permissions.allow = ["exec:echo*"]
    }, undefined, {
      llmForRun: (onRetry) => withRetry(raw, { baseDelayMs: 1, jitter: () => 0, onRetry }),
    })
    const session = env.sessions.create("计数会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const outcome = await manager.enqueue(session.id, { userText: "echo 一下", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")
    // without the reset the second llm.started would report attempt 3
    const started = received(socket).filter((e) => e.type === "llm.started")
    expect(started.map((e) => e.payload.attempt)).toEqual([1, 1])
  })

  it("records a throwing executor's error tool_result", async () => {
    const boom = new Map<string, ToolExecutor>([
      ["exec", {
        risk: "sensitive",
        concurrency: "parallel",
        async execute() {
          throw new Error("executor exploded")
        },
      }],
    ])
    const { env, manager } = makeEnv(
      scriptClient([execToolTurn("call_b", "echo boom"), textTurn("完了")]),
      (c) => {
        c.permissions.allow = ["exec:echo*"]
      },
      undefined,
      { tools: boom },
    )
    const session = env.sessions.create("炸掉会话")

    const outcome = await manager.enqueue(session.id, { userText: "执行 echo boom", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")
    const msgs = env.sessions.readMessages(session.id)
    const result = msgs[2]!.blocks[0] as ToolResultBlock
    expect(result).toMatchObject({ type: "tool_result", callId: "call_b", status: "error" })
    expect(result.output).toContain("executor exploded")

    // the tool message keeps the granted reason even though the executor threw
    expect((msgs[2] as ToolMessage).grantedBy).toEqual({ call_b: "whitelist" })
  })
})

// --- context compaction -------------------------------------------------------

/** Wrap a client so every request is captured (order preserved). */
function recordRequests(client: LlmClient, reqs: LlmRequest[]): LlmClient {
  return {
    stream(req) {
      reqs.push(req)
      return client.stream(req)
    },
  }
}

/** A client whose FIRST stream call throws, later calls play the given events. */
function failFirstClient(message: string, then: LlmStreamEvent[]): LlmClient {
  let failed = false
  return {
    async *stream() {
      if (!failed) {
        failed = true
        throw new Error(message)
      }
      yield* then
    },
  }
}

/** First call plays `ok`, every later call throws `message` (a failing post-run summarizer). */
function firstOkThenFailClient(ok: LlmStreamEvent[], message: string): LlmClient {
  let n = 0
  return {
    async *stream() {
      n += 1
      if (n === 1) {
        yield* ok
        return
      }
      throw new Error(message)
    },
  }
}

/** First call throws `message` (zero events), later calls play `script` in order (last repeats). */
function throwFirstClient(message: string, script: LlmStreamEvent[][]): LlmClient {
  let n = 0
  return {
    async *stream() {
      n += 1
      if (n === 1) throw new Error(message)
      yield* script[Math.min(n - 2, script.length - 1)]!
    },
  }
}

/**
 * Seed n user/assistant history pairs (old1a, old1b, old2a, ...). Assistant
 * messages carry a real usage anchor (inputTokens 10_000): the v2 trigger
 * estimates context from the last assistant's usage, so seeding without it
 * would make every fixture trivially under-budget instead of over-budget.
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

/** textTurn whose message_done carries a custom usage.inputTokens (drives the NEXT run's trigger anchor). */
function textTurnWithUsage(text: string, inputTokens: number): LlmStreamEvent[] {
  return [
    { type: "text_delta", delta: text },
    { type: "message_done", stopReason: "end_turn", usage: { inputTokens, outputTokens: 2 } },
  ]
}

describe("RunManager context compaction", () => {
  it("sends over the yellow line with zero wait: run starts first, no compaction before run.started, full history", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurnWithUsage("主回复", 10_000), textTurn("段摘要A"), textTurn("总摘要A")]), reqs),
      (c) => { c.sessions.contextTokens = 10 }, // tiny budget: the waterline is over the line
    )
    const session = env.sessions.create("零等待会话")
    seedHistory(env.sessions, session.id, 2) // 4 messages, anchored at 10_000 tokens
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })

    // v3: 发消息零压缩——run.started 是第一事件,用户消息紧随,run 完成前
    // 没有任何 compaction 事件(v2 的开场预压缩已删除)。
    const events = received(socket)
    expect(events[0]!.type).toBe("run.started")
    expect(events[1]!.type).toBe("message.created")
    const runDoneAt = events.findIndex((e) => e.type === "run.completed")
    expect(runDoneAt).toBeGreaterThan(0)
    expect(events.slice(0, runDoneAt).filter((e) => e.type.startsWith("compaction."))).toHaveLength(0)
    // the FIRST llm request carried the FULL history: no context thread item,
    // the early verbatim text still in
    const mainReq = reqs[0]!
    expect(mainReq.messages[0]!.role).not.toBe("system")
    expect(JSON.stringify(mainReq.messages)).toContain("历史问题1")
  })

  it("compacts after the run when the waterline crosses the yellow line: phase post-run, meta persisted", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurnWithUsage("主回复", 10_000), textTurn("段摘要A"), textTurn("总摘要A")]), reqs),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("收尾压缩会话")
    const seeded = seedHistory(env.sessions, session.id, 2)
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })

    // the run's own turn anchored this round's real usage over the line →
    // the compaction runs AFTER run.completed
    const events = received(socket)
    const types = events.map((e) => e.type)
    const startedIdx = types.indexOf("compaction.started")
    expect(startedIdx).toBeGreaterThanOrEqual(0)
    expect(startedIdx).toBeGreaterThan(types.indexOf("run.completed"))
    expect(events[startedIdx]!.payload).toEqual({ phase: "post-run" })
    // both summarizer calls follow the main request
    expect(reqs[1]!.tools).toEqual([])
    expect(reqs[1]!.system).toContain("对话摘要器")
    expect(reqs[1]!.messages[0]!.content).toContain("历史问题1")
    expect(reqs[2]!.system).toContain("对话摘要归并器")
    // first compaction has no previous top: the merge input IS the segment summary
    expect(reqs[2]!.messages[0]!.content).toContain("段摘要A")
    // v2 state persisted; the compaction audit event (the stream session_search
    // now reads) carries the segment summary
    expect(env.sessions.meta(session.id)!.compaction).toMatchObject({ top: "总摘要A", upto: seeded[3]!.id })
    expect(env.sessions.meta(session.id)!.compaction!.segments).toHaveLength(1)
    expect(env.sessions.readCompactions(session.id)).toHaveLength(1)
    // completed: ok result, real counts (4 seeded messages compacted, the turn kept)
    const okCompleted = events.find((e) => e.type === "compaction.completed")
    expect(okCompleted!.payload).toEqual({ segments: 1, kept: 2, phase: "post-run", result: "ok" })
  })

  it("second compaction merges the previous top into the new one", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([
        textTurnWithUsage("主回复", 10_000),
        textTurn("段摘要A"), textTurn("总摘要A"),
        textTurnWithUsage("主回复2", 10_000),
        textTurn("段摘要B"), textTurn("总摘要B"),
      ]), reqs),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("两次压缩")
    seedHistory(env.sessions, session.id, 2)
    await manager.enqueue(session.id, { userText: "一", trigger: "user" })
    await manager.enqueue(session.id, { userText: "二", trigger: "user" })

    const meta = env.sessions.meta(session.id)
    expect(meta!.compaction!.segments).toHaveLength(2)
    expect(meta!.compaction!.top).toBe("总摘要B")
    // the second run's main request already saw the first compaction's view
    expect(reqs[3]!.messages[0]!.role).toBe("user")
    expect(reqs[3]!.messages[0]!.content).toContain("<compacted-summary>")
    expect(reqs[3]!.messages[0]!.content).toContain("总摘要A")
    // the second merge's input carries the old top and the new segment summary
    const mergeInput = reqs[5]!.messages[0]!.content as string
    expect(mergeInput).toContain("总摘要A")
    expect(mergeInput).toContain("段摘要B")
  })

  /**
   * 收尾压缩进行中 submit 第二条消息 → 进入队列,压缩完成后
   * 才开跑。驱动器的串行化天然保证这一点——#execute 在收尾压缩上 await,
   * 驱动循环不会出队下一条,无需额外忙碌标记。
   */
  it("a second message submitted during a post-run compaction queues until the compaction completes", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let n = 0
    const client: LlmClient = {
      async *stream() {
        n += 1
        if (n === 1) {
          yield* textTurnWithUsage("回答a", 10_000) // the run's usage anchors over the line
          return
        }
        if (n === 2) {
          yield { type: "text_delta", delta: "段摘要A（进行中）" }
          await gate // stand in for the seconds-long real summarizer call
          return
        }
        if (n === 3) {
          yield* textTurn("总摘要A")
          return
        }
        yield* textTurn("回答b")
      },
    }

    const { env, manager } = makeEnv(client, (c) => { c.sessions.contextTokens = 10 })
    const session = env.sessions.create("压缩排队")
    seedHistory(env.sessions, session.id, 2)
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const aP = manager.enqueue(session.id, { userText: "a", trigger: "user" })
    await waitForEvent(socket, "compaction.started") // the post-run compaction is in flight
    expect(n).toBe(2) // run done + the parked segment summarizer

    // Seeing no further reaction, Master types "b" while the compaction runs:
    // it queues (explicit wait), it does NOT start its run.
    const bP = manager.enqueue(session.id, { userText: "b", trigger: "user", disposition: "wait" })
    await new Promise((r) => setTimeout(r, 30))
    const eventsBefore = received(socket)
    expect(eventsBefore.some((e) => e.type === "message.queued")).toBe(true)
    expect(eventsBefore.filter((e) => e.type === "run.started")).toHaveLength(1)

    release()
    await aP
    await bP

    // b's run.started arrives only AFTER the compaction completed
    const events = received(socket)
    const types = events.map((e) => e.type)
    const compactionDoneAt = types.indexOf("compaction.completed")
    const bStartedAt = types.indexOf("run.started", types.indexOf("run.started") + 1) // second run.started
    expect(bStartedAt).toBeGreaterThan(compactionDoneAt)
    // both runs settled clean; b's own usage (1) stays under the line → no second compaction
    expect(types.filter((t) => t === "compaction.started")).toHaveLength(1)
    const msgs = env.sessions.readMessages(session.id)
    const assistantTexts = msgs
      .filter((m) => m.role === "assistant")
      .map((m) => (m.blocks[0] as { text?: string }).text)
    expect(assistantTexts.slice(-2)).toEqual(["回答a", "回答b"])
  })

  it("upgrades a legacy compactedSummary session: old summary seeds the top (post-run)", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurnWithUsage("主回复", 10_000), textTurn("段摘要N"), textTurn("总摘要N")]), reqs),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("旧格式")
    const seeded = seedHistory(env.sessions, session.id, 2)
    env.sessions.updateMeta(session.id, { compactedSummary: "旧总摘要", compactedUpto: seeded[0]!.id })

    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })

    const meta = env.sessions.meta(session.id)
    expect(meta!.compaction!.top).toBe("总摘要N")
    // legacy fields are no longer cleared by compaction: they linger in meta but stay shadowed —
    // prev reads meta.compaction first, so the next compaction seeds from
    // the compaction event, not these stale keys.
    expect(meta!.compactedSummary).toBe("旧总摘要")
    expect(meta!.compactedUpto).toBe(seeded[0]!.id)
    // the merge input seeded from the legacy top (the third call: main → seg → merge)
    expect((reqs[2]!.messages[0]!.content as string)).toContain("旧总摘要")
  })

  it("a failing post-run summarizer: full history was already sent, completed(result:failed), no meta", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const reqs: LlmRequest[] = []
      const { env, manager } = makeEnv(
        recordRequests(firstOkThenFailClient(textTurnWithUsage("主回复", 10_000), "摘要挂了"), reqs),
        (c) => { c.sessions.contextTokens = 10 },
      )
      const session = env.sessions.create("回退")
      seedHistory(env.sessions, session.id, 2)
      const socket = new FakeSocket()
      env.bus.subscribe(session.id, socket)
      await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
      const meta = env.sessions.meta(session.id)
      expect(meta?.compaction).toBeUndefined()
      // v3: the run already went out over the FULL history (nothing to fall
      // back to — the compaction simply did not happen); the failed summarizer
      // call is the second request.
      expect(JSON.stringify(reqs[0]!.messages)).toContain("历史问题1")
      expect(reqs[1]!.system).toContain("对话摘要器")
      // Completed-must-arrive protocol (v3): a started is ALWAYS paired with a
      // completed — failure reports result "failed" with zeroed counters. The
      // failure logs exactly once inside the Compactor, tagged with the phase.
      const events = received(socket)
      expect(events.filter((e) => e.type === "compaction.started").map((e) => e.payload)).toEqual([{ phase: "post-run" }])
      const completed = events.find((e) => e.type === "compaction.completed")
      expect(completed).toBeDefined()
      expect(completed!.payload).toEqual({ segments: 0, kept: 0, phase: "post-run", result: "failed" })
      expect(errorSpy.mock.calls.filter((c) => String(c[0]).startsWith("kclaw compaction (post-run) failed"))).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("below threshold with existing state: no new calls, no compaction events, the meta view still applies", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(recordRequests(scriptClient([textTurn("主回复")]), reqs))
    const session = env.sessions.create("未触发")
    const seeded = seedHistory(env.sessions, session.id, 2)
    // 事件源下 meta.compaction 由 compaction 事件投影而来：用 appendCompaction 播种
    // 既有压缩状态（updateMeta 不再直接写 compaction，避免与事件重复计段）。
    env.sessions.appendCompaction(session.id, {
      at: new Date().toISOString(), trigger: "manual", from: null, upto: seeded[1]!.id,
      messages: 2, segmentSummary: "段摘要A", top: "总摘要A",
    })
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)
    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    expect(reqs.length).toBe(1) // the main conversation only
    const types = received(socket).map((e) => e.type)
    expect(types).not.toContain("compaction.started")
    expect(types).not.toContain("compaction.completed")
    // the persisted view drives THIS run's provider messages: the context
    // thread item first, the verbatim text before upto gone
    expect(reqs[0]!.messages[0]!.role).toBe("user")
    expect(reqs[0]!.messages[0]!.content).toContain("<compacted-summary>")
    expect(reqs[0]!.messages[0]!.content).toContain("总摘要A")
    expect(JSON.stringify(reqs[0]!.messages)).not.toContain("历史问题1")
  })

  it("compactSession defers while a run is active; queued messages still refuse", async () => {
    // a never-ending llm keeps the run hanging: the session counts as busy —
    // the request is deferred (queued ack), NOT refused. The run-after chain
    // flushes it after the run settles.
    const { env, manager } = makeEnv(
      scriptClient([textTurnWithUsage("主回复", 10_000), textTurn("段摘要G"), textTurn("总摘要G")]),
      (c) => { c.sessions.contextTokens = 40 }, // tiny target so the deferred manual boundary exists
    )
    const session = env.sessions.create("忙会话")
    seedHistory(env.sessions, session.id, 3)
    const p = manager.enqueue(session.id, { userText: "长任务", trigger: "user" })
    await expect(manager.compactSession(session.id, "重点保留登录模块")).resolves.toEqual({
      queued: true,
      message: "已排队：当前运行结束后自动压缩",
    })
    await p
    // the deferral was flushed by the run-after chain: a manual compaction
    // record with the focus landed
    const records = env.sessions.readCompactions(session.id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ trigger: "manual", focus: "重点保留登录模块" })

    // backed-up queued messages still refuse (they need human attention first)
    const { manager: m2, env: e2 } = makeEnv(hangingClient())
    const s2 = e2.sessions.create("队列拒绝")
    const p2 = m2.enqueue(s2.id, { userText: "占住运行", trigger: "user" })
    void m2.enqueue(s2.id, { userText: "排队消息", trigger: "user", disposition: "wait" })
    await expect(m2.compactSession(s2.id)).rejects.toThrow(/还有 \d+ 条排队消息/)
    expect(m2.cancel(s2.id)).toBe(true)
    await p2
  })

  it("compactSession throws session not found for a missing session", async () => {
    const { manager } = makeEnv(scriptClient([textTurn("不该被调用")]))
    await expect(manager.compactSession("ses_missing")).rejects.toThrow("session not found")
  })

  it("compactSession compacts immediately with focus and reports the result", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurn("段摘要F"), textTurn("总摘要F")]), reqs),
      (c) => { c.sessions.contextTokens = 10 }, // tiny target so a manual boundary exists
    )
    const session = env.sessions.create("手动会话")
    seedHistory(env.sessions, session.id, 2)

    const out = await manager.compactSession(session.id, "重点保留登录模块")

    expect(out.message).toContain("压缩了 1 段")
    expect(reqs.length).toBe(2) // segment summary + merge only — no main run
    // the focus line reached BOTH summarizer prompts
    expect(reqs[0]!.messages[0]!.content).toContain("用户特别要求重点保留：重点保留登录模块")
    expect(reqs[1]!.messages[0]!.content).toContain("用户特别要求重点保留：重点保留登录模块")
    // the fresh v2 state landed in meta
    expect(env.sessions.meta(session.id)!.compaction).toMatchObject({ top: "总摘要F" })
  })

  it("audit-logs auto compaction with the covered range", async () => {
    const { env, manager } = makeEnv(
      scriptClient([textTurnWithUsage("主回复", 10_000), textTurn("段摘要A"), textTurn("总摘要A")]),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("审计")
    const seeded = seedHistory(env.sessions, session.id, 2)
    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    const records = env.sessions.readCompactions(session.id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      // first compaction (no prior state) → the span starts at session start;
      // post-run: the whole seeded history fell under the boundary
      trigger: "auto", from: null, upto: seeded[3]!.id,
      messages: 4, segmentSummary: "段摘要A", top: "总摘要A",
    })
    expect(records[0]!.focus).toBeUndefined()
  })

  it("audit-logs manual compaction with trigger manual (focus optional)", async () => {
    const { env, manager } = makeEnv(
      scriptClient([textTurn("段摘要F"), textTurn("总摘要F")]),
      (c) => { c.sessions.contextTokens = 10 }, // tiny target so a manual boundary exists
    )
    const session = env.sessions.create("手动审计")
    seedHistory(env.sessions, session.id, 2)
    await manager.compactSession(session.id) // 不带 focus
    const records = env.sessions.readCompactions(session.id)
    expect(records).toHaveLength(1)
    expect(records[0]!.trigger).toBe("manual")
    expect(records[0]!.focus).toBeUndefined()
  })

  it("writes no audit record when the summarizer fails", async () => {
    const { env, manager } = makeEnv(
      firstOkThenFailClient(textTurnWithUsage("主回复", 10_000), "摘要挂了"),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("失败审计")
    seedHistory(env.sessions, session.id, 2)
    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    expect(env.sessions.readCompactions(session.id)).toEqual([])
  })

  it("failed MANUAL compaction: completed(result:failed) on the bus, the throw reaches the caller", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { env, manager } = makeEnv(
        failFirstClient("手动摘要挂了", textTurn("不会到这")),
        (c) => { c.sessions.contextTokens = 10 },
      )
      const session = env.sessions.create("手动失败")
      seedHistory(env.sessions, session.id, 2)
      const socket = new FakeSocket()
      env.bus.subscribe(session.id, socket)

      // compactSession rethrows the failed outcome's carried error: the HTTP
      // route maps it to a 500 carrying the message (routes/compact.test.ts).
      await expect(manager.compactSession(session.id)).rejects.toThrow("手动摘要挂了")

      const events = received(socket)
      expect(events.filter((e) => e.type === "compaction.started").map((e) => e.payload)).toEqual([{ phase: "manual" }])
      const completed = events.find((e) => e.type === "compaction.completed")
      expect(completed).toBeDefined()
      expect(completed!.payload).toEqual({ segments: 0, kept: 0, phase: "manual", result: "failed" })
      expect(env.sessions.meta(session.id)?.compaction).toBeUndefined()
      expect(env.sessions.readCompactions(session.id)).toEqual([])
      expect(errorSpy.mock.calls.filter((c) => String(c[0]).startsWith("kclaw compaction (manual) failed"))).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("cancelling the run mid-post-run-summarizer: completed(result:cancelled), nothing persisted", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let n = 0
    const llm: LlmClient = {
      async *stream() {
        n += 1
        if (n === 1) {
          yield* textTurnWithUsage("主回复", 10_000) // over the line → post-run compaction
          return
        }
        if (n === 2) {
          yield { type: "text_delta", delta: "段摘要（半截）" }
          await gate // the summarizer call parks; the run is cancelled meanwhile
          yield { type: "text_delta", delta: "（后半）" }
          return
        }
        yield* textTurn("不该到这")
      },
    }
    const { env, manager } = makeEnv(llm, (c) => { c.sessions.contextTokens = 10 })
    const session = env.sessions.create("取消压缩")
    seedHistory(env.sessions, session.id, 2)
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const run = manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    await waitForEvent(socket, "compaction.started")
    // The run's own turn is done but #execute still awaits the compaction —
    // the controller is still registered, so cancel() reaches it and the
    // signal linkage cuts the in-flight summarizer.
    expect(manager.cancel(session.id)).toBe(true)
    release() // the parked stream settles only AFTER the abort

    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn") // the run itself had already finished
    const events = received(socket)
    expect(events.filter((e) => e.type === "compaction.started").map((e) => e.payload)).toEqual([{ phase: "post-run" }])
    const completed = events.find((e) => e.type === "compaction.completed")
    expect(completed).toBeDefined()
    expect(completed!.payload).toEqual({ segments: 0, kept: 0, phase: "post-run", result: "cancelled" })
    expect(env.sessions.meta(session.id)?.compaction).toBeUndefined()
    expect(env.sessions.readCompactions(session.id)).toEqual([])
  })

  it("emergency in-run compaction via the overflow hook audits trigger in-run with the emergency flag", async () => {
    // The provider rejects the FIRST request with a context-overflow error
    // (zero events streamed) → the loop consults onContextOverflow → the
    // server runs an emergency compaction → the request is retried once over
    // the compacted view. No direct-call reach into the private method — the
    // real hook path is the only way this audit record gets written.
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(throwFirstClient("context length exceeded", [
        textTurn("段摘要E"), textTurn("总摘要E"), textTurn("恢复"),
      ]), reqs),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("急救会话")
    const seeded = seedHistory(env.sessions, session.id, 2)
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const outcome = await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn") // the retried request completed the run

    const records = env.sessions.readCompactions(session.id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ trigger: "in-run", emergency: true, upto: seeded[1]!.id, top: "总摘要E" })
    const events = received(socket)
    expect(events.filter((e) => e.type === "compaction.started").map((e) => e.payload)).toEqual([{ phase: "in-run" }])
    expect(events.find((e) => e.type === "compaction.completed")!.payload).toEqual({
      segments: 1, kept: 3, phase: "in-run", result: "ok",
    })
    // the retry went out over the swapped view: thread item first, early
    // verbatim text before upto gone, and the retry was silent (one llm.started)
    expect(reqs.length).toBe(4)
    const retry = reqs[3]!
    expect(retry.messages[0]!.role).toBe("user")
    expect(retry.messages[0]!.content).toContain("<compacted-summary>")
    expect(retry.messages[0]!.content).toContain("总摘要E")
    expect(JSON.stringify(retry.messages)).not.toContain("历史问题1")
    expect(events.filter((e) => e.type === "llm.started")).toHaveLength(1)
  })

  it("emergency bypasses the yellow-line gate when the anchor is missing; the forced boundary still rescues", async () => {
    // Important-1 regression: the rescue is consulted when the FIRST request of a
    // run overflows, but `active` may hold no assistant message yet (a post-run
    // compaction just finished, the retained part has no reply) → the estimate
    // anchors to 0, misses system/tool-def overhead and sits BELOW the yellow
    // line while the real request genuinely overflows. Before the fix the
    // yellow-line check silently dropped the rescue and the run died with the
    // error; now emergency skips the gate and, when chooseBoundary can't find a
    // boundary (the only user message is at index 0), falls back to
    // emergencyBoundary — keep the last user turn, compress everything before it.
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(throwFirstClient("context length exceeded", [
        textTurn("段摘要E"), textTurn("总摘要E"), textTurn("恢复"),
      ]), reqs),
      (c) => { c.sessions.contextTokens = 10 }, // yellow = 6.6, target = 3.3
    )
    const session = env.sessions.create("急救豁免黄线")
    // a low-anchor history: the assistant message carries tiny inputTokens, so
    // the estimate (anchor + fresh user text) is far below the line while the
    // provider still reports an overflow on the first request
    const u1 = newMessage(session.id, "user", [{ id: "seed-u-1", type: "text", text: "历史问题1" }])
    const a1 = newAssistantMessage(session.id, "mock-model", [{ id: "seed-a-1", type: "text", text: "历史回答1" }], { inputTokens: 2, outputTokens: 0 })
    env.sessions.appendMessage(session.id, u1)
    env.sessions.appendMessage(session.id, a1)
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const outcome = await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    // the rescue ran and the retried request completed the run — not an error
    expect(outcome.stopReason).toBe("end_turn")

    const records = env.sessions.readCompactions(session.id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ trigger: "in-run", emergency: true, from: null, upto: a1.id, messages: 2 })
    const events = received(socket)
    expect(events.find((e) => e.type === "compaction.completed")!.payload).toEqual({
      segments: 1, kept: 1, phase: "in-run", result: "ok",
    })
    // the retry went out over the compacted view: thread item first, seeded
    // verbatim text gone, only the fresh user turn remains
    expect(reqs.length).toBe(4)
    const retry = reqs[3]!
    expect(retry.messages[0]!.role).toBe("user")
    expect(retry.messages[0]!.content).toContain("<compacted-summary>")
    expect(retry.messages[0]!.content).toContain("总摘要E")
    expect(JSON.stringify(retry.messages)).not.toContain("历史问题1")
    expect(JSON.stringify(retry.messages)).not.toContain("历史回答1")
    expect(JSON.stringify(retry.messages)).toContain("新问题")
  })

  it("mid-run compaction at the red line: phase in-run, the next request leads with the thread item", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([
        execToolTurnWithUsage("call_m", "echo hi", 9), // the tool turn anchors over the RED line
        textTurn("段摘要I"), textTurn("总摘要I"), textTurn("完成"),
      ]), reqs),
      (c) => {
        c.sessions.contextTokens = 10 // red line: 10 × 0.90 = 9
        c.permissions.allow = ["exec:echo*"]
      },
    )
    const session = env.sessions.create("中途压缩会话")
    const seeded = seedHistory(env.sessions, session.id, 2)
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const outcome = await manager.enqueue(session.id, { userText: "执行一下", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")
    const events = received(socket)
    const types = events.map((e) => e.type)
    // the compaction fired MID-run: after the tool batch, before run.completed
    const startedIdx = types.indexOf("compaction.started")
    expect(startedIdx).toBeGreaterThanOrEqual(0)
    expect(startedIdx).toBeLessThan(types.indexOf("run.completed"))
    expect(events[startedIdx]!.payload).toEqual({ phase: "in-run" })
    expect(events.find((e) => e.type === "compaction.completed")!.payload).toEqual({
      segments: 1, kept: 3, phase: "in-run", result: "ok",
    })
    // the request BEFORE the compaction carried the full verbatim history…
    expect(reqs[0]!.messages[0]!.role).not.toBe("system")
    expect(JSON.stringify(reqs[0]!.messages)).toContain("历史问题1")
    // …the request AFTER it leads with the context thread item
    expect(reqs[3]!.messages[0]!.role).toBe("user")
    expect(reqs[3]!.messages[0]!.content).toContain("总摘要I")
    expect(JSON.stringify(reqs[3]!.messages)).not.toContain("历史问题1")
    // the run's own tail stayed verbatim
    expect(JSON.stringify(reqs[3]!.messages)).toContain("执行一下")
    expect(env.sessions.meta(session.id)!.compaction).toMatchObject({ top: "总摘要I", upto: seeded[3]!.id })
    // the final turn's usage (1) stays under the yellow line → no post-run compaction
    expect(types.filter((t) => t === "compaction.started")).toHaveLength(1)
  })

  it("cancelCompaction cuts the in-flight compaction and suppresses the rest of THIS run; a new run recovers", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let n = 0
    const client: LlmClient = {
      async *stream() {
        n += 1
        if (n === 1 || n === 3) {
          yield* execToolTurnWithUsage(`c${n}`, "echo hi", 9) // two tool rounds, both over the red line
          return
        }
        if (n === 2) {
          yield { type: "text_delta", delta: "段摘要（半截）" }
          await gate // the in-run compaction parks here; cancel lands meanwhile
          yield { type: "text_delta", delta: "（后半）" }
          return
        }
        if (n === 4) {
          yield* textTurnWithUsage("完成", 10_000) // over the yellow line — suppressed by the cancel mark
          return
        }
        if (n === 5) {
          yield* textTurnWithUsage("回复2", 10_000) // the fresh run's usage anchors over the line
          return
        }
        if (n === 6) {
          yield* textTurn("段摘要Z")
          return
        }
        yield* textTurn("总摘要Z")
      },
    }
    const { env, manager } = makeEnv(client, (c) => {
      c.sessions.contextTokens = 10
      c.permissions.allow = ["exec:echo*"]
    })
    const session = env.sessions.create("取消防循环")
    seedHistory(env.sessions, session.id, 2)
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    const run1 = manager.enqueue(session.id, { userText: "执行一下", trigger: "user" })
    await waitForEvent(socket, "compaction.started") // the in-run compaction is parked on the gate
    expect(manager.cancelCompaction(session.id)).toBe(true) // an in-flight compaction existed
    release()

    expect((await run1).stopReason).toBe("end_turn")
    const events1 = received(socket)
    expect(events1.filter((e) => e.type === "compaction.started").map((e) => e.payload)).toEqual([{ phase: "in-run" }])
    expect(events1.find((e) => e.type === "compaction.completed")!.payload).toEqual({
      segments: 0, kept: 0, phase: "in-run", result: "cancelled",
    })
    // the SECOND tool round crossed the red line again but the cancel mark
    // suppressed it — and so did the post-run check (usage 10_000 > line)
    expect(events1.filter((e) => e.type === "compaction.started")).toHaveLength(1)
    expect(env.sessions.meta(session.id)?.compaction).toBeUndefined()
    expect(env.sessions.readCompactions(session.id)).toEqual([])

    // a NEW run starts clean: the mark is cleared, auto compaction recovers
    const run2 = manager.enqueue(session.id, { userText: "再来一轮", trigger: "user" })
    expect((await run2).stopReason).toBe("end_turn")
    const events2 = received(socket)
    const started = events2.filter((e) => e.type === "compaction.started")
    expect(started.map((e) => e.payload)).toEqual([{ phase: "in-run" }, { phase: "post-run" }])
    expect(events2.filter((e) => e.type === "compaction.completed").at(-1)!.payload).toMatchObject({
      phase: "post-run", result: "ok",
    })
    expect(env.sessions.meta(session.id)!.compaction).toMatchObject({ top: "总摘要Z" })
  })
})

// --- memory injection------------------------------------------
// RunManagerDeps.memory 是 MemorySystem：L2 cognition 拼进 system prompt
// （cognitionPrompt 为空/抛错则回落到纯 AGENTS.md），L1 情节以 memory note 注入
// 用户消息（searchEpisodes 失败静默跳过）。四触发提取管线由 daemon 装配。

describe("RunManager memory injection", () => {
  it("injects L2 cognition into the system prompt and L1 episodes as memory notes", async () => {
    const fakeMemory = {
      cognitionPrompt: (wd: string) => "[关于用户]\nMaster 偏好中文。",
      searchEpisodes: async (_wd: string, q: string, n: number) => [
        { topic: "ws", title: "重连线", date: "2026-08-28", text: `匹配 ${q.slice(0, 8)} 的情节`, score: 1 },
      ],
    } as unknown as MemorySystem
    const requests: Parameters<LlmClient["stream"]>[0][] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* textTurn("好的")
      },
    }
    const { env, manager } = makeEnv(llm, undefined, undefined, { memory: fakeMemory })
    const session = env.sessions.create("记忆注入会话", undefined, "/w/proj")

    await manager.enqueue(session.id, { userText: "重连怎么样了", trigger: "user" })

    // the system prompt carries the L2 cognition block after the AGENTS.md base
    expect(requests[0]!.system).toContain("Master 偏好中文。")
    // the user message carries the L1 episode as a memory note
    const [user] = env.sessions.readMessages(session.id)
    const note = user!.blocks.find((b) => b.type === "note")
    expect(note).toEqual({ id: expect.any(String), type: "note", kind: "memory", text: "相关经历（重连线）: 匹配 重连怎么样了 的情节" })
  })

  it("tolerates a throwing memory system (run proceeds without memory context)", async () => {
    const boom = {
      cognitionPrompt: () => { throw new Error("x") },
      searchEpisodes: async () => { throw new Error("y") },
    } as unknown as MemorySystem
    const { env, manager } = makeEnv(scriptClient([textTurn("hi")]), undefined, undefined, { memory: boom })
    const session = env.sessions.create("炸记忆会话")

    const outcome = await manager.enqueue(session.id, { userText: "hi", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")
  })
})

// --- system 事件审计（第 9 种持久化事件）--------------------------------------
// 每次 run 在系统提示词拼装完成后、进入模型循环前，把全量文本作为一条 system
// 事件追加进该会话的事件流（只落盘，不上总线）。语义拍板：写入失败即本次 run
// 失败（与消息写入失败同待遇）；不加幻影会话守卫；steer 注入与 run 内多次模型
// 调用复用同一份提示词，每 run 恰好一条。

describe("RunManager system 事件审计", () => {
  // 批 1 的 isSystemEvent 守卫未导出到 @kclaw/core 公共入口：测试内行内收窄
  type StreamEvent = ReturnType<SessionStore["readEvents"]>[number]
  const isSystem = (e: StreamEvent): e is StreamEvent & { type: "system"; at: string; stable: string; live?: string } =>
    e.type === "system"

  it("一次 run 落恰好一条 system 事件：文本为 AGENTS.md 原文，先于本 run 的 user 消息", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("收到")]))
    writeFileSync(env.paths.agentsMd, "# 人设\n你是测试助理。", "utf8")
    const session = env.sessions.create("审计会话")

    await manager.enqueue(session.id, { userText: "你好", trigger: "user" })

    const events = env.sessions.readEvents(session.id)
    const systemEvents = events.filter(isSystem)
    expect(systemEvents).toHaveLength(1)
    expect(systemEvents[0]!.stable).toContain("# 人设\n你是测试助理。")
    expect(systemEvents[0]!.stable).toContain("<system-reminder>") // 注入约定恒在稳定段
    expect(systemEvents[0]!.live).toBe("")
    expect(Number.isNaN(Date.parse(systemEvents[0]!.at))).toBe(false)
    // 流序：system 事件先于本 run 的 user 消息事件
    const systemIdx = events.findIndex(isSystem)
    const userMsgIdx = events.findIndex((e) => e.type === "message" && e.role === "user")
    expect(systemIdx).toBeGreaterThan(-1)
    expect(userMsgIdx).toBeGreaterThan(systemIdx)
  })

  it("无 AGENTS.md 且认知为空时，system 事件文本等于默认人设", async () => {
    // makeEnv 的临时 home 不写 AGENTS.md；makeMemoryFake 的 cognitionPrompt 恒为空串
    const { env, manager } = makeEnv(scriptClient([textTurn("收到")]))
    const session = env.sessions.create("默认人设会话")

    await manager.enqueue(session.id, { userText: "你好", trigger: "user" })

    const [systemEvent] = env.sessions.readEvents(session.id).filter(isSystem)
    // 人格在首、注入约定恒定为最后一段——两者都在稳定段
    expect(systemEvent!.stable).toContain("你是 kclaw，一个务实的个人助理。")
    expect(systemEvent!.stable).toContain("<system-reminder>")
  })

  it("认知非空时 system 事件文本 = AGENTS.md + 空行 + 认知 + 空行 + 注入约定", async () => {
    const fakeMemory = {
      cognitionPrompt: () => "[关于用户]\nMaster 偏好中文。",
      searchEpisodes: async () => [],
    } as unknown as MemorySystem
    const { env, manager } = makeEnv(scriptClient([textTurn("收到")]), undefined, undefined, { memory: fakeMemory })
    writeFileSync(env.paths.agentsMd, "# 人设\n你是测试助理。", "utf8")
    const session = env.sessions.create("认知审计会话")

    await manager.enqueue(session.id, { userText: "你好", trigger: "user" })

    const [systemEvent] = env.sessions.readEvents(session.id).filter(isSystem)
    // 稳定段 = 人设 + 注入约定；认知归实时段（live 变化不重写稳定前缀）
    expect(systemEvent!.stable).toContain("# 人设\n你是测试助理。")
    expect(systemEvent!.stable).toContain("<system-reminder>")
    expect(systemEvent!.live).toContain("[关于用户]\nMaster 偏好中文。")
  })

  it("appendSystem 写入失败即本次 run 失败：outcome 拒绝 + queue_entry_failed 可见性，驱动器不停转", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("收到")]))
    const session = env.sessions.create("炸审计会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    // 只炸 appendSystem 的 store 视图（其余方法走原型委托）："跑了但没记录"
    // 的静默缺口不允许——写入失败必须让本次 run 失败
    const failingStore = Object.create(env.sessions) as SessionStore
    Object.defineProperty(failingStore, "appendSystem", {
      value(): void {
        throw new Error("disk full: cannot append system")
      },
    })
    const failingManager = new RunManager({
      config: env.config, paths: env.paths, sessions: failingStore,
      memory: env.memory, bus: env.bus,
      llm: scriptClient([textTurn("收到")]), workspace: env.config.workspace,
    })

    // 装配段（runAgent 之前）同步抛 → 驱动器条目级失败兜底：outcome 以该错误拒绝
    await expect(failingManager.enqueue(session.id, { userText: "写不进去", trigger: "user" }))
      .rejects.toThrow("disk full: cannot append system")

    // 可见性：bus 上补发 run.failed {code:"queue_entry_failed"}，message 带 messageId 与原因
    const failed = received(socket).find((e) => e.type === "run.failed")
    expect(failed).toBeDefined()
    expect(failed!.payload).toMatchObject({ error: { code: "queue_entry_failed" } })
    expect((failed!.payload as { error: { message: string } }).error.message).toContain("disk full")

    // 没有任何 run 痕迹：无 system 审计事件、无消息落盘（装配段即失败，模型未被调用）
    expect(env.sessions.readEvents(session.id).filter((e) => e.type === "system")).toHaveLength(0)
    expect(env.sessions.readMessages(session.id)).toEqual([])

    // 驱动器没有停转：随后一次正常 enqueue 照常完成并补上审计
    const outcome = await manager.enqueue(session.id, { userText: "再来一次", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")
    expect(env.sessions.readEvents(session.id).filter((e) => e.type === "system")).toHaveLength(1)
  })
})

describe("RunManager extraTools (MCP adapter seam)", () => {
  it("appends adapter defs to the LLM request tools and keeps the executors callable", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurn("收到")]), reqs),
      undefined,
      undefined,
      {
        extraTools: () => ({
          executors: new Map<string, ToolExecutor>([
            [
              "mcp__files__read",
              {
                risk: "sensitive",
                concurrency: "serial",
                execute: async () => ({ status: "ok", output: "file content" }),
              },
            ],
          ]),
          defs: [
            {
              name: "mcp__files__read",
              description: "Read a file via the files MCP server",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
        }),
      },
    )

    const session = env.sessions.create("extra-tools-test")
    await manager.enqueue(session.id, { userText: "看看文件", trigger: "user" })

    expect(reqs.length).toBeGreaterThan(0)
    const def = reqs[0]!.tools.find((t) => t.name === "mcp__files__read")
    expect(def).toBeDefined()
    expect(def?.description).toBe("Read a file via the files MCP server")
    expect(def?.parameters).toMatchObject({ type: "object" })
    // Builtin defs still present alongside the adapter's.
    expect(reqs[0]!.tools.some((t) => t.name === "fs_read")).toBe(true)
  })

  it("re-evaluates extraTools per run (reconnect recovery reflected)", async () => {
    const reqs: LlmRequest[] = []
    let connected = false
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurn("收到")]), reqs),
      undefined,
      undefined,
      {
        extraTools: () => ({
          executors: connected
            ? new Map([["mcp__x__t", { risk: "safe", concurrency: "parallel", execute: async () => ({ status: "ok", output: "" }) }]])
            : new Map(),
          defs: connected
            ? [{ name: "mcp__x__t", description: "later-connected tool", parameters: { type: "object" } }]
            : [],
        }),
      },
    )
    const session = env.sessions.create("extra-tools-live")
    await manager.enqueue(session.id, { userText: "第一轮", trigger: "user" })
    expect(reqs[0]!.tools.some((t) => t.name === "mcp__x__t")).toBe(false)

    connected = true // server came up between runs
    await manager.enqueue(session.id, { userText: "第二轮", trigger: "user" })
    expect(reqs.at(-1)!.tools.some((t) => t.name === "mcp__x__t")).toBe(true)
  })
})

describe("RunManager attachment mounting", () => {
  it("mounts a text attachment inline and an image as multimodal parts", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(recordRequests(scriptClient([textTurn("收到")]), reqs))
    const session = env.sessions.create("att-mount")
    const attDir = join(env.paths.attachmentsDir, session.id)
    mkdirSync(attDir, { recursive: true })
    const textPath = join(attDir, "note.md")
    writeFileSync(textPath, "# 备忘\n买牛奶")
    const imgPath = join(attDir, "shot.png")
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    await manager.enqueue(session.id, {
      userText: "看附件",
      trigger: "user",
      attachments: [
        { path: textPath, name: "note.md", size: 12, mimeType: "text/markdown" },
        { path: imgPath, name: "shot.png", size: 4, mimeType: "image/png" },
      ],
    })

    const userMsg = reqs[0]!.messages.find((m) => m.role === "user")
    expect(userMsg).toBeDefined()
    const content = userMsg!.content
    expect(Array.isArray(content)).toBe(true)
    const parts = content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("[附件 note.md]") })
    expect(parts.some((p) => p.type === "image_url" && p.image_url?.url.startsWith("data:image/png;base64,"))).toBe(true)
  })

  it("leaves large non-text attachments as metadata only", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(recordRequests(scriptClient([textTurn("收到")]), reqs))
    const session = env.sessions.create("att-meta")
    const attDir = join(env.paths.attachmentsDir, session.id)
    mkdirSync(attDir, { recursive: true })
    const pdfPath = join(attDir, "big.pdf")
    writeFileSync(pdfPath, "PDF!")

    await manager.enqueue(session.id, {
      userText: "看看",
      trigger: "user",
      attachments: [{ path: pdfPath, name: "big.pdf", size: 999_999, mimeType: "application/pdf" }],
    })
    const userMsg = reqs[0]!.messages.find((m) => m.role === "user")
    expect(typeof userMsg!.content).toBe("string")
    expect(userMsg!.content).toContain("仅元数据")
    expect(userMsg!.content).toContain("fs_read")
  })

  it("rejects an attachment outside the session dir", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("收到")]))
    const session = env.sessions.create("att-bad")
    const outside = join(env.paths.attachmentsDir, "other-session", "x.txt")
    mkdirSync(join(env.paths.attachmentsDir, "other-session"), { recursive: true })
    writeFileSync(outside, "x")
    await expect(
      manager.enqueue(session.id, {
        userText: "hi",
        trigger: "user",
        attachments: [{ path: outside, name: "x.txt", size: 1, mimeType: "text/plain" }],
      }),
    ).rejects.toThrow(/outside the session/)
  })
})

describe("RunManager model resolution + usage recording", () => {
  it("resolves session meta model over the daemon default", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(recordRequests(scriptClient([textTurn("收到")]), reqs))
    const session = env.sessions.create("model-session")
    env.sessions.updateMeta(session.id, { model: "glm-4" })
    await manager.enqueue(session.id, { userText: "hi", trigger: "user" })
    expect(reqs[0]!.model).toBe("glm-4")
  })

  it("input.model wins over the session meta model", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(recordRequests(scriptClient([textTurn("收到")]), reqs))
    const session = env.sessions.create("model-session2")
    env.sessions.updateMeta(session.id, { model: "glm-4" })
    await manager.enqueue(session.id, { userText: "hi", trigger: "user", model: "deep-1" })
    expect(reqs[0]!.model).toBe("deep-1")
  })

  it("resolves a provider ENTRY key to its wire model", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurn("收到")]), reqs),
      (c) => {
        c.providers.entries.deepseek = { baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "deepseek-v4-flash" }
      },
    )
    const session = env.sessions.create("model-session3")
    // The WebUI/CLI store the entry KEY ("deepseek"); the wire model must be
    // the entry's `.model` ("deepseek-v4-flash"), not the key itself.
    env.sessions.updateMeta(session.id, { model: "deepseek" })
    await manager.enqueue(session.id, { userText: "hi", trigger: "user" })
    expect(reqs[0]!.model).toBe("deepseek-v4-flash")
  })

  it("records per-run usage into the ledger with the resolved model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kclaw-usage-run-"))
    const usage = new UsageStore(join(dir, "usage.db"))
    const { env, manager } = makeEnv(scriptClient([textTurn("收到")]), undefined, undefined, { usageStore: usage })
    const session = env.sessions.create("usage-session")
    await manager.enqueue(session.id, { userText: "hi", trigger: "user" })
    const t = usage.total({})
    expect(t.inputTokens).toBeGreaterThan(0) // script textTurn carries usage
    expect(t.outputTokens).toBeGreaterThan(0)
    const bySession = usage.aggregate("session", {})
    expect(bySession[0]!.key).toBe(session.id)
    usage.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

// --- sandbox.checked 事件审计（批次 D，第 10 种持久化事件）---------------------
// 每次 run 在沙箱探测后立即落一条 sandbox.checked 事件：config 开关、是否真的
// 探测、探测结果与原因（只落盘，不上总线；不进投影、不推进 updatedAt）。语义
// 拍板：写入失败即本次 run 失败（与 system 事件同待遇——审计承诺必须完整）。

describe("RunManager sandbox.checked 事件审计", () => {
  type StreamEvent = ReturnType<SessionStore["readEvents"]>[number]
  const isSandbox = (e: StreamEvent): e is StreamEvent & { type: "sandbox.checked"; enabled: boolean; available: boolean } =>
    e.type === "sandbox.checked"

  it("一次 run 落恰好一条 sandbox.checked：配置关闭时 enabled 为 false、不带原因", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("收到")])) // makeEnv 默认关闭沙箱
    const session = env.sessions.create("沙箱审计关闭会话")

    await manager.enqueue(session.id, { userText: "你好", trigger: "user" })

    const events = env.sessions.readEvents(session.id)
    const sandboxEvents = events.filter(isSandbox)
    expect(sandboxEvents).toHaveLength(1)
    expect(sandboxEvents[0]).toMatchObject({ enabled: false, available: false })
    expect("unavailableReason" in sandboxEvents[0]!).toBe(false)
    // 流序：sandbox.checked 先于本 run 的 user 消息事件
    const sbIdx = events.findIndex(isSandbox)
    const userMsgIdx = events.findIndex((e) => e.type === "message" && e.role === "user")
    expect(userMsgIdx).toBeGreaterThan(sbIdx)
  })

  it("配置开启时如实留痕宿主探测结果", async () => {
    // 宿主的真实探测结果（macOS sandbox-exec / Linux bwrap）：有沙箱则
    // available:true，无则 false 且带原因——本测试两种走向都必须如实断言。
    const hasHostSandbox =
      process.platform === "darwin" ||
      spawnSync("which", ["bwrap"], { encoding: "utf8" }).status === 0
    const { env, manager } = makeEnv(
      scriptClient([textTurn("收到")]),
      (c) => { c.sandbox = { enabled: true, writeRoots: [] } },
    )
    const session = env.sessions.create("沙箱审计开启会话")

    await manager.enqueue(session.id, { userText: "你好", trigger: "user" })

    const [sandboxEvent] = env.sessions.readEvents(session.id).filter(isSandbox)
    expect(sandboxEvent!.enabled).toBe(true)
    expect(sandboxEvent!.available).toBe(hasHostSandbox)
    if (!hasHostSandbox) expect(typeof sandboxEvent!.unavailableReason).toBe("string")
  })

  it("appendSandboxChecked 写入失败即本次 run 失败：outcome 拒绝 + queue_entry_failed 可见性，驱动器不停转", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("收到")]))
    const session = env.sessions.create("炸沙箱审计会话")
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    // 只炸 appendSandboxChecked 的 store 视图："跑了但没留痕"的静默缺口不允许
    const failingStore = Object.create(env.sessions) as SessionStore
    Object.defineProperty(failingStore, "appendSandboxChecked", {
      value(): void {
        throw new Error("disk full: cannot append sandbox.checked")
      },
    })
    const failingManager = new RunManager({
      config: env.config, paths: env.paths, sessions: failingStore,
      memory: env.memory, bus: env.bus,
      llm: scriptClient([textTurn("收到")]), workspace: env.config.workspace,
    })

    // 装配段（runAgent 之前）同步抛 → 驱动器条目级失败兜底：outcome 以该错误拒绝
    await expect(failingManager.enqueue(session.id, { userText: "写不进去", trigger: "user" }))
      .rejects.toThrow("disk full: cannot append sandbox.checked")

    // 可见性：bus 上补发 run.failed {code:"queue_entry_failed"}，message 带原因
    const failed = received(socket).find((e) => e.type === "run.failed")
    expect(failed).toBeDefined()
    expect(failed!.payload).toMatchObject({ error: { code: "queue_entry_failed" } })
    expect((failed!.payload as { error: { message: string } }).error.message).toContain("disk full")

    // 驱动器没有停转：随后一次正常 enqueue 照常完成并补上审计
    const outcome = await manager.enqueue(session.id, { userText: "再来一次", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")
    expect(env.sessions.readEvents(session.id).filter(isSandbox)).toHaveLength(1)
  })
})

// --- run 边界与权限裁决的档案事件（issue #18）--------------------------------
// 每次 run 落一对 run.started / run.ended（含 trigger、stopReason、usage/error），
// 每次人工确认的裁决落一条 permission.decided。只落盘不上总线；不进投影、
// 不推进 updatedAt。写入失败即本次 run 失败（与 system/sandbox 审计同待遇）。

describe("RunManager run 边界与权限裁决档案事件", () => {
  type StreamEvent = ReturnType<SessionStore["readEvents"]>[number]
  const of = (events: StreamEvent[], type: "run.started" | "run.ended" | "permission.decided") =>
    events.filter((e) => e.type === type)

  it("一次 run 落恰好一对 run.started / run.ended：trigger、stopReason、usage 就位，夹住本轮消息事件", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("收到")]))
    const session = env.sessions.create("边界会话")

    await manager.enqueue(session.id, { userText: "你好", trigger: "user" })

    const events = env.sessions.readEvents(session.id)
    const started = of(events, "run.started")
    const ended = of(events, "run.ended")
    expect(started).toHaveLength(1)
    expect(ended).toHaveLength(1)
    expect(started[0]).toMatchObject({ trigger: "user" })
    expect(ended[0]).toMatchObject({ stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } })
    expect("error" in ended[0]!).toBe(false)
    // 次序：run.started 先于本 run 的 user 消息事件，run.ended 殿后
    const first = events.findIndex((e) => e.type === "run.started")
    const userMsg = events.findIndex((e) => e.type === "message" && e.role === "user")
    const last = events.findIndex((e) => e.type === "run.ended")
    expect(first).toBeLessThan(userMsg)
    expect(last).toBe(events.length - 1)
  })

  it("失败的 run 也落 run.ended（stopReason error + 失败原因）——有始必有终", async () => {
    const { env, manager } = makeEnv({
      async *stream(): AsyncIterable<LlmStreamEvent> { throw new Error("provider down") },
    })
    const session = env.sessions.create("失败边界会话")

    const outcome = await manager.enqueue(session.id, { userText: "你好", trigger: "user" })
    expect(outcome.stopReason).toBe("error")

    const ended = of(env.sessions.readEvents(session.id), "run.ended")
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ stopReason: "error", error: { code: "llm_error" } })
  })

  it("确认批准落 permission.decided：verdict、actor、工具身份齐全，先于工具执行", async () => {
    const { env, manager } = makeEnv(scriptClient([execToolTurn("call_2", "echo yes"), textTurn("好")]))
    const session = env.sessions.create("裁决会话")

    const run = manager.enqueue(session.id, { userText: "执行 echo yes", trigger: "user" })
    const deadline = Date.now() + 2000
    while (manager.broker.pending().length === 0) {
      if (Date.now() > deadline) throw new Error("confirmation never became pending")
      await new Promise((r) => setTimeout(r, 5))
    }
    const [listed] = manager.broker.pending()
    expect(listed).toMatchObject({
      confirmationId: expect.stringMatching(/^conf_/),
      toolCall: expect.objectContaining({ name: "exec" }),
      risk: "sensitive",
    })
    expect(manager.broker.resolve(listed!.confirmationId, "once", "cli")).toBe(true)
    await run

    const events = env.sessions.readEvents(session.id)
    const decided = of(events, "permission.decided")
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({
      confirmationId: listed!.confirmationId,
      decision: "once",
      by: "cli",
      tool: { callId: "call_2", name: "exec", argsJson: expect.stringContaining("echo yes") },
    })
    // 次序：裁决记录在对应的工具结果消息事件之前
    const decidedIdx = events.findIndex((e) => e.type === "permission.decided")
    const toolResultIdx = events.findIndex((e) => e.type === "message" && e.role === "tool")
    expect(decidedIdx).toBeLessThan(toolResultIdx)
  })

  it("确认超时落 decision timeout / by timeout；拒绝落 decision reject", async () => {
    const { env, manager } = makeEnv(
      scriptClient([execToolTurn("call_t", "echo slow"), textTurn("好")]),
      (c) => { c.permissions.confirmTimeoutMs = 50 },
    )
    const session = env.sessions.create("超时裁决会话")
    await manager.enqueue(session.id, { userText: "执行 echo slow", trigger: "user" })

    const timedOut = of(env.sessions.readEvents(session.id), "permission.decided")
    expect(timedOut).toHaveLength(1)
    expect(timedOut[0]).toMatchObject({ decision: "timeout", by: "timeout" })

    const { env: env2, manager: manager2 } = makeEnv(
      scriptClient([execToolTurn("call_r", "echo no"), textTurn("好")]),
      undefined,
      () => Promise.resolve({ decision: "reject" as const, by: "web" as const }),
    )
    const session2 = env2.sessions.create("拒绝裁决会话")
    await manager2.enqueue(session2.id, { userText: "执行 echo no", trigger: "user" })

    const rejected = of(env2.sessions.readEvents(session2.id), "permission.decided")
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ decision: "reject", by: "web" })
  })

  it("运行中被中止的 run 落 run.ended stopReason aborted；确认等待中的中止不落裁决", async () => {
    // 挂起的流让 run 停在确认等待：中止后既不该有裁决记录，也必须有 ended 落款。
    const { env, manager } = makeEnv(
      scriptClient([execToolTurn("call_a", "echo hang"), textTurn("好")]),
      (c) => { c.permissions.confirmTimeoutMs = 60_000 },
    )
    const session = env.sessions.create("中止会话")
    const run = manager.enqueue(session.id, { userText: "执行 echo hang", trigger: "user" })

    const deadline = Date.now() + 2000
    while (manager.broker.pending().length === 0) {
      if (Date.now() > deadline) throw new Error("confirmation never became pending")
      await new Promise((r) => setTimeout(r, 5))
    }
    await manager.cancel(session.id)
    const outcome = await run
    expect(outcome.stopReason).toBe("aborted")

    const events = env.sessions.readEvents(session.id)
    expect(of(events, "permission.decided")).toHaveLength(0)
    const ended = of(events, "run.ended")
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ stopReason: "aborted" })
  })
})

describe("RunManager readonly mode", () => {
  it("keeps write-class tools off the surface: a stubborn call errors unknown and never runs", async () => {
    const { env, manager } = makeEnv(scriptClient([
      [
        { type: "tool_call_started", index: 0, callId: "c1", name: "fs_write" },
        { type: "tool_call_delta", index: 0, delta: "{}" },
        { type: "message_done", stopReason: "tool_use" as const, usage: { inputTokens: 10, outputTokens: 1 } },
      ],
      [textTurn("完成")],
    ]))
    const session = env.sessions.create("ro-session")
    env.sessions.updateMeta(session.id, { mode: "readonly" })
    const outcome = await manager.enqueue(session.id, { userText: "写个文件", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")
    // fs_write is not even listed in readonly mode, so the call never reaches
    // the gate: the loop answers it as an unknown tool (the model kept the
    // name from stale context), and no denied note is produced.
    const messages = env.sessions.readMessages(session.id)
    const toolMsg = messages.find((m) => m.role === "tool")
    const result = toolMsg?.blocks.find((b) => b.type === "tool_result") as { status: string; output: string } | undefined
    expect(result?.status).toBe("error")
    expect(result?.output).toContain("unknown tool: fs_write")
    const deniedNote = messages.some((m) =>
      m.blocks.some((b) => b.type === "note" && "kind" in b && (b as { kind?: string }).kind === "denied"),
    )
    expect(deniedNote).toBe(false)
  })
})

describe("RunManager subagent session guard", () => {
  it("rejects user-triggered submissions on a child session (read-only to users)", () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("不会被消费")]))
    const parent = env.sessions.create("主会话")
    // 子会话：meta 带 parentSessionId（create 的第五参）
    const child = env.sessions.create("子代理 · 试跑", undefined, undefined, "default", parent.id)
    expect(() => manager.submit(child.id, { userText: "插话", trigger: "user" }))
      .toThrow("子代理会话不接收用户消息")
    // 没有任何消息落进子会话
    expect(env.sessions.readMessages(child.id)).toHaveLength(0)
  })
})

// --- skill 注入（渐进披露：列表常驻 + skill_read 按需取正文）------------------
// 技能目录每 run 重扫：全局 <home>/skills + 项目 <workdir>/.kclaw/skills，
// 项目级整目录覆盖全局。模型可见段追加进系统提示词（persona + 认知之后），
// 与 system 审计事件同文；disable-model-invocation 的技能不进列表。

function writeSkill(root: string, name: string, md: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, "SKILL.md"), md)
}

function skillReadToolTurn(callId: string, name: string): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name: "skill_read" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ name }) },
    { type: "message_done", stopReason: "tool_use" as const, usage: { inputTokens: 1, outputTokens: 2 } },
  ]
}

describe("RunManager skill injection", () => {
  type StreamEvent = ReturnType<SessionStore["readEvents"]>[number]
  const isSystem = (e: StreamEvent): e is StreamEvent & { type: "system"; text: string } => e.type === "system"

  it("model-visible skill lands in the prompt and the system audit event; disable-model-invocation does not", async () => {
    const requests: LlmRequest[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* textTurn("好的")
      },
    }
    const { env, manager } = makeEnv(llm)
    writeSkill(join(env.paths.home, "skills"), "commit-helper", "---\ndescription: 按仓库规范写提交说明。\n---\n\n# 提交规范\n\n一行标题。\n")
    writeSkill(join(env.paths.home, "skills"), "heavy-flow", "---\ndescription: 重流程。\ndisable-model-invocation: true\n---\n\n正文\n")
    const session = env.sessions.create("技能会话")

    await manager.enqueue(session.id, { userText: "帮我提交", trigger: "user" })

    const system = requests[0]!.system ?? ""
    expect(system).toContain("## 可用技能")
    expect(system).toContain("commit-helper")
    expect(system).toContain("按仓库规范写提交说明")
    expect(system).not.toContain("heavy-flow")
    // system 审计事件两段拼接 = 发给模型的提示词；技能清单归属实时段
    const [systemEvent] = env.sessions.readEvents(session.id).filter(isSystem)
    const joined = [systemEvent!.stable, systemEvent!.live].filter((x) => x !== "").join("\n\n")
    expect(joined).toBe(system)
    expect(systemEvent!.live).toContain("## 可用技能")
  })

  it("project skill overrides the same-named global one for sessions in that workdir", async () => {
    const requests: LlmRequest[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* textTurn("好的")
      },
    }
    const { env, manager } = makeEnv(llm)
    writeSkill(join(env.paths.home, "skills"), "deploy", "---\ndescription: 全局部署版。\n---\n\n全局正文\n")
    // makeEnv 把 config.workspace 设为临时目录；项目技能放它的 .kclaw/skills
    writeSkill(join(env.config.workspace, ".kclaw", "skills"), "deploy", "---\ndescription: 项目部署版。\n---\n\n项目正文\n")
    const session = env.sessions.create("项目技能会话")

    await manager.enqueue(session.id, { userText: "部署", trigger: "user" })

    const system = requests[0]!.system ?? ""
    expect(system).toContain("项目部署版")
    expect(system).not.toContain("全局部署版")
  })

  it("分段冻结：两轮之间新放的技能下一轮进清单（stable 前缀逐字节不变）；压缩清除后重新装配", async () => {
    const requests: LlmRequest[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* textTurn("好的")
      },
    }
    const { env, manager } = makeEnv(llm)
    const session = env.sessions.create("分段冻结会话")

    await manager.enqueue(session.id, { userText: "第一轮", trigger: "user" })
    expect(requests[0]!.system ?? "").not.toContain("## 可用技能")
    const stable1 = env.sessions.meta(session.id)!.systemBaseline!.stable.text

    // live 段即时生效：两轮之间新放的技能在下一轮的清单里出现；stable 前缀
    // 逐字节不变（前缀缓存命中面），只是实时段起重新计算。
    writeSkill(join(env.config.workspace, ".kclaw", "skills"), "fresh", "---\ndescription: 新放的技能。\n---\n\n正文\n")
    await manager.enqueue(session.id, { userText: "第二轮", trigger: "user" })
    expect(requests[1]!.system ?? "").toContain("fresh")
    expect((requests[1]!.system ?? "").startsWith(stable1)).toBe(true)
    expect(env.sessions.meta(session.id)!.systemBaseline!.stable).toEqual(
      env.sessions.meta(session.id)!.systemBaseline!.stable,
    )

    // 压缩清除双段基线（重冻结边界 = 缓存冷启动）：下一轮重新装配，清单保持。
    env.sessions.appendCompaction(session.id, { at: new Date().toISOString(), trigger: "auto", from: null, upto: "m1", messages: 1, segmentSummary: "s", top: "t" })
    await manager.enqueue(session.id, { userText: "第三轮", trigger: "user" })
    expect(requests[2]!.system ?? "").toContain("fresh")
    expect((requests[2]!.system ?? "").startsWith(stable1)).toBe(true)
  })

  it("skill_read loads the body as a tool result (project copy wins on name)", async () => {
    const { env, manager } = makeEnv(scriptClient([
      skillReadToolTurn("call_skill", "deploy"),
      textTurn("照规程部署完成"),
    ]))
    writeSkill(join(env.paths.home, "skills"), "deploy", "---\ndescription: 部署。\n---\n\n# 全局部署正文\n\n1. 拉取镜像\n")
    writeSkill(join(env.config.workspace, ".kclaw", "skills"), "deploy", "---\ndescription: 部署。\n---\n\n# 项目部署正文\n\n1. 先切流量\n")

    const session = env.sessions.create("取文会话")
    const outcome = await manager.enqueue(session.id, { userText: "按 deploy 技能部署", trigger: "user" })

    expect(outcome.stopReason).toBe("end_turn")
    const msgs = env.sessions.readMessages(session.id)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const result = msgs[2]!.blocks[0] as ToolResultBlock
    expect(result.status).toBe("ok")
    expect(result.output).toContain("# 项目部署正文")
    expect(result.output).not.toContain("全局部署正文")
  })
})

// --- 技能点名的隐式包装（mapLlmMessages 钩子，Master 2026-09-03）----------
// 气泡/持久化/事件流保持用户原文；只有发给模型的 provider 请求在钩子里被
// 追加一行“先 skill_read 读规程再执行”的调用指示。

describe("RunManager skill invocation wrap", () => {
  const seenUserText = (req: LlmRequest): string => {
    const users = req.messages.filter((m) => m.role === "user") as { content: string }[]
    return users.at(-1)!.content
  }

  it("wraps an in-text /skill mention for the model; persistence and events stay raw", async () => {
    const requests: LlmRequest[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* textTurn("好的")
      },
    }
    const { env, manager } = makeEnv(llm)
    writeSkill(join(env.paths.home, "skills"), "test", "---\ndescription: 验收技能。\n---\n\n正文\n")
    const session = env.sessions.create("包装会话")

    await manager.enqueue(session.id, { userText: "帮我 /test 跑一下", trigger: "user" })

    // 模型视图：原文打底 + 一行技能调用指示
    const seen = seenUserText(requests[0]!)
    expect(seen.startsWith("帮我 /test 跑一下")).toBe(true)
    expect(seen).toContain("「/test」是在调用技能 test")
    expect(seen).toContain("skill_read")
    // 持久化（events.jsonl 的 message 事件）：原文
    const msgs = env.sessions.readMessages(session.id)
    expect((msgs[0]!.blocks[0] as { type: string; text: string }).text).toBe("帮我 /test 跑一下")
    // 事件流（轨迹页/气泡的数据源）：原文
    const messageEvent = env.sessions.readEvents(session.id).find((e) => e.type === "message") as
      | { blocks: { type: string; text: string }[] }
      | undefined
    expect(messageEvent!.blocks[0]!.text).toBe("帮我 /test 跑一下")
  })

  it("skips the wrap for user-invocable:false skills and unknown tokens", async () => {
    const requests: LlmRequest[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* textTurn("好的")
      },
    }
    const { env, manager } = makeEnv(llm)
    writeSkill(join(env.paths.home, "skills"), "inner", "---\ndescription: 仅模型。\nuser-invocable: false\n---\n\n正文\n")
    const session = env.sessions.create("不包装会话")

    await manager.enqueue(session.id, { userText: "看 /inner 和 /nope", trigger: "user" })

    expect(seenUserText(requests[0]!)).toBe("看 /inner 和 /nope")
  })

  it("still wraps a leading /skill command (regression of the client-era entry)", async () => {
    const requests: LlmRequest[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield* textTurn("好的")
      },
    }
    const { env, manager } = makeEnv(llm)
    writeSkill(join(env.paths.home, "skills"), "deploy", "---\ndescription: 部署。\n---\n\n正文\n")
    const session = env.sessions.create("行首点名会话")

    await manager.enqueue(session.id, { userText: "/deploy 上线", trigger: "user" })

    const seen = seenUserText(requests[0]!)
    expect(seen.startsWith("/deploy 上线")).toBe(true)
    expect(seen).toContain("「/deploy」是在调用技能 deploy")
  })
})
