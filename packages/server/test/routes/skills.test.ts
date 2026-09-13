import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
  app = await createApp({ home, token: "t", stores: { sessions }, builtinSources: [] })
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

describe("skill reuse routes", () => {
  const externalSkill = (root: string): string => {
    const dir = join(root, "external", "pdf-real")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: 外部 PDF 技能。\n---\n\n外部正文\n")
    return dir
  }

  it("discovery lists candidates from registered extra sources with dedup and origin labels", async () => {
    const root = mkdtempSync(join(tmpdir(), "kclaw-skillroute-ext-"))
    try {
      const external = externalSkill(root)
      const agentA = join(root, "agent-a-skills")
      const agentB = join(root, "agent-b-skills")
      mkdirSync(agentA, { recursive: true })
      mkdirSync(agentB, { recursive: true })
      symlinkSync(external, join(agentA, "pdf"))
      symlinkSync(join(agentA, "pdf"), join(agentB, "pdf"))
      // 注册两个来源
      for (const dir of [agentA, agentB]) {
        const res = await app.inject({ method: "POST", url: "/skills/sources", headers: auth, payload: { dir } })
        expect(res.statusCode).toBe(201)
      }
      const res = await app.inject({ method: "GET", url: "/skills/discovery", headers: auth })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { sources: { agent: string; stale: boolean }[]; skills: { name: string; sources: string[]; reused: boolean }[] }
      expect(body.sources.map((s) => s.agent)).toEqual(["custom", "custom"])
      expect(body.skills).toHaveLength(1)
      expect(body.skills[0]).toMatchObject({ name: "pdf", reused: false })
      expect(body.skills[0]!.sources).toEqual(["custom"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("create → tier overwrite in GET /skills → cancel round-trips", async () => {
    const root = mkdtempSync(join(tmpdir(), "kclaw-skillroute-ext-"))
    try {
      const external = externalSkill(root)
      const created = await app.inject({ method: "POST", url: "/skills/links", headers: auth, payload: { name: "pdf", target: external, agent: "claude", tier: "off" } })
      expect(created.statusCode).toBe(201)
      // 档位 off：用户面与模型面都不出现
      const listed = await app.inject({ method: "GET", url: "/skills", headers: auth })
      expect((listed.json() as { name: string }[]).map((r) => r.name)).not.toContain("pdf")
      // 改档位 → all → 出现
      const patched = await app.inject({ method: "PATCH", url: "/skills/links/pdf", headers: auth, payload: { tier: "all" } })
      expect(patched.statusCode).toBe(200)
      const listed2 = await app.inject({ method: "GET", url: "/skills", headers: auth })
      expect((listed2.json() as { name: string; visibility: string }[]).find((r) => r.name === "pdf")).toMatchObject({ visibility: "all" })
      // 管理面记录不受可见性过滤影响
      const links = await app.inject({ method: "GET", url: "/skills/links", headers: auth })
      expect(links.json()).toMatchObject({ links: [{ name: "pdf", tier: "all", agent: "claude" }] })
      // 取消复用
      const removed = await app.inject({ method: "DELETE", url: "/skills/links/pdf", headers: auth })
      expect(removed.statusCode).toBe(200)
      const listed3 = await app.inject({ method: "GET", url: "/skills", headers: auth })
      expect((listed3.json() as { name: string }[]).map((r) => r.name)).not.toContain("pdf")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("reused candidates show as reused in discovery; same-name-different-content creation is 409", async () => {
    const root = mkdtempSync(join(tmpdir(), "kclaw-skillroute-ext-"))
    try {
      const external = externalSkill(root)
      const agentA = join(root, "agent-a-skills")
      mkdirSync(agentA, { recursive: true })
      symlinkSync(external, join(agentA, "pdf"))
      await app.inject({ method: "POST", url: "/skills/sources", headers: auth, payload: { dir: agentA } })
      await app.inject({ method: "POST", url: "/skills/links", headers: auth, payload: { name: "pdf", target: external, agent: "claude", tier: "all" } })
      const discovery = await app.inject({ method: "GET", url: "/skills/discovery", headers: auth })
      expect((discovery.json() as { skills: { name: string; reused: boolean }[] }).skills[0]).toMatchObject({ name: "pdf", reused: true })
      // 重复复用同内容
      const dup = await app.inject({ method: "POST", url: "/skills/links", headers: auth, payload: { name: "pdf", target: external, agent: "claude", tier: "all" } })
      expect(dup.statusCode).toBe(409)
      // 取消后，名字被同名自有技能占用 → 冲突
      await app.inject({ method: "DELETE", url: "/skills/links/pdf", headers: auth })
      writeSkill(join(home, "skills"), "pdf", "---\ndescription: 自有版。\n---\n\n自有正文\n")
      const blocked = await app.inject({ method: "POST", url: "/skills/links", headers: auth, payload: { name: "pdf", target: external, agent: "claude", tier: "all" } })
      expect(blocked.statusCode).toBe(409)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("preview serves discovered bodies and refuses out-of-tree paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "kclaw-skillroute-ext-"))
    try {
      const external = externalSkill(root)
      const agentA = join(root, "agent-a-skills")
      mkdirSync(agentA, { recursive: true })
      symlinkSync(external, join(agentA, "pdf"))
      await app.inject({ method: "POST", url: "/skills/sources", headers: auth, payload: { dir: agentA } })
      const ok = await app.inject({ method: "POST", url: "/skills/discovery/preview", headers: auth, payload: { path: external } })
      expect(ok.statusCode).toBe(200)
      expect(ok.json()).toMatchObject({ name: "pdf-real", body: expect.stringContaining("外部正文") })
      const bad = await app.inject({ method: "POST", url: "/skills/discovery/preview", headers: auth, payload: { path: home } })
      expect(bad.statusCode).toBe(404)
      const missing = await app.inject({ method: "POST", url: "/skills/discovery/preview", headers: auth, payload: {} })
      expect(missing.statusCode).toBe(400)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects relative workdir on write routes and missing workdir stays global", async () => {
    const rel = await app.inject({ method: "POST", url: "/skills/links", headers: auth, payload: { name: "x", target: "/tmp/y", workdir: "relative/path" } })
    expect(rel.statusCode).toBe(400)
    const relDel = await app.inject({ method: "DELETE", url: `/skills/links/x?workdir=${encodeURIComponent("relative/path")}`, headers: auth })
    expect(relDel.statusCode).toBe(400)
    const projectLinks = await app.inject({ method: "GET", url: `/skills/links?workdir=${encodeURIComponent(workdir)}`, headers: auth })
    expect(projectLinks.statusCode).toBe(200)
    expect(projectLinks.json()).toEqual({ links: [], extraSources: [] })
  })
})
