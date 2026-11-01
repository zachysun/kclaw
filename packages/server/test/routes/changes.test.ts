import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, mkdir, writeFile, unlink } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig, newMessage, SessionStore } from "@kclaw/core"
import type { KclawConfig, ToolResultBlock } from "@kclaw/core"
import { createApp } from "../../src/index.js"
import type { FastifyInstance } from "fastify"

const AUTH = { authorization: "Bearer t1" }

interface ChangeOp {
  callId: string
  tool: "fs_write" | "fs_edit"
  at: string
  args: { old?: string; new?: string; content?: string }
}
interface ChangeFile {
  path: string
  relativePath: string | null
  firstAt: string
  lastAt: string
  ops: ChangeOp[]
}

/** tool_call block fixture (args mirrored into argsJson, as the agent loop does). */
function callBlock(callId: string, name: string, args: unknown) {
  return { id: `blk-call-${callId}`, type: "tool_call" as const, callId, name, args, argsJson: JSON.stringify(args) }
}
function resultBlock(callId: string, status: "ok" | "error", output = ""): ToolResultBlock {
  return { id: `blk-res-${callId}`, type: "tool_result", callId, status, output, durationMs: 1 }
}

/** Append one assistant(tool_call) + tool(tool_result) pair pinned to a fixed timestamp. */
function appendTurn(
  sessions: SessionStore, sessionId: string, at: string,
  call: ReturnType<typeof callBlock>, result: ToolResultBlock,
): void {
  const assistant = newMessage(sessionId, "assistant", [call])
  const tool = newMessage(sessionId, "tool", [result])
  sessions.appendMessage(sessionId, { ...assistant, createdAt: at })
  sessions.appendMessage(sessionId, { ...tool, createdAt: at })
}

describe("changes routes", () => {
  let home: string
  let workspace: string // canonical (realpath) — macOS /var is a symlink
  let config: KclawConfig
  let app: FastifyInstance
  let sessions: SessionStore
  let sessionId: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-changes-home-"))
    workspace = realpathSync(await mkdtemp(join(tmpdir(), "kclaw-changes-ws-")))
    await mkdir(join(workspace, "src"), { recursive: true })
    config = structuredClone(defaultConfig)
    config.workspace = workspace
    app = await createApp({ home, token: "t1", stores: { config } })
    sessions = new SessionStore(join(home, "sessions"))
    const meta = sessions.create("changes-test", undefined, workspace)
    sessionId = meta.id
  })

  afterEach(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  describe("GET /sessions/:id/changes", () => {
    it("aggregates ok fs_write/fs_edit calls per file with relative paths and args", async () => {
      await writeFile(join(workspace, "src/a.ts"), "export const a = 1\n")
      appendTurn(sessions, sessionId, "2026-01-01T00:00:01.000Z",
        callBlock("c1", "fs_edit", { path: "src/a.ts", old: "a = 1", new: "a = 2" }),
        resultBlock("c1", "ok", "replaced 1 occurrence"))
      appendTurn(sessions, sessionId, "2026-01-01T00:00:02.000Z",
        callBlock("c2", "fs_write", { path: "src/b.ts", content: "export const b = 2\n" }),
        resultBlock("c2", "ok", "wrote 20 bytes"))

      const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}/changes`, headers: AUTH })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { files: ChangeFile[] }
      // sorted by lastAt desc: b.ts (written later) first
      expect(body.files.map((f) => f.relativePath)).toEqual(["src/b.ts", "src/a.ts"])

      const [b, a] = body.files
      expect(a.path).toBe(join(workspace, "src/a.ts"))
      expect(a.ops).toHaveLength(1)
      expect(a.ops[0]).toMatchObject({ callId: "c1", tool: "fs_edit", at: "2026-01-01T00:00:01.000Z" })
      expect(a.ops[0].args).toEqual({ old: "a = 1", new: "a = 2" })
      expect(b.ops[0]).toMatchObject({ callId: "c2", tool: "fs_write" })
      expect(b.ops[0].args).toEqual({ content: "export const b = 2\n" })
    })

    it("excludes failed tool calls (they did not change the file)", async () => {
      appendTurn(sessions, sessionId, "2026-01-01T00:00:01.000Z",
        callBlock("c1", "fs_edit", { path: "src/a.ts", old: "nope", new: "x" }),
        resultBlock("c1", "error", "old not found"))
      appendTurn(sessions, sessionId, "2026-01-01T00:00:02.000Z",
        callBlock("c2", "fs_edit", { path: "src/a.ts", old: "x", new: "y" }),
        resultBlock("c2", "ok"))

      const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}/changes`, headers: AUTH })
      const body = res.json() as { files: ChangeFile[] }
      expect(body.files).toHaveLength(1)
      expect(body.files[0]!.ops.map((o) => o.callId)).toEqual(["c2"])
    })

    it("folds multiple edits of one file into a single entry with ops newest-first", async () => {
      appendTurn(sessions, sessionId, "2026-01-01T00:00:01.000Z",
        callBlock("c1", "fs_edit", { path: "src/a.ts", old: "1", new: "2" }), resultBlock("c1", "ok"))
      appendTurn(sessions, sessionId, "2026-01-01T00:00:03.000Z",
        callBlock("c3", "fs_edit", { path: "src/a.ts", old: "2", new: "3" }), resultBlock("c3", "ok"))

      const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}/changes`, headers: AUTH })
      const body = res.json() as { files: ChangeFile[] }
      expect(body.files).toHaveLength(1)
      const f = body.files[0]!
      expect(f.ops.map((o) => o.callId)).toEqual(["c3", "c1"])
      expect(f.firstAt).toBe("2026-01-01T00:00:01.000Z")
      expect(f.lastAt).toBe("2026-01-01T00:00:03.000Z")
    })

    it("ignores non-write tools", async () => {
      appendTurn(sessions, sessionId, "2026-01-01T00:00:01.000Z",
        callBlock("c1", "bash", { command: "echo hi" }), resultBlock("c1", "ok"))
      appendTurn(sessions, sessionId, "2026-01-01T00:00:02.000Z",
        callBlock("c2", "fs_read", { path: "src/a.ts" }), resultBlock("c2", "ok"))

      const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}/changes`, headers: AUTH })
      expect(res.json() as { files: ChangeFile[] }).toEqual({ files: [] })
    })

    it("skips write calls with malformed or pathless args", async () => {
      appendTurn(sessions, sessionId, "2026-01-01T00:00:01.000Z",
        callBlock("c1", "fs_write", { content: "no path" }), resultBlock("c1", "ok"))
      const assistant = newMessage(sessionId, "assistant", [])
      sessions.appendMessage(sessionId, {
        ...assistant, createdAt: "2026-01-01T00:00:02.000Z",
        blocks: [{ id: "blk-x", type: "tool_call", callId: "c2", name: "fs_edit", args: {}, argsJson: "{not json" }],
      })
      appendTurn(sessions, sessionId, "2026-01-01T00:00:03.000Z",
        callBlock("c3", "fs_write", { path: "src/ok.ts", content: "x" }), resultBlock("c3", "ok"))

      const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}/changes`, headers: AUTH })
      const body = res.json() as { files: ChangeFile[] }
      expect(body.files.map((f) => f.relativePath)).toEqual(["src/ok.ts"])
    })

    it("keeps out-of-workspace absolute paths with relativePath null", async () => {
      const outside = realpathSync(await mkdtemp(join(tmpdir(), "kclaw-changes-out-")))
      try {
        appendTurn(sessions, sessionId, "2026-01-01T00:00:01.000Z",
          callBlock("c1", "fs_write", { path: join(outside, "notes.md"), content: "hi" }),
          resultBlock("c1", "ok"))

        const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}/changes`, headers: AUTH })
        const body = res.json() as { files: ChangeFile[] }
        expect(body.files).toHaveLength(1)
        expect(body.files[0]!.path).toBe(join(outside, "notes.md"))
        expect(body.files[0]!.relativePath).toBeNull()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })

    it("answers 404 for an unknown session", async () => {
      const res = await app.inject({ method: "GET", url: "/sessions/ses_nope/changes", headers: AUTH })
      expect(res.statusCode).toBe(404)
    })
  })

  describe("GET /sessions/:id/changes/file", () => {
    beforeEach(async () => {
      await writeFile(join(workspace, "src/a.ts"), "export const a = 2\n")
      appendTurn(sessions, sessionId, "2026-01-01T00:00:01.000Z",
        callBlock("c1", "fs_edit", { path: "src/a.ts", old: "a = 1", new: "a = 2" }),
        resultBlock("c1", "ok"))
    })

    it("serves current disk content for a whitelisted relative path", async () => {
      const res = await app.inject({
        method: "GET", url: `/sessions/${sessionId}/changes/file?path=${encodeURIComponent("src/a.ts")}`,
        headers: AUTH,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ content: "export const a = 2\n", bytes: 19 })
    })

    it("accepts the resolved absolute form too", async () => {
      const res = await app.inject({
        method: "GET", url: `/sessions/${sessionId}/changes/file?path=${encodeURIComponent(join(workspace, "src/a.ts"))}`,
        headers: AUTH,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json() as { content: string }).toEqual({ content: "export const a = 2\n", bytes: 19 })
    })

    it("rejects paths outside the change whitelist with 400", async () => {
      for (const p of ["src/never-written.ts", "../escape.txt", "src"]) {
        const res = await app.inject({
          method: "GET", url: `/sessions/${sessionId}/changes/file?path=${encodeURIComponent(p)}`, headers: AUTH,
        })
        expect(res.statusCode).toBe(400)
      }
    })

    it("answers 404 when the file is gone from disk", async () => {
      await unlink(join(workspace, "src/a.ts"))
      const res = await app.inject({
        method: "GET", url: `/sessions/${sessionId}/changes/file?path=${encodeURIComponent("src/a.ts")}`,
        headers: AUTH,
      })
      expect(res.statusCode).toBe(404)
    })

    it("flags binary content without returning it", async () => {
      await writeFile(join(workspace, "src/logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x4e]))
      appendTurn(sessions, sessionId, "2026-01-01T00:00:02.000Z",
        callBlock("c2", "fs_write", { path: "src/logo.png", content: "binary-ish" }),
        resultBlock("c2", "ok"))

      const res = await app.inject({
        method: "GET", url: `/sessions/${sessionId}/changes/file?path=${encodeURIComponent("src/logo.png")}`,
        headers: AUTH,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ binary: true, bytes: 4 })
    })

    it("answers 413 over the 1 MiB read cap", async () => {
      await writeFile(join(workspace, "src/big.txt"), "x".repeat(1024 * 1024 + 1))
      appendTurn(sessions, sessionId, "2026-01-01T00:00:02.000Z",
        callBlock("c2", "fs_write", { path: "src/big.txt", content: "big" }), resultBlock("c2", "ok"))

      const res = await app.inject({
        method: "GET", url: `/sessions/${sessionId}/changes/file?path=${encodeURIComponent("src/big.txt")}`,
        headers: AUTH,
      })
      expect(res.statusCode).toBe(413)
    })

    it("answers 400 when the path parameter is missing", async () => {
      const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}/changes/file`, headers: AUTH })
      expect(res.statusCode).toBe(400)
    })

    it("answers 404 for an unknown session", async () => {
      const res = await app.inject({
        method: "GET", url: "/sessions/ses_nope/changes/file?path=src/a.ts", headers: AUTH,
      })
      expect(res.statusCode).toBe(404)
    })
  })
})
