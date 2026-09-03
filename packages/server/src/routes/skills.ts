import type { FastifyInstance, FastifyReply } from "fastify"
import { isModelVisible, isUserVisible, scanSkillDirs, type KclawPaths, type SkillRecord } from "@kclaw/core"
import { join } from "node:path"

const NOT_FOUND = { error: "not found" } as const

/** 路径段白名单校验（纵深防御，同 /memory 路由族）：拦目录穿越段。 */
const isSafeSegment = (s: string): boolean => s.length > 0 && s !== "." && s !== ".." && !s.includes("/")

/** 用户可见技能的档位标签：all（模型+用户）| user-only（disable-model-invocation）。 */
function visibilityOf(s: SkillRecord): "all" | "user-only" {
  return isModelVisible(s) ? "all" : "user-only"
}

/**
 * /skills 路由族：只读技能管理面（CLI /skill 与 Web 技能页的共同后端）。
 * 每次请求现扫全局 <home>/skills + 可选 workdir 的 .kclaw/skills（项目级
 * 覆盖全局），与 run 时的注入同源同规则；user-invocable:false 的技能对
 * 用户面不存在（列表不显示、点名 404，对齐 Claude Code"从 / 菜单隐藏"）。
 */
export function registerSkillRoutes(app: FastifyInstance, opts: { paths: KclawPaths }): void {
  const scan = (workdir: string | undefined) =>
    scanSkillDirs({
      global: opts.paths.skillsDir,
      project: workdir !== undefined && workdir.trim() !== "" ? join(workdir, ".kclaw", "skills") : undefined,
    })

  app.get("/skills", async (req) => {
    const { workdir } = req.query as { workdir?: string }
    return scan(workdir)
      .filter(isUserVisible)
      .map((s) => ({ name: s.name, displayName: s.displayName, description: s.description, visibility: visibilityOf(s), origin: s.origin }))
  })

  app.get("/skills/:name", async (req, reply: FastifyReply) => {
    const { name } = req.params as { name: string }
    const { workdir } = req.query as { workdir?: string }
    if (!isSafeSegment(name)) return reply.code(400).send({ error: "invalid segment" })
    const skill = scan(workdir).find((s) => s.name === name)
    // user-invocable:false → 用户面视为不存在（404 与未知名字同响应，不泄露存在性）
    if (skill === undefined || !isUserVisible(skill)) return reply.code(404).send(NOT_FOUND)
    return { name: skill.name, displayName: skill.displayName, description: skill.description, visibility: visibilityOf(skill), origin: skill.origin, content: skill.body }
  })
}
