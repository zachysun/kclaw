/**
 * /sessions/:id/goal 路由族测试（issue #47）：路由层行为——未知会话 404、
 * 无 host 503、body 校验 400、动作与设定的透传（stub goal host 记录调用，
 * compact.test.ts 同款做法）。驱动器行为在 test/goal-loop.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"
import type { GoalLoopHost } from "../../src/goal-loop.js"

const AUTH = { authorization: "Bearer t1" }

interface HostCall {
  op: "view" | "set" | "pause" | "resume" | "userStop" | "clear"
  id?: string
  input?: { text: string; acceptance: string[] }
}

describe("/sessions/:id/goal routes", () => {
  let home: string
  let sessions: SessionStore
  let app: FastifyInstance
  let calls: HostCall[]
  let stubError: Error | null
  let sessionId: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-goal-routes-"))
    sessions = new SessionStore(join(home, "sessions"))
    sessionId = sessions.create("会话").id
    calls = []
    stubError = null
    // GoalView 形状：{goal: 快照, derived, armed, limits}；路由再包一层 {goal: view}。
    const view = {
      goal: { text: "目标", acceptance: [], state: "active", setAt: "2026-01-01T00:00:00.000Z", rounds: 0, totalRounds: 0, tokensUsed: 0 },
      derived: { rounds: 0, totalRounds: 0, tokensUsed: 0, noProgressStreak: 0, gateFailStreak: 0, parseFails: 0, transportFails: 0, approvalTimeoutStreak: 0, lastRun: undefined },
      armed: true,
      limits: { maxRounds: 10, tokenBudget: 2_000_000 },
    }
    const host = {
      view: (id: string) => {
        calls.push({ op: "view", id })
        return view
      },
      set: (id: string, input: { text: string; acceptance: string[] }) => {
        calls.push({ op: "set", id, input })
        if (stubError !== null) throw stubError
        return { ...view.goal, text: input.text, acceptance: input.acceptance }
      },
      pause: (id: string) => {
        calls.push({ op: "pause", id })
        if (stubError !== null) throw stubError
        return { ...view.goal, state: "paused" }
      },
      resume: (id: string) => {
        calls.push({ op: "resume", id })
        if (stubError !== null) throw stubError
        return { ...view.goal, state: "active" }
      },
      userStop: (id: string) => {
        calls.push({ op: "userStop", id })
        if (stubError !== null) throw stubError
        return { goal: { ...view.goal, state: "paused" }, aborted: false, dropped: 0 }
      },
      clear: (id: string) => {
        calls.push({ op: "clear", id })
        if (stubError !== null) throw stubError
        return { hadState: "active" }
      },
    } as unknown as GoalLoopHost
    app = await createApp({ home, token: "t1", stores: { sessions }, goal: host })
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })

  it("GET returns the host view; goal null when the host has none", async () => {
    const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}/goal`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().goal.goal.state).toBe("active")
    expect(calls).toEqual([{ op: "view", id: sessionId }])
  })

  it("unknown session answers 404 on every route in the family", async () => {
    for (const [method, url] of [
      ["GET", "/sessions/s_missing/goal"],
      ["POST", "/sessions/s_missing/goal"],
      ["POST", "/sessions/s_missing/goal/pause"],
      ["POST", "/sessions/s_missing/goal/resume"],
      ["POST", "/sessions/s_missing/goal/stop"],
      ["DELETE", "/sessions/s_missing/goal"],
    ] as const) {
      const res = await app.inject({ method, url, headers: AUTH, payload: method === "GET" || method === "DELETE" ? undefined : {} })
      expect(res.statusCode).toBe(404)
    }
  })

  it("no host → the whole family answers 503", async () => {
    const bare = await createApp({ home, token: "t1", stores: { sessions } })
    const res = await bare.inject({ method: "GET", url: `/sessions/${sessionId}/goal`, headers: AUTH })
    expect(res.statusCode).toBe(503)
    await bare.close()
  })

  it("POST validates the body (text non-empty string, acceptance string array)", async () => {
    const bad1 = await app.inject({ method: "POST", url: `/sessions/${sessionId}/goal`, headers: AUTH, payload: {} })
    expect(bad1.statusCode).toBe(400)
    const bad2 = await app.inject({ method: "POST", url: `/sessions/${sessionId}/goal`, headers: AUTH, payload: { text: "  " } })
    expect(bad2.statusCode).toBe(400)
    const bad3 = await app.inject({ method: "POST", url: `/sessions/${sessionId}/goal`, headers: AUTH, payload: { text: "目标", acceptance: "pnpm test" } })
    expect(bad3.statusCode).toBe(400)
  })

  it("POST passes text/acceptance through and returns goal + view", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/goal`,
      headers: AUTH,
      payload: { text: "测试全过", acceptance: ["pnpm test"] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().goal.acceptance).toEqual(["pnpm test"])
    // 路由在 set 之后还会取一次 view 组装 {goal, view} 响应。
    expect(calls).toEqual([
      { op: "set", id: sessionId, input: { text: "测试全过", acceptance: ["pnpm test"] } },
      { op: "view", id: sessionId },
    ])
  })

  it("host validation errors map to 400 with the message", async () => {
    stubError = new Error("验收命令需要可用的 exec 沙箱")
    const res = await app.inject({ method: "POST", url: `/sessions/${sessionId}/goal`, headers: AUTH, payload: { text: "目标", acceptance: ["pnpm test"] } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain("沙箱")
  })

  it("pause/resume/stop/clear each pass through", async () => {
    expect((await app.inject({ method: "POST", url: `/sessions/${sessionId}/goal/pause`, headers: AUTH })).statusCode).toBe(200)
    expect((await app.inject({ method: "POST", url: `/sessions/${sessionId}/goal/resume`, headers: AUTH })).statusCode).toBe(200)
    const stop = await app.inject({ method: "POST", url: `/sessions/${sessionId}/goal/stop`, headers: AUTH })
    expect(stop.statusCode).toBe(200)
    expect(stop.json()).toMatchObject({ aborted: false, dropped: 0 })
    const del = await app.inject({ method: "DELETE", url: `/sessions/${sessionId}/goal`, headers: AUTH })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ ok: true, hadState: "active" })
    expect(calls.map((c) => c.op)).toEqual(["pause", "resume", "userStop", "clear"])
  })
})
