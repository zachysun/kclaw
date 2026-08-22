import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, loadOrCreateToken, SERVER_NAME } from "../src/index.js"
import type { FastifyInstance } from "fastify"

describe("createApp auth + endpoints", () => {
  let app: FastifyInstance

  afterEach(async () => {
    if (app) await app.close()
  })

  it("GET /health requires no auth and returns {ok:true}", async () => {
    app = await createApp({ home: tmpdir(), token: "t1" })
    const res = await app.inject({ method: "GET", url: "/health" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it("GET /status without authorization header returns 401 unauthorized", async () => {
    app = await createApp({ home: tmpdir(), token: "t1" })
    const res = await app.inject({ method: "GET", url: "/status" })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthorized" })
  })

  it("GET /status with a wrong bearer token returns 401 unauthorized", async () => {
    app = await createApp({ home: tmpdir(), token: "t1" })
    const res = await app.inject({
      method: "GET",
      url: "/status",
      headers: { authorization: "Bearer nope" },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthorized" })
  })

  it("GET /status with the correct bearer token returns version and uptimeSec", async () => {
    app = await createApp({ home: tmpdir(), token: "t1" })
    const res = await app.inject({
      method: "GET",
      url: "/status",
      headers: { authorization: "Bearer t1" },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { version: string; uptimeSec: number }
    expect(typeof body.version).toBe("string")
    expect(body.version.length).toBeGreaterThan(0)
    expect(Number.isInteger(body.uptimeSec)).toBe(true)
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0)
  })
})

describe("loadOrCreateToken", () => {
  let home: string

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-server-test-"))
  })

  afterAll(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it("creates <home>/token with mode 0600 and a UUID", async () => {
    const token = loadOrCreateToken(home)
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    const st = await stat(join(home, "token"))
    expect(st.mode & 0o777).toBe(0o600)
  })

  it("returns the same token on the next call and keeps mode 0600", async () => {
    const first = loadOrCreateToken(home)
    const second = loadOrCreateToken(home)
    expect(second).toBe(first)
    const st = await stat(join(home, "token"))
    expect(st.mode & 0o777).toBe(0o600)
  })
})

describe("package exports", () => {
  it("exports package name", () => {
    expect(SERVER_NAME).toBe("@kclaw/server")
  })
})
