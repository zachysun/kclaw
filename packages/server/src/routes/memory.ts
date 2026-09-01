import type { FastifyInstance, FastifyReply } from "fastify"
import type { KclawConfig, MemorySystem } from "@kclaw/core"

const NOT_FOUND = { error: "not found" } as const
/** spec 9.2：global 认知文件只认这 3 个 kind；其它一律 404。 */
const KINDS = new Set(["persona", "wiki", "rule"])
type CogKind = "persona" | "wiki" | "rule"

/** 路径段白名单校验（纵深防御）：段非空、非 "."、非 ".."、不含 "/"。
 *  允许 CJK/空格（URL 里已 encodeURIComponent），只拦目录穿越段。 */
const isSafeSegment = (s: string): boolean => s.length > 0 && s !== "." && s !== ".." && !s.includes("/")

/** 校验 PATCH body：必须是 `{content}` 且 content 为非空字符串，否则返回 undefined。 */
function requireContent(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const c = (body as { content?: unknown }).content
  return typeof c === "string" && c !== "" ? c : undefined
}

/** spec 9.2 的 /memory 路由族：管理记忆塔（项目线文件 + global 认知文件）。 */
export function registerMemoryRoutes(app: FastifyInstance, opts: { memory?: MemorySystem; config?: KclawConfig }): void {
  // 无 memory 装配（createApp 未传 system）时全部 503，不注册会崩的调用。
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: "memory system unavailable" })
  const memory = opts.memory
  const isKind = (k: string): k is CogKind => KINDS.has(k)
  const badSegment = (reply: FastifyReply) => reply.code(400).send({ error: "invalid segment" })

  app.get("/memory/projects", async (_req, reply) => {
    if (memory === undefined) return unavailable(reply)
    return memory.projects()
  })

  app.get("/memory/projects/:id", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { id } = req.params as { id: string }
    if (!isSafeSegment(id)) return badSegment(reply)
    // projectThreads 对不存在的项目返回空数组而非 undefined，用 projects() 判定项目存在。
    if (!memory.projects().some((p) => p.id === id)) return reply.code(404).send(NOT_FOUND)
    return { id, threads: memory.projectThreads(id) }
  })

  app.get("/memory/threads/:project/:topic", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { project, topic } = req.params as { project: string; topic: string }
    if (!isSafeSegment(project) || !isSafeSegment(topic)) return badSegment(reply)
    const content = memory.threadContent(project, topic)
    if (content === undefined) return reply.code(404).send(NOT_FOUND)
    return { content }
  })

  app.patch("/memory/threads/:project/:topic", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { project, topic } = req.params as { project: string; topic: string }
    if (!isSafeSegment(project) || !isSafeSegment(topic)) return badSegment(reply)
    const content = requireContent(req.body)
    if (content === undefined) return reply.code(400).send({ error: "content must be a non-empty string" })
    if (memory.threadContent(project, topic) === undefined) return reply.code(404).send(NOT_FOUND)
    memory.writeThread(project, topic, content)
    return { ok: true }
  })

  app.delete("/memory/threads/:project/:topic", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { project, topic } = req.params as { project: string; topic: string }
    if (!isSafeSegment(project) || !isSafeSegment(topic)) return badSegment(reply)
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
    if (!isSafeSegment(file)) return badSegment(reply)
    const content = memory.cognitionContent(kind, file)
    if (content === undefined) return reply.code(404).send(NOT_FOUND)
    return { content }
  })

  app.patch("/memory/global/:kind/:file", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    const { kind, file } = req.params as { kind: string; file: string }
    if (!isKind(kind)) return reply.code(404).send(NOT_FOUND)
    if (!isSafeSegment(file)) return badSegment(reply)
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
    if (!isSafeSegment(file)) return badSegment(reply)
    // persona 是全局画像，只能清空正文不能删文件（spec 9.2）。
    if (kind === "persona") return reply.code(400).send({ error: "persona 不可删除（可清空正文）" })
    if (memory.cognitionContent(kind, file) === undefined) return reply.code(404).send(NOT_FOUND)
    memory.deleteCognition(kind, file)
    return { ok: true }
  })

  // 手动写入入口（spec 4.2 手动行）：/memory save（CLI/Web）触发当前项目的
  // L0→L1 提取，范围 = 该项目自上次水位以来的新消息（与定时/跟随同一条管线）。
  app.post("/memory/trigger-manual", async (req, reply) => {
    if (memory === undefined) return unavailable(reply)
    // write.manual 是开关（默认开）：关闭时明确拒绝，同 immediate 的"工具在、执行时拒绝"。
    if (opts.config !== undefined && opts.config.memory.write.manual === false) {
      return reply.code(400).send({ error: "手动写入已关闭（memory.write.manual=false），可依赖定时/跟随触发" })
    }
    const body = req.body as { workdir?: unknown; sessionId?: unknown } | null
    const workdir =
      typeof body === "object" && body !== null && typeof body.workdir === "string" && body.workdir !== ""
        ? body.workdir
        : undefined
    // 可选归属会话（Task 7）：触发方（CLI/Web）可指定本次手动写入挂到哪个会话；
    // 缺省回落由 core #recentSessionId 决定。仅接受非空字符串。
    const sessionId =
      typeof body === "object" && body !== null && typeof body.sessionId === "string" && body.sessionId !== ""
        ? body.sessionId
        : undefined
    try {
      await memory.triggerManual(workdir ?? opts.config?.workspace ?? process.cwd(), sessionId)
      return { ok: true }
    } catch (err) {
      return reply.code(500).send({ error: `manual trigger failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  })
}
