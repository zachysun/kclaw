import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig } from "@kclaw/core"
import type { KclawConfig } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

describe("config route", () => {
  let home: string
  let config: KclawConfig
  let app: FastifyInstance

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-config-test-"))
    config = structuredClone(defaultConfig)
    config.providers = {
      default: "main",
      entries: {
        main: { baseUrl: "https://api.example.com/v1", apiKey: "sk-12345678", model: "gpt-4o" },
        short: { baseUrl: "https://other.example.com", apiKey: "ab", model: "m2" },
        empty: { baseUrl: "https://empty.example.com", apiKey: "", model: "m3" },
      },
    }
    config.web = { tavilyApiKey: "tvly-xyzw9876" }
    app = await createApp({ home, token: "t1", stores: { config } })
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })

  it("GET /config masks provider api keys as ***+last4 (*** when shorter)", async () => {
    const res = await app.inject({ method: "GET", url: "/config", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as KclawConfig

    expect(body.providers.entries.main).toEqual({
      baseUrl: "https://api.example.com/v1",
      apiKey: "***5678",
      model: "gpt-4o",
    })
    expect(body.providers.entries.short).toEqual({
      baseUrl: "https://other.example.com",
      apiKey: "***",
      model: "m2",
    })
    expect(body.providers.entries.empty).toEqual({
      baseUrl: "https://empty.example.com",
      apiKey: "***",
      model: "m3",
    })
    expect(body.providers.default).toBe("main")
  })

  it("GET /config masks web.tavilyApiKey the same way", async () => {
    const res = await app.inject({ method: "GET", url: "/config", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as KclawConfig
    expect(body.web.tavilyApiKey).toBe("***9876")
  })

  it("GET /config passes every other field through unchanged", async () => {
    const res = await app.inject({ method: "GET", url: "/config", headers: AUTH })
    const body = res.json() as KclawConfig
    expect(body.permissions).toEqual(defaultConfig.permissions)
    expect(body.memory).toEqual(defaultConfig.memory)
    expect(body.bash).toEqual(defaultConfig.bash)
    expect(body.workspace).toBe(defaultConfig.workspace)
  })

  it("GET /config never mutates the injected config object", async () => {
    await app.inject({ method: "GET", url: "/config", headers: AUTH })
    expect(config.providers.entries.main.apiKey).toBe("sk-12345678")
    expect(config.providers.entries.short.apiKey).toBe("ab")
    expect(config.providers.entries.empty.apiKey).toBe("")
    expect(config.web.tavilyApiKey).toBe("tvly-xyzw9876")
  })

  it("GET /config without an auth header returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/config" })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthorized" })
  })

  it("PATCH /config updates the daily settings in place and persists them", async () => {
    const res = await app.inject({
      method: "PATCH", url: "/config", headers: { ...AUTH, "content-type": "application/json" },
      payload: { daily: { hour: 22, intervalDays: 3 } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, daily: { hour: 22, intervalDays: 3 } })
    // 就地生效（调度器每次扫描读 config，改动下一拍即吃到）
    expect(config.daily).toEqual({ hour: 22, intervalDays: 3 })
    // 持久化：重新 loadConfig 读回同值
    const { loadConfig, resolvePaths } = await import("@kclaw/core")
    const reloaded = loadConfig(resolvePaths(home))
    expect(reloaded.daily).toEqual({ hour: 22, intervalDays: 3 })
    // 凭据拆分不受影响：config.json 里 provider key 是空串占位、凭据文件持有真值
    const { readFile } = await import("node:fs/promises")
    const persisted = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as KclawConfig
    expect(persisted.providers.entries.main?.apiKey).toBe("")
  })

  it("PATCH /config validates the daily values and rejects anything else", async () => {
    const bad = [
      { hour: 24, intervalDays: 1 },
      { hour: 8, intervalDays: 0 },
      { hour: "eight", intervalDays: 1 },
      { hour: 8 },
    ]
    for (const daily of bad) {
      const res = await app.inject({
        method: "PATCH", url: "/config", headers: { ...AUTH, "content-type": "application/json" },
        payload: { daily },
      })
      expect(res.statusCode, JSON.stringify(daily)).toBe(400)
    }
    // 负 hour 是合法的关闭表达
    const off = await app.inject({
      method: "PATCH", url: "/config", headers: { ...AUTH, "content-type": "application/json" },
      payload: { daily: { hour: -1, intervalDays: 2 } },
    })
    expect(off.statusCode).toBe(200)
    expect(config.daily.hour).toBe(-1)
    // 白名单外的一律拒绝
    const alien = await app.inject({
      method: "PATCH", url: "/config", headers: { ...AUTH, "content-type": "application/json" },
      payload: { memory: { consolidate: false } },
    })
    expect(alien.statusCode).toBe(400)
  })
})

describe("static hosting of packages/web dist", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-static-test-"))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it("with webDist set, GET / serves <webDist>/index.html (shell exempt from auth)", async () => {
    const dist = join(home, "dist")
    await mkdir(dist)
    await writeFile(join(dist, "index.html"), "<html>kclaw-web-placeholder</html>", "utf8")
    const app = await createApp({ home, token: "t1", webDist: dist })
    try {
      const res = await app.inject({ method: "GET", url: "/", headers: AUTH })
      expect(res.statusCode).toBe(200)
      expect(res.body).toContain("kclaw-web-placeholder")
      expect(res.headers["content-type"]).toContain("text/html")

      // The static shell loads before the client holds a token:
      // GET / is exempt from bearer auth once webDist is configured.
      const noAuth = await app.inject({ method: "GET", url: "/" })
      expect(noAuth.statusCode).toBe(200)
      expect(noAuth.body).toContain("kclaw-web-placeholder")
    } finally {
      await app.close()
    }
  })

  it("without webDist, GET / is 404 (registration skipped)", async () => {
    const app = await createApp({ home, token: "t1" })
    try {
      const res = await app.inject({ method: "GET", url: "/", headers: AUTH })
      expect(res.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})
