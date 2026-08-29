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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MemoryStore, SessionStore, UsageStore, loadConfig, newAssistantMessage, newMessage, resolvePaths, withRetry } from "@kclaw/core"
import type {
  AgentEvent, AssistantMessage, KclawConfig, KclawPaths, LlmClient, LlmRequest, LlmStreamEvent, Message, ToolExecutor, ToolMessage, ToolResultBlock,
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

  it("emits user message lifecycle + note.emitted on the bus in wire order", async () => {
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
    // spec §9: run.cancel 不再连带取消排队消息（旧 #cancelQueued 行为删除）——
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

describe("RunManager context compaction v2", () => {
  it("compacts over-budget history: two summarizer calls, segment index, compact note", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurn("段摘要A"), textTurn("总摘要A"), textTurn("主回复")]), reqs),
      (c) => { c.sessions.contextTokens = 10 }, // tiny budget: force the trigger
    )
    const session = env.sessions.create("压缩会话")
    const seeded = seedHistory(env.sessions, session.id, 2) // 4 messages
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })

    // three LLM calls: segment summary, top merge, then the main conversation
    expect(reqs.length).toBe(3)
    const [segReq, mergeReq, mainReq] = reqs
    expect(segReq!.tools).toEqual([])
    expect(segReq!.system).toContain("对话摘要器")
    expect(segReq!.messages[0]!.content).toContain("历史问题1")
    expect(mergeReq!.system).toContain("对话摘要归并器")
    // first compaction has no previous top: the merge input IS the segment summary
    expect(mergeReq!.messages[0]!.content).toContain("段摘要A")

    // meta carries the v2 state
    const meta = env.sessions.meta(session.id)
    expect(meta!.compaction).toMatchObject({ top: "总摘要A", upto: seeded[1]!.id })
    expect(meta!.compaction!.segments).toHaveLength(1)
    // the persisted user message carries the compact note
    const msgs = env.sessions.readMessages(session.id)
    const user = msgs.find((m) => m.role === "user" && m.blocks.some((b) => b.type === "text" && b.text === "新问题"))!
    const note = user.blocks.find((b) => b.type === "note" && b.kind === "compact")
    expect((note as { text?: string }).text).toContain("已压缩为 1 段")
    expect((note as { text?: string }).text).toContain("session_search")
    // structured meta for the UI (segment count + kept tail size), invisible to the model
    expect(note).toMatchObject({ compact: { segments: 1, kept: 2 } })
    // the compact note was broadcast on the bus
    expect(received(socket).some((e) =>
      e.type === "note.emitted" && (e.payload as { block: { kind?: string } }).block?.kind === "compact",
    )).toBe(true)
    // the main request sees only the kept tail + the new user text
    expect(JSON.stringify(mainReq!.messages)).not.toContain("历史问题1")
    expect(JSON.stringify(mainReq!.messages)).toContain("历史问题2")
    expect(JSON.stringify(mainReq!.messages)).toContain("新问题")
    // the segment index was written under the session dir
    expect(existsSync(join(env.paths.sessionsDir, session.id, "index.db"))).toBe(true)
  })

  it("second compaction merges the previous top into the new one", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([
        textTurn("段摘要A"), textTurn("总摘要A"), textTurnWithUsage("主回复", 10_000),
        textTurn("段摘要B"), textTurn("总摘要B"), textTurnWithUsage("主回复2", 10_000),
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
    // the second merge's input carries the old top and the new segment summary
    const mergeInput = reqs[4]!.messages[0]!.content as string
    expect(mergeInput).toContain("总摘要A")
    expect(mergeInput).toContain("段摘要B")
  })

  /**
   * Master's 2026-08-28 report (tiny test budget, real network latency):
   * send "a" → total silence (no echo, no "compacting" hint) while the
   * pre-run compaction's two LLM calls run; send "b" meanwhile → b waits,
   * then triggers a SECOND compaction that swallows a's exchange, so "a"
   * renders late with a 1-segment note and "b" later still with a 2-segment
   * note. FIXED EXPECTATIONS: the compaction announces itself on the bus
   * (compaction.started while the summarizer runs, compaction.completed
   * after the meta write), so the silence window is gone.
   */
  it("during rapid input: compaction announces itself, queued second message re-compacts", async () => {
    const calls: LlmRequest[] = []
    let firstCallStarted!: () => void
    const firstCall = new Promise<void>((r) => { firstCallStarted = r })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const script = [
      textTurn("段摘要A"), textTurn("总摘要A"), textTurnWithUsage("回答A", 10_000),
      textTurn("段摘要B"), textTurn("总摘要B"), textTurn("回答B"),
    ]
    let i = 0
    const client: LlmClient = {
      async *stream(req) {
        calls.push(req)
        if (i === 0) {
          firstCallStarted()
          await gate // stand in for the seconds-long real summarizer call
        }
        yield* script[Math.min(i++, script.length - 1)]!
      },
    }

    const { env, manager } = makeEnv(client, (c) => { c.sessions.contextTokens = 10 })
    const session = env.sessions.create("压缩观察")
    seedHistory(env.sessions, session.id, 2)
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)

    // Master sends "a"; the pre-run compaction's first summarizer call is
    // in flight. FIXED: the bus already announced the compaction — the
    // silence window (no events at all) is gone.
    const aP = manager.enqueue(session.id, { userText: "a", trigger: "user" })
    await firstCall
    expect(calls.length).toBe(1)
    expect(received(socket).map((e) => e.type)).toEqual(["compaction.started"])

    // Seeing no reaction, Master types "b" while the compaction is running.
    // 排队是显式处置：b 要测"排队后 re-compact"，须显式 wait（默认 steer 进引导缓冲）
    const bP = manager.enqueue(session.id, { userText: "b", trigger: "user", disposition: "wait" })
    release()
    await aP
    await bP

    // The completed event follows the meta write, before the run's own events.
    const events = received(socket)
    const types = events.map((e) => e.type)
    expect(types.indexOf("compaction.completed")).toBeGreaterThanOrEqual(0)
    expect(types.indexOf("compaction.completed")).toBeLessThan(types.indexOf("run.started"))
    const completedEv = events.find((e) => e.type === "compaction.completed") as { payload: { segments: number; kept: number } }
    expect(completedEv.payload.segments).toBe(1)

    // SYMPTOM 2 (per-session queue works, but nothing announced it): b's run
    // only starts after a's run completed — its message echo arrives late.
    const idx = (pred: (e: AgentEvent) => boolean): number =>
      events.findIndex((e) => pred(e))
    const aCompleted = idx((e) => e.type === "run.completed")
    const bCreated = idx((e) =>
      e.type === "message.created" &&
      JSON.stringify(e.payload).includes("\"b\""))
    expect(aCompleted).toBeGreaterThanOrEqual(0)
    expect(bCreated).toBeGreaterThan(aCompleted)

    // SYMPTOM 3: b's run re-compacted — six LLM calls (2× summary pair + 2×
    // main). The second segment summary swallows the PREVIOUS retention
    // window; a's own exchange ("a"/"回答A" is tiny here) falls inside the new
    // one — with real long replies it would be swallowed too (same boundary
    // walk, just more mass above the target line).
    expect(calls.length).toBe(6)
    expect(calls[3]!.messages[0]!.content as string).toContain("历史问题2")
    expect(calls[3]!.messages[0]!.content as string).not.toContain("回答A")
    const meta = env.sessions.meta(session.id)
    expect(meta!.compaction!.segments).toHaveLength(2)
    const msgs = env.sessions.readMessages(session.id)
    const notes = msgs
      .filter((m) => m.role === "user" && ["a", "b"].includes(String(m.blocks.find((b) => b.type === "text")?.text ?? "")))
      .map((m) => (m.blocks.find((b) => b.type === "note" && b.kind === "compact") as { text?: string } | undefined)?.text ?? "")
    expect(notes[0]).toContain("已压缩为 1 段")
    expect(notes[1]).toContain("已压缩为 2 段")
  })

  it("upgrades a legacy compactedSummary session: old summary seeds the top", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurn("段摘要N"), textTurn("总摘要N"), textTurn("主回复")]), reqs),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("旧格式")
    const seeded = seedHistory(env.sessions, session.id, 2)
    env.sessions.updateMeta(session.id, { compactedSummary: "旧总摘要", compactedUpto: seeded[0]!.id })

    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })

    const meta = env.sessions.meta(session.id)
    expect(meta!.compaction!.top).toBe("总摘要N")
    // legacy fields cleared
    expect(meta!.compactedSummary).toBeUndefined()
    expect(meta!.compactedUpto).toBeUndefined()
    // the merge input seeded from the legacy top
    expect((reqs[1]!.messages[0]!.content as string)).toContain("旧总摘要")
  })

  it("falls back to full history when the summarizer call fails", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(failFirstClient("摘要挂了", textTurn("主回复")), reqs),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("回退")
    seedHistory(env.sessions, session.id, 2)
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)
    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    const meta = env.sessions.meta(session.id)
    expect(meta?.compaction).toBeUndefined()
    expect(JSON.stringify(reqs.at(-1)!.messages)).toContain("历史问题1") // full history sent
    // Failure semantics: started was announced, completed never is — clients
    // clear the compacting state from the run's own lifecycle events instead.
    const types = received(socket).map((e) => e.type)
    expect(types).toContain("compaction.started")
    expect(types).not.toContain("compaction.completed")
  })

  it("below threshold with existing state: no new calls, no compaction events, note still injected", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(recordRequests(scriptClient([textTurn("主回复")]), reqs))
    const session = env.sessions.create("未触发")
    const seeded = seedHistory(env.sessions, session.id, 2)
    env.sessions.updateMeta(session.id, {
      compaction: { segments: [{ upto: seeded[1]!.id, summary: "段摘要A" }], top: "总摘要A", upto: seeded[1]!.id },
    })
    const socket = new FakeSocket()
    env.bus.subscribe(session.id, socket)
    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    expect(reqs.length).toBe(1) // the main conversation only
    const types = received(socket).map((e) => e.type)
    expect(types).not.toContain("compaction.started")
    expect(types).not.toContain("compaction.completed")
    const msgs = env.sessions.readMessages(session.id)
    const user = msgs.find((m) => m.role === "user" && m.blocks.some((b) => b.type === "text" && b.text === "新问题"))!
    const note = user.blocks.find((b) => b.type === "note" && b.kind === "compact")
    expect((note as { text?: string }).text).toContain("总摘要A")
    // carried-over note (no new compaction): meta still present, same segment count
    expect(note).toMatchObject({ compact: { segments: 1, kept: 2 } })
  })

  it("compactSession refuses while a run is active or queued", async () => {
    // a never-ending llm keeps the run hanging: the session counts as busy
    const { env, manager } = makeEnv(hangingClient())
    const session = env.sessions.create("忙会话")
    const p = manager.enqueue(session.id, { userText: "长任务", trigger: "user" })
    await expect(manager.compactSession(session.id)).rejects.toThrow("会话正在运行")
    expect(manager.cancel(session.id)).toBe(true)
    await p
    // the gate lifts once the run settled: nothing to compact → the
    // nothing-to-do message, not a busy error
    await expect(manager.compactSession(session.id)).resolves.toEqual({ message: "无可压缩内容" })
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
      scriptClient([textTurn("段摘要A"), textTurn("总摘要A"), textTurn("主回复")]),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("审计")
    const seeded = seedHistory(env.sessions, session.id, 2)
    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    const records = env.sessions.readCompactions(session.id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      // first compaction (no prior state) → the span starts at session start
      trigger: "auto", from: null, upto: seeded[1]!.id,
      messages: 2, segmentSummary: "段摘要A", top: "总摘要A",
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
      failFirstClient("摘要挂了", textTurn("主回复")),
      (c) => { c.sessions.contextTokens = 10 },
    )
    const session = env.sessions.create("失败审计")
    seedHistory(env.sessions, session.id, 2)
    await manager.enqueue(session.id, { userText: "新问题", trigger: "user" })
    expect(env.sessions.readCompactions(session.id)).toEqual([])
  })
})

// --- auto memory extraction -------------------------------------------------

/** Poll an (async) condition until true or timeout (extraction is fire-and-forget). */
async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error("timed out waiting for condition")
}

describe("RunManager auto memory extraction", () => {
  const enableAutoExtract = (c: KclawConfig) => {
    c.memory.autoExtract = true
  }

  it("auto-extracts durable facts after a successful run", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurn("好的"), textTurn('["用户住在上海"]')]), reqs),
      enableAutoExtract,
    )
    const session = env.sessions.create("提取会话")

    const outcome = await manager.enqueue(session.id, { userText: "我搬到上海了", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")

    await waitUntil(async () => (await env.memory.search("上海", 5)).length > 0)
    const hits = await env.memory.search("上海", 5)
    expect(hits.map((n) => n.source)).toEqual(["auto"])
    expect(hits[0]!.text).toBe("用户住在上海")

    // the extraction request: no tools, spec-pinned system prompt, conversation rendering
    expect(reqs.length).toBe(2)
    const extractReq = reqs[1]!
    expect(extractReq.tools).toEqual([])
    expect(extractReq.model).toBe("mock-model")
    expect(extractReq.system).toBe(
      "从对话中提取值得长期记住的用户个人事实（居住地、偏好、约定、背景等）。只输出 JSON 字符串数组，无值得记的内容输出 []。",
    )
    expect(JSON.stringify(extractReq.messages)).toContain("我搬到上海了")
  })

  it("uses memory.extractModel when set", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurn("好的"), textTurn("[]")]), reqs),
      (c) => {
        c.memory.autoExtract = true
        c.memory.extractModel = "extractor-model"
      },
    )
    const session = env.sessions.create("提取模型会话")

    await manager.enqueue(session.id, { userText: "随便聊聊", trigger: "user" })
    await waitUntil(() => reqs.length >= 2)
    expect(reqs[1]!.model).toBe("extractor-model")
  })

  it("no extraction when autoExtract is off", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(scriptClient([textTurn("好的")]), reqs),
      (c) => {
        c.memory.autoExtract = false
      },
    )
    const session = env.sessions.create("关闭提取会话")

    const outcome = await manager.enqueue(session.id, { userText: "我住上海", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")
    await new Promise((r) => setTimeout(r, 50))
    expect(reqs.length).toBe(1) // main conversation only, no extraction call
    expect(await env.memory.search("上海", 5)).toEqual([])
  })

  it("a failing extraction never affects the run outcome", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { env, manager } = makeEnv(
        scriptClient([textTurn("好的"), textTurn("不是JSON")]),
        enableAutoExtract,
      )
      const session = env.sessions.create("坏响应会话")

      const outcome = await manager.enqueue(session.id, { userText: "我住上海", trigger: "user" })
      expect(outcome.stopReason).toBe("end_turn")

      await waitUntil(() => errorSpy.mock.calls.length > 0)
      await new Promise((r) => setTimeout(r, 20))
      expect(await env.memory.search("上海", 5)).toEqual([])
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("non-end_turn runs skip extraction", async () => {
    const reqs: LlmRequest[] = []
    const { env, manager } = makeEnv(
      recordRequests(hangingClient(), reqs),
      enableAutoExtract,
    )
    const session = env.sessions.create("中止会话")

    const p = manager.enqueue(session.id, { userText: "慢点", trigger: "user" })
    await new Promise((r) => setTimeout(r, 10)) // let the hanging llm call start
    expect(manager.cancel(session.id)).toBe(true)
    const outcome = await p
    expect(outcome.stopReason).toBe("aborted")

    await new Promise((r) => setTimeout(r, 50))
    expect(reqs.length).toBe(1) // the aborted main call only — no extraction
    expect(await env.memory.search("上海", 5)).toEqual([])
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

describe("RunManager readonly mode", () => {
  it("denies write-class tool calls with a readonly note when the session is readonly", async () => {
    const { env, manager } = makeEnv(scriptClient([
      [
        { type: "tool_call_started", index: 0, callId: "c1", name: "fs_write" },
        { type: "tool_call_delta", index: 0, delta: "{}" },
        { type: "message_done", stopReason: "tool_use" as const, usage: { inputTokens: 10, outputTokens: 1 } },
      ],
      [textTurn("完成")],
    ]))
    const session = env.sessions.create("ro-session")
    env.sessions.updateMeta(session.id, { readonly: true })
    const outcome = await manager.enqueue(session.id, { userText: "写个文件", trigger: "user" })
    expect(outcome.stopReason).toBe("end_turn")
    // The denied tool call produced a note instead of running.
    const messages = env.sessions.readMessages(session.id)
    const toolNote = messages.some((m) =>
      m.blocks.some((b) => b.type === "note" && "kind" in b && (b as { kind?: string }).kind === "denied"),
    )
    expect(toolNote).toBe(true)
  })
})
