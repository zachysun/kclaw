import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { JobScheduler } from "../../src/jobs/scheduler.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-sched-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("JobScheduler", () => {
  it("creates job with next cron occurrence, persists across instances", () => {
    const s = new JobScheduler(join(dir, "jobs.db"))
    const j = s.create({ name: "早报", cron: "0 9 * * *", prompt: "给我今日早报" })
    expect(j.id).toMatch(/^job_/)
    expect(j.nextRunAt > new Date().toISOString()).toBe(true)
    const s2 = new JobScheduler(join(dir, "jobs.db"))
    expect(s2.list().map((x) => x.id)).toEqual([j.id])
  })
  it("due returns enabled jobs whose time passed; markRun records without advancing", () => {
    const s = new JobScheduler(join(dir, "jobs.db"))
    const j = s.create({ name: "every5", cron: "*/5 * * * *", prompt: "p" })
    const past = new Date(Date.now() - 3600_000)
    s.update(j.id, { nextRunAt: past.toISOString() }) // 直接回拨模拟积压（update 允许 patch nextRunAt 用于测试）
    expect(s.due(new Date()).map((x) => x.id)).toEqual([j.id])
    const now = new Date()
    s.markRun(j.id, "ok", now)
    const after = s.get(j.id)!
    expect(after.lastStatus).toBe("ok")
    expect(after.lastRunAt).toBe(now.toISOString())
    expect(after.nextRunAt).toBe(past.toISOString()) // markRun no longer advances next_run_at
    expect(s.due(new Date()).map((x) => x.id)).toEqual([j.id]) // still due until claimDue claims it
  })
  it("disabled jobs never due; invalid cron throws", () => {
    const s = new JobScheduler(join(dir, "jobs.db"))
    const j = s.create({ name: "x", cron: "* * * * *", prompt: "p" })
    s.update(j.id, { enabled: false })
    expect(s.due(new Date(Date.now() + 120_000))).toEqual([])
    expect(() => s.create({ name: "bad", cron: "not-a-cron", prompt: "p" })).toThrow()
  })
  it("remove deletes", () => {
    const s = new JobScheduler(join(dir, "jobs.db"))
    const j = s.create({ name: "x", cron: "* * * * *", prompt: "p" })
    expect(s.remove(j.id)).toBe(true)
    expect(s.get(j.id)).toBeUndefined()
  })
})

describe("claimDue (atomic claim)", () => {
  // create() seeds nextRunAt from real wall-clock time; back-date each row so
  // the fixed claim times below are actually due (update allows patching
  // nextRunAt for tests).
  const BACKDATED = "2026-01-01T00:00:00Z"

  it("advances nextRunAt at claim time — a second claim gets nothing", () => {
    const s = new JobScheduler(join(dir, "jobs.db"))
    const j = s.create({ name: "j", cron: "*/5 * * * *", prompt: "p" })
    s.update(j.id, { nextRunAt: BACKDATED })
    const first = s.claimDue(new Date("2026-01-01T00:05:00Z"))
    expect(first).toHaveLength(1)
    const again = s.claimDue(new Date("2026-01-01T00:05:01Z"))
    expect(again).toHaveLength(0) // claimed: next already advanced past now
  })
  it("two handles on one db never both claim the same row", () => {
    const path = join(dir, "jobs.db")
    const a = new JobScheduler(path)
    const b = new JobScheduler(path)
    const j = a.create({ name: "j", cron: "*/5 * * * *", prompt: "p" })
    a.update(j.id, { nextRunAt: BACKDATED })
    const now = new Date("2026-01-01T00:05:00Z")
    expect(a.claimDue(now)).toHaveLength(1)
    expect(b.claimDue(now)).toHaveLength(0)
  })
  it("markRun records the outcome without touching next_run_at", () => {
    const s = new JobScheduler(join(dir, "jobs.db"))
    const job = s.create({ name: "j", cron: "*/5 * * * *", prompt: "p" })
    s.update(job.id, { nextRunAt: BACKDATED })
    const claimed = s.claimDue(new Date("2026-01-01T00:05:00Z"))
    expect(claimed).toHaveLength(1)
    s.markRun(job.id, "ok", new Date("2026-01-01T00:05:30Z"))
    const after = s.get(job.id)
    expect(after?.lastStatus).toBe("ok")
    expect(after?.nextRunAt).toBe(claimed[0]!.nextRunAt) // unchanged by markRun
  })
  it("a crash between claim and markRun does not re-fire the job", () => {
    const s = new JobScheduler(join(dir, "jobs.db"))
    const j = s.create({ name: "j", cron: "*/5 * * * *", prompt: "p" })
    s.update(j.id, { nextRunAt: BACKDATED })
    s.claimDue(new Date("2026-01-01T00:05:00Z"))
    // simulate the process dying before markRun: a fresh handle sees the advanced row
    const revived = new JobScheduler(join(dir, "jobs.db"))
    expect(revived.claimDue(new Date("2026-01-01T00:05:10Z"))).toHaveLength(0)
  })
})
