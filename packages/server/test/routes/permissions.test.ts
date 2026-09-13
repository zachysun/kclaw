import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { appendDecidedRule, defaultConfig } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

interface RulesResponse {
  global: { path: string; rules: { rule: string }[] }
  project: { path: string; tracked: boolean; ignored: boolean; rules: { rule: string }[] }
}

describe("permissions rules routes", () => {
  let home: string
  let workspace: string
  let app: FastifyInstance

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kclaw-perm-home-"))
    workspace = mkdtempSync(join(tmpdir(), "kclaw-perm-ws-"))
    const config = structuredClone(defaultConfig)
    config.workspace = workspace
    app = await createApp({ home, token: "t1", stores: { config } })
  })

  afterEach(async () => {
    await app.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it("GET /permissions/rules lists both scopes with their on-disk state", async () => {
    appendDecidedRule(join(home, "permissions.yaml"), {
      rule: "exec:git push*",
      decidedAt: "2026-09-06T00:00:00.000Z",
      origin: { tool: "exec", argsJson: "{}" },
    })
    const res = await app.inject({ method: "GET", url: "/permissions/rules", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as RulesResponse
    expect(body.global.path).toBe(join(home, "permissions.yaml"))
    expect(body.global.rules.map((r) => r.rule)).toEqual(["exec:git push*"])
    // empty project scope: file absent, not tracked → rules flow through
    expect(body.project.ignored).toBe(false)
    expect(body.project.rules).toEqual([])
  })

  it("GET /permissions/rules marks a git-tracked project file as ignored with empty rules", async () => {
    mkdirSync(join(workspace, ".kclaw"), { recursive: true })
    writeFileSync(join(workspace, ".kclaw", "permissions.yaml"), "rules: []\n")
    execSync("git init -q", { cwd: workspace })
    execSync("git add .kclaw/permissions.yaml", { cwd: workspace })

    const res = await app.inject({ method: "GET", url: "/permissions/rules", headers: AUTH })
    const body = res.json() as RulesResponse
    expect(body.project.tracked).toBe(true)
    expect(body.project.ignored).toBe(true)
    expect(body.project.rules).toEqual([])
  })

  it("GET /permissions/rules honors a ?workspace= override", async () => {
    const other = mkdtempSync(join(tmpdir(), "kclaw-perm-other-"))
    try {
      appendDecidedRule(join(other, ".kclaw", "permissions.yaml"), {
        rule: "fs_write:x",
        decidedAt: "2026-09-06T00:00:00.000Z",
        origin: { tool: "fs_write", argsJson: "{}" },
      }, { workspace: other })
      const res = await app.inject({
        method: "GET",
        url: `/permissions/rules?workspace=${encodeURIComponent(other)}`,
        headers: AUTH,
      })
      const body = res.json() as RulesResponse
      expect(body.project.path).toBe(join(other, ".kclaw", "permissions.yaml"))
      expect(body.project.rules.map((r) => r.rule)).toEqual(["fs_write:x"])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it("DELETE /permissions/rules removes by scope+index and returns the entry", async () => {
    const globalPath = join(home, "permissions.yaml")
    appendDecidedRule(globalPath, {
      rule: "exec:git push*",
      decidedAt: "2026-09-06T00:00:00.000Z",
      origin: { tool: "exec", argsJson: "{}" },
    })
    appendDecidedRule(globalPath, {
      rule: "exec:ls",
      decidedAt: "2026-09-06T00:00:01.000Z",
      origin: { tool: "exec", argsJson: "{}" },
    })

    const res = await app.inject({
      method: "DELETE",
      url: "/permissions/rules",
      headers: AUTH,
      payload: { scope: "global", index: 0 },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { removed: { rule: string } }).removed.rule).toBe("exec:git push*")

    const after = await app.inject({ method: "GET", url: "/permissions/rules", headers: AUTH })
    expect((after.json() as RulesResponse).global.rules.map((r) => r.rule)).toEqual(["exec:ls"])
  })

  it("DELETE /permissions/rules validates scope and index, and 404s out of range", async () => {
    const badScope = await app.inject({
      method: "DELETE", url: "/permissions/rules", headers: AUTH, payload: { scope: "session", index: 0 },
    })
    expect(badScope.statusCode).toBe(400)

    const badIndex = await app.inject({
      method: "DELETE", url: "/permissions/rules", headers: AUTH, payload: { scope: "global", index: -1 },
    })
    expect(badIndex.statusCode).toBe(400)

    const missing = await app.inject({
      method: "DELETE", url: "/permissions/rules", headers: AUTH, payload: { scope: "global", index: 3 },
    })
    expect(missing.statusCode).toBe(404)
  })

  it("DELETE /permissions/rules with scope=project targets the requested workspace", async () => {
    appendDecidedRule(join(workspace, ".kclaw", "permissions.yaml"), {
      rule: "fs_write:notes.md",
      decidedAt: "2026-09-06T00:00:00.000Z",
      origin: { tool: "fs_write", argsJson: "{}" },
    }, { workspace })
    const res = await app.inject({
      method: "DELETE",
      url: "/permissions/rules",
      headers: AUTH,
      payload: { scope: "project", index: 0 },
    })
    expect(res.statusCode).toBe(200)
    const after = await app.inject({ method: "GET", url: "/permissions/rules", headers: AUTH })
    expect((after.json() as RulesResponse).project.rules).toEqual([])
  })

  it("DELETE /permissions/rules honors ?workspace= like the listing does (web client shape)", async () => {
    // The WebUI reads the project list with ?workspace=<session workdir> and
    // sends the SAME query on delete, with only {scope, index} in the body.
    // The delete target must therefore resolve from the query too, or it
    // lands on the daemon default workspace and misses (404) — or worse,
    // deletes a same-index rule from the wrong file.
    const other = mkdtempSync(join(tmpdir(), "kclaw-perm-other-"))
    try {
      appendDecidedRule(join(other, ".kclaw", "permissions.yaml"), {
        rule: "fs_write:x",
        decidedAt: "2026-09-06T00:00:00.000Z",
        origin: { tool: "fs_write", argsJson: "{}" },
      }, { workspace: other })
      const listed = await app.inject({
        method: "GET",
        url: `/permissions/rules?workspace=${encodeURIComponent(other)}`,
        headers: AUTH,
      })
      expect((listed.json() as RulesResponse).project.rules.map((r) => r.rule)).toEqual(["fs_write:x"])

      const res = await app.inject({
        method: "DELETE",
        url: `/permissions/rules?workspace=${encodeURIComponent(other)}`,
        headers: AUTH,
        payload: { scope: "project", index: 0 },
      })
      expect(res.statusCode).toBe(200)
      const after = await app.inject({
        method: "GET",
        url: `/permissions/rules?workspace=${encodeURIComponent(other)}`,
        headers: AUTH,
      })
      expect((after.json() as RulesResponse).project.rules).toEqual([])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
