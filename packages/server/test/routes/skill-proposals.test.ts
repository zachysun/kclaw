/**
 * /skills/proposals 路由族：无装配 503、列表（含 status 过滤与 applied 用量）、
 * 详情、apply|reject|revert（409 冲突 / 404 缺失）、删除限制。装配用真
 * SkillEvolutionSystem（临时目录 + 真文件），提案经系统 API 造出。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../../src/app.js"
import { SessionStore, SkillEvolutionSystem, defaultConfig, type SkillProposal } from "@kclaw/core"

let home: string
let workdir: string
let sessions: SessionStore
let evo: SkillEvolutionSystem
let app: Awaited<ReturnType<typeof createApp>>

const auth = { authorization: "Bearer t" }

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kclaw-proposalroute-"))
  workdir = mkdtempSync(join(tmpdir(), "kclaw-proposalroute-ws-"))
  mkdirSync(join(home, "skills"), { recursive: true })
  sessions = new SessionStore(join(home, "sessions"))
  const cfg = structuredClone(defaultConfig)
  cfg.workspace = workdir
  evo = new SkillEvolutionSystem({
    skillsDir: join(home, "skills"),
    sessions,
    config: cfg,
    resolveLlm: () => { throw new Error("no llm in route tests") },
  })
  app = await createApp({
    home, token: "t",
    stores: { sessions },
    skillsEvolution: evo,
  })
})
afterEach(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); rmSync(workdir, { recursive: true, force: true }) })

function installSkill(rootDir: string, name: string, body: string): void {
  mkdirSync(join(rootDir, name), { recursive: true })
  writeFileSync(join(rootDir, name, "SKILL.md"), body)
}

/** 经系统 API 造一个 project 新增提案（归属已建会话）。 */
function makeProposal(name = "temp-kit"): SkillProposal {
  const meta = sessions.create("s", undefined, workdir)
  const r = evo.propose(meta.id, { name, content: `---\ndescription: d\n---\n${name} 正文`, rationale: "r" })
  if (!r.ok) throw new Error(r.error)
  return r.proposal
}

describe("no assembly", () => {
  it("answers 503 for the whole proposal family when skillsEvolution is absent", async () => {
    const bareHome = mkdtempSync(join(tmpdir(), "kclaw-bare-"))
    const bare = await createApp({ home: bareHome, token: "t", stores: { sessions } })
    try {
      for (const [method, url] of [
        ["GET", "/skills/proposals"],
        ["GET", "/skills/proposals/x"],
        ["POST", "/skills/proposals/x/apply"],
        ["DELETE", "/skills/proposals/x"],
      ] as const) {
        const res = await bare.inject({ method, url, headers: auth })
        expect(res.statusCode).toBe(503)
      }
    } finally {
      await bare.close()
      rmSync(bareHome, { recursive: true, force: true })
    }
  })
})

describe("list and detail", () => {
  it("lists proposals with fields; status filter narrows", async () => {
    const p = makeProposal()
    const res = await app.inject({ method: "GET", url: "/skills/proposals", headers: auth })
    expect(res.statusCode).toBe(200)
    const rows = (res.json() as { proposals: SkillProposal[] }).proposals
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: p.id, status: "proposed", kind: "new", name: "temp-kit", scope: "project", workdir })
    const filtered = await app.inject({ method: "GET", url: "/skills/proposals?status=applied", headers: auth })
    expect((filtered.json() as { proposals: unknown[] }).proposals).toHaveLength(0)
  })

  it("detail returns the proposal; unknown id 404; path segment 400", async () => {
    const p = makeProposal()
    const ok = await app.inject({ method: "GET", url: `/skills/proposals/${p.id}`, headers: auth })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as SkillProposal).name).toBe("temp-kit")
    expect(await app.inject({ method: "GET", url: "/skills/proposals/nope", headers: auth }).then((r) => r.statusCode)).toBe(404)
    expect(await app.inject({ method: "GET", url: "/skills/proposals/..%2Fetc", headers: auth }).then((r) => r.statusCode)).toBe(400)
  })
})

describe("governance actions", () => {
  it("apply writes the skill file and reports usage; second apply conflicts (409)", async () => {
    const p = makeProposal()
    const session = sessions.create("reader", undefined, workdir)
    const apply = await app.inject({ method: "POST", url: `/skills/proposals/${p.id}/apply`, headers: auth })
    expect(apply.statusCode).toBe(200)
    expect(apply.json()).toEqual({ ok: true })
    // 提案内容真的落进项目技能目录
    expect(readFileSync(join(workdir, ".kclaw", "skills", "temp-kit", "SKILL.md"), "utf8")).toContain("temp-kit 正文")
    // applied 行带 usage；apply 之后的 skill_read 计入
    sessions.appendMessage(session.id, {
      id: "m1", sessionId: session.id, role: "assistant", createdAt: new Date().toISOString(),
      blocks: [{ id: "b1", type: "tool_call", callId: "c1", name: "skill_read", args: { name: "temp-kit" }, argsJson: '{"name":"temp-kit"}' }],
    } as never)
    const row = (await (await app.inject({ method: "GET", url: `/skills/proposals/${p.id}`, headers: auth })).json() as SkillProposal & { usage?: number })
    expect(row.status).toBe("applied")
    expect(row.usage).toBe(1)
    const again = await app.inject({ method: "POST", url: `/skills/proposals/${p.id}/apply`, headers: auth })
    expect(again.statusCode).toBe(409)
    // applied 不可删（409）
    expect((await app.inject({ method: "DELETE", url: `/skills/proposals/${p.id}`, headers: auth })).statusCode).toBe(409)
  })

  it("revert of an applied new proposal removes the skill dir", async () => {
    const p = makeProposal()
    await app.inject({ method: "POST", url: `/skills/proposals/${p.id}/apply`, headers: auth })
    const rev = await app.inject({ method: "POST", url: `/skills/proposals/${p.id}/revert`, headers: auth })
    expect(rev.statusCode).toBe(200)
    expect(existsSync(join(workdir, ".kclaw", "skills", "temp-kit"))).toBe(false)
    // reverted 可删
    expect((await app.inject({ method: "DELETE", url: `/skills/proposals/${p.id}`, headers: auth })).statusCode).toBe(200)
    expect(evo.listProposals()).toHaveLength(0)
  })

  it("reject then delete; unknown id actions 404", async () => {
    const p = makeProposal()
    expect((await app.inject({ method: "POST", url: `/skills/proposals/${p.id}/reject`, headers: auth })).statusCode).toBe(200)
    expect((await app.inject({ method: "POST", url: `/skills/proposals/${p.id}/reject`, headers: auth })).statusCode).toBe(409)
    expect((await app.inject({ method: "POST", url: `/skills/proposals/${p.id}/apply`, headers: auth })).statusCode).toBe(409)
    expect((await app.inject({ method: "DELETE", url: `/skills/proposals/${p.id}`, headers: auth })).statusCode).toBe(200)
    expect((await app.inject({ method: "DELETE", url: "/skills/proposals/nope", headers: auth })).statusCode).toBe(404)
  })
})
