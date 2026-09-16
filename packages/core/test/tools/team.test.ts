import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBuiltinTools } from "../../src/tools/index.js"
import type { MemorySystem } from "../../src/memory/system.js"
import type { TeamFacade, TeamIdentity } from "../../src/team/facade.js"

const TEAM_TOOLS = [
  "create_team", "spawn_teammate",
  "send_message", "list_agents", "task_create", "task_update", "task_list",
]

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-team-tools-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function fakeFacade(): TeamFacade {
  return {
    describeSession: vi.fn(async () => null),
    createTeam: vi.fn(async () => ({ teamId: "tm_1", name: "crew" })),
    spawnTeammate: vi.fn(async () => ({ name: "builder", sessionId: "ses_m1" })),
    sendMessage: vi.fn(async () => ({ id: "tma_1" })),
    listAgents: vi.fn(async () => ({ members: [] })),
    taskCreate: vi.fn(async (_identity, req) => ({
      id: 1, subject: req.subject, detail: req.detail ?? "", status: "pending" as const,
      assignee: null, dependencies: [], attempt: 0, revision: 1,
      createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
    })),
    taskUpdate: vi.fn(async (_identity, req) => ({
      id: req.id, subject: "t", detail: "", status: "in_progress" as const,
      assignee: null, dependencies: [], attempt: 1, attemptId: req.attemptId, revision: 2,
      createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
    })),
    taskList: vi.fn(async () => ({ tasks: [] })),
  }
}

function build(opts: { facade: TeamFacade; identity: TeamIdentity }, childRun = false) {
  return createBuiltinTools({
    workspace: dir,
    memoryCtx: {
      system: {
        triggerImmediate: vi.fn(async () => undefined),
        searchAll: vi.fn(async () => []),
      } as unknown as MemorySystem,
      sessionId: "ses_lead",
      workdir: dir,
      immediateEnabled: false,
    },
    tavilyApiKey: "tvly-test",
    ...(childRun ? { childRun: true } : {}),
    team: opts,
  })
}

describe("team tool surface", () => {
  it("the lead gets all seven team tools, all safe", () => {
    const facade = fakeFacade()
    const lead: TeamIdentity = { role: "lead", teamId: "tm_1", sessionId: "ses_lead" }
    const { tools, toolDefs } = build({ facade, identity: lead })
    for (const name of TEAM_TOOLS) {
      expect(tools.has(name), name).toBe(true)
      expect(tools.get(name)!.risk).toBe("safe")
    }
    expect(tools.has("memory_save")).toBe(true)
    expect(tools).toHaveLength(12 + 7)
    expect(toolDefs.map((d) => d.name).sort()).toEqual([...tools.keys()].sort())
  })

  it("a member never gets create_team / spawn_teammate (no second team, no multi-level)", () => {
    const facade = fakeFacade()
    const member: TeamIdentity = { role: "member", teamId: "tm_1", sessionId: "ses_m1", name: "builder" }
    const { tools } = build({ facade, identity: member })
    expect(tools.has("create_team")).toBe(false)
    expect(tools.has("spawn_teammate")).toBe(false)
    for (const name of TEAM_TOOLS.filter((n) => n !== "create_team" && n !== "spawn_teammate")) {
      expect(tools.has(name), name).toBe(true)
    }
    expect(tools).toHaveLength(12 + 5)
  })

  it("a real member run (child session) also drops memory_save", () => {
    const facade = fakeFacade()
    const member: TeamIdentity = { role: "member", teamId: "tm_1", sessionId: "ses_m1", name: "builder" }
    const { tools } = build({ facade, identity: member }, true)
    expect(tools.has("memory_save")).toBe(false)
    expect(tools.has("subagent_run")).toBe(false)
    expect(tools).toHaveLength(11 + 5)
  })
})

describe("team tool behavior", () => {
  it("send_message: a member defaults to the lead, the lead must name a recipient", async () => {
    const facade = fakeFacade()
    const member: TeamIdentity = { role: "member", teamId: "tm_1", sessionId: "ses_m1", name: "builder" }
    const { tools } = build({ facade, identity: member })
    const res = await tools.get("send_message")!.execute({ text: "done" })
    expect(res.status).toBe("ok")
    expect(facade.sendMessage).toHaveBeenCalledWith(member, { to: { kind: "lead" }, text: "done" })

    const lead: TeamIdentity = { role: "lead", teamId: "tm_1", sessionId: "ses_lead" }
    const leadTools = build({ facade, identity: lead }).tools
    const missing = await leadTools.get("send_message")!.execute({ text: "hi" })
    expect(missing.status).toBe("error")
    const named = await leadTools.get("send_message")!.execute({ to: "builder", text: "hi" })
    expect(named.status).toBe("ok")
    expect(facade.sendMessage).toHaveBeenCalledWith(lead, { to: { kind: "member", name: "builder" }, text: "hi" })
  })

  it("task_update maps the snake_case wire args onto the facade request (late-write fields included)", async () => {
    const facade = fakeFacade()
    const member: TeamIdentity = { role: "member", teamId: "tm_1", sessionId: "ses_m1", name: "builder" }
    const { tools } = build({ facade, identity: member })
    const res = await tools.get("task_update")!.execute({ id: 3, expected_revision: 5, attempt_id: "tma_9", status: "completed" })
    expect(res.status).toBe("ok")
    expect(facade.taskUpdate).toHaveBeenCalledWith(member, { id: 3, expectedRevision: 5, attemptId: "tma_9", status: "completed" })
  })

  it("task_update without the revision pair is rejected before the facade is touched", async () => {
    const facade = fakeFacade()
    const member: TeamIdentity = { role: "member", teamId: "tm_1", sessionId: "ses_m1", name: "builder" }
    const { tools } = build({ facade, identity: member })
    const res = await tools.get("task_update")!.execute({ id: 3 })
    expect(res.status).toBe("error")
    expect(facade.taskUpdate).not.toHaveBeenCalled()
  })
})
