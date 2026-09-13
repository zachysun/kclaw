import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig } from "@kclaw/core"
import type { KclawConfig } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import { FILE_LIST_CAP } from "../../src/routes/fs.js"
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

interface FilesBody {
  workdir: string
  files: string[]
  truncated: boolean
  error?: string
}

/** git init + commit with a fixed identity so the test never depends on global config. */
function git(cwd: string, args: string[]): void {
  const res = spawnSync("git", ["-c", "user.email=t@kclaw.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`)
}

describe("fs files route (workspace file listing for the mention drawer)", () => {
  let home: string
  let workspace: string
  let config: KclawConfig
  let app: FastifyInstance

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-fsfiles-home-"))
    workspace = realpathSync(await mkdtemp(join(tmpdir(), "kclaw-fsfiles-ws-")))
    config = structuredClone(defaultConfig)
    config.workspace = workspace
    app = await createApp({ home, token: "t1", stores: { config } })
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  it("in a git repo: tracked + untracked-but-not-ignored files only, git-ignored content absent", async () => {
    await writeFile(join(workspace, ".gitignore"), "secret.txt\nnode_modules/\n")
    await mkdir(join(workspace, "sub"))
    await mkdir(join(workspace, "node_modules"))
    await writeFile(join(workspace, "a.ts"), "x")
    await writeFile(join(workspace, "sub", "b.ts"), "x")
    await writeFile(join(workspace, "secret.txt"), "x")
    await writeFile(join(workspace, "node_modules", "junk.js"), "x")
    await writeFile(join(workspace, "untracked.txt"), "x")
    git(workspace, ["init"])
    git(workspace, ["add", "."])
    git(workspace, ["commit", "-m", "init"])

    const res = await app.inject({ method: "GET", url: `/fs/files?workdir=${encodeURIComponent(workspace)}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as FilesBody
    expect(body.workdir).toBe(workspace)
    expect(body.truncated).toBe(false)
    expect(body.files).toContain("a.ts")
    expect(body.files).toContain("sub/b.ts")
    expect(body.files).toContain("untracked.txt")
    expect(body.files).toContain(".gitignore")
    expect(body.files).not.toContain("secret.txt")
    expect(body.files.some((f) => f.startsWith("node_modules/"))).toBe(false)
    // case-insensitive lexicographic order
    expect([...body.files].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))).toEqual(body.files)
  })

  it("in a git repo: non-ASCII filenames come back verbatim (no C-quote escaping)", async () => {
    await writeFile(join(workspace, "说明文档.md"), "x")
    git(workspace, ["init"])
    git(workspace, ["add", "."])
    git(workspace, ["commit", "-m", "init"])

    const res = await app.inject({ method: "GET", url: `/fs/files?workdir=${encodeURIComponent(workspace)}`, headers: AUTH })
    expect((res.json() as FilesBody).files).toEqual(["说明文档.md"])
  })

  it("in a git repo: an index entry whose file was deleted does not appear", async () => {
    await writeFile(join(workspace, "a.ts"), "x")
    git(workspace, ["init"])
    git(workspace, ["add", "."])
    git(workspace, ["commit", "-m", "init"])
    const { unlinkSync } = await import("node:fs")
    unlinkSync(join(workspace, "a.ts"))

    const res = await app.inject({ method: "GET", url: `/fs/files?workdir=${encodeURIComponent(workspace)}`, headers: AUTH })
    expect((res.json() as FilesBody).files).toEqual([])
  })

  it("outside a git repo: recursive scan excluding .git, .kclaw and node_modules", async () => {
    await mkdir(join(workspace, ".git"))
    await mkdir(join(workspace, ".kclaw"))
    await mkdir(join(workspace, "node_modules"))
    await mkdir(join(workspace, "sub"))
    await writeFile(join(workspace, ".git", "HEAD"), "x")
    await writeFile(join(workspace, ".kclaw", "permissions.yaml"), "x")
    await writeFile(join(workspace, "node_modules", "junk.js"), "x")
    await writeFile(join(workspace, "a.ts"), "x")
    await writeFile(join(workspace, "sub", "c.ts"), "x")

    const res = await app.inject({ method: "GET", url: `/fs/files?workdir=${encodeURIComponent(workspace)}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json() as FilesBody
    expect(body.files).toEqual(["a.ts", "sub/c.ts"])
  })

  it("truncates at the cap and reports it", async () => {
    for (let i = 0; i <= FILE_LIST_CAP; i++) {
      await writeFile(join(workspace, `f${String(i).padStart(5, "0")}.ts`), "x")
    }
    const res = await app.inject({ method: "GET", url: `/fs/files?workdir=${encodeURIComponent(workspace)}`, headers: AUTH })
    const body = res.json() as FilesBody
    expect(body.files).toHaveLength(FILE_LIST_CAP)
    expect(body.truncated).toBe(true)
  })

  it("falls back to the configured workspace and 400s on invalid workdir", async () => {
    const bare = await app.inject({ method: "GET", url: "/fs/files", headers: AUTH })
    expect(bare.statusCode).toBe(200)
    expect((bare.json() as FilesBody).workdir).toBe(workspace)

    const missing = await app.inject({ method: "GET", url: `/fs/files?workdir=${encodeURIComponent(join(workspace, "nope"))}`, headers: AUTH })
    expect(missing.statusCode).toBe(400)
    expect((missing.json() as FilesBody).error).toContain("does not exist")

    const unauth = await app.inject({ method: "GET", url: "/fs/files" })
    expect(unauth.statusCode).toBe(401)
  })
})
