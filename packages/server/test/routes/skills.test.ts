import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../../src/app.js"
import { SessionStore } from "@kclaw/core"

let home: string
let workdir: string
let app: Awaited<ReturnType<typeof createApp>>

const writeSkill = (root: string, name: string, md: string): void => {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, "SKILL.md"), md)
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kclaw-skillroute-"))
  workdir = mkdtempSync(join(tmpdir(), "kclaw-skillroute-ws-"))
  const sessions = new SessionStore(join(home, "sessions"))
  app = await createApp({ home, token: "t", stores: { sessions } })
})
afterEach(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); rmSync(workdir, { recursive: true, force: true }) })

const auth = { authorization: "Bearer t" }

describe("GET /skills", () => {
  it("lists user-visible skills with visibility marks; user-invocable:false stays hidden", async () => {
    writeSkill(join(home, "skills"), "commit-helper", "---\ndescription: 提交规范。\n---\n\n正文\n")
    writeSkill(join(home, "skills"), "heavy-flow", "---\ndescription: 重流程。\ndisable-model-invocation: true\n---\n\n正文\n")
    writeSkill(join(home, "skills"), "background", "---\ndescription: 模型背景知识。\nuser-invocable: false\n---\n\n正文\n")
    const res = await app.inject({ method: "GET", url: "/skills", headers: auth })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ name: string; visibility: string; origin: string }>
    expect(rows.map((r) => r.name)).toEqual(["commit-helper", "heavy-flow"])
    expect(rows.find((r) => r.name === "commit-helper")).toMatchObject({ visibility: "all", origin: "global" })
    expect(rows.find((r) => r.name === "heavy-flow")).toMatchObject({ visibility: "user-only" })
  })
  it("merges project skills from the workdir query, project winning by name", async () => {
    writeSkill(join(home, "skills"), "deploy", "---\ndescription: 全局部署。\n---\n\n全局正文\n")
    writeSkill(join(workdir, ".kclaw", "skills"), "deploy", "---\ndescription: 项目部署。\n---\n\n项目正文\n")
    const res = await app.inject({ method: "GET", url: `/skills?workdir=${encodeURIComponent(workdir)}`, headers: auth })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ name: string; origin: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: "deploy", origin: "project" })
  })
  it("returns [] when no skill directory exists", async () => {
    const res = await app.inject({ method: "GET", url: "/skills", headers: auth })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

describe("GET /skills/:name", () => {
  it("returns the body content of a user-visible skill", async () => {
    writeSkill(join(home, "skills"), "commit-helper", "---\ndescription: 提交规范。\n---\n\n# 提交规程\n\n一行标题。\n")
    const res = await app.inject({ method: "GET", url: "/skills/commit-helper", headers: auth })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: "commit-helper", content: expect.stringContaining("# 提交规程") })
  })
  it("404s an unknown skill", async () => {
    const res = await app.inject({ method: "GET", url: "/skills/nope", headers: auth })
    expect(res.statusCode).toBe(404)
  })
  it("404s a user-invocable:false skill — user-facing surfaces pretend it is not there", async () => {
    writeSkill(join(home, "skills"), "background", "---\ndescription: 背景。\nuser-invocable: false\n---\n\n正文\n")
    const res = await app.inject({ method: "GET", url: "/skills/background", headers: auth })
    expect(res.statusCode).toBe(404)
  })
  it("project copy wins through the workdir query", async () => {
    writeSkill(join(home, "skills"), "deploy", "---\ndescription: 部署。\n---\n\n全局正文\n")
    writeSkill(join(workdir, ".kclaw", "skills"), "deploy", "---\ndescription: 部署。\n---\n\n项目正文\n")
    const res = await app.inject({ method: "GET", url: `/skills/deploy?workdir=${encodeURIComponent(workdir)}`, headers: auth })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ content: expect.stringContaining("项目正文") })
  })
  it("rejects traversal-looking names", async () => {
    const res = await app.inject({ method: "GET", url: "/skills/..%2Fetc", headers: auth })
    expect([400, 404]).toContain(res.statusCode)
  })
})
