import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../../src/app.js"
import { MemorySystem, SessionStore, defaultConfig } from "@kclaw/core"

let home: string
let system: MemorySystem
let app: Awaited<ReturnType<typeof createApp>>

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kclaw-memroute-"))
  const sessions = new SessionStore(join(home, "sessions"))
  system = new MemorySystem({
    memoryDir: join(home, "memory"), sessions, config: structuredClone(defaultConfig),
    resolveLlm: () => ({ llm: {} as never, model: "m" }),
  })
  system.writeCognition("persona", "persona", "画像")
  // 种子项目线文件：直接落盘（memory 目录结构，spec 2.1）
  mkdirSync(join(home, "memory", "projects", "kclaw-x"), { recursive: true })
  writeFileSync(join(home, "memory", "projects", "kclaw-x", "workdir.txt"), "/w/kclaw")
  writeFileSync(join(home, "memory", "projects", "kclaw-x", "ws.md"), "---\ntopic: ws\ntitle: T\nstatus: active\ncreated: 2026-08-28\nupdated: 2026-08-28\n---\n\n## 2026-08-28 · H\n\n正文\n")
  app = await createApp({ home, token: "t", stores: { sessions }, memory: system })
})
afterEach(async () => { await app.close(); rmSync(home, { recursive: true, force: true }) })

const auth = { authorization: "Bearer t" }

describe("POST /memory/trigger-manual", () => {
  it("triggers a manual write for the given workdir", async () => {
    // /w/none 无会话消息 → 手动提取安全空转（不调 LLM），端点应 200。
    const res = await app.inject({
      method: "POST", url: "/memory/trigger-manual", headers: { ...auth, "content-type": "application/json" },
      payload: { workdir: "/w/none" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
  it("defaults workdir to config.workspace when omitted", async () => {
    const res = await app.inject({ method: "POST", url: "/memory/trigger-manual", headers: auth })
    expect(res.statusCode).toBe(200)
  })
  it("threads the given sessionId through to triggerManual (Task 7)", async () => {
    const spy = vi.spyOn(system, "triggerManual").mockResolvedValue(undefined)
    try {
      const res = await app.inject({
        method: "POST", url: "/memory/trigger-manual", headers: { ...auth, "content-type": "application/json" },
        payload: { workdir: "/w/none", sessionId: "ses_abc" },
      })
      expect(res.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith("/w/none", "ses_abc")
    } finally { spy.mockRestore() }
  })
  it("treats an empty sessionId as absent (falls back to undefined, Task 7 validation)", async () => {
    const spy = vi.spyOn(system, "triggerManual").mockResolvedValue(undefined)
    try {
      await app.inject({
        method: "POST", url: "/memory/trigger-manual", headers: { ...auth, "content-type": "application/json" },
        payload: { workdir: "/w/none", sessionId: "" },
      })
      expect(spy).toHaveBeenCalledWith("/w/none", undefined)
    } finally { spy.mockRestore() }
  })
  it("treats a whitespace-only sessionId as absent (trim, falls back to undefined)", async () => {
    const spy = vi.spyOn(system, "triggerManual").mockResolvedValue(undefined)
    try {
      await app.inject({
        method: "POST", url: "/memory/trigger-manual", headers: { ...auth, "content-type": "application/json" },
        payload: { workdir: "/w/none", sessionId: "   " },
      })
      expect(spy).toHaveBeenCalledWith("/w/none", undefined)
    } finally { spy.mockRestore() }
  })
  it("rejects with a clear error when memory.write.manual is disabled", async () => {
    const cfg = structuredClone(defaultConfig)
    cfg.memory.write.manual = false
    const app2 = await createApp({
      home, token: "t", stores: { sessions: new SessionStore(join(home, "sessions-off")), config: cfg },
      memory: system,
    })
    try {
      const res = await app2.inject({ method: "POST", url: "/memory/trigger-manual", headers: auth, payload: { workdir: "/w/none" } })
      expect(res.statusCode).toBe(400)
      expect(String(res.json().error)).toContain("manual")
    } finally { await app2.close() }
  })
  it("surfaces a failing trigger as 500", async () => {
    const boom = { triggerManual: async () => { throw new Error("extract failed") } } as unknown as MemorySystem
    const app2 = await createApp({
      home, token: "t", stores: { sessions: new SessionStore(join(home, "sessions-boom")) },
      memory: boom, config: structuredClone(defaultConfig),
    })
    try {
      const res = await app2.inject({ method: "POST", url: "/memory/trigger-manual", headers: auth, payload: { workdir: "/w" } })
      expect(res.statusCode).toBe(500)
    } finally { await app2.close() }
  })
})


describe("GET /memory/projects", () => {
  it("lists projects with thread counts", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/projects", headers: auth })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.some((p: { id: string }) => p.id === "kclaw-x")).toBe(true)
  })
  it("401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/projects" })
    expect(res.statusCode).toBe(401)
  })
})

describe("GET /memory/projects/:id", () => {
  it("returns threads for a known project", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/projects/kclaw-x", headers: auth })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe("kclaw-x")
    expect(Array.isArray(body.threads)).toBe(true)
    expect(body.threads.some((t: { topic: string }) => t.topic === "ws")).toBe(true)
  })
  it("404 for an unknown project", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/projects/nope", headers: auth })
    expect(res.statusCode).toBe(404)
  })
})

describe("thread routes", () => {
  it("GET/PATCH/DELETE the thread lifecycle", async () => {
    const get = await app.inject({ method: "GET", url: "/memory/threads/kclaw-x/ws", headers: auth })
    expect(get.statusCode).toBe(200)
    expect(get.body).toContain("topic: ws")
    const patched = await app.inject({ method: "PATCH", url: "/memory/threads/kclaw-x/ws", headers: { ...auth, "content-type": "application/json" }, payload: { content: "---\ntopic: ws\ntitle: T2\nstatus: active\ncreated: 2026-08-28\nupdated: 2026-08-29\n---\n\n## 2026-08-28 · H\n\n改过\n" } })
    expect(patched.statusCode).toBe(200)
    expect((await app.inject({ method: "GET", url: "/memory/threads/kclaw-x/ws", headers: auth })).body).toContain("改过")
    const gone = await app.inject({ method: "DELETE", url: "/memory/threads/kclaw-x/ws", headers: auth })
    expect(gone.statusCode).toBe(200)
    expect((await app.inject({ method: "GET", url: "/memory/threads/kclaw-x/ws", headers: auth })).statusCode).toBe(404)
  })
  it("404 for unknown project/thread", async () => {
    expect((await app.inject({ method: "GET", url: "/memory/threads/nope/ws", headers: auth })).statusCode).toBe(404)
  })
})

describe("global routes", () => {
  it("lists and reads cognition files; PATCH overwrites; persona DELETE is 400", async () => {
    const list = await app.inject({ method: "GET", url: "/memory/global", headers: auth })
    expect(list.json()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "persona", name: "persona" })]))
    const read = await app.inject({ method: "GET", url: "/memory/global/persona/persona", headers: auth })
    expect(read.body).toContain("画像")
    const patched = await app.inject({ method: "PATCH", url: "/memory/global/persona/persona", headers: { ...auth, "content-type": "application/json" }, payload: { content: "---\ntitle: persona\nscope: global\n---\n\n新画像\n" } })
    expect(patched.statusCode).toBe(200)
    expect((await app.inject({ method: "DELETE", url: "/memory/global/persona/persona", headers: auth })).statusCode).toBe(400)
    expect((await app.inject({ method: "DELETE", url: "/memory/global/wiki/none", headers: auth })).statusCode).toBe(404)
  })
})

describe("segment validation (path traversal defense)", () => {
  // 裸 ".." 段会被 Fastify 路由层在到达 handler 前规范化并拒绝（404）；这是路由层第一道闸。
  // 真正能穿透到 handler 的是编码后的穿越段（如 %2e%2e%2f 解码成 "../"），
  // isSafeSegment 负责兜住这第二道闸 → 400。
  it("GET /memory/projects/../x → blocked by router (404, no escape)", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/projects/../x", headers: auth })
    expect(res.statusCode).toBe(404)
  })
  it("GET /memory/threads/kclaw-x/../x → blocked by router (404, no escape)", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/threads/kclaw-x/../x", headers: auth })
    expect(res.statusCode).toBe(404)
  })
  it("GET /memory/threads/kclaw-x/..%2Fx (encoded ../) → 400 invalid segment", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/threads/kclaw-x/..%2Fx", headers: auth })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid segment" })
  })
  it("PATCH traversal into parent dirs is rejected; no file escapes the memory dir", async () => {
    // topic 解码为 "../../evil"：修复前会 join 到 memory 目录之外写 evil.md；修复后 400。
    const res = await app.inject({ method: "PATCH", url: "/memory/threads/kclaw-x/..%2F..%2Fevil", headers: { ...auth, "content-type": "application/json" }, payload: { content: "---\ntopic: evil\n---\n\nescaped\n" } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: "invalid segment" })
    expect(existsSync(join(home, "evil.md"))).toBe(false)        // 未逃逸到 home
    expect(existsSync(join(home, "memory", "evil.md"))).toBe(false) // 未逃逸到 memory 根
  })
})

describe("PATCH validation and unknown kind", () => {
  it("PATCH thread with missing content → 400", async () => {
    const res = await app.inject({ method: "PATCH", url: "/memory/threads/kclaw-x/ws", headers: { ...auth, "content-type": "application/json" }, payload: {} })
    expect(res.statusCode).toBe(400)
  })
  it("PATCH thread with empty content → 400", async () => {
    const res = await app.inject({ method: "PATCH", url: "/memory/threads/kclaw-x/ws", headers: { ...auth, "content-type": "application/json" }, payload: { content: "" } })
    expect(res.statusCode).toBe(400)
  })
  it("PATCH global with empty content → 400", async () => {
    const res = await app.inject({ method: "PATCH", url: "/memory/global/wiki/foo", headers: { ...auth, "content-type": "application/json" }, payload: { content: "" } })
    expect(res.statusCode).toBe(400)
  })
  it("GET global with unknown kind → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/memory/global/bogus/persona", headers: auth })
    expect(res.statusCode).toBe(404)
  })
})

describe("503 fallback (no memory)", () => {
  let noMemoryHome: string
  let noMemoryApp: Awaited<ReturnType<typeof createApp>>
  beforeEach(async () => {
    noMemoryHome = mkdtempSync(join(tmpdir(), "kclaw-memroute-none-"))
    const sessions = new SessionStore(join(noMemoryHome, "sessions"))
    noMemoryApp = await createApp({ home: noMemoryHome, token: "t", stores: { sessions } })
  })
  afterEach(async () => { await noMemoryApp.close(); rmSync(noMemoryHome, { recursive: true, force: true }) })
  it("GET /memory/projects → 503 with the unavailable payload", async () => {
    const res = await noMemoryApp.inject({ method: "GET", url: "/memory/projects", headers: auth })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: "memory system unavailable" })
  })
  it("GET /memory/global → 503 too", async () => {
    const res = await noMemoryApp.inject({ method: "GET", url: "/memory/global", headers: auth })
    expect(res.statusCode).toBe(503)
  })
})
