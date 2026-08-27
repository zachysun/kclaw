import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig } from "@kclaw/core"
import type { KclawConfig } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

interface BrowseBody {
  path: string
  parent: string | null
  dirs: string[]
  error?: string
}

describe("fs browse route", () => {
  let home: string
  let workspace: string // canonical (realpath) — the route resolves symlinks
  let config: KclawConfig
  let app: FastifyInstance

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-fs-home-"))
    // mkdtemp under macOS /var (a symlink to /private/var); the route answers
    // with the realpath, so compare against the canonical form.
    workspace = realpathSync(await mkdtemp(join(tmpdir(), "kclaw-fs-ws-")))
    await mkdir(join(workspace, "alpha"))
    await mkdir(join(workspace, "Beta"))
    await mkdir(join(workspace, "alpha", "inner"))
    await writeFile(join(workspace, "notes.txt"), "not a dir")
    await symlink(workspace, join(workspace, "self-link"), "dir").catch(() => {
      // symlink may require privileges on some platforms; the case skips itself
    })
    config = structuredClone(defaultConfig)
    config.workspace = workspace
    app = await createApp({ home, token: "t1", stores: { config } })
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  it("lists directories only, sorted case-insensitively, rooted at the workspace without a path", async () => {
    const res = await app.inject({ method: "GET", url: "/fs/browse", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as BrowseBody
    expect(body.path).toBe(workspace)
    expect(body.dirs).toContain("alpha")
    expect(body.dirs).toContain("Beta")
    expect(body.dirs).not.toContain("notes.txt") // files are excluded
    expect([...body.dirs].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))).toEqual(body.dirs)
    expect(body.parent).not.toBeNull()
  })

  it("navigates into a subdirectory and reports the parent", async () => {
    const target = join(workspace, "alpha")
    const res = await app.inject({ method: "GET", url: `/fs/browse?path=${encodeURIComponent(target)}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as BrowseBody
    expect(body.path).toBe(target)
    expect(body.parent).toBe(workspace)
    expect(body.dirs).toEqual(["inner"])
  })

  it("follows symlinked directories", async () => {
    const res = await app.inject({ method: "GET", url: "/fs/browse", headers: AUTH })
    const body = res.json() as BrowseBody
    // Skip silently when the platform refused the symlink in beforeEach.
    if (body.dirs.includes("self-link")) {
      const res2 = await app.inject({
        method: "GET",
        url: `/fs/browse?path=${encodeURIComponent(join(workspace, "self-link"))}`,
        headers: AUTH,
      })
      expect(res2.statusCode).toBe(200)
      expect((res2.json() as BrowseBody).path).toBe(workspace) // resolved to the real target
    }
  })

  it("reports parent null at the filesystem root", async () => {
    const res = await app.inject({ method: "GET", url: "/fs/browse?path=/", headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as BrowseBody
    expect(body.path).toBe("/")
    expect(body.parent).toBeNull()
  })

  it("400 on a missing path, a file, and requires auth", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent(join(workspace, "nope"))}`,
      headers: AUTH,
    })
    expect(missing.statusCode).toBe(400)
    expect((missing.json() as BrowseBody).error).toContain("does not exist")

    const file = await app.inject({
      method: "GET",
      url: `/fs/browse?path=${encodeURIComponent(join(workspace, "notes.txt"))}`,
      headers: AUTH,
    })
    expect(file.statusCode).toBe(400)
    expect((file.json() as BrowseBody).error).toContain("not a directory")

    const unauth = await app.inject({ method: "GET", url: "/fs/browse" })
    expect(unauth.statusCode).toBe(401)
  })
})
