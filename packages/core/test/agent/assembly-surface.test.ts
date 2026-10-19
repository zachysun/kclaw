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

describe("executeRun deps → surface forwarding (tiered disclosure)", () => {
  it("a user run's ACTIVE set carries the full tier + tool_search; directory/deferred tiers ride the pool", async () => {
    const captured: LlmRequest[] = []
    const engine = makeEngine(captured)
    await runOnce(engine, "user")
    expect(captured.length).toBeGreaterThan(0)
    const names = captured[0]!.tools!.map((t) => t.name)
    // full tier: core loop tools, complete schemas in the request
    for (const n of ["bash", "fs_read", "fs_edit", "grep", "glob", "todo_list_write", "todo_list_read", "skill_read", "skill_list"]) {
      expect(names).toContain(n)
    }
    // tool_search itself (full) — the pool is non-empty in a daemon-shaped engine
    expect(names).toContain("tool_search")
    // directory tier: NOT in the request; the model sees them via the system
    // prompt's tool directory (assert the directory section landed in base)
    expect(names).not.toContain("process_list")
    expect(names).not.toContain("cron_create")
    expect(names).not.toContain("cron_list")
    expect(names).not.toContain("subagent_run")
    expect(names).not.toContain("create_goal")
    const system = captured[0]!.system as string
    expect(system).toContain("工具目录")
    expect(system).toContain("process_list")
    expect(system).toContain("cron_create")
    expect(system).toContain("create_goal")
    // this engine wires no team host, so the deferred tier is empty here —
    // its NAME-ONLY line is covered by the registry exposure tests; what
    // this seam pins is that a listed tool always carries its description
    // format and the deferred line never appears without deferred tools.
    expect(system).not.toContain("低频工具（只列名字")
  })

  it("a cron-fired run loses the cron WRITE tools everywhere (anti-recursion survives tiering)", async () => {
    const captured: LlmRequest[] = []
    const engine = makeEngine(captured)
    await runOnce(engine, "cron")
    const names = captured[0]!.tools!.map((t) => t.name)
    const system = captured[0]!.system as string
    // cron_list is directory tier → pool, and must SURVIVE there
    expect(names).not.toContain("cron_list")
    // the narrowing runs before tiering: the write trio is gone from the pool
    // (and thus unsearchable) on a cron-fired run
    const cronInSystem = system.includes("cron_create")
    expect(cronInSystem).toBe(false)
  })
})
