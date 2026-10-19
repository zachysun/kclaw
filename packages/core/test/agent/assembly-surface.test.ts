import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeRun } from "../../src/agent/run-assembly.js"
import type { RunEngine } from "../../src/agent/run-assembly.js"
import { resolvePaths } from "../../src/storage/paths.js"
import { loadConfig } from "../../src/storage/config.js"
import { SessionStore } from "../../src/session/store.js"
import { MemorySystem } from "../../src/memory/system.js"
import { EventBus } from "../../src/bus.js"
import { ConfirmationBroker } from "../../src/permissions/broker.js"
import { Compactor } from "../../src/session/compactor.js"
import { ProcessRegistry } from "../../src/process/registry.js"
import { CronScheduler } from "../../src/cron/scheduler.js"
import type { LlmClient, LlmRequest, LlmStreamEvent } from "../../src/provider/types.js"

/**
 * Assembly-level wiring regression: the factory tests assert what
 * createBuiltinTools exposes for given options, but the daemon's real path
 * is executeRun → deps → createBuiltinTools. A deps field that stops being
 * forwarded (the batch-3 processes gap, caught post-hoc) is invisible to
 * factory tests — these tests pin the forwarding at the seam where it broke.
 */

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kclaw-asm-surface-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function makeEngine(captured: LlmRequest[]): RunEngine {
  const paths = resolvePaths(home)
  const config = loadConfig(paths)
  const sessions = new SessionStore(paths.sessionsDir)
  const bus = new EventBus()
  const memory = new MemorySystem({
    memoryDir: paths.memoryDir,
    sessions,
    config,
    resolveLlm: () => ({ llm: capturingClient(captured), model: "test-model" }),
  })
  const llm: LlmClient = {
    async *stream(req): AsyncIterable<LlmStreamEvent> {
      captured.push(req)
      yield { type: "text_delta", delta: "done" }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
  return {
    deps: {
      config,
      paths,
      sessions,
      memory,
      bus,
      llm,
      model: "test-model",
      workspace: home,
      broker: new ConfirmationBroker(),
      processes: new ProcessRegistry(),
      cronScheduler: new CronScheduler(join(home, "cron.db")),
      goalHost: {
        set: () => { throw new Error("not used in this test") },
        pause: () => { throw new Error("not used in this test") },
        resume: () => { throw new Error("not used in this test") },
        userStop: () => { throw new Error("not used in this test") },
        view: () => undefined,
        requestCheck: () => false,
      },
    },
    compactor: new Compactor({ sessions, emit: (e) => bus.emit(e) }),
  }
}

function capturingClient(captured: LlmRequest[]): LlmClient {
  return {
    async *stream(req): AsyncIterable<LlmStreamEvent> {
      captured.push(req)
      yield { type: "text_delta", delta: "done" }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
}

const runOnce = async (engine: RunEngine, trigger: "user" | "cron") => {
  const sessionId = engine.deps.sessions.create("surface").id
  return executeRun(engine, {
    sessionId,
    input: { userText: "hi", trigger },
    controller: new AbortController(),
    drainSteer: () => [],
  })
}

describe("executeRun deps → surface forwarding", () => {
  it("a user run carries the process trio and all four cron tools", async () => {
    const captured: LlmRequest[] = []
    const engine = makeEngine(captured)
    await runOnce(engine, "user")
    expect(captured.length).toBeGreaterThan(0)
    const names = captured[0]!.tools!.map((t) => t.name)
    expect(names).toContain("bash")
    expect(names).toContain("process_list")
    expect(names).toContain("process_output")
    expect(names).toContain("process_kill")
    expect(names).toContain("cron_create")
    expect(names).toContain("cron_list")
    expect(names).toContain("cron_update")
    expect(names).toContain("cron_delete")
    expect(names).toContain("todo_write")
    expect(names).toContain("todo_read")
    expect(names).toContain("create_goal")
    expect(names).toContain("get_goal")
    expect(names).toContain("update_goal")
  })

  it("a cron-fired run keeps cron_list but loses the write trio (anti-recursion)", async () => {
    const captured: LlmRequest[] = []
    const engine = makeEngine(captured)
    await runOnce(engine, "cron")
    const names = captured[0]!.tools!.map((t) => t.name)
    expect(names).toContain("cron_list")
    expect(names).not.toContain("cron_create")
    expect(names).not.toContain("cron_update")
    expect(names).not.toContain("cron_delete")
    // the process trio is unaffected by the cron trigger
    expect(names).toContain("process_list")
  })
})
