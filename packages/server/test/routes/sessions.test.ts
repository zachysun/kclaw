import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore, newMessage, defaultConfig } from "@kclaw/core"
import type { SessionMeta, KclawConfig } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

describe("sessions routes", () => {
  let home: string
  let store: SessionStore
  let config: KclawConfig
  let app: FastifyInstance

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-sessions-test-"))
    store = new SessionStore(join(home, "sessions"))
    config = structuredClone(defaultConfig)
    config.workspace = "/ws/root"
    app = await createApp({ home, token: "t1", stores: { sessions: store, config } })
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })

  it("POST /sessions without a body returns 201 with the SessionMeta shape", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions", headers: AUTH })
    expect(res.statusCode).toBe(201)
    const meta = res.json() as SessionMeta
    expect(meta.id).toMatch(/^ses_/)
    expect(typeof meta.title).toBe("string")
    expect(meta.title.length).toBeGreaterThan(0)
    expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof meta.updatedAt).toBe("string")
  })

  it("POST /sessions with a title returns 201 with that title", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: AUTH,
      payload: { title: "debugging kclaw" },
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as SessionMeta).title).toBe("debugging kclaw")
  })

  it("POST /sessions 带 workdir 写回 meta", async () => {
    const res = await app.inject({
      method: "POST", url: "/sessions", headers: AUTH, payload: { workdir: "/tmp/x" },
    })
    expect(res.statusCode).toBe(201)
    expect((res.json() as SessionMeta).workdir).toBe("/tmp/x")
  })

  it("POST /sessions without workdir stores the configured workspace", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions", headers: AUTH })
    expect(res.statusCode).toBe(201)
    expect((res.json() as SessionMeta).workdir).toBe("/ws/root")
  })

  it("POST /sessions with an empty workdir string returns 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/sessions", headers: AUTH, payload: { workdir: "" },
    })
    expect(res.statusCode).toBe(400)
    expect(typeof (res.json() as { error: string }).error).toBe("string")
  })

  it("GET /sessions lists created sessions", async () => {
    const a = (await app.inject({ method: "POST", url: "/sessions", headers: AUTH })).json() as SessionMeta
    const b = (await app.inject({
      method: "POST", url: "/sessions", headers: AUTH, payload: { title: "second" },
    })).json() as SessionMeta
    const res = await app.inject({ method: "GET", url: "/sessions", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const metas = res.json() as SessionMeta[]
    expect(metas.map((m) => m.id).sort()).toEqual([a.id, b.id].sort())
  })

  it("GET /sessions/:id/messages returns messages appended via the injected store", async () => {
    const created = (await app.inject({ method: "POST", url: "/sessions", headers: AUTH })).json() as SessionMeta
    const m1 = newMessage(created.id, "user", [{ id: "blk_1", type: "text", text: "hello" }])
    const m2 = newMessage(created.id, "assistant", [{ id: "blk_2", type: "text", text: "hi there" }])
    store.appendMessage(created.id, m1)
    store.appendMessage(created.id, m2)

    const res = await app.inject({ method: "GET", url: `/sessions/${created.id}/messages`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const messages = res.json() as Array<{ id: string }>
    expect(messages.map((m) => m.id)).toEqual([m1.id, m2.id])
  })

  it("GET /sessions/:id/messages returns [] for an existing session with no messages", async () => {
    const created = (await app.inject({ method: "POST", url: "/sessions", headers: AUTH })).json() as SessionMeta
    const res = await app.inject({ method: "GET", url: `/sessions/${created.id}/messages`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it("PATCH /sessions/:id renames the session and returns the updated meta", async () => {
    const created = (await app.inject({ method: "POST", url: "/sessions", headers: AUTH })).json() as SessionMeta
    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/${created.id}`,
      headers: AUTH,
      payload: { title: "renamed" },
    })
    expect(res.statusCode).toBe(200)
    const meta = res.json() as SessionMeta
    expect(meta.id).toBe(created.id)
    expect(meta.title).toBe("renamed")

    const list = (await app.inject({ method: "GET", url: "/sessions", headers: AUTH })).json() as SessionMeta[]
    expect(list.find((m) => m.id === created.id)?.title).toBe("renamed")
  })

  it("GET /sessions/:id/messages for an unknown id returns 404", async () => {
    const res = await app.inject({ method: "GET", url: "/sessions/ses_doesnotexist/messages", headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "session not found" })
  })

  it("GET /sessions/:id/events 返回全部事件（created + message + compaction）", async () => {
    const created = (await app.inject({ method: "POST", url: "/sessions", headers: AUTH })).json() as SessionMeta
    store.appendMessage(created.id, newMessage(created.id, "user", [{ id: "blk_1", type: "text", text: "hello" }]))
    store.appendCompaction(created.id, {
      at: "2026-08-30T00:00:00Z",
      trigger: "manual",
      from: null,
      upto: created.id,
      messages: 1,
      segmentSummary: "summary",
      top: "top",
    })

    const res = await app.inject({ method: "GET", url: `/sessions/${created.id}/events`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const events = res.json() as Array<{ type: string }>
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.map((e) => e.type)).toEqual(["session.created", "message", "compaction"])
  })

  it("GET /sessions/:id/events 会话不存在返回 404", async () => {
    const res = await app.inject({ method: "GET", url: "/sessions/ses_nope/events", headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "session not found" })
  })

  it("PATCH /sessions/:id for an unknown id returns 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/sessions/ses_doesnotexist",
      headers: AUTH,
      payload: { title: "x" },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "session not found" })
  })

  it("GET /sessions without an auth header returns 401 (auth covers the new routes)", async () => {
    const res = await app.inject({ method: "GET", url: "/sessions" })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: "unauthorized" })
  })

  it("POST /sessions with malformed JSON returns 400 {error}", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{not json",
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string }
    expect(typeof body.error).toBe("string")
    expect(body.error.length).toBeGreaterThan(0)
  })

  it("POST /sessions with an empty title string returns 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/sessions", headers: AUTH, payload: { title: "" },
    })
    expect(res.statusCode).toBe(400)
    expect(typeof (res.json() as { error: string }).error).toBe("string")
  })

  it("PATCH /sessions/:id with an empty title string returns 400", async () => {
    const created = (await app.inject({ method: "POST", url: "/sessions", headers: AUTH })).json() as SessionMeta
    const res = await app.inject({
      method: "PATCH", url: `/sessions/${created.id}`, headers: AUTH, payload: { title: "" },
    })
    expect(res.statusCode).toBe(400)
    expect(typeof (res.json() as { error: string }).error).toBe("string")
  })

  it("POST /sessions with a non-string title returns 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/sessions", headers: AUTH, payload: { title: 42 },
    })
    expect(res.statusCode).toBe(400)
    expect(typeof (res.json() as { error: string }).error).toBe("string")
  })

  it("an explicitly injected store is the one serving the routes (pre-seeded session is listed)", async () => {
    const seeded = store.create("pre-seeded")
    const res = await app.inject({ method: "GET", url: "/sessions", headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect((res.json() as SessionMeta[]).some((m) => m.id === seeded.id && m.title === "pre-seeded")).toBe(true)
  })

  it("without the stores option, a SessionStore is created under <home>/sessions", async () => {
    const appNoStores = await createApp({ home, token: "t1" })
    try {
      const res = await appNoStores.inject({ method: "POST", url: "/sessions", headers: AUTH })
      expect(res.statusCode).toBe(201)
      const meta = res.json() as SessionMeta
      const entries = await readdir(join(home, "sessions"))
      expect(entries).toContain(meta.id)
    } finally {
      await appNoStores.close()
    }
  })

  it("DELETE /sessions/:id soft-deletes; hidden from default list, visible in deleted list", async () => {
    const created = (await app.inject({
      method: "POST", url: "/sessions", headers: AUTH, payload: { title: "t" },
    })).json() as SessionMeta
    const del = await app.inject({ method: "DELETE", url: `/sessions/${created.id}`, headers: AUTH })
    expect(del.statusCode).toBe(200)
    expect((del.json() as SessionMeta).deleted).toBe(true)

    const list = (await app.inject({ method: "GET", url: "/sessions", headers: AUTH })).json() as SessionMeta[]
    expect(list.some((s) => s.id === created.id)).toBe(false)

    const deleted = (await app.inject({
      method: "GET", url: "/sessions?deleted=true", headers: AUTH,
    })).json() as SessionMeta[]
    expect(deleted.some((s) => s.id === created.id)).toBe(true)
  })

  it("POST /sessions/:id/restore restores a soft-deleted session", async () => {
    const created = (await app.inject({
      method: "POST", url: "/sessions", headers: AUTH, payload: {},
    })).json() as SessionMeta
    await app.inject({ method: "DELETE", url: `/sessions/${created.id}`, headers: AUTH })
    const restore = await app.inject({ method: "POST", url: `/sessions/${created.id}/restore`, headers: AUTH })
    expect(restore.statusCode).toBe(200)

    const list = (await app.inject({ method: "GET", url: "/sessions", headers: AUTH })).json() as SessionMeta[]
    expect(list.some((s) => s.id === created.id)).toBe(true)
  })

  it("POST /sessions/:id/purge permanently deletes a session", async () => {
    const created = (await app.inject({
      method: "POST", url: "/sessions", headers: AUTH, payload: { title: "to purge" },
    })).json() as SessionMeta
    const purge = await app.inject({ method: "POST", url: `/sessions/${created.id}/purge`, headers: AUTH })
    expect(purge.statusCode).toBe(200)
    expect(purge.json()).toEqual({ ok: true })
    expect(store.meta(created.id)).toBeUndefined()
  })

  it("DELETE /sessions/:id for an unknown id returns 404", async () => {
    const res = await app.inject({ method: "DELETE", url: "/sessions/ses_doesnotexist", headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "session not found" })
  })

  it("POST /sessions/:id/restore for an unknown id returns 404", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions/ses_doesnotexist/restore", headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "session not found" })
  })

  it("POST /sessions/:id/purge for an unknown id returns 404", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions/ses_doesnotexist/purge", headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "session not found" })
  })

  it("GET /sessions/:id/queue returns persisted entries; empty array for none; 404 unknown", async () => {
    const created = (await app.inject({ method: "POST", url: "/sessions", headers: AUTH })).json() as SessionMeta
    store.replaceQueue(created.id, [
      { messageId: "msg_1", disposition: "wait", text: "q", trigger: "user", enqueuedAt: "2026-08-29T00:00:00Z" },
    ])
    const res = await app.inject({ method: "GET", url: `/sessions/${created.id}/queue`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { messageId: "msg_1", disposition: "wait", text: "q", trigger: "user", enqueuedAt: "2026-08-29T00:00:00Z" },
    ])

    // 无排队条目的会话：空数组（不是 undefined/null）
    const other = (await app.inject({ method: "POST", url: "/sessions", headers: AUTH })).json() as SessionMeta
    const none = await app.inject({ method: "GET", url: `/sessions/${other.id}/queue`, headers: AUTH })
    expect(none.statusCode).toBe(200)
    expect(none.json()).toEqual([])

    const missing = await app.inject({ method: "GET", url: "/sessions/ses_nope/queue", headers: AUTH })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: "session not found" })
  })

  it("POST /sessions/:id/disposition writes the override; invalid value is 400", async () => {
    const created = (await app.inject({ method: "POST", url: "/sessions", headers: AUTH })).json() as SessionMeta
    const ok = await app.inject({
      method: "POST",
      url: `/sessions/${created.id}/disposition`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { disposition: "wait" },
    })
    expect(ok.statusCode).toBe(200)
    expect(store.meta(created.id)?.dispositionOverride).toBe("wait")

    const bad = await app.inject({
      method: "POST",
      url: `/sessions/${created.id}/disposition`,
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { disposition: "nope" },
    })
    expect(bad.statusCode).toBe(400)

    const missing = await app.inject({
      method: "POST",
      url: "/sessions/ses_nope/disposition",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { disposition: "wait" },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: "session not found" })
  })
})

describe("POST /sessions 切会话记忆写入（/clear、/new、新建会话共用）", () => {
  let home: string
  let store: SessionStore

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-clearmem-"))
    store = new SessionStore(join(home, "sessions"))
  })

  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  const waitClear = async (calls: unknown[]): Promise<void> => {
    for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  }

  it("triggers a clear write for the OLD session of the same project", async () => {
    // 旧会话先建（用户刚聊完的那个）；新会话创建后异步触发 clear，归属指向旧会话
    const oldSession = store.create("旧会话", undefined, "/tmp/x")
    const calls: Array<{ workdir: string; sessionId?: string }> = []
    const memory = {
      recentSessionId: () => oldSession.id, // 创建前该项目最近活动者 = 旧会话
      triggerClear: async (workdir: string, sessionId?: string) => { calls.push({ workdir, sessionId }) },
    } as unknown as import("@kclaw/core").MemorySystem
    const app = await createApp({ home, token: "t1", stores: { sessions: store }, memory })
    try {
      const res = await app.inject({ method: "POST", url: "/sessions", headers: AUTH, payload: { workdir: "/tmp/x" } })
      expect(res.statusCode).toBe(201)
      await waitClear(calls)
      expect(calls).toEqual([{ workdir: "/tmp/x", sessionId: oldSession.id }])
    } finally { await app.close() }
  })

  it("a failing clear write does not break the 201 response", async () => {
    const memory = {
      recentSessionId: () => undefined,
      triggerClear: async () => { throw new Error("extract boom") },
    } as unknown as import("@kclaw/core").MemorySystem
    const app = await createApp({ home, token: "t1", stores: { sessions: store }, memory })
    try {
      const res = await app.inject({ method: "POST", url: "/sessions", headers: AUTH, payload: { workdir: "/tmp/x" } })
      expect(res.statusCode).toBe(201)
    } finally { await app.close() }
  })
})
