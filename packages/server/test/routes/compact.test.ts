/**
 * POST /sessions/:id/compact — the manual compaction endpoint.
 *
 * Route-level behavior only: the missing-session 404, the focus body
 * validation (400), the no-run-manager 503, the busy-refusal → 409 mapping
 * and the focus passthrough to RunManager.compactSession — verified against
 * a stub run manager injected through AppOptions.run (the ws.test.ts stub
 * idiom, constructed like test/routes/config.test.ts). The compaction
 * itself is proven at the RunManager level in test/run.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"
import type { RunManager } from "../../src/run.js"

const AUTH = { authorization: "Bearer t1" }

describe("POST /sessions/:id/compact", () => {
  let home: string
  let sessions: SessionStore
  let app: FastifyInstance
  let compactCalls: Array<{ id: string; focus?: string }>
  let compactResult: { message: string } | Error

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-compact-test-"))
    sessions = new SessionStore(join(home, "sessions"))
    compactCalls = []
    compactResult = { message: "压缩了 1 段，剩 3 条原文消息" }
    // Stub run manager: the route only needs compactSession; the stub records
    // its call args for the passthrough assertions below.
    app = await createApp({
      home,
      token: "t1",
      stores: { sessions },
      run: {
        compactSession: async (id: string, focus?: string) => {
          compactCalls.push({ id, focus })
          if (compactResult instanceof Error) throw compactResult
          return compactResult
        },
      } as unknown as RunManager,
    })
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })

  it("404s with the session-not-found error for a missing session", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions/ses_missing/compact", headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "session not found" })
    expect(compactCalls).toEqual([])
  })

  it("400s on a non-string focus", async () => {
    const s = sessions.create("数字focus")
    const res = await app.inject({
      method: "POST", url: `/sessions/${s.id}/compact`, headers: AUTH, payload: { focus: 5 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "focus must be a non-empty string" })
    expect(compactCalls).toEqual([])
  })

  it("400s on a present-but-empty focus string", async () => {
    const s = sessions.create("空focus")
    const res = await app.inject({
      method: "POST", url: `/sessions/${s.id}/compact`, headers: AUTH, payload: { focus: "   " },
    })
    expect(res.statusCode).toBe(400)
    expect(compactCalls).toEqual([])
  })

  it("200s when idle: the stub result passes through, focus absent → undefined", async () => {
    const s = sessions.create("闲会话")
    const res = await app.inject({ method: "POST", url: `/sessions/${s.id}/compact`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: "压缩了 1 段，剩 3 条原文消息" })
    expect(compactCalls).toEqual([{ id: s.id, focus: undefined }])
  })

  it("passes a string focus through to compactSession", async () => {
    const s = sessions.create("focus会话")
    const res = await app.inject({
      method: "POST", url: `/sessions/${s.id}/compact`, headers: AUTH,
      payload: { focus: "重点保留登录模块" },
    })
    expect(res.statusCode).toBe(200)
    expect(compactCalls).toEqual([{ id: s.id, focus: "重点保留登录模块" }])
  })

  it("maps the busy refusal to 409", async () => {
    const s = sessions.create("忙会话")
    compactResult = new Error("会话正在运行，等它结束")
    const res = await app.inject({ method: "POST", url: `/sessions/${s.id}/compact`, headers: AUTH })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: "会话正在运行，等它结束" })
  })

  it("maps both refusal messages to 409", async () => {
    // fake compactSession 依次 reject 两种拒绝文案，断言均映射 409 且原文案透传
    const s = sessions.create("双拒会话")
    for (const message of ["会话正在运行，等它结束", "还有 2 条排队消息，先处理或取消"]) {
      compactResult = new Error(message)
      const res = await app.inject({ method: "POST", url: `/sessions/${s.id}/compact`, headers: AUTH })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: message })
    }
  })

  it("503s when no run manager is wired", async () => {
    await app.close()
    const bare = await createApp({ home, token: "t1", stores: { sessions } })
    try {
      const s = sessions.create("无run会话")
      const res = await bare.inject({ method: "POST", url: `/sessions/${s.id}/compact`, headers: AUTH })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ error: "run manager unavailable" })
    } finally {
      await bare.close()
    }
  })

  it("GET /sessions/:id/compactions returns 404 / [] / records", async () => {
    expect((await app.inject({ method: "GET", url: "/sessions/ses_missing/compactions", headers: AUTH })).statusCode).toBe(404)
    const s = sessions.create("c")
    const empty = await app.inject({ method: "GET", url: `/sessions/${s.id}/compactions`, headers: AUTH })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual([])
    // records: oldest append first (file order)
    sessions.appendCompaction(s.id, {
      at: "2026-08-27T00:00:00.000Z", trigger: "auto", from: "m1", upto: "m3",
      messages: 3, segmentSummary: "段摘要", top: "总摘要",
    })
    sessions.appendCompaction(s.id, {
      at: "2026-08-27T00:00:01.000Z", trigger: "manual", focus: "登录模块", from: "m1", upto: "m3",
      messages: 3, segmentSummary: "段摘要", top: "总摘要",
    })
    const filled = await app.inject({ method: "GET", url: `/sessions/${s.id}/compactions`, headers: AUTH })
    expect(filled.statusCode).toBe(200)
    expect((filled.json() as Array<{ trigger: string }>).map((r) => r.trigger)).toEqual(["auto", "manual"])
  })
})
