import { readFileSync, statSync } from "node:fs"
import { relative, resolve } from "node:path"
import type { FastifyInstance } from "fastify"
import type { ChangeFile, ChangeOp, KclawConfig, Message, SessionStore } from "@kclaw/core"

/** Read cap for the current-content preview, same as the fs_read tool. */
export const MAX_CHANGE_FILE_BYTES = 1024 * 1024

const WRITE_TOOLS: ReadonlySet<string> = new Set(["fs_write", "fs_edit"])

/** Dependencies for the changes routes (injected by createApp). */
export interface ChangesStores {
  sessions: SessionStore
  config?: KclawConfig
}

/**
 * Derive the per-file change aggregation from the session event stream.
 * Nothing is persisted: events.jsonl is the only truth, so the result is
 * unaffected by compaction (the stream is append-only). A call counts as a
 * change record only when its tool_result paired by callId ended `ok` —
 * a failed fs_edit changed nothing.
 *
 * Path resolution mirrors the fs tools (`path.resolve(workspace, p)`): the
 * workspace root is the session workdir, falling back to the global config
 * workspace. Out-of-workspace targets stay in the list (the permission gate
 * may legitimately allow confirmed writes there) with relativePath null.
 */
export function collectChanges(messages: Message[], workspaceRoot: string): ChangeFile[] {
  const okCallIds = new Set<string>()
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "tool_result" && b.status === "ok") okCallIds.add(b.callId)
    }
  }

  const byPath = new Map<string, ChangeFile>()
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type !== "tool_call" || !WRITE_TOOLS.has(b.name) || !okCallIds.has(b.callId)) continue
      let args: Record<string, unknown>
      try {
        args = JSON.parse(b.argsJson) as Record<string, unknown>
      } catch {
        continue
      }
      const rawPath = args.path
      if (typeof rawPath !== "string" || rawPath.length === 0) continue
      const tool = b.name as "fs_write" | "fs_edit"

      const resolved = resolve(workspaceRoot, rawPath)
      const rel = relative(workspaceRoot, resolved)
      const relativePath = rel.length > 0 && !rel.startsWith("..") ? rel : null
      const opArgs: ChangeOp["args"] = {}
      if (tool === "fs_edit") {
        if (typeof args.old === "string") opArgs.old = args.old
        if (typeof args.new === "string") opArgs.new = args.new
      } else if (typeof args.content === "string") {
        opArgs.content = args.content
      }

      let file = byPath.get(resolved)
      if (file === undefined) {
        file = { path: resolved, relativePath, firstAt: m.createdAt, lastAt: m.createdAt, ops: [] }
        byPath.set(resolved, file)
      }
      if (m.createdAt < file.firstAt) file.firstAt = m.createdAt
      if (m.createdAt > file.lastAt) file.lastAt = m.createdAt
      file.ops.push({ callId: b.callId, tool, at: m.createdAt, args: opArgs })
    }
  }

  const files = [...byPath.values()]
  for (const f of files) f.ops.sort((a, b) => b.at.localeCompare(a.at))
  files.sort((a, b) => b.lastAt.localeCompare(a.lastAt))
  return files
}

/**
 * Register the changes routes (read-only views over the event stream):
 * - `GET /sessions/:id/changes` — per-file aggregation of ok fs_write/fs_edit calls.
 * - `GET /sessions/:id/changes/file?path=` — current disk content of a changed
 *   file. The path must resolve to one of the session's change records (the
 *   whitelist IS the aggregation), so the preview never becomes a generic
 *   file-read endpoint. Binary content is detected (NUL byte) and flagged
 *   instead of returned; the size cap matches fs_read.
 */
export function registerChangesRoutes(app: FastifyInstance, stores: ChangesStores): void {
  app.get("/sessions/:id/changes", async (request, reply) => {
    const { id } = request.params as { id: string }
    const meta = stores.sessions.meta(id)
    if (meta === undefined) return reply.code(404).send({ error: "session not found" })
    const root = resolve(meta.workdir ?? stores.config?.workspace ?? process.cwd())
    return { files: collectChanges(stores.sessions.readMessages(id), root) }
  })

  app.get("/sessions/:id/changes/file", async (request, reply) => {
    const { id } = request.params as { id: string }
    const meta = stores.sessions.meta(id)
    if (meta === undefined) return reply.code(404).send({ error: "session not found" })
    const query = request.query as Record<string, unknown>
    const raw = query.path
    if (typeof raw !== "string" || raw.length === 0) {
      return reply.code(400).send({ error: "path query parameter is required" })
    }
    const root = resolve(meta.workdir ?? stores.config?.workspace ?? process.cwd())
    const whitelist = new Set(collectChanges(stores.sessions.readMessages(id), root).map((f) => f.path))
    const resolved = resolve(root, raw)
    if (!whitelist.has(resolved)) {
      return reply.code(400).send({ error: "path is not a changed file of this session" })
    }

    let size: number
    try {
      const st = statSync(resolved)
      if (st.isDirectory()) return reply.code(400).send({ error: "not a file" })
      size = st.size
    } catch {
      return reply.code(404).send({ error: "file no longer on disk" })
    }
    if (size > MAX_CHANGE_FILE_BYTES) {
      return reply.code(413).send({ error: `file too large: ${size} bytes (max ${MAX_CHANGE_FILE_BYTES})` })
    }

    const buf = readFileSync(resolved)
    // NUL byte anywhere = binary; never return the content.
    if (buf.includes(0)) return reply.send({ binary: true, bytes: buf.length })
    return reply.send({ content: buf.toString("utf8"), bytes: buf.length })
  })
}
