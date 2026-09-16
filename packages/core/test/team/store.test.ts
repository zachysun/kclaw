import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initTeamDirectory, ensureWorkspaceIgnore, TeamStore, TeamConflictError, isValidMemberName } from "../../src/team/store.js"

let workspace: string
let teamDir: string
let store: TeamStore

const limits = { maxMembers: 3, maxActive: 4, maxUnreadPerTarget: 2, maxMessageBytes: 1000, maxTasks: 4 }

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "kclaw-team-"))
  teamDir = join(workspace, ".agent-teams", "ses_lead")
  initTeamDirectory(teamDir, { version: 1, teamId: "ses_lead", name: "test-team", leadSessionId: "ses_lead", createdAt: "2026-09-16T00:00:00Z" })
  store = new TeamStore(teamDir, limits)
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe("team directory skeleton", () => {
  it("creates the team/task layout and the record", () => {
    expect(existsSync(join(teamDir, "team.json"))).toBe(true)
    expect(existsSync(join(teamDir, "team", "members.json"))).toBe(true)
    expect(existsSync(join(teamDir, "task", "board.json"))).toBe(true)
    expect(store.record()?.leadSessionId).toBe("ses_lead")
  })

  it("ensureWorkspaceIgnore appends the ignore line once and creates a missing .gitignore", () => {
    ensureWorkspaceIgnore(workspace, ".agent-teams")
    ensureWorkspaceIgnore(workspace, ".agent-teams")
    const content = readFileSync(join(workspace, ".gitignore"), "utf8")
    expect(content.match(/\.agent-teams\//g)).toHaveLength(1)
  })

  it("ensureWorkspaceIgnore keeps existing lines", () => {
    writeFileSync(join(workspace, ".gitignore"), "node_modules/\ndist/\n", "utf8")
    ensureWorkspaceIgnore(workspace, ".agent-teams")
    const content = readFileSync(join(workspace, ".gitignore"), "utf8")
    expect(content).toContain("node_modules/")
    expect(content).toContain(".agent-teams/")
  })
})

describe("member list", () => {
  it("validates names: format, reserved word", () => {
    expect(isValidMemberName("researcher")).toBe(true)
    expect(isValidMemberName("web-dev")).toBe(true)
    expect(isValidMemberName("Lead")).toBe(false)
    expect(isValidMemberName("lead")).toBe(false)
    expect(isValidMemberName("2fast")).toBe(false)
    expect(isValidMemberName("has space")).toBe(false)
    expect(isValidMemberName("x".repeat(40))).toBe(false)
  })

  it("provision → attach → settle makes a member active", async () => {
    await store.provisionMember({ name: "researcher", role: "research", model: "prov/model-a" })
    await store.attachMemberSession("researcher", "ses_child")
    const member = await store.settleMember("researcher", "active")
    expect(member.status).toBe("active")
    expect(member.sessionId).toBe("ses_child")
    expect(member.model).toBe("prov/model-a")
    expect(store.memberByName("researcher")?.status).toBe("active")
    expect(store.memberBySession("ses_child")?.name).toBe("researcher")
  })

  it("failed settlement keeps the name and the member-list slot (names never reused)", async () => {
    await store.provisionMember({ name: "doomed" })
    await store.settleMember("doomed", "failed", "provider exploded")
    expect(store.memberByName("doomed")?.failReason).toBe("provider exploded")
    await expect(store.provisionMember({ name: "doomed" })).rejects.toThrow(TeamConflictError)
  })

  it("duplicate names and the member-list cap fail loudly (failed spawns included)", async () => {
    await store.provisionMember({ name: "a" })
    await expect(store.provisionMember({ name: "a" })).rejects.toThrow(TeamConflictError)
    await store.provisionMember({ name: "b" })
    await store.provisionMember({ name: "c" })
    await store.settleMember("c", "failed", "boom")
    await expect(store.provisionMember({ name: "d" })).rejects.toThrow(/full/) // cap counts failed entries
  })
})

describe("inbox", () => {
  it("enqueue appends pending; markDelivered flips in place; unread counts pending", async () => {
    const first = await store.enqueueMail({ from: { kind: "lead" }, to: "researcher", type: "text", text: "hello" })
    await store.enqueueMail({ from: { kind: "member", name: "researcher" }, to: "lead", type: "text", text: "done" })
    expect(store.unreadCount("researcher")).toBe(1)
    expect(first.status).toBe("pending")
    await store.markDelivered("researcher", first.id)
    expect(store.unreadCount("researcher")).toBe(0)
    expect(store.readInbox("researcher")[0]?.status).toBe("delivered")
    expect(store.readInbox("researcher")[0]?.deliveredAt).toBeDefined()
    expect(store.pendingInbox("lead")).toHaveLength(1)
  })

  it("unread cap and byte cap reject loudly", async () => {
    await store.enqueueMail({ from: { kind: "lead" }, to: "a", type: "text", text: "1" })
    await store.enqueueMail({ from: { kind: "lead" }, to: "a", type: "text", text: "2" })
    await expect(store.enqueueMail({ from: { kind: "lead" }, to: "a", type: "text", text: "3" })).rejects.toThrow(/full/)
    await expect(store.enqueueMail({ from: { kind: "lead" }, to: "b", type: "text", text: "x".repeat(1001) })).rejects.toThrow(/byte cap/)
  })
})

describe("task board", () => {
  it("create assigns monotonic ids and validates dependencies", async () => {
    const first = await store.createTask({ subject: "survey", detail: "read the code" })
    const second = await store.createTask({ subject: "implement", dependencies: [first.id] })
    expect(second.id).toBe(first.id + 1)
    expect(second.status).toBe("pending")
    expect(second.assignee).toBeNull()
    await expect(store.createTask({ subject: "x", dependencies: [99] })).rejects.toThrow(/does not exist/)
  })

  it("task cap fails loudly", async () => {
    for (let i = 0; i < limits.maxTasks; i++) await store.createTask({ subject: `t${i}` })
    await expect(store.createTask({ subject: "over" })).rejects.toThrow(/full/)
  })

  it("claim → complete with attempt echo; stale attemptId is rejected", async () => {
    const task = await store.createTask({ subject: "work" })
    await store.provisionMember({ name: "a" }) // assignee must be on the list
    const claimed = await store.updateTask({ id: task.id, expectedRevision: task.revision, status: "in_progress", assignee: "a" })
    // late write from a superseded executor: wrong attemptId cannot complete
    await expect(store.updateTask({ id: task.id, expectedRevision: claimed.revision, attemptId: "tma_stale", status: "completed" }))
      .rejects.toThrow(/attemptId/)
    const done = await store.updateTask({ id: task.id, expectedRevision: claimed.revision, attemptId: claimed.attemptId, status: "completed" })
    expect(done.status).toBe("completed")
    expect(done.attemptId).toBe(claimed.attemptId) // terminal keeps the finishing attempt
  })

  it("CAS: a stale expectedRevision is rejected", async () => {
    const task = await store.createTask({ subject: "work" })
    await store.updateTask({ id: task.id, expectedRevision: task.revision, subject: "renamed" })
    await expect(store.updateTask({ id: task.id, expectedRevision: task.revision, subject: "lost update" }))
      .rejects.toThrow(/changed under you/)
  })

  it("transition legality: terminal states are final, failed can restart with a new attempt", async () => {
    const task = await store.createTask({ subject: "work" })
    await store.provisionMember({ name: "a" })
    const claimed = await store.updateTask({ id: task.id, expectedRevision: task.revision, status: "in_progress", assignee: "a" })
    const failed = await store.updateTask({ id: task.id, expectedRevision: claimed.revision, attemptId: claimed.attemptId, status: "failed" })
    const retried = await store.updateTask({ id: task.id, expectedRevision: failed.revision, status: "in_progress" })
    expect(retried.attempt).toBe(2)
    expect(retried.attemptId).not.toBe(claimed.attemptId)
    await expect(store.updateTask({ id: task.id, expectedRevision: retried.revision, status: "pending" })).rejects.toThrow(/illegal transition/)
    const done = await store.updateTask({ id: task.id, expectedRevision: retried.revision, attemptId: retried.attemptId, status: "completed" })
    await expect(store.updateTask({ id: task.id, expectedRevision: done.revision, status: "in_progress" })).rejects.toThrow(/illegal transition/)
  })

  it("claim requires an assignee; assignee must be on the member list", async () => {
    const task = await store.createTask({ subject: "work" })
    await expect(store.updateTask({ id: task.id, expectedRevision: task.revision, status: "in_progress" })).rejects.toThrow(/without an assignee/)
    await expect(store.updateTask({ id: task.id, expectedRevision: task.revision, assignee: "ghost", status: "in_progress" })).rejects.toThrow(/member list/)
  })

  it("one unfinished task per member: a second claim and a reassignment onto a busy member are rejected", async () => {
    await store.provisionMember({ name: "a" })
    await store.provisionMember({ name: "b" })
    const first = await store.createTask({ subject: "first" })
    const second = await store.createTask({ subject: "second" })
    await store.updateTask({ id: first.id, expectedRevision: first.revision, status: "in_progress", assignee: "a" })
    // a claiming a second task is rejected…
    await expect(store.updateTask({ id: second.id, expectedRevision: second.revision, status: "in_progress", assignee: "a" }))
      .rejects.toThrow(/one unfinished task per member/)
    // …and the lead reassigning the in_progress task onto busy b is rejected too…
    await store.updateTask({ id: second.id, expectedRevision: second.revision, status: "in_progress", assignee: "b" })
    const firstNow = store.task(first.id)!
    await expect(store.updateTask({ id: first.id, expectedRevision: firstNow.revision, assignee: "b" }))
      .rejects.toThrow(/one unfinished task per member/)
    // …while re-asserting the same assignee on the same task stays legal.
    const secondNow = store.task(second.id)!
    const same = await store.updateTask({ id: second.id, expectedRevision: secondNow.revision, assignee: "b" })
    expect(same.assignee).toBe("b")
    // once a holds nothing (task completed via attempt echo), a fresh claim goes through.
    const firstHeld = store.task(first.id)!
    const done = await store.updateTask({ id: first.id, expectedRevision: firstHeld.revision, attemptId: firstHeld.attemptId, status: "completed" })
    expect(done.status).toBe("completed")
    const third = await store.createTask({ subject: "third" })
    await store.updateTask({ id: third.id, expectedRevision: third.revision, status: "in_progress", assignee: "a" })
    expect(store.heldTask("a")?.id).toBe(third.id)
  })

  it("dependency edits detect cycles", async () => {
    const a = await store.createTask({ subject: "a" })
    const b = await store.createTask({ subject: "b", dependencies: [a.id] })
    const c = await store.createTask({ subject: "c", dependencies: [b.id] })
    await expect(store.updateTask({ id: a.id, expectedRevision: a.revision, dependencies: [c.id] })).rejects.toThrow(/cycle/)
    await expect(store.updateTask({ id: a.id, expectedRevision: a.revision, dependencies: [a.id] })).rejects.toThrow(/cannot depend on itself/)
    // legal edit: independent task gains a dep
    const d = await store.createTask({ subject: "d" })
    const updated = await store.updateTask({ id: d.id, expectedRevision: d.revision, dependencies: [c.id] })
    expect(updated.dependencies).toEqual([c.id])
  })

  it("readyTasks gates on unclaimed + completed deps; heldTask finds the owner's task", async () => {
    await store.provisionMember({ name: "worker" })
    const a = await store.createTask({ subject: "a" })
    const b = await store.createTask({ subject: "b", dependencies: [a.id] })
    expect(store.readyTasks().map((t) => t.id)).toEqual([a.id])
    const claimed = await store.updateTask({ id: a.id, expectedRevision: a.revision, status: "in_progress", assignee: "worker" })
    expect(store.readyTasks().map((t) => t.id)).toEqual([]) // b blocked by a
    expect(store.heldTask("worker")?.id).toBe(a.id)
    await store.updateTask({ id: a.id, expectedRevision: claimed.revision, attemptId: claimed.attemptId, status: "completed" })
    expect(store.readyTasks().map((t) => t.id)).toEqual([b.id]) // unlocked
    expect(store.heldTask("worker")).toBeNull()
  })
})
