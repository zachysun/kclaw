import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { FastifyInstance } from "fastify"
import { newId } from "@kclaw/core"
import type { SessionStore } from "@kclaw/core"

/** Upload size cap: 20MB raw body. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** Dependencies for the attachment routes (injected by createApp). */
export interface AttachmentStores {
  sessions: SessionStore
  attachmentsDir: string
}

/** Strip path separators and control chars from a user-supplied filename. */
function sanitizeFilename(name: string): string {
  const base = basename(name)
  const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "")
  return cleaned === "" ? "file" : cleaned
}

/**
 * Register attachment routes:
 * - `POST /sessions/:id/attachments?filename=<name>` — raw body upload
 *   (Content-Length checked, stream-capped at 20MB), saved to
 *   `<attachmentsDir>/<sessionId>/<newId>__<sanitized>`.
 * - `GET /sessions/:id/attachments` — file list (name/size/mtime, newest first).
 * - `GET /sessions/:id/attachments/:file` — download with a traversal guard.
 */
export function registerAttachmentRoutes(app: FastifyInstance, opts: AttachmentStores): void {
  // Raw upload bodies arrive with arbitrary content types (images, pdfs):
  // catch everything the app's JSON parser doesn't own as a Buffer. The JSON
  // parser still wins for application/json (exact match beats wildcard).
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body))

  const sessionDir = (sessionId: string): string => join(opts.attachmentsDir, sessionId)

  app.post("/sessions/:id/attachments", { bodyLimit: MAX_ATTACHMENT_BYTES }, async (request, reply) => {
    const sessionId = (request.params as { id: string }).id
    if (opts.sessions.meta(sessionId) === undefined) return reply.code(404).send({ error: "session not found" })
    const filename = (request.query as Record<string, unknown>).filename
    if (typeof filename !== "string" || filename === "") {
      return reply.code(400).send({ error: "attachment requires a ?filename= parameter" })
    }
    const body = request.body as Buffer | undefined
    if (body === undefined || body.length === 0) {
      return reply.code(400).send({ error: "attachment body must not be empty" })
    }
    if (body.length > MAX_ATTACHMENT_BYTES) {
      return reply.code(413).send({ error: "attachment too large (max 20MB)" })
    }
    const dir = sessionDir(sessionId)
    mkdirSync(dir, { recursive: true })
    const stored = `${newId("att")}__${sanitizeFilename(filename)}`
    writeFileSync(join(dir, stored), body)
    return reply.send({ file: { path: join(dir, stored), name: sanitizeFilename(filename), size: body.length } })
  })

  app.get("/sessions/:id/attachments", async (request, reply) => {
    const sessionId = (request.params as { id: string }).id
    if (opts.sessions.meta(sessionId) === undefined) return reply.code(404).send({ error: "session not found" })
    const dir = sessionDir(sessionId)
    let entries: Array<{ name: string; size: number; mtimeMs: number }> = []
    try {
      for (const e of readdirSync(dir)) {
        const st = statSync(join(dir, e))
        if (!st.isFile()) continue
        entries.push({ name: e, size: st.size, mtimeMs: st.mtimeMs })
      }
    } catch {
      return reply.send([]) // no attachments yet
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return reply.send(entries.map((e) => ({ name: e.name, size: e.size })))
  })

  app.get("/sessions/:id/attachments/:file", async (request, reply) => {
    const { id, file } = request.params as { id: string; file: string }
    if (opts.sessions.meta(id) === undefined) return reply.code(404).send({ error: "session not found" })
    const dir = resolve(sessionDir(id))
    const target = resolve(join(dir, file))
    if (target !== dir && !target.startsWith(dir + "/")) {
      return reply.code(400).send({ error: "invalid attachment path" })
    }
    try {
      statSync(target).isFile()
    } catch {
      return reply.code(404).send({ error: "attachment not found" })
    }
    return reply.send(createReadStream(target))
  })
}
