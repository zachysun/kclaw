/**
 * Scheduler tick tests: startSchedulerTick turning due Job rows
 * of a REAL JobScheduler (temp SQLite) into runs of a REAL RunManager under a
 * mock LlmClient, with job.* frames observed on a fake socket CONNECTED to
 * the bus (job events carry no sessionId → broadcast, not subscribe).
 *
 * Covers: the happy fire (session/note/markRun/events/no re-run), the
 * claim-then-execute semantics (claimDue advances nextRunAt the moment a
 * tick takes the job — no double-fire on overlapping ticks), in-flight
 * re-entry protection while a run is still executing, pruning a job's
 * session history after each fire, the error path
 * (llm throws → stopReason "error" → job.failed + lastStatus "error"),
 * disabled jobs never firing, and stop() idempotence + interval shutdown.
 */
import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  JobScheduler,
  MemoryStore,
  SessionStore,
  loadConfig,
  resolvePaths,
} from "@kclaw/core"
import type {
  AgentEvent,
  Job,
  KclawConfig,
  LlmClient,
  LlmStreamEvent,
} from "@kclaw/core"
import { EventBus } from "../src/bus.js"
import { RunManager } from "../src/run.js"
import { startSchedulerTick } from "../src/scheduler-tick.js"

// --- fixtures ---------------------------------------------------------------

/** Temp dirs to sweep in afterEach. */
const dirs: string[] = []
/** Tickers to stop in afterEach (tests also stop some themselves). */
const tickers: { stop(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(tickers.splice(0).map((t) => t.stop()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Minimal in-memory stand-in for a connected socket (job.* = broadcast). */
class FakeSocket {
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
}

function received(socket: FakeSocket): AgentEvent[] {
  return socket.sent.map((s) => JSON.parse(s) as AgentEvent)
}

async function waitForEvent(socket: FakeSocket, type: AgentEvent["type"], timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (received(socket).some((e) => e.type === type)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for event ${type}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** JobScheduler that counts claimDue() calls — the only way to see a tick happen. */
class CountingScheduler extends JobScheduler {
  claimCalls = 0
  override claimDue(now: Date): Job[] {
    this.claimCalls += 1
    return super.claimDue(now)
  }
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

function failingClient(): LlmClient {
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      throw new Error("provider exploded")
    },
  }
}

interface TickEnv {
  scheduler: CountingScheduler
  sessions: SessionStore
  bus: EventBus
  manager: RunManager
  socket: FakeSocket
}

/** Real stores + scheduler + RunManager under fresh temp dirs; connected socket on the bus. */
function makeEnv(llm: LlmClient): TickEnv {
  const home = mkdtempSync(join(tmpdir(), "kclaw-tick-home-"))
  const workspace = mkdtempSync(join(tmpdir(), "kclaw-tick-ws-"))
  dirs.push(home, workspace)

  const paths = resolvePaths(home)
  const config = loadConfig(paths)
  config.workspace = workspace
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }

  const sessions = new SessionStore(paths.sessionsDir)
  const memory = new MemoryStore({ notesDir: paths.memoryNotesDir, indexDb: paths.memoryIndexDb })
  const bus = new EventBus()
  const manager = new RunManager({
    config, paths, sessions, memory, bus, llm, workspace,
  })
  const scheduler = new CountingScheduler(join(home, "jobs.db"))
  const socket = new FakeSocket()
  bus.connect(socket) // connected (not subscribed): receives sessionId-less job.* events
  return { scheduler, sessions, bus, manager, socket }
}

/** Back-date a job's nextRunAt by a minute so the next tick finds it due. */
function backdate(scheduler: JobScheduler, id: string): void {
  scheduler.update(id, { nextRunAt: new Date(Date.now() - 60_000).toISOString() })
}

function startTick(env: TickEnv, intervalMs: number, purgeTtlMs?: number): { stop(): Promise<void> } {
  const tick = startSchedulerTick({
    scheduler: env.scheduler,
    run: env.manager,
    bus: env.bus,
    sessions: env.sessions,
    intervalMs,
    purgeTtlMs,
  })
  tickers.push(tick)
  return tick
}

// --- tests ------------------------------------------------------------------

describe("startSchedulerTick", () => {
  it("fires a due job end to end: session, job note, markRun ok, no re-run", async () => {
    const env = makeEnv(scriptClient([textTurn("早报好了")]))
    const job = env.scheduler.create({ name: "早报", cron: "* * * * *", prompt: "给我今日早报" })
    backdate(env.scheduler, job.id)

    startTick(env, 25)

    await waitForEvent(env.socket, "job.completed")

    // job.started (broadcast: no sessionId) preceded the run
    const started = received(env.socket).find((e) => e.type === "job.started")
    expect(started).toBeDefined()
    expect(started!.sessionId).toBeUndefined()
    expect(started!.payload).toEqual({ jobId: job.id })

    // session created with title=job.name and jobId recorded
    const [session] = env.sessions.list()
    expect(session.title).toBe("早报")
    expect(session.jobId).toBe(job.id)

    // first user message: prompt text + kind:"job" note naming the job
    const [user] = env.sessions.readMessages(session.id)
    expect(user!.blocks).toEqual([
      { id: expect.any(String), type: "text", text: "给我今日早报" },
      {
        id: expect.any(String), type: "note", kind: "job",
        text: "本会话由定时任务「早报」触发",
      },
    ])

    // job.completed summarizes the run's stopReason
    const completed = received(env.socket).find((e) => e.type === "job.completed")
    expect(completed!.payload).toEqual({ jobId: job.id, summary: "end_turn" })

    // markRun recorded the ok outcome
    const after = env.scheduler.get(job.id)
    expect(after!.lastStatus).toBe("ok")
    expect(after!.lastError).toBeUndefined()
    expect(after!.lastRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // in-flight cleared + nextRunAt advanced: later ticks must not re-run
    await sleep(100)
    expect(received(env.socket).filter((e) => e.type === "job.started")).toHaveLength(1)
    expect(env.sessions.list()).toHaveLength(1)
  })

  it("fires due jobs through claimDue (no double-fire on overlapping ticks)", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        await gate // the run hangs until released: the fire never settles
        yield { type: "text_delta", delta: "好" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const env = makeEnv(llm)
    const job = env.scheduler.create({ name: "认领", cron: "* * * * *", prompt: "跑" })
    const backdated = new Date(Date.now() - 60_000).toISOString()
    env.scheduler.update(job.id, { nextRunAt: backdated })

    startTick(env, 20)
    await waitForEvent(env.socket, "job.started")

    // claim-then-execute: claiming advanced nextRunAt while the run is still
    // hanging, so a later tick cannot claim (let alone fire) the job again
    expect(Date.parse(env.scheduler.get(job.id)!.nextRunAt)).toBeGreaterThan(Date.parse(backdated))

    await sleep(120) // several ticks pass while the fire is unsettled
    expect(received(env.socket).filter((e) => e.type === "job.started")).toHaveLength(1)
    expect(env.sessions.list()).toHaveLength(1)

    release()
    await waitForEvent(env.socket, "job.completed")
    expect(received(env.socket).filter((e) => e.type === "job.started")).toHaveLength(1)
  })

  it("prunes a job's old sessions down to JOB_SESSION_KEEP after firing", async () => {
    const env = makeEnv(scriptClient([textTurn("好")]))
    const job = env.scheduler.create({ name: "清理", cron: "* * * * *", prompt: "跑" })
    // 22 historical sessions of the same job; the fire adds a 23rd
    const oldIds = new Set<string>()
    for (let i = 0; i < 22; i++) {
      oldIds.add(env.sessions.create(`第${i}次`, job.id).id)
    }
    backdate(env.scheduler, job.id)

    startTick(env, 25)
    await waitForEvent(env.socket, "job.completed")

    // the fresh fire + the newest 19 old sessions survive (20 total)
    const kept = env.sessions.list().filter((m) => m.jobId === job.id)
    expect(kept).toHaveLength(20)
    // the oldest 3 land in the recycle bin (soft-deleted, purgeable later)
    const deleted = env.sessions.list({ deleted: true })
    expect(deleted).toHaveLength(3)
    for (const m of deleted) expect(oldIds.has(m.id)).toBe(true)
  })

  it("skips a job that is still running when the next tick fires", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        await gate // the run hangs until released; markRun has not happened
        yield { type: "text_delta", delta: "好" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const env = makeEnv(llm)
    const job = env.scheduler.create({ name: "慢任务", cron: "* * * * *", prompt: "慢慢来" })
    backdate(env.scheduler, job.id)

    startTick(env, 20)
    await waitForEvent(env.socket, "job.started")

    // ~6 ticks pass while the run is in flight and the row is still due
    await sleep(120)
    expect(received(env.socket).filter((e) => e.type === "job.started")).toHaveLength(1)
    expect(env.sessions.list()).toHaveLength(1)

    release()
    await waitForEvent(env.socket, "job.completed")
    expect(env.scheduler.get(job.id)!.lastStatus).toBe("ok")
  })

  it("emits job.failed and records lastStatus error when the run fails", async () => {
    const env = makeEnv(failingClient())
    const job = env.scheduler.create({ name: "坏任务", cron: "* * * * *", prompt: "必定失败" })
    backdate(env.scheduler, job.id)

    startTick(env, 25)

    await waitForEvent(env.socket, "job.failed")

    const failed = received(env.socket).find((e) => e.type === "job.failed")
    expect(failed!.payload).toEqual({
      jobId: job.id,
      error: { code: "job_failed", message: expect.any(String) },
    })

    const after = env.scheduler.get(job.id)
    expect(after!.lastStatus).toBe("error")
    expect(after!.lastError).toBeTruthy()

    // the run did start: session and user message exist
    const [session] = env.sessions.list()
    expect(session.jobId).toBe(job.id)
    expect(env.sessions.readMessages(session.id).map((m) => m.role)).toContain("user")
  })

  it("never fires a disabled job", async () => {
    const env = makeEnv(scriptClient([textTurn("不该出现")]))
    const job = env.scheduler.create({ name: "停用", cron: "* * * * *", prompt: "不该跑" })
    env.scheduler.update(job.id, {
      enabled: false,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    })

    startTick(env, 20)
    await sleep(100)

    expect(received(env.socket)).toEqual([])
    expect(env.sessions.list()).toEqual([])
    expect(env.scheduler.get(job.id)!.lastStatus).toBeUndefined()
  })

  it("a socket whose send throws neither fails the job nor starves other subscribers", async () => {
    const env = makeEnv(scriptClient([textTurn("好")]))
    const job = env.scheduler.create({ name: "抗炸", cron: "* * * * *", prompt: "跑" })
    backdate(env.scheduler, job.id)

    // connected BEFORE the healthy socket: every job.* broadcast reaches it
    // first, and each send throws synchronously
    const broken = { send(): void { throw new Error("send boom") } }
    env.bus.connect(broken)

    startTick(env, 25)

    // the healthy socket still saw the full job lifecycle …
    await waitForEvent(env.socket, "job.completed")
    expect(received(env.socket).some((e) => e.type === "job.started")).toBe(true)
    // … and the job was recorded ok, not marked failed by the broken socket
    expect(env.scheduler.get(job.id)!.lastStatus).toBe("ok")
    expect(received(env.socket).some((e) => e.type === "job.failed")).toBe(false)
  })

  it("purges soft-deleted sessions past retention each tick", async () => {
    const env = makeEnv(scriptClient([textTurn("好")]))
    const old = env.sessions.create("旧会话")
    const fresh = env.sessions.create("新会话")
    env.sessions.delete(old.id)
    env.sessions.delete(fresh.id)
    // 把 old 的 deletedAt 改到 61 秒前，超过 1 分钟的 ttl；fresh 保持刚删除
    env.sessions.updateMeta(old.id, { deletedAt: new Date(Date.now() - 61_000).toISOString() })

    startTick(env, 25, 60_000) // purgeTtlMs = 1 minute

    // 无 due job 也会在首次 tick 执行清理，轮询等待 old 被永久删除
    const deadline = Date.now() + 2000
    while (env.sessions.meta(old.id) !== undefined) {
      if (Date.now() > deadline) throw new Error("expired session was not purged")
      await sleep(5)
    }
    expect(env.sessions.meta(fresh.id)).toBeDefined() // 未过期保留
  })

  it("stop() is idempotent and the interval stops firing", async () => {
    const env = makeEnv(scriptClient([textTurn("好")]))
    const job = env.scheduler.create({ name: "一次性", cron: "* * * * *", prompt: "跑一次" })
    backdate(env.scheduler, job.id)

    const tick = startTick(env, 30)
    await waitForEvent(env.socket, "job.completed")
    await sleep(80) // several interval ticks fire while idle (no re-run)
    expect(env.scheduler.claimCalls).toBeGreaterThanOrEqual(3)
    expect(received(env.socket).filter((e) => e.type === "job.started")).toHaveLength(1)

    await tick.stop()
    await tick.stop() // idempotent

    // make the job due again AFTER stop: nothing may fire anymore
    const claimCalls = env.scheduler.claimCalls
    const frames = received(env.socket).length
    backdate(env.scheduler, job.id)
    await sleep(120) // > 2 intervals
    expect(env.scheduler.claimCalls).toBe(claimCalls)
    expect(received(env.socket)).toHaveLength(frames)
  })
})
