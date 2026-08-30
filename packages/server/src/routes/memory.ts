import type { FastifyInstance, FastifyReply } from "fastify"
import type { MemorySystem } from "@kclaw/core"

const NOT_FOUND = { error: "not found" } as const
/** spec 9.2：global 认知文件只认这 3 个 kind；其它一律 404。 */
const KINDS = new Set(["persona", "wiki", "rule"])
type CogKind = "persona" | "wiki" | "rule"

/** 校验 PATCH body：必须是 `{content}` 且 content 为非空字符串，否则返回 undefined。 */
function requireContent(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const c = (body as { content?: unknown }).content
  return typeof c === "string" && c !== "" ? c : undefined
}

/** spec 9.2 的 /memory 路由族：管理记忆塔（项目线文件 + global 认知文件）。 */
export function registerMemoryRoutes(app: FastifyInstance, opts: { memory?: MemorySystem }): void {
  // 无 memory 装配（createApp 未传 system）时全部 503，不注册会崩的调用。
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: "memory system unavailable" })
  const memory = opts.memory
  const isKind = (k: string): k is CogKind => KINDS.has(k)

  app.get("/memory/projects", async (_req, reply) => {
    if (memory === undefined) return unavailable(reply)
    return memory.projects()
  })

  app.get("/memory/projects/:id", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { id } = req.params as { id: string }
    // projectThreads 对不存在的项目返回空数组而非 undefined，用 projects() 判定项目存在。
    if (!memory.projects().some((p) => p.id === id)) return reply.code(404).send(NOT_FOUND)
    return { id, threads: memory.projectThreads(id) }
  })

  app.get("/memory/threads/:project/:topic", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { project, topic } = req.params as { project: string; topic: string }
    const content = memory.threadContent(project, topic)
    if (content === undefined) return reply.code(404).send(NOT_FOUND)
    return { content }
  })

  app.patch("/memory/threads/:project/:topic", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { project, topic } = req.params as { project: string; topic: string }
    const content = requireContent(req.body)
    if (content === undefined) return reply.code(400).send({ error: "content must be a non-empty string" })
    if (memory.threadContent(project, topic) === undefined) return reply.code(404).send(NOT_FOUND)
    memory.writeThread(project, topic, content)
    return { ok: true }
  })

  app.delete("/memory/threads/:project/:topic", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { project, topic } = req.params as { project: string; topic: string }
    if (memory.threadContent(project, topic) === undefined) return reply.code(404).send(NOT_FOUND)
    memory.deleteThread(project, topic)
    return { ok: true }
  })

  app.get("/memory/global", async (_req, reply) => {
    if (memory === undefined) return unavailable(reply)
    return memory.globalFiles()
  })

  app.get("/memory/global/:kind/:file", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { kind, file } = req.params as { kind: string; file: string }
    if (!isKind(kind)) return reply.code(404).send(NOT_FOUND)
    const content = memory.cognitionContent(kind, file)
    if (content === undefined) return reply.code(404).send(NOT_FOUND)
    return { content }
  })

  app.patch("/memory/global/:kind/:file", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { kind, file } = req.params as { kind: string; file: string }
    if (!isKind(kind)) return reply.code(404).send(NOT_FOUND)
    const content = requireContent(req.body)
    if (content === undefined) return reply.code(400).send({ error: "content must be a non-empty string" })
    if (memory.cognitionContent(kind, file) === undefined) return reply.code(404).send(NOT_FOUND)
    memory.writeCognition(kind, file, content)
    return { ok: true }
  })

  app.delete("/memory/global/:kind/:file", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { kind, file } = req.params as { kind: string; file: string }
    if (!isKind(kind)) return reply.code(404).send(NOT_FOUND)
    // persona 是全局画像，只能清空正文不能删文件（spec 9.2）。
    if (kind === "persona") return reply.code(400).send({ error: "persona 不可删除（可清空正文）" })
    if (memory.cognitionContent(kind, file) === undefined) return reply.code(404).send(NOT_FOUND)
    memory.deleteCognition(kind, file)
    return { ok: true }
  })
}
