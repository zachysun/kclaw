import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CronScheduler } from "@kclaw/core"
import type { Cron } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

describe("crons routes", () => {
  let home: string
  let scheduler: CronScheduler
  let app: FastifyInstance

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-crons-test-"))
    scheduler = new CronScheduler(join(home, "cron.db"))
    app = await createApp({ home, token: "t1", stores: { crons: scheduler } })
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })

  it("POST /cron creates a cron and returns 201 with the Cron shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cron",
      headers: AUTH,
      payload: { name: "早报", cron: "0 9 * * *", prompt: "给我今日早报" },
    })
    expect(res.statusCode).toBe(201)
    const cron = res.json() as Cron
    expect(cron.id).toMatch(/^cron_/)
    expect(cron.name).toBe("早报")
    expect(cron.cron).toBe("0 9 * * *")
    expect(cron.prompt).toBe("给我今日早报")
    expect(cron.enabled).toBe(true)
    expect(cron.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("GET /cron lists created crons (create → list roundtrip)", async () => {
    const a = (await app.inject({
      method: "POST", url: "/cron", headers: AUTH,
      payload: { name: "a", cron: "* * * * *", prompt: "pa" },
    })).json() as Cron
    const b = (await app.inject({
      method: "POST", url: "/cron", headers: AUTH,
      payload: { name: "b", cron: "*/5 * * * *", prompt: "pb" },
    })).json() as Cron

    const res = await app.inject({ method: "GET", url: "/cron", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const crons = res.json() as Cron[]
    expect(crons.map((j) => j.id).sort()).toEqual([a.id, b.id].sort())
  })

  it("PATCH /cron/:id updates fields and returns the updated cron", async () => {
    const created = (await app.inject({
      method: "POST", url: "/cron", headers: AUTH,
      payload: { name: "old", cron: "* * * * *", prompt: "old prompt" },
    })).json() as Cron

    const res = await app.inject({
      method: "PATCH",
      url: `/cron/${created.id}`,
      headers: AUTH,
      payload: { name: "new", prompt: "new prompt", enabled: false, cron: "0 12 * * *" },
    })
    expect(res.statusCode).toBe(200)
    const cron = res.json() as Cron
    expect(cron.id).toBe(created.id)
    expect(cron.name).toBe("new")
    expect(cron.prompt).toBe("new prompt")
    expect(cron.enabled).toBe(false)
    expect(cron.cron).toBe("0 12 * * *")
    expect(cron.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // recalculated for the new cron

    const list = (await app.inject({ method: "GET", url: "/cron", headers: AUTH })).json() as Cron[]
    expect(list.find((j) => j.id === created.id)).toEqual(cron)
  })

  it("DELETE /cron/:id returns 204 with an empty body", async () => {
    const created = (await app.inject({
      method: "POST", url: "/cron", headers: AUTH,
      payload: { name: "x", cron: "* * * * *", prompt: "p" },
    })).json() as Cron

    const res = await app.inject({ method: "DELETE", url: `/cron/${created.id}`, headers: AUTH })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe("")
    expect(res.rawPayload.length).toBe(0)

    const list = (await app.inject({ method: "GET", url: "/cron", headers: AUTH })).json() as Cron[]
    expect(list.map((j) => j.id)).not.toContain(created.id)
  })

  it("POST /cron with an invalid cron returns 400 with the cron-parser message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cron",
      headers: AUTH,
      payload: { name: "bad", cron: "not-a-cron", prompt: "p" },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string }
    expect(typeof body.error).toBe("string")
    expect(body.error.length).toBeGreaterThan(0)
  })

  it("PATCH /cron/:id with an invalid cron returns 400 with the cron-parser message", async () => {
    const created = (await app.inject({
      method: "POST", url: "/cron", headers: AUTH,
      payload: { name: "x", cron: "* * * * *", prompt: "p" },
    })).json() as Cron
    const res = await app.inject({
      method: "PATCH",
      url: `/cron/${created.id}`,
      headers: AUTH,
      payload: { cron: "still-not-a-cron" },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string }
    expect(typeof body.error).toBe("string")
    expect(body.error.length).toBeGreaterThan(0)
    // The cron is untouched by the failed patch.
    const after = (await app.inject({ method: "GET", url: "/cron", headers: AUTH })).json() as Cron[]
    expect(after.find((j) => j.id === created.id)?.cron).toBe("* * * * *")
  })

  it("PATCH /cron/:id for an unknown id returns 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/cron/cron_doesnotexist",
      headers: AUTH,
      payload: { name: "x" },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "cron not found" })
  })

  it("DELETE /cron/:id for an unknown id returns 404", async () => {
    const res = await app.inject({ method: "DELETE", url: "/cron/cron_doesnotexist", headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "cron not found" })
  })

  it("POST /cron with a missing field returns 400", async () => {
    for (const payload of [{ cron: "* * * * *", prompt: "p" }, { name: "n", prompt: "p" }, { name: "n", cron: "* * * * *" }]) {
      const res = await app.inject({ method: "POST", url: "/cron", headers: AUTH, payload })
      expect(res.statusCode).toBe(400)
      expect(typeof (res.json() as { error: string }).error).toBe("string")
    }
  })

  it("POST /cron with a non-string field returns 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/cron", headers: AUTH,
      payload: { name: 42, cron: "* * * * *", prompt: "p" },
    })
    expect(res.statusCode).toBe(400)
    expect(typeof (res.json() as { error: string }).error).toBe("string")
  })

  it("PATCH /cron/:id with a non-string name / non-boolean enabled returns 400", async () => {
    const created = (await app.inject({
      method: "POST", url: "/cron", headers: AUTH,
      payload: { name: "x", cron: "* * * * *", prompt: "p" },
    })).json() as Cron

    const badName = await app.inject({
      method: "PATCH", url: `/cron/${created.id}`, headers: AUTH, payload: { name: 7 },
    })
    expect(badName.statusCode).toBe(400)

    const badEnabled = await app.inject({
      method: "PATCH", url: `/cron/${created.id}`, headers: AUTH, payload: { enabled: "yes" },
    })
    expect(badEnabled.statusCode).toBe(400)
  })

  it("GET /cron without an auth header returns 401 (auth covers the new routes)", async () => {
    const res = await app.inject({ method: "GET", url: "/cron" })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthorized" })
  })

  it("without the stores option, a CronScheduler is created at <home>/cron.db", async () => {
    const appNoStores = await createApp({ home, token: "t1" })
    try {
      const res = await appNoStores.inject({
        method: "POST", url: "/cron", headers: AUTH,
        payload: { name: "x", cron: "* * * * *", prompt: "p" },
      })
      expect(res.statusCode).toBe(201)
      const st = await stat(join(home, "cron.db"))
      expect(st.isFile()).toBe(true)
    } finally {
      await appNoStores.close()
    }
  })
})
