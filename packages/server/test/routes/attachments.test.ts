import { describe, expect, it, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FastifyInstance } from "fastify"
import { SessionStore, resolvePaths } from "@kclaw/core"
import { createApp } from "../../src/index.js"

describe("attachment routes", () => {
  let app: FastifyInstance
  const homes: string[] = []

  async function makeApp(): Promise<{ app: FastifyInstance; sessionId: string }> {
    const home = mkdtempSync(join(tmpdir(), "kclaw-att-"))
    homes.push(home)
    const paths = resolvePaths(home)
    const sessions = new SessionStore(paths.sessionsDir)
    const session = sessions.create("att-test")
    app = await createApp({ home, token: "t1", attachmentsDir: paths.attachmentsDir })
    return { app, sessionId: session.id }
  }

  afterEach(async () => {
    if (app) await app.close()
  })

  const auth = { authorization: "Bearer t1" }

  it("uploads, lists and downloads an attachment", async () => {
    const { app, sessionId } = await makeApp()
    const up = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/attachments?filename=${encodeURIComponent("note.md")}`,
      headers: { ...auth, "content-type": "text/markdown" },
      payload: "# 备忘\n买牛奶",
    })
    expect(up.statusCode).toBe(200)
    const { file } = up.json() as { file: { path: string; name: string; size: number } }
    expect(file.name).toBe("note.md")
    expect(file.size).toBe(Buffer.byteLength("# 备忘\n买牛奶", "utf8"))
    expect(readFileSync(file.path, "utf8")).toBe("# 备忘\n买牛奶")

    const list = await app.inject({ method: "GET", url: `/sessions/${sessionId}/attachments`, headers: auth })
    expect(list.statusCode).toBe(200)
    const files = list.json() as Array<{ name: string; size: number }>
    expect(files).toHaveLength(1)
    expect(files[0]!.name).toContain("__note.md")

    const stored = files[0]!.name
    const dl = await app.inject({ method: "GET", url: `/sessions/${sessionId}/attachments/${stored}`, headers: auth })
    expect(dl.statusCode).toBe(200)
    expect(dl.body).toBe("# 备忘\n买牛奶")
  })

  it("sanitizes path separators out of the stored filename", async () => {
    const { app, sessionId } = await makeApp()
    const up = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/attachments?filename=${encodeURIComponent("../../evil.txt")}`,
      headers: auth,
      payload: "x",
    })
    expect(up.statusCode).toBe(200)
    const { file } = up.json() as { file: { path: string; name: string } }
    expect(file.name).toBe("evil.txt")
    expect(file.path).not.toContain("..")
  })

  it("rejects over-limit uploads with 413", async () => {
    const { app, sessionId } = await makeApp()
    const up = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/attachments?filename=big.bin`,
      headers: { ...auth, "content-length": String(30 * 1024 * 1024) },
      payload: Buffer.alloc(30 * 1024 * 1024, 1),
    })
    expect(up.statusCode).toBe(413)
  })

  it("rejects traversal in the download path", async () => {
    const { app, sessionId } = await makeApp()
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/attachments/${encodeURIComponent("../token")}`,
      headers: auth,
    })
    expect([400, 404]).toContain(res.statusCode)
  })

  it("404s for unknown sessions and missing files", async () => {
    const { app, sessionId } = await makeApp()
    expect((await app.inject({ method: "POST", url: "/sessions/nope/attachments?filename=a.txt", headers: auth, payload: "x" })).statusCode).toBe(404)
    expect((await app.inject({ method: "GET", url: `/sessions/${sessionId}/attachments/none`, headers: auth })).statusCode).toBe(404)
  })

  it("requires the bearer token", async () => {
    const { app, sessionId } = await makeApp()
    const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}/attachments` })
    expect(res.statusCode).toBe(401)
  })
})
