/**
 * Goal loop assembly tests (issue #47): launchDaemon with a real RunManager
 * and goal host, driven end-to-end over REST. The injected llmFactory is
 * request-aware — judge calls carry `temperature: 0` and an empty tool list,
 * run calls don't — so one client serves both roles from separate scripts.
 *
 * Scenarios: judge says met in round 1; not_met then met (two rounds);
 * perpetual not_met with progress → the 10-round consecutive cap stops the
 * loop as paused(round-limit).
 */
import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, resolvePaths } from "@kclaw/core"
import type { KclawConfig, LlmClient, LlmRequest, LlmStreamEvent } from "@kclaw/core"
import { launchDaemon } from "../src/daemon.js"
import type { Daemon } from "../src/daemon.js"

const homes: string[] = []
const daemons: Daemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined)
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** Request-aware scripted client: run vs judge roles split by request shape. */
function goalAwareLlm(opts: { runText: string; judgeVerdicts: string[] }): {
  client: LlmClient
  runRequests: LlmRequest[]
  judgeRequests: LlmRequest[]
} {
  const runRequests: LlmRequest[] = []
  const judgeRequests: LlmRequest[] = []
  let judgeIndex = 0
  const events = (text: string): LlmStreamEvent[] => [
    { type: "text_delta", delta: text },
    { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 10 } },
  ]
  return {
    runRequests,
    judgeRequests,
    client: {
      async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
        const isJudge = req.temperature === 0 && req.tools.length === 0
        if (isJudge) {
          judgeRequests.push(req)
          const script = opts.judgeVerdicts
          yield* events(script[Math.min(judgeIndex++, script.length - 1)]!)
        } else {
          runRequests.push(req)
          yield* events(opts.runText)
        }
      },
    },
  }
}

/** Defaults plus a mock provider entry; background LLM consumers disabled. */
function makeConfig(home: string): KclawConfig {
  const config = loadConfig(resolvePaths(home))
  config.workspace = mkdtempSync(join(tmpdir(), "kclaw-goal-ws-"))
  homes.push(config.workspace)
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  // Memory extraction and skill evolution would consume the scripted client
  // outside the loop's control; both are off so every LLM call is attributable.
  config.memory.write.immediate = false
  config.memory.write.manual = false
  config.memory.consolidate = false
  config.skills.evolution.enabled = false
  return config
}

interface GoalApiView {
  goal: {
    goal: { state: string; stoppedReason?: string; totalRounds: number; tokensUsed: number }
    derived: { totalRounds: number }
  } | null
}

async function api(daemon: Daemon, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) }
}

/** Poll GET /sessions/:id/goal until the loop leaves `active`, bounded. */
async function waitForStop(daemon: Daemon, sessionId: string, timeoutMs = 30_000): Promise<GoalApiView["goal"]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { json } = await api(daemon, "GET", `/sessions/${sessionId}/goal`)
    const view = (json as GoalApiView).goal
    if (view !== null && view.goal.state !== "active") return view
    if (Date.now() > deadline) throw new Error(`goal loop still active after ${timeoutMs}ms: ${JSON.stringify(view)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function launchGoalDaemon(config: KclawConfig, home: string, llm: LlmClient): Promise<Daemon> {
  const daemon = await launchDaemon({ home, config, llmFactory: () => llm })
  daemons.push(daemon)
  return daemon
}

/** Set a goal on a fresh session; returns the session id. */
async function armGoal(daemon: Daemon, text: string): Promise<string> {
  const created = await api(daemon, "POST", "/sessions", {})
  expect(created.status).toBe(201)
  const sessionId = created.json.id as string
  const set = await api(daemon, "POST", `/sessions/${sessionId}/goal`, { text })
  expect(set.status).toBe(200)
  return sessionId
}

describe("goal loop assembly (launchDaemon, REST-driven)", () => {
  it("judge says met in round 1 → state complete, one goal.checked event", async () => {
    const home = mkdtempSync(join(tmpdir(), "kclaw-goal-home-"))
    homes.push(home)
    const llm = goalAwareLlm({
      runText: "所有改动已完成",
      judgeVerdicts: ['{"verdict":"met","reason":"目标已达成","progress":"完成"}'],
    })
    const daemon = await launchGoalDaemon(makeConfig(home), home, llm.client)
    const sessionId = await armGoal(daemon, "把测试改到全过")

    const view = await waitForStop(daemon, sessionId)
    expect(view?.goal.state).toBe("complete")
    expect(view?.goal.stoppedReason).toBe("met")
    expect(view?.goal.totalRounds).toBe(1)

    // The judge really ran with the pinned sampling and no tools, once.
    expect(llm.judgeRequests.length).toBe(1)
    expect(llm.judgeRequests[0]!.temperature).toBe(0)
    expect(llm.judgeRequests[0]!.tools).toEqual([])
    expect(llm.runRequests.length).toBe(1)

    // The audit trail: goal.set + run events + exactly one goal.checked.
    const lines = readFileSync(join(home, "sessions", sessionId, "events.jsonl"), "utf8").trim().split("\n")
    const types = lines.map((line) => (JSON.parse(line) as { type: string }).type)
    expect(types.filter((t) => t === "goal.set").length).toBeGreaterThanOrEqual(1)
    expect(types.filter((t) => t === "goal.checked").length).toBe(1)
    expect(types[types.length - 1]).toBe("goal.set") // the complete-state snapshot
  }, 60_000)

  it("not_met then met → two rounds, complete", async () => {
    const home = mkdtempSync(join(tmpdir(), "kclaw-goal-home-"))
    homes.push(home)
    const llm = goalAwareLlm({
      runText: "本轮推进了一部分",
      judgeVerdicts: [
        '{"verdict":"not_met","reason":"还差收尾","progress":"完成了主体实现"}',
        '{"verdict":"met","reason":"目标已达成","progress":"完成"}',
      ],
    })
    const daemon = await launchGoalDaemon(makeConfig(home), home, llm.client)
    const sessionId = await armGoal(daemon, "把测试改到全过")

    const view = await waitForStop(daemon, sessionId)
    expect(view?.goal.state).toBe("complete")
    expect(view?.goal.stoppedReason).toBe("met")
    expect(view?.goal.totalRounds).toBe(2)
    expect(llm.judgeRequests.length).toBe(2)
    expect(llm.runRequests.length).toBe(2)
  }, 60_000)

  it("perpetual not_met with progress → the 10-round consecutive cap stops as paused(round-limit)", async () => {
    const home = mkdtempSync(join(tmpdir(), "kclaw-goal-home-"))
    homes.push(home)
    const llm = goalAwareLlm({
      runText: "继续推进",
      judgeVerdicts: ['{"verdict":"not_met","reason":"还没完成","progress":"推进中"}'],
    })
    const daemon = await launchGoalDaemon(makeConfig(home), home, llm.client)
    const sessionId = await armGoal(daemon, "把测试改到全过")

    const view = await waitForStop(daemon, sessionId)
    expect(view?.goal.state).toBe("paused")
    expect(view?.goal.stoppedReason).toBe("round-limit")
    expect(view?.goal.totalRounds).toBe(10)
    expect(llm.judgeRequests.length).toBe(10)
    expect(llm.runRequests.length).toBe(10)

    // One goal.checked per round, all persisted for the audit page.
    const lines = readFileSync(join(home, "sessions", sessionId, "events.jsonl"), "utf8").trim().split("\n")
    const checked = lines
      .map((line) => JSON.parse(line) as { type: string })
      .filter((e) => e.type === "goal.checked")
    expect(checked.length).toBe(10)
  }, 60_000)
})
