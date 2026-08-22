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
  it("due returns enabled jobs whose time passed, markRun advances past backlog", () => {
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
    expect(after.nextRunAt > now.toISOString()).toBe(true) // 跳过积压
    expect(s.due(new Date())).toEqual([])
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
