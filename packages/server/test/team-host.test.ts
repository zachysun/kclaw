/**
 * Team host integration tests: the REAL RunManager + real team facade over a
 * real workspace — mock LLM only. Pinned semantics:
 * - create_team materializes the directory and audited events land on the
 *   lead's stream; a second create_team for the same session is rejected.
 * - spawn_teammate provisions a persistent child session, delivers the
 *   initial task through the mailbox (delivered, not pending) and the member
 *   run executes on its own session.
 * - a user message aimed at a member lands in the LEAD history (forwarding
   * marker) and reaches the member's run input.
 * - auto-dispatch: creating a ready task wakes an idle member, whose scripted
 *   model claims it with task_update (attempt minted by the store's CAS).
 * - the panel route serves the whole team view; non-team sessions 404.
 * - delete cascade: cancelMembersForLead stops a running member and the team
 *   directory is archived under `.agent-teams/archive/`.
 * - delivery is marked only on target-side land; a second send while the
 *   first input is still in flight never renders the same entry twice.
 * - crash recovery: an idle member holding an in_progress task gets one
 *   resume nudge per situation (no wake loop).
 */
import { describe, it, expect, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import WebSocket from "ws"
import {
  EventBus,
  SessionStore,
  loadConfig,
  resolvePaths,
  type KclawConfig,
  type KclawPaths,
  type LlmClient,
  type LlmStreamEvent,
  type MemorySystem,
} from "@kclaw/core"
import type { FastifyInstance } from "fastify"
import { RunManager } from "../src/run.js"
import { createApp } from "../src/app.js"
import { createTeamHost, type TeamHost } from "../src/team.js"

const TOKEN = "t1"
type Frame = Record<string, unknown>

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** End-turn stream with fixed text. */
function endTurn(text: string): LlmStreamEvent[] {
  return [
    { type: "text_delta", delta: text },
    { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

/** One tool_use round (safe tool, no confirmation expected). */
function toolTurn(callId: string, name: string, args: object): LlmStreamEvent[] {
  return [
    { type: "tool_call_started", index: 0, callId, name },
    { type: "tool_call_delta", index: 0, delta: JSON.stringify(args) },
    { type: "message_done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

/** LLM whose nth stream() plays the nth script (the last script repeats). */
function scriptedLlm(...turns: LlmStreamEvent[][]): LlmClient {
  let call = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      const turn = turns[Math.min(call, turns.length - 1)]!
      call++
      for (const event of turn) yield event
    },
  }
}

/** Poll until `cond` holds (runs settle asynchronously); cond may be async. */
async function until(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not reached in time")
    await sleep(20)
  }
}

const dirs: string[] = []
const apps: FastifyInstance[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function makeTeamEnv(llm: LlmClient, teamCfg?: KclawConfig["team"]): Promise<{
  paths: KclawPaths
  config: KclawConfig
  sessions: SessionStore
  host: TeamHost
  manager: RunManager
  app: FastifyInstance
  url: string
  workspace: string
}> {
  const home = mkdtempSync(join(tmpdir(), "kclaw-team-home-"))
  const workspace = mkdtempSync(join(tmpdir(), "kclaw-team-ws-"))
  dirs.push(home, workspace)
  const paths = resolvePaths(home)
  const config = loadConfig(paths)
  config.workspace = workspace
  if (teamCfg !== undefined) config.team = { ...config.team, ...teamCfg }
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  const sessions = new SessionStore(paths.sessionsDir)
  const bus = new EventBus()
  let managerRef: RunManager | undefined
  const host = createTeamHost({
    config,
    sessions,
    bus,
    getRun: () => {
      if (managerRef === undefined) throw new Error("run manager not ready")
      return managerRef
    },
  })
  const manager = new RunManager({ config, paths, sessions, memory: makeMemoryFake(), bus, llm, workspace, team: { facade: host.facade } })
  managerRef = manager
  const app = await createApp({ home, token: TOKEN, stores: { sessions, config, paths }, bus, run: manager, team: host })
  apps.push(app)
  await app.listen({ port: 0, host: "127.0.0.1" })
  const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`
  return { paths, config, sessions, host, manager, app, url, workspace }
}

function makeMemoryFake(): MemorySystem {
  return { searchEpisodes: async () => [], cognitionPrompt: () => "" } as unknown as MemorySystem
}

function teamDir(workspace: string): string {
  return join(workspace, ".agent-teams")
}

describe("team host", () => {
  it("create_team materializes the directory, audits on the lead stream and refuses a second team", async () => {
    const { sessions, host, workspace } = await makeTeamEnv(scriptedLlm(endTurn("ok")))
    const lead = sessions.create("组长", undefined, workspace)
    const created = await host.facade.createTeam(lead.id, "crew")
    expect(created.teamId).toBe(lead.id)
    const record = JSON.parse(readFileSync(join(teamDir(workspace), created.teamId, "team.json"), "utf8")) as Record<string, unknown>
    expect(record.leadSessionId).toBe(lead.id)
    expect(record.name).toBe("crew")
    expect(await host.facade.describeSession(lead.id)).toEqual({ role: "lead", teamId: created.teamId, sessionId: lead.id })
    expect(await host.facade.describeSession("ses_missing")).toBeNull()
    const events = sessions.readEvents(lead.id).filter((e) => e.type.startsWith("team."))
    expect(events.some((e) => e.type === "team.created")).toBe(true)
    await expect(host.facade.createTeam(lead.id)).rejects.toThrow(/already belongs to a team/)
  })

  it("spawn_teammate provisions a persistent child, delivers the initial task and runs it", async () => {
    const llm = scriptedLlm(endTurn("初始任务收到"))
    const { sessions, host, workspace } = await makeTeamEnv(llm)
    const lead = sessions.create("组长", undefined, workspace)
    const { teamId } = await host.facade.createTeam(lead.id)
    const spawned = await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "builder", task: "把首页按钮改蓝" })
    // Child session is a persistent child of the lead.
    const child = sessions.meta(spawned.sessionId)!
    expect(child.parentSessionId).toBe(lead.id)
    expect(child.title).toContain("builder")
    // Member list: active, with the model snapshot absent (default routing).
    const panel = await host.panel(lead.id)
    expect(panel?.members).toHaveLength(1)
    expect(panel?.members[0]).toMatchObject({ name: "builder", status: "active", sessionId: spawned.sessionId })
    // Initial task was delivered (nothing left pending) and the member ran.
    await until(() => sessions.readMessages(spawned.sessionId).length >= 2)
    const [userMsg, assistantMsg] = sessions.readMessages(spawned.sessionId)
    expect(userMsg?.blocks.some((b) => b.type === "text" && (b as { text: string }).text.includes("把首页按钮改蓝"))).toBe(true)
    expect(assistantMsg?.role).toBe("assistant")
    // Audit family on the lead stream.
    const types = sessions.readEvents(lead.id).map((e) => e.type)
    for (const t of ["team.member.provisioned", "team.member.settled", "team.message.queued", "team.message.delivered"]) {
      expect(types, t).toContain(t)
    }
  })

  it("a user message aimed at a member lands in the lead history and reaches the member's next run", async () => {
    const llm = scriptedLlm(endTurn("r1"), endTurn("r2"))
    const { sessions, host, workspace } = await makeTeamEnv(llm)
    const lead = sessions.create("组长", undefined, workspace)
    const { teamId } = await host.facade.createTeam(lead.id)
    const spawned = await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "builder", task: "t1" })
    await until(() => sessions.readMessages(spawned.sessionId).length >= 2)
    const before = sessions.readMessages(spawned.sessionId).length
    await host.deliverUserToMember(lead.id, "builder", "顺带把图标也换了")
    // The lead's history carries the forwarded message with a marker note.
    const leadLast = sessions.readMessages(lead.id).at(-1)!
    expect(leadLast.role).toBe("user")
    expect(leadLast.blocks.some((b) => b.type === "text" && (b as { text: string }).text.includes("顺带把图标也换了"))).toBe(true)
    expect(leadLast.blocks.some((b) => b.type === "note" && (b as { text: string }).text.includes("builder"))).toBe(true)
    await until(() => sessions.readMessages(spawned.sessionId).length >= before + 2)
    const second = sessions.readMessages(spawned.sessionId).slice(before)
    const text = second[0]?.blocks.find((b) => b.type === "text") as { text: string } | undefined
    expect(text?.text).toContain("顺带把图标也换了")
    // Unknown member is a loud error.
    await expect(host.deliverUserToMember(lead.id, "ghost", "x")).rejects.toThrow(/no active member/)
  })

  it("auto-dispatch wakes an idle member onto a ready task and the scripted model claims it via task_update", async () => {
    const llm = scriptedLlm(
      endTurn("初始任务收到"),
      toolTurn("call-1", "task_update", { id: 1, expected_revision: 1, status: "in_progress" }),
      endTurn("认领完成"),
    )
    const { sessions, host, workspace } = await makeTeamEnv(llm)
    const lead = sessions.create("组长", undefined, workspace)
    const { teamId } = await host.facade.createTeam(lead.id)
    const spawned = await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "builder", task: "t1" })
    await until(() => sessions.readMessages(spawned.sessionId).length >= 2)
    const task = await host.facade.taskCreate({ role: "lead", teamId, sessionId: lead.id }, { subject: "改配色" })
    expect(task.status).toBe("pending")
    // pumpIdle wakes the builder, whose model claims the task through the real
    // tool surface (identity probed by the run assembly).
    await until(() => {
      const snapshot = host.facade.taskList({ role: "lead", teamId, sessionId: lead.id })
      return snapshot.then((r) => r.tasks[0]?.status === "in_progress" && r.tasks[0]?.assignee === "builder")
    })
    const board = JSON.parse(readFileSync(join(teamDir(workspace), teamId, "task", "1.json"), "utf8")) as Record<string, unknown>
    expect(board.attempt).toBe(1)
    expect(typeof board.attemptId).toBe("string")
    // The dispatch text reached the member's run input.
    const userTexts = sessions.readMessages(spawned.sessionId).filter((m) => m.role === "user")
    expect(userTexts.some((m) => m.blocks.some((b) => b.type === "text" && (b as { text: string }).text.includes("任务派发")))).toBe(true)
  })

  it("the panel route serves the team view; a session without a team 404s", async () => {
    const { sessions, host, app, workspace } = await makeTeamEnv(scriptedLlm(endTurn("ok")))
    const lead = sessions.create("组长", undefined, workspace)
    const outsider = sessions.create("路人", undefined, workspace)
    const auth = { authorization: `Bearer ${TOKEN}` }
    expect((await app.inject({ method: "GET", url: `/sessions/${outsider.id}/team`, headers: auth })).statusCode).toBe(404)
    const { teamId } = await host.facade.createTeam(lead.id)
    await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "builder", task: "t" })
    await host.facade.taskCreate({ role: "lead", teamId, sessionId: lead.id }, { subject: "s1" })
    const res = await app.inject({ method: "GET", url: `/sessions/${lead.id}/team`, headers: auth })
    expect(res.statusCode).toBe(200)
    const panel = res.json() as { team: { teamId: string }; identity: string; members: unknown[]; tasks: unknown[] }
    expect(panel.team.teamId).toBe(teamId)
    expect(panel.identity).toBe("lead")
    expect(panel.members).toHaveLength(1)
    expect(panel.tasks).toHaveLength(1)
    // Directory stays out of the workspace's version control.
    const gitignore = readFileSync(join(workspace, ".gitignore"), "utf8")
    expect(gitignore).toContain(".agent-teams/")
  })

  it("the delete cascade cancels a running member (no parent-stop at runtime, only at deletion)", async () => {
    // A gated stream holds the member's first run open until released.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let gated = true
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        if (gated) {
          await gate
          gated = false
        }
        yield { type: "text_delta", delta: "done" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { sessions, host, workspace, manager } = await makeTeamEnv(llm)
    const lead = sessions.create("组长", undefined, workspace)
    const { teamId } = await host.facade.createTeam(lead.id)
    const spawned = await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "builder", task: "长任务" })
    await sleep(100) // let the member run reach the gated stream
    // No cascade at runtime: cancelling the LEAD leaves the member running.
    manager.cancel(lead.id)
    await sleep(50)
    expect(host.cancelMembersForLead("ses_none")).toBe(0)
    expect(host.cancelMembersForLead(lead.id)).toBe(1)
    // Release the gate so the aborted member run settles before teardown;
    // an aborted run leaves no assistant message, so there is nothing else
    // to wait for here — the assertions above are the contract.
    release()
    await sleep(300)
  })

  it("ws send_message with a target delivers through the mailbox", async () => {
    const llm = scriptedLlm(endTurn("r1"), endTurn("r2"))
    const { sessions, host, url, workspace } = await makeTeamEnv(llm)
    const lead = sessions.create("组长", undefined, workspace)
    const { teamId } = await host.facade.createTeam(lead.id)
    const spawned = await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "builder", task: "t1" })
    await until(() => sessions.readMessages(spawned.sessionId).length >= 2)
    const before = sessions.readMessages(spawned.sessionId).length
    // ?token= connects pre-authenticated (the auth frame gets no ack).
    const ws = new WebSocket(`${url}?token=${TOKEN}`)
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve)
      ws.on("error", reject)
    })
    const frames: Frame[] = []
    ws.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Frame))
    ws.send(JSON.stringify({ type: "send_message", sessionId: lead.id, target: "builder", text: "ws 直达组员" }))
    await until(() => frames.some((f) => f.type === "send_message_ack"))
    expect(frames.find((f) => f.type === "send_message_ack")?.queued).toBe(false)
    await until(() => sessions.readMessages(spawned.sessionId).length >= before + 2)
    // An unknown target answers an error frame and the connection stays open.
    ws.send(JSON.stringify({ type: "send_message", sessionId: lead.id, target: "ghost", text: "x" }))
    await until(() => frames.some((f) => f.type === "error"))
    ws.close()
  })

  it("team.maxActive caps concurrent member runs; deferred mail drains at idle edges", async () => {
    // A shared gated stream parks every member run until released, so the
    // concurrency count is directly observable.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        await gate
        yield { type: "text_delta", delta: "done" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { sessions, host, workspace } = await makeTeamEnv(llm, { maxActive: 1 })
    const lead = sessions.create("组长", undefined, workspace)
    const { teamId } = await host.facade.createTeam(lead.id)
    const first = await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "builder", task: "t1" })
    await sleep(100) // builder's run reaches the gated stream (plate full)
    const second = await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "welder", task: "t2" })
    await sleep(100)
    // The cap held: welder's initial mail stayed pending — no run, no messages.
    expect(sessions.readMessages(second.sessionId)).toHaveLength(0)
    const panel = await host.panel(lead.id)
    expect(panel?.members.find((m) => m.name === "builder")?.busy).toBe(true)
    expect(panel?.members.find((m) => m.name === "welder")?.busy).toBe(false)
    // Release: builder settles → his idle edge pumps welder's deferred mail out.
    release()
    await until(() => sessions.readMessages(second.sessionId).length >= 2)
    expect(sessions.readMessages(first.sessionId).length).toBeGreaterThanOrEqual(2)
    await sleep(200) // let trailing idle-edge pumps settle before teardown
  })

  it("deleting the lead archives the team directory under .agent-teams/archive/", async () => {
    const llm = scriptedLlm(endTurn("ok"))
    const { sessions, host, workspace, app } = await makeTeamEnv(llm)
    const lead = sessions.create("组长", undefined, workspace)
    const { teamId } = await host.facade.createTeam(lead.id)
    expect(existsSync(join(teamDir(workspace), teamId))).toBe(true)
    const res = await app.inject({ method: "DELETE", url: `/sessions/${lead.id}`, headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.statusCode).toBe(200)
    expect(existsSync(join(teamDir(workspace), teamId))).toBe(false)
    expect(existsSync(join(teamDir(workspace), "archive", teamId))).toBe(true)
    const record = JSON.parse(readFileSync(join(teamDir(workspace), "archive", teamId, "team.json"), "utf8")) as Record<string, unknown>
    expect(record.leadSessionId).toBe(lead.id)
  })

  it("a second send while the first input is in flight is rendered once, not twice", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        await gate
        yield { type: "text_delta", delta: "done" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const { sessions, host, workspace } = await makeTeamEnv(llm)
    const lead = sessions.create("组长", undefined, workspace)
    const { teamId } = await host.facade.createTeam(lead.id)
    const spawned = await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "builder", task: "AAA-marker" })
    await sleep(100) // builder's run is parked inside the gated stream
    await host.facade.sendMessage({ role: "lead", teamId, sessionId: lead.id }, { to: { kind: "member", name: "builder" }, text: "BBB-marker" })
    release()
    await until(() => {
      const runs = sessions.readMessages(spawned.sessionId).filter((m) => m.role === "user")
      return runs.some((m) => m.blocks.some((b) => b.type === "text" && b.text.includes("BBB-marker")))
    })
    await sleep(200) // trailing idle edges settle
    const userRuns = sessions.readMessages(spawned.sessionId).filter((m) => m.role === "user")
    const aaa = userRuns.filter((m) => m.blocks.some((b) => b.type === "text" && b.text.includes("AAA-marker")))
    const bbb = userRuns.filter((m) => m.blocks.some((b) => b.type === "text" && b.text.includes("BBB-marker")))
    expect(aaa).toHaveLength(1)
    expect(bbb).toHaveLength(1)
  })

  it("a fresh mainline session (no team yet) still carries the lead protocol — create_team stays reachable", async () => {
    const llm = scriptedLlm(endTurn("ok"))
    const { sessions, manager, workspace } = await makeTeamEnv(llm)
    const lead = sessions.create("新会话", undefined, workspace)
    manager.submit(lead.id, { userText: "你好", trigger: "user", disposition: "steer" })
    await until(() => sessions.readMessages(lead.id).length >= 2)
    const systemEvents = sessions.readEvents(lead.id).filter((e) => e.type === "system")
    expect(systemEvents.length).toBeGreaterThanOrEqual(1)
    const stable = (systemEvents[0] as { stable?: string }).stable ?? ""
    expect(stable).toContain("团队协作")
    expect(stable).toContain("create_team")
  })

  it("an idle member holding an in_progress task gets one resume nudge per situation", async () => {
    const llm = scriptedLlm(
      endTurn("就位收到"),
      toolTurn("c1", "task_update", { id: 1, expected_revision: 1, status: "in_progress" }),
      endTurn("收到，继续推进"),
    )
    const { sessions, host, workspace } = await makeTeamEnv(llm)
    const lead = sessions.create("组长", undefined, workspace)
    const { teamId } = await host.facade.createTeam(lead.id)
    const spawned = await host.facade.spawnTeammate({ role: "lead", teamId, sessionId: lead.id }, { name: "builder", task: "就位" })
    await until(() => sessions.readMessages(spawned.sessionId).length >= 2) // the spawn-mail run settled
    await host.facade.taskCreate({ role: "lead", teamId, sessionId: lead.id }, { subject: "做不完的活" })
    // Auto-dispatch wakes builder, who claims the task; his run then ends
    // WITHOUT completing it — the next idle edge must nudge him exactly once.
    const runs = () => sessions.readMessages(spawned.sessionId).filter((m) => m.role === "user")
    await until(() => runs().some((m) => m.blocks.some((b) => b.type === "text" && b.text.includes("任务派发"))))
    await until(() => runs().some((m) => m.blocks.some((b) => b.type === "text" && b.text.includes("恢复提醒"))))
    await sleep(250) // the nudged run settles; nothing may wake him again
    expect(runs().length).toBe(3) // 就位 mail / 任务派发 offer / 恢复提醒 nudge
  })
})
