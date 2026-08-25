import { describe, expect, it, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FastifyInstance } from "fastify"
import { JobScheduler, SessionStore, UsageStore, loadConfig, resolvePaths } from "@kclaw/core"
import { createApp } from "../../src/index.js"

describe("usage + model routes", () => {
  let app: FastifyInstance
  const dirs: string[] = []
  const auth = { authorization: "Bearer t1" }

  async function makeApp(): Promise<{ app: FastifyInstance; usage: UsageStore; sessions: SessionStore }> {
    const home = mkdtempSync(join(tmpdir(), "kclaw-um-"))
    dirs.push(home)
    const paths = resolvePaths(home)
    const config = loadConfig(paths)
    config.providers = { default: "p", entries: { p: { baseUrl: "x", apiKey: "k", model: "m1" }, glm: { baseUrl: "x", apiKey: "k", model: "glm-4" } } }
    const sessions = new SessionStore(paths.sessionsDir)
    const usage = new UsageStore(paths.usageDb)
    app = await createApp({ home, token: "t1", stores: { sessions, config, paths }, usage })
    return { app, usage, sessions }
  }

  afterEach(async () => {
    if (app) await app.close()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("GET /usage returns empty aggregation by default and with by=model", async () => {
    const { app } = await makeApp()
    const res = await app.inject({ method: "GET", url: "/usage", headers: auth })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { by: string; buckets: unknown[]; total: { inputTokens: number } }
    expect(body.by).toBe("day")
    expect(body.buckets).toEqual([])
    expect(body.total.inputTokens).toBe(0)

    const byModel = await app.inject({ method: "GET", url: "/usage?by=model", headers: auth })
    expect((byModel.json() as { by: string }).by).toBe("model")
  })

  it("POST /sessions/:id/model switches the session model and rejects unknown names", async () => {
    const { app, sessions } = await makeApp()
    const sid = sessions.create("m").id

    const bad = await app.inject({ method: "POST", url: `/sessions/${sid}/model`, headers: auth, payload: { model: "nope" } })
    expect(bad.statusCode).toBe(400)
    expect((bad.json() as { error: string }).error).toContain("model not found")

    const ok = await app.inject({ method: "POST", url: `/sessions/${sid}/model`, headers: auth, payload: { model: "glm" } })
    expect(ok.statusCode).toBe(200)
    expect(sessions.meta(sid)?.model).toBe("glm")

    const clear = await app.inject({ method: "POST", url: `/sessions/${sid}/model`, headers: auth, payload: { model: "" } })
    expect(clear.statusCode).toBe(200)
    expect(sessions.meta(sid)?.model).toBeUndefined()
  })

  it("jobs accept an optional model field end to end", async () => {
    const home = mkdtempSync(join(tmpdir(), "kclaw-um-job-"))
    dirs.push(home)
    const paths = resolvePaths(home)
    const jobs = new JobScheduler(paths.jobsDb)
    app = await createApp({ home, token: "t1", stores: { jobs, paths } })

    const create = await app.inject({ method: "POST", url: "/jobs", headers: auth, payload: { name: "brief", cron: "* * * * *", prompt: "hi", model: "glm" } })
    expect(create.statusCode).toBe(201)
    const created = create.json() as { id: string; model?: string }
    expect(created.model).toBe("glm")
    expect(jobs.get(created.id)?.model).toBe("glm")

    const patch = await app.inject({ method: "PATCH", url: `/jobs/${created.id}`, headers: auth, payload: { model: "p" } })
    expect(patch.statusCode).toBe(200)
    expect(jobs.get(created.id)?.model).toBe("p")
  })
})
