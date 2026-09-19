/**
 * Channel admin routes: auth coverage, secret masking (the snapshot never
 * carries secret content), draft validation, and the 503-when-unassembled
 * precedent. The manager behind the routes is a fake — manager behavior
 * lives in feishu/manager.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { ChannelRoutesView } from "../../src/routes/channel.js"
import type { FeishuSnapshot } from "../../src/feishu/manager.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

const SNAPSHOT: FeishuSnapshot = {
  config: { enabled: true, appId: "cli_a", appSecretSet: true, allowlist: ["ou_1"], primaryOpenId: "ou_1" },
  status: { state: "running" },
  pendingSenders: [{ openId: "ou_9", count: 2, lastSeen: 42 }],
}

function fakeView(): ChannelRoutesView & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    snapshot: () => { calls.push("snapshot"); return structuredClone(SNAPSHOT) },
    save: vi.fn(async (draft) => { calls.push(`save:${draft.appId}`); return structuredClone(SNAPSHOT) }),
    allowAdd: vi.fn(async (openId) => { calls.push(`allow:${openId}`); return structuredClone(SNAPSHOT) }),
    testCredentials: vi.fn(async () => ({ ok: true })),
  }
}

describe("channel routes", () => {
  let home: string
  let app: FastifyInstance
  let view: ReturnType<typeof fakeView>

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kclaw-channel-routes-"))
    view = fakeView()
    const config = structuredClone(defaultConfig)
    app = await createApp({ home, token: "t1", stores: { config }, channel: view })
  })

  afterEach(async () => {
    await app.close()
    rmSync(home, { recursive: true, force: true })
  })

  it("GET /channel returns the masked snapshot", async () => {
    const res = await app.inject({ method: "GET", url: "/channel", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as FeishuSnapshot
    expect(body.config.appSecretSet).toBe(true)
    expect(body.status).toEqual({ state: "running" })
    expect(body.pendingSenders).toEqual(SNAPSHOT.pendingSenders)
    expect(JSON.stringify(body)).not.toContain("s3cret")
  })

  it("requires the bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/channel" })
    expect(res.statusCode).toBe(401)
  })

  it("POST /channel/config forwards the draft and returns the new snapshot", async () => {
    const res = await app.inject({
      method: "POST", url: "/channel/config", headers: AUTH,
      payload: { enabled: true, appId: "cli_b", appSecret: "", allowlist: ["ou_1"] },
    })
    expect(res.statusCode).toBe(200)
    expect(view.save).toHaveBeenCalledWith({ enabled: true, appId: "cli_b", appSecret: "", allowlist: ["ou_1"] })
  })

  it("POST /channel/config validates the body shape", async () => {
    const res = await app.inject({ method: "POST", url: "/channel/config", headers: AUTH, payload: { appId: "x" } })
    expect(res.statusCode).toBe(400)
    const bad = await app.inject({
      method: "POST", url: "/channel/config", headers: AUTH,
      payload: { enabled: true, appId: "x", allowlist: [], appSecret: 3 },
    })
    expect(bad.statusCode).toBe(400)
    expect(view.save).not.toHaveBeenCalled()
  })

  it("POST /channel/config maps manager rejections to 400", async () => {
    view.save = vi.fn(async () => { throw new Error("推送接收人必须在白名单里") })
    const res = await app.inject({
      method: "POST", url: "/channel/config", headers: AUTH,
      payload: { enabled: true, appId: "x", allowlist: [], primaryOpenId: "ou_9" },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain("白名单")
  })

  it("POST /channel/test forwards the draft credentials", async () => {
    const res = await app.inject({
      method: "POST", url: "/channel/test", headers: AUTH,
      payload: { appId: "cli_a", appSecret: "draft" },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { ok: boolean }).ok).toBe(true)
    expect(view.testCredentials).toHaveBeenCalledWith("cli_a", "draft")
  })

  it("POST /channel/allowlist/:openId returns the refreshed snapshot", async () => {
    const res = await app.inject({ method: "POST", url: "/channel/allowlist/ou_9", headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(view.allowAdd).toHaveBeenCalledWith("ou_9")
    expect((res.json() as FeishuSnapshot).config.appSecretSet).toBe(true)
  })

  it("answers 503 without the manager assembly (the /mcp precedent)", async () => {
    const config = structuredClone(defaultConfig)
    const bare = await createApp({ home, token: "t1", stores: { config } })
    try {
      const get = await bare.inject({ method: "GET", url: "/channel", headers: AUTH })
      expect(get.statusCode).toBe(200)
      expect(get.json()).toEqual({
        config: { enabled: false, appId: "", appSecretSet: false, allowlist: [] },
        status: { state: "disabled" },
        pendingSenders: [],
      })
      const post = await bare.inject({
        method: "POST", url: "/channel/config", headers: AUTH,
        payload: { enabled: false, appId: "", allowlist: [] },
      })
      expect(post.statusCode).toBe(503)
    } finally {
      await bare.close()
    }
  })
})
