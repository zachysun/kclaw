import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
