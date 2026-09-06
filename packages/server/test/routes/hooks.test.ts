import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../../src/app.js"
import { SessionStore, HookRegistry } from "@kclaw/core"

let home: string
let app: Awaited<ReturnType<typeof createApp>>

const auth = { authorization: "Bearer t" }

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kclaw-hookroute-"))
  const sessions = new SessionStore(join(home, "sessions"))
  app = await createApp({ home, token: "t", stores: { sessions } })
})
afterEach(async () => {
  await app.close()
  rmSync(home, { recursive: true, force: true })
})

describe("GET /hooks", () => {
  it("no registry wired → builtin hooks still listed, user side empty", async () => {
    const res = await app.inject({ method: "GET", url: "/hooks", headers: auth })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { builtin: Array<Record<string, unknown>>; user: unknown[] }
    expect(body.builtin.length).toBeGreaterThanOrEqual(13)
    expect(body.builtin[0]).toMatchObject({ origin: "builtin", position: expect.any(String) })
    expect(body.user).toEqual([])
  })

  it("wired registry: user files and load failures appear on the user side", async () => {
    const hooksDir = join(home, "hooks")
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(join(hooksDir, "good.js"), 'export const hook = { position: "run-before" }\nexport default () => undefined\n')
    writeFileSync(join(hooksDir, "bad.js"), 'export const hook = { position: "nope" }\nexport default () => undefined\n')
    await app.close()
    const sessions = new SessionStore(join(home, "sessions"))
    const registry = new HookRegistry({ userDir: hooksDir })
    await registry.refresh()
    app = await createApp({ home, token: "t", stores: { sessions }, hooks: registry })

    const res = await app.inject({ method: "GET", url: "/hooks", headers: auth })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      builtin: Array<{ name: string }>
      user: Array<{ name: string; position: string; enabled: boolean; error?: string }>
    }
    expect(body.builtin.map((b) => b.name)).toContain("user-message-land")
    const good = body.user.find((u) => u.name === "good.js")
    expect(good).toMatchObject({ position: "run-before", enabled: true, origin: "user" })
    const bad = body.user.find((u) => u.name === "bad.js")
    expect(bad).toMatchObject({ position: "?", enabled: false })
    expect(bad!.error).toContain("unknown position")
  })

  it("requires the bearer token like every other route", async () => {
    const res = await app.inject({ method: "GET", url: "/hooks" })
    expect(res.statusCode).toBe(401)
  })
})
