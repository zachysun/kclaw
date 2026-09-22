import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AddressInfo } from "node:net"
import { defaultConfig } from "@kclaw/core"
import type { ConfigNotifier, KclawConfig } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

function makeConfig(over?: (cfg: KclawConfig) => void): KclawConfig {
  const cfg = structuredClone(defaultConfig)
  cfg.providers = {
    default: "ds",
    entries: { ds: { format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-secret-key", model: "deepseek-chat" } },
  }
  over?.(cfg)
  return cfg
}

describe("providers routes", () => {
  let home: string
  let app: FastifyInstance

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kclaw-providers-routes-"))
    app = await createApp({ home, token: "t1", stores: { config: makeConfig() } })
  })
  afterEach(async () => {
    await app.close()
    rmSync(home, { recursive: true, force: true })
  })

  it("GET /providers masks keys and serves the preset catalog", async () => {
    const res = await app.inject({ method: "GET", url: "/providers", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.default).toBe("ds")
    expect(body.entries.ds.apiKey).toBe("***-key")
    expect(body.entries.ds.model).toBe("deepseek-chat")
    expect(body.presets.map((p: { id: string }) => p.id)).toEqual(["openai", "anthropic", "deepseek", "ollama"])
  })

  it("POST creates an entry, persists config.json, and rejects duplicates/bad input", async () => {
    const res = await app.inject({
      method: "POST", url: "/providers", headers: AUTH,
      payload: { name: "gpt", entry: { format: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-openai", model: "gpt-4o" } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().entries.gpt.apiKey).toBe("***enai")

    const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    expect(persisted.providers.entries.gpt.apiKey).toBe("sk-openai") // disk keeps the real key

    const dupe = await app.inject({
      method: "POST", url: "/providers", headers: AUTH,
      payload: { name: "gpt", entry: { format: "openai", baseUrl: "https://x", apiKey: "k", model: "m" } },
    })
    expect(dupe.statusCode).toBe(409)
    const bad = await app.inject({
      method: "POST", url: "/providers", headers: AUTH,
      payload: { name: "bad name!", entry: { format: "openai", baseUrl: "https://x", apiKey: "k", model: "m" } },
    })
    expect(bad.statusCode).toBe(400)
  })

  it("PATCH updates an entry and a blank apiKey keeps the stored key", async () => {
    const res = await app.inject({
      method: "PATCH", url: "/providers/ds", headers: AUTH,
      payload: { entry: { format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-reasoner" } },
    })
    expect(res.statusCode).toBe(200)
    const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    expect(persisted.providers.entries.ds.model).toBe("deepseek-reasoner")
    expect(persisted.providers.entries.ds.apiKey).toBe("sk-secret-key")

    const missing = await app.inject({
      method: "PATCH", url: "/providers/nope", headers: AUTH,
      payload: { entry: { format: "openai", baseUrl: "https://x", apiKey: "k", model: "m" } },
    })
    expect(missing.statusCode).toBe(404)
  })

  it("PATCH renames an entry: the key moves, the default pointer and memory refs follow", async () => {
    const res = await app.inject({
      method: "PATCH", url: "/providers/ds", headers: AUTH,
      payload: { name: "deepseek", entry: { format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat" } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().default).toBe("deepseek")
    const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    expect(persisted.providers.entries.ds).toBeUndefined()
    expect(persisted.providers.entries.deepseek.apiKey).toBe("sk-secret-key") // blank key still keeps the stored one
    expect(persisted.providers.default).toBe("deepseek")

    const dupe = await app.inject({
      method: "PATCH", url: "/providers/deepseek", headers: AUTH,
      payload: { name: "deepseek", entry: { format: "openai", baseUrl: "https://x", apiKey: "k", model: "m" } },
    })
    expect(dupe.statusCode).toBe(200) // same name = plain update, no rename

    const conflict = await app.inject({
      method: "POST", url: "/providers", headers: AUTH,
      payload: { name: "other", entry: { format: "openai", baseUrl: "https://x", apiKey: "k", model: "m" } },
    })
    expect(conflict.statusCode).toBe(200)
    const clash = await app.inject({
      method: "PATCH", url: "/providers/other", headers: AUTH,
      payload: { name: "deepseek", entry: { format: "openai", baseUrl: "https://x", apiKey: "k", model: "m" } },
    })
    expect(clash.statusCode).toBe(409)
    const bad = await app.inject({
      method: "PATCH", url: "/providers/other", headers: AUTH,
      payload: { name: "bad name!", entry: { format: "openai", baseUrl: "https://x", apiKey: "k", model: "m" } },
    })
    expect(bad.statusCode).toBe(400)
  })

  it("a rename follows the memory extraction/embedding references", async () => {
    await app.close()
    app = await createApp({
      home, token: "t1",
      stores: {
        config: makeConfig((cfg) => {
          cfg.memory = { ...structuredClone(defaultConfig.memory), extractModel: "ds", embedding: { provider: "ds", model: "x" } }
        }),
      },
    })
    const res = await app.inject({
      method: "PATCH", url: "/providers/ds", headers: AUTH,
      payload: { name: "deepseek", entry: { format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat" } },
    })
    expect(res.statusCode).toBe(200)
    const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    expect(persisted.memory.extractModel).toBe("deepseek")
    expect(persisted.memory.embedding.provider).toBe("deepseek")
  })

  it("DELETE removes an entry but guards the default", async () => {
    const guarded = await app.inject({ method: "DELETE", url: "/providers/ds", headers: AUTH })
    expect(guarded.statusCode).toBe(409)
    expect(guarded.json().error).toContain("switch the default")

    await app.inject({
      method: "POST", url: "/providers", headers: AUTH,
      payload: { name: "tmp", entry: { format: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k", model: "claude-sonnet-4" } },
    })
    const res = await app.inject({ method: "DELETE", url: "/providers/tmp", headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().entries.tmp).toBeUndefined()
    const missing = await app.inject({ method: "DELETE", url: "/providers/tmp", headers: AUTH })
    expect(missing.statusCode).toBe(404)
  })

  it("POST /:name/default switches the default and persists", async () => {
    await app.inject({
      method: "POST", url: "/providers", headers: AUTH,
      payload: { name: "gpt", entry: { format: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o" } },
    })
    const res = await app.inject({ method: "POST", url: "/providers/gpt/default", headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().default).toBe("gpt")
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).providers.default).toBe("gpt")
    const missing = await app.inject({ method: "POST", url: "/providers/nope/default", headers: AUTH })
    expect(missing.statusCode).toBe(404)
  })

  describe("POST /providers/models probe", () => {
    let server: Server
    let base: string
    beforeEach(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [{ id: "mock-a" }, { id: "mock-b" }] }))
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

    it("probes a stored entry with its real (unmasked) key", async () => {
      await app.inject({
        method: "PATCH", url: "/providers/ds", headers: AUTH,
        payload: { entry: { format: "openai", baseUrl: base + "/v1", apiKey: "", model: "deepseek-chat" } },
      })
      const res = await app.inject({ method: "POST", url: "/providers/models", headers: AUTH, payload: { name: "ds" } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, models: ["mock-a", "mock-b"] })
    })

    it("probes explicit form values and surfaces provider failures as 502", async () => {
      const ok = await app.inject({
        method: "POST", url: "/providers/models", headers: AUTH,
        payload: { format: "openai", baseUrl: base + "/v1", apiKey: "k" },
      })
      expect(ok.json()).toEqual({ ok: true, models: ["mock-a", "mock-b"] })
      const bad = await app.inject({
        method: "POST", url: "/providers/models", headers: AUTH,
        payload: { format: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
      })
      expect(bad.statusCode).toBe(502)
      expect(bad.json().ok).toBe(false)
    })

    it("rejects malformed probes", async () => {
      const noFormat = await app.inject({
        method: "POST", url: "/providers/models", headers: AUTH, payload: { baseUrl: "https://x" },
      })
      expect(noFormat.statusCode).toBe(400)
      const unknown = await app.inject({
        method: "POST", url: "/providers/models", headers: AUTH, payload: { name: "nope" },
      })
      expect(unknown.statusCode).toBe(404)
    })
  })
})

describe("providers config-change notification", () => {
  it("every mutation publishes the providers section after persisting", async () => {
    const published: string[] = []
    const configNotifier: ConfigNotifier = {
      publish: (section) => published.push(section),
      subscribe: () => () => undefined,
    }
    const notifierHome = mkdtempSync(join(tmpdir(), "kclaw-providers-notify-"))
    const notifierApp = await createApp({ home: notifierHome, token: "t1", stores: { config: makeConfig() }, configNotifier })
    try {
    const inject = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
      notifierApp.inject({ method, url, headers: AUTH, payload })
    await inject("POST", "/providers", { name: "gpt", entry: { format: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o" } })
    await inject("PATCH", "/providers/gpt", { entry: { format: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" } })
    await inject("POST", "/providers/ds/default")
    await inject("DELETE", "/providers/gpt")
    // 失败的请求（校验 4xx）不发：in-memory config 未变
    await inject("POST", "/providers", { name: "bad name!", entry: {} })
    expect(published).toEqual(["providers", "providers", "providers", "providers"])
    } finally {
      await notifierApp.close()
      rmSync(notifierHome, { recursive: true, force: true })
    }
  })
})
