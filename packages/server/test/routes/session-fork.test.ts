import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HistorySearchIndex, SessionStore, newMessage } from "@kclaw/core"
import type { SessionMeta } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import { createSessionForkHost } from "../../src/session-fork.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

function seedSession(store: SessionStore, title = "原会话"): { id: string; u1: string } {
  const m = store.create(title, undefined, "/ws/root", "default")
  const u1 = newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "第一问" }])
  store.appendRunStarted(m.id, { at: new Date().toISOString(), trigger: "user" })
  store.appendMessage(m.id, u1)
  store.appendRunEnded(m.id, { at: new Date().toISOString(), stopReason: "end_turn" })
  return { id: m.id, u1: u1.id }
}

describe("POST /sessions/:id/fork", () => {
  let home: string
  let store: SessionStore
  let app: FastifyInstance

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-fork-route-"))
    store = new SessionStore(join(home, "sessions"))
  })

  afterEach(async () => {
    await app?.close()
    await rm(home, { recursive: true, force: true })
  })

  async function buildWithHost(host: ReturnType<typeof createSessionForkHost> | undefined): Promise<FastifyInstance> {
    return createApp({ home, token: "t1", stores: { sessions: store }, ...(host !== undefined ? { sessionFork: host } : {}) })
  }

  it("无宿主（裸 app）→ 503", async () => {
    app = await buildWithHost(undefined)
    const src = seedSession(store)
    const res = await app.inject({ method: "POST", url: `/sessions/${src.id}/fork`, headers: AUTH })
    expect(res.statusCode).toBe(503)
  })

  it("空闲 + 宿主 → 201，返回的 meta 带血缘与标题", async () => {
    app = await buildWithHost(createSessionForkHost({ sessions: store, run: { isIdle: () => true }, workspaceFallback: "/ws/root" }))
    const src = seedSession(store)
    const res = await app.inject({ method: "POST", url: `/sessions/${src.id}/fork`, headers: AUTH, payload: { messageId: src.u1 } })
    expect(res.statusCode).toBe(201)
    const meta = res.json() as SessionMeta
    expect(meta.forkedFrom).toEqual({ sessionId: src.id, messageId: src.u1 })
    expect(meta.title).toBe("原会话 · fork")
  })

  it("非 Idle → 409", async () => {
    app = await buildWithHost(createSessionForkHost({ sessions: store, run: { isIdle: () => false }, workspaceFallback: "/ws/root" }))
    const src = seedSession(store)
    const res = await app.inject({ method: "POST", url: `/sessions/${src.id}/fork`, headers: AUTH })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toContain("运行结束后可 fork")
  })

  it("会话不存在 → 404；messageId 形状非法 → 400", async () => {
    app = await buildWithHost(createSessionForkHost({ sessions: store, run: { isIdle: () => true }, workspaceFallback: "/ws/root" }))
    const missing = await app.inject({ method: "POST", url: "/sessions/ses_nope/fork", headers: AUTH })
    expect(missing.statusCode).toBe(404)
    const src = seedSession(store)
    const bad = await app.inject({ method: "POST", url: `/sessions/${src.id}/fork`, headers: AUTH, payload: { messageId: "" } })
    expect(bad.statusCode).toBe(400)
    const badType = await app.inject({ method: "POST", url: `/sessions/${src.id}/fork`, headers: AUTH, payload: { messageId: 42 } })
    expect(badType.statusCode).toBe(400)
  })

  it("core 内部错误 → 500 通用文案（不透传 Error.message）", async () => {
    const src = seedSession(store)
    const explosive: SessionStore = Object.create(store)
    explosive.readEvents = () => {
      throw new Error("EACCES: permission denied, open /Users/someone/.kclaw/sessions/x/events.jsonl")
    }
    app = await buildWithHost(createSessionForkHost({ sessions: explosive, run: { isIdle: () => true }, workspaceFallback: "/ws/root" }))
    const res = await app.inject({ method: "POST", url: `/sessions/${src.id}/fork`, headers: AUTH, payload: {} })
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain("/Users/someone")
    expect(JSON.parse(res.body).error).toBe("fork 失败：内部错误")
  })

  it("messageId 在流中不存在 → 400", async () => {
    app = await buildWithHost(createSessionForkHost({ sessions: store, run: { isIdle: () => true }, workspaceFallback: "/ws/root" }))
    const src = seedSession(store)
    const res = await app.inject({ method: "POST", url: `/sessions/${src.id}/fork`, headers: AUTH, payload: { messageId: "msg_nope" } })
    expect(res.statusCode).toBe(400)
  })

  it("subagent 会话 → 400", async () => {
    app = await buildWithHost(createSessionForkHost({ sessions: store, run: { isIdle: () => true }, workspaceFallback: "/ws/root" }))
    const src = seedSession(store)
    const child = store.create("子会话", undefined, "/ws/root", "default", src.id)
    const res = await app.inject({ method: "POST", url: `/sessions/${child.id}/fork`, headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain("subagent")
  })
})
