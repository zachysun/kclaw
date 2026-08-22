/**
 * RunManager integration tests: the daemon-side send_message → runAgent
 * assembly on REAL stores under a temp KCLAW_HOME, driven by a scripted
 * LlmClient (local twin of the P1/P2 script-client helpers).
 *
 * Covers: happy text turn (outcome + JSONL + bus fan-out), memory note
 * injection onto the user message, per-session serialization vs cross-session
 * concurrency, the whitelisted tool round, and cancel() of a hanging
 * run.
 */
import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MemoryStore, SessionStore, loadConfig, resolvePaths, withRetry } from "@kclaw/core"
import type {
  AgentEvent, AssistantMessage, KclawConfig, KclawPaths, LlmClient, LlmStreamEvent, ToolExecutor, ToolMessage, ToolResultBlock,
} from "@kclaw/core"
import { EventBus } from "../src/bus.js"
import { ConfirmationBroker } from "../src/confirm.js"
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
  return [
    { type: "tool_call_started", index: 0, callId, name: "exec" },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify({ command }) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
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
  memory: MemoryStore
  bus: EventBus
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
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  patchConfig?.(config)

  const sessions = new SessionStore(paths.sessionsDir)
  const memory = new MemoryStore({ notesDir: paths.memoryNotesDir, indexDb: paths.memoryIndexDb })
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
    await env.memory.save({ text: "用户在上海，喜欢本帮菜" })
    const session = env.sessions.create("记忆会话")

    await manager.enqueue(session.id, { userText: "上海 本帮菜", trigger: "user" })

    const [user] = env.sessions.readMessages(session.id)
    expect(user!.blocks).toEqual([
      { id: expect.any(String), type: "text", text: "上海 本帮菜" },
      {
        id: expect.any(String), type: "note", kind: "memory",
        text: "相关记忆: 用户在上海，喜欢本帮菜",
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

  it("emits user message lifecycle + note.emitted on the bus in §5.4 order (P4 T1)", async () => {
    const { env, manager } = makeEnv(scriptClient([textTurn("好的")]))
    await env.memory.save({ text: "用户在上海" })
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
      block: { id: expect.any(String), type: "note", kind: "memory", text: "相关记忆: 用户在上海" },
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
      { id: expect.any(String), type: "note", kind: "memory", text: "相关记忆: 用户在上海" },
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

    // spec §11 invariant on the bus: run.started … run.failed (terminal),
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
    const second = manager.enqueue(session.id, { userText: "第二句", trigger: "user" })

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
      async () => ({ approved: false, by: "web" }),
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
      () => new Promise<{ approved: boolean; by: "web" }>(() => {}), // never settles
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
    const late = new Promise<{ approved: boolean; by: "web" }>((resolve) => {
      setTimeout(() => resolve({ approved: true, by: "web" }), 250)
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
    expect(requests[0]!.system).toBe("# 人设\n你是测试助理。")

    // a second session WITHOUT AGENTS.md… is impossible here (same home), so
    // the default branch is pinned from a fresh home with no file written.
    const fresh = makeEnv(llm)
    const session2 = fresh.env.sessions.create("默认人设会话")
    await fresh.manager.enqueue(session2.id, { userText: "嗨", trigger: "user" })
    expect(requests.at(-1)!.system).toBe("你是 kclaw，一个务实的个人助理。")
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

  it("surfaces provider retries as llm.failed {willRetry:true} events with run context (I1)", async () => {
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

  it("resets the attempt counter between llm calls: every llm.started reports its own attempt (I1)", async () => {
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

  it("records a throwing executor's error tool_result (M-b)", async () => {
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
