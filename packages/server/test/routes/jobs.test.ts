import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobScheduler } from "@kclaw/core"
import type { Job } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

describe("jobs routes", () => {
  let home: string
  let scheduler: JobScheduler
  let app: FastifyInstance

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-jobs-test-"))
    scheduler = new JobScheduler(join(home, "jobs.db"))
    app = await createApp({ home, token: "t1", stores: { jobs: scheduler } })
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })

  it("POST /jobs creates a job and returns 201 with the Job shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: AUTH,
      payload: { name: "早报", cron: "0 9 * * *", prompt: "给我今日早报" },
    })
    expect(res.statusCode).toBe(201)
    const job = res.json() as Job
    expect(job.id).toMatch(/^job_/)
    expect(job.name).toBe("早报")
    expect(job.cron).toBe("0 9 * * *")
    expect(job.prompt).toBe("给我今日早报")
    expect(job.enabled).toBe(true)
    expect(job.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("GET /jobs lists created jobs (create → list roundtrip)", async () => {
    const a = (await app.inject({
      method: "POST", url: "/jobs", headers: AUTH,
      payload: { name: "a", cron: "* * * * *", prompt: "pa" },
    })).json() as Job
    const b = (await app.inject({
      method: "POST", url: "/jobs", headers: AUTH,
      payload: { name: "b", cron: "*/5 * * * *", prompt: "pb" },
    })).json() as Job

    const res = await app.inject({ method: "GET", url: "/jobs", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const jobs = res.json() as Job[]
    expect(jobs.map((j) => j.id).sort()).toEqual([a.id, b.id].sort())
  })

  it("PATCH /jobs/:id updates fields and returns the updated job", async () => {
    const created = (await app.inject({
      method: "POST", url: "/jobs", headers: AUTH,
      payload: { name: "old", cron: "* * * * *", prompt: "old prompt" },
    })).json() as Job

    const res = await app.inject({
      method: "PATCH",
      url: `/jobs/${created.id}`,
      headers: AUTH,
      payload: { name: "new", prompt: "new prompt", enabled: false, cron: "0 12 * * *" },
    })
    expect(res.statusCode).toBe(200)
    const job = res.json() as Job
    expect(job.id).toBe(created.id)
    expect(job.name).toBe("new")
    expect(job.prompt).toBe("new prompt")
    expect(job.enabled).toBe(false)
    expect(job.cron).toBe("0 12 * * *")
    expect(job.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // recalculated for the new cron

    const list = (await app.inject({ method: "GET", url: "/jobs", headers: AUTH })).json() as Job[]
    expect(list.find((j) => j.id === created.id)).toEqual(job)
  })

  it("DELETE /jobs/:id returns 204 with an empty body", async () => {
    const created = (await app.inject({
      method: "POST", url: "/jobs", headers: AUTH,
      payload: { name: "x", cron: "* * * * *", prompt: "p" },
    })).json() as Job

    const res = await app.inject({ method: "DELETE", url: `/jobs/${created.id}`, headers: AUTH })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe("")
    expect(res.rawPayload.length).toBe(0)

    const list = (await app.inject({ method: "GET", url: "/jobs", headers: AUTH })).json() as Job[]
    expect(list.map((j) => j.id)).not.toContain(created.id)
  })

  it("POST /jobs with an invalid cron returns 400 with the cron-parser message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: AUTH,
      payload: { name: "bad", cron: "not-a-cron", prompt: "p" },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string }
    expect(typeof body.error).toBe("string")
    expect(body.error.length).toBeGreaterThan(0)
  })

  it("PATCH /jobs/:id with an invalid cron returns 400 with the cron-parser message", async () => {
    const created = (await app.inject({
      method: "POST", url: "/jobs", headers: AUTH,
      payload: { name: "x", cron: "* * * * *", prompt: "p" },
    })).json() as Job
    const res = await app.inject({
      method: "PATCH",
      url: `/jobs/${created.id}`,
      headers: AUTH,
      payload: { cron: "still-not-a-cron" },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string }
    expect(typeof body.error).toBe("string")
    expect(body.error.length).toBeGreaterThan(0)
    // The job is untouched by the failed patch.
    const after = (await app.inject({ method: "GET", url: "/jobs", headers: AUTH })).json() as Job[]
    expect(after.find((j) => j.id === created.id)?.cron).toBe("* * * * *")
  })

  it("PATCH /jobs/:id for an unknown id returns 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/jobs/job_doesnotexist",
      headers: AUTH,
      payload: { name: "x" },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "job not found" })
  })

  it("DELETE /jobs/:id for an unknown id returns 404", async () => {
    const res = await app.inject({ method: "DELETE", url: "/jobs/job_doesnotexist", headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "job not found" })
  })

  it("POST /jobs with a missing field returns 400", async () => {
    for (const payload of [{ cron: "* * * * *", prompt: "p" }, { name: "n", prompt: "p" }, { name: "n", cron: "* * * * *" }]) {
      const res = await app.inject({ method: "POST", url: "/jobs", headers: AUTH, payload })
      expect(res.statusCode).toBe(400)
      expect(typeof (res.json() as { error: string }).error).toBe("string")
    }
  })

  it("POST /jobs with a non-string field returns 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/jobs", headers: AUTH,
      payload: { name: 42, cron: "* * * * *", prompt: "p" },
    })
    expect(res.statusCode).toBe(400)
    expect(typeof (res.json() as { error: string }).error).toBe("string")
  })

  it("PATCH /jobs/:id with a non-string name / non-boolean enabled returns 400", async () => {
    const created = (await app.inject({
      method: "POST", url: "/jobs", headers: AUTH,
      payload: { name: "x", cron: "* * * * *", prompt: "p" },
    })).json() as Job

    const badName = await app.inject({
      method: "PATCH", url: `/jobs/${created.id}`, headers: AUTH, payload: { name: 7 },
    })
    expect(badName.statusCode).toBe(400)

    const badEnabled = await app.inject({
      method: "PATCH", url: `/jobs/${created.id}`, headers: AUTH, payload: { enabled: "yes" },
    })
    expect(badEnabled.statusCode).toBe(400)
  })

  it("GET /jobs without an auth header returns 401 (auth covers the new routes)", async () => {
    const res = await app.inject({ method: "GET", url: "/jobs" })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthorized" })
  })

  it("without the stores option, a JobScheduler is created at <home>/jobs.db", async () => {
    const appNoStores = await createApp({ home, token: "t1" })
    try {
      const res = await appNoStores.inject({
        method: "POST", url: "/jobs", headers: AUTH,
        payload: { name: "x", cron: "* * * * *", prompt: "p" },
      })
      expect(res.statusCode).toBe(201)
      const st = await stat(join(home, "jobs.db"))
      expect(st.isFile()).toBe(true)
    } finally {
      await appNoStores.close()
    }
  })
})
