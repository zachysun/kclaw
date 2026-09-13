import type { FastifyInstance, FastifyReply } from "fastify"
import {
  applyReuseTiers,
  backfillPluginAttribution,
  createSkillLink,
  discoveredTargetPaths,
  discoverSkills,
  isModelVisible,
  isUserVisible,
  previewSkillBody,
  readLinksFile,
  removeDiscoverySource,
  removeSkillLink,
  resolveDiscoverySources,
  scanSkillDirs,
  setSkillLinkTier,
  addDiscoverySource,
  type KclawPaths,
  type ReuseAgent,
  type ReuseTier,
  type SkillRecord,
} from "@kclaw/core"
import { realpathSync } from "node:fs"
import { join } from "node:path"

const NOT_FOUND = { error: "not found" } as const

/** 路径段白名单校验（纵深防御，同 /memory 路由族）：拦目录穿越段。 */
const isSafeSegment = (s: string): boolean => s.length > 0 && s !== "." && s !== ".." && !s.includes("/")

/** 用户可见技能的档位标签：all（模型+用户）| user-only（disable-model-invocation）。 */
function visibilityOf(s: SkillRecord): "all" | "user-only" {
  return isModelVisible(s) ? "all" : "user-only"
}

/**
 * /skills 路由族：技能管理面（CLI /skill 与 Web 技能页的共同后端）。
 * 每次请求现扫全局 <home>/skills + 可选 workdir 的 .kclaw/skills（项目级
 * 覆盖全局），与 run 时的注入同源同规则；复用技能（软链接接入）的可见
 * 档位由 .links.json 按 realpath 覆盖，与 run 装配共用同一覆盖函数。
 * user-invocable:false 的技能对用户面不存在（列表不显示、点名 404，对齐
 * Claude Code"从 / 菜单隐藏"）；复用链接的管理记录直接从 .links.json 读，
 * 不受该过滤影响（否则"仅模型"档在页面上消失后无法改回；管理面本身持
 * token 鉴权）。
 */
export function registerSkillRoutes(app: FastifyInstance, opts: { paths: KclawPaths; builtinSources?: { agent: string; dir: string }[]; pluginHomes?: { agent: string; home: string }[] }): void {
  const builtin = opts.builtinSources
  const pluginHomes = opts.pluginHomes
  const projectSkillsDir = (workdir: string | undefined): string | undefined =>
    workdir !== undefined && workdir.trim() !== "" ? join(workdir, ".kclaw", "skills") : undefined

  const scan = (workdir: string | undefined): SkillRecord[] => {
    const project = projectSkillsDir(workdir)
    return applyReuseTiers(
      scanSkillDirs({ global: opts.paths.skillsDir, project }),
      [readLinksFile(opts.paths.skillsDir), project !== undefined ? readLinksFile(project) : { links: [], extraSources: [] }],
    )
  }

  /** 写操作的 scope 目录：workdir 必须是绝对路径，防拼接逃逸。 */
  const writeScopeDir = (workdir: string | undefined): string | undefined => {
    if (workdir === undefined || workdir.trim() === "") return opts.paths.skillsDir
    const wd = workdir.trim()
    if (!wd.startsWith("/")) return undefined
    return join(wd, ".kclaw", "skills")
  }

  app.get("/skills", async (req) => {
    const { workdir } = req.query as { workdir?: string }
    return scan(workdir)
      .filter(isUserVisible)
      .map((s) => ({ name: s.name, displayName: s.displayName, description: s.description, visibility: visibilityOf(s), origin: s.origin, plugin: s.plugin }))
  })

  app.get("/skills/:name", async (req, reply: FastifyReply) => {
    const { name } = req.params as { name: string }
    const { workdir } = req.query as { workdir?: string }
    if (!isSafeSegment(name)) return reply.code(400).send({ error: "invalid segment" })
    const skill = scan(workdir).find((s) => s.name === name)
    // user-invocable:false → 用户面视为不存在（404 与未知名字同响应，不泄露存在性）
    if (skill === undefined || !isUserVisible(skill)) return reply.code(404).send(NOT_FOUND)
    return { name: skill.name, displayName: skill.displayName, description: skill.description, visibility: visibilityOf(skill), origin: skill.origin, plugin: skill.plugin, content: skill.body }
  })

  // ---- 复用管理面（写操作，均经持 token 鉴权中间件） ----------------------

  app.get("/skills/links", async (req, reply: FastifyReply) => {
    const { workdir } = req.query as { workdir?: string }
    const dir = writeScopeDir(workdir)
    if (dir === undefined) return reply.code(400).send({ error: "workdir must be an absolute path" })
    // 旧记录（归属字段出现前建的）惰性回填：目标能匹配到已安装插件就补名。
    backfillPluginAttribution({ skillsDir: dir, pluginHomes })
    const file = readLinksFile(dir)
    // current = 该链接的目标仍是探测正在提供的版本（realpath 命中）；插件
    // 升级换版本目录后旧链接仍可用但过时，页面据此刻"过时"标。
    const current = discoveredTargetPaths({ skillsDir: opts.paths.skillsDir, builtin, pluginHomes })
    const links = file.links.map((l) => {
      let real: string | undefined
      try {
        real = realpathSync(l.target)
      } catch {
        real = undefined
      }
      return { ...l, current: real !== undefined && current.has(real) }
    })
    return { links, extraSources: file.extraSources }
  })

  app.get("/skills/discovery", async (req) => {
    const { workdir } = req.query as { workdir?: string }
    const project = projectSkillsDir(workdir)
    return {
      sources: resolveDiscoverySources(opts.paths.skillsDir, builtin),
      skills: discoverSkills({
        skillsDir: opts.paths.skillsDir,
        owned: scan(workdir),
        builtin,
        pluginHomes,
        // 项目 scope 里已建的链接也计入 reused 判定（探测锚在全局）
        extraLinksScopes: project !== undefined ? [readLinksFile(project)] : [],
      }),
      // 项目 scope 自身注册的 extraSources（与全局分开列出，便于分 scope 管理）
      projectSources: project !== undefined ? resolveDiscoverySources(project, []).filter((s) => s.agent === "custom") : [],
    }
  })

  app.post("/skills/discovery/preview", async (req, reply: FastifyReply) => {
    const body = req.body as { path?: unknown } | null
    const path = body?.path
    if (typeof path !== "string" || path.trim() === "") return reply.code(400).send({ error: "path is required" })
    const result = previewSkillBody({ skillsDir: opts.paths.skillsDir, path: path.trim(), builtin })
    if (!result.ok) return reply.code(404).send({ error: result.error })
    return result
  })

  const TIERS: readonly ReuseTier[] = ["all", "user", "model", "off"]
  const AGENTS: readonly ReuseAgent[] = ["claude", "codex", "dsh", "zcode", "custom"]

  app.post("/skills/links", async (req, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | null
    const name = typeof body?.name === "string" ? body.name : ""
    const target = typeof body?.target === "string" ? body.target.trim() : ""
    const agent = typeof body?.agent === "string" && AGENTS.includes(body.agent as ReuseAgent) ? (body.agent as ReuseAgent) : "custom"
    const tier = typeof body?.tier === "string" && TIERS.includes(body.tier as ReuseTier) ? (body.tier as ReuseTier) : "all"
    const plugin = typeof body?.plugin === "string" && body.plugin.trim() !== "" ? body.plugin.trim() : undefined
    const workdir = typeof body?.workdir === "string" ? body.workdir : undefined
    const dir = writeScopeDir(workdir)
    if (dir === undefined) return reply.code(400).send({ error: "workdir must be an absolute path" })
    if (!isSafeSegment(name)) return reply.code(400).send({ error: "invalid skill name" })
    if (!target.startsWith("/")) return reply.code(400).send({ error: "target must be an absolute path" })
    // 同名自有技能：realpath 与目标一致 = 已复用（重复创建），不同 = 真冲突，
    // 都 409 但文案区分。
    const owned = scan(workdir).find((s) => s.name === name)
    if (owned !== undefined) {
      let ownedReal: string | undefined
      try {
        ownedReal = realpathSync(owned.dir)
      } catch {
        ownedReal = undefined
      }
      let realTarget = target
      try {
        realTarget = realpathSync(target)
      } catch {
        // 不存在的 target 由 core 的创建校验报 400，这里按原值比较即可。
      }
      const conflict = ownedReal !== realTarget
      return reply.code(409).send({
        error: conflict ? `name already taken by a different skill: ${name}` : `already reused under this name: ${name}`,
      })
    }
    const result = createSkillLink({ skillsDir: dir, name, target, agent, tier, plugin })
    if (!result.ok) return reply.code(result.error.startsWith("already reused") ? 409 : 400).send({ error: result.error })
    reply.code(201)
    return { ok: true }
  })

  app.patch("/skills/links/:name", async (req, reply: FastifyReply) => {
    const { name } = req.params as { name: string }
    const body = req.body as Record<string, unknown> | null
    const tier = body?.tier
    const workdir = typeof body?.workdir === "string" ? body.workdir : undefined
    const dir = writeScopeDir(workdir)
    if (dir === undefined) return reply.code(400).send({ error: "workdir must be an absolute path" })
    if (!isSafeSegment(name)) return reply.code(400).send({ error: "invalid segment" })
    if (typeof tier !== "string" || !TIERS.includes(tier as ReuseTier)) return reply.code(400).send({ error: "tier must be one of all|user|model|off" })
    const result = setSkillLinkTier({ skillsDir: dir, name, tier: tier as ReuseTier })
    if (!result.ok) return reply.code(result.error === "no such link record" ? 404 : 400).send({ error: result.error })
    return { ok: true }
  })

  app.delete("/skills/links/:name", async (req, reply: FastifyReply) => {
    const { name } = req.params as { name: string }
    const { workdir } = req.query as { workdir?: string }
    const dir = writeScopeDir(workdir)
    if (dir === undefined) return reply.code(400).send({ error: "workdir must be an absolute path" })
    if (!isSafeSegment(name)) return reply.code(400).send({ error: "invalid segment" })
    const result = removeSkillLink({ skillsDir: dir, name })
    if (!result.ok) return reply.code(result.error === "no such link record" ? 404 : 400).send({ error: result.error })
    return { ok: true }
  })

  app.post("/skills/sources", async (req, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | null
    const dir = typeof body?.dir === "string" ? body.dir.trim() : ""
    const workdir = typeof body?.workdir === "string" ? body.workdir : undefined
    const scopeDir = writeScopeDir(workdir)
    if (scopeDir === undefined) return reply.code(400).send({ error: "workdir must be an absolute path" })
    if (dir === "" || !dir.startsWith("/")) return reply.code(400).send({ error: "dir must be an absolute path" })
    const result = addDiscoverySource({ skillsDir: scopeDir, dir })
    if (!result.ok) return reply.code(409).send({ error: result.error })
    reply.code(201)
    return { ok: true }
  })

  app.delete("/skills/sources", async (req, reply: FastifyReply) => {
    const { dir, workdir } = req.query as { dir?: string; workdir?: string }
    const scopeDir = writeScopeDir(workdir)
    if (scopeDir === undefined) return reply.code(400).send({ error: "workdir must be an absolute path" })
    if (typeof dir !== "string" || dir.trim() === "") return reply.code(400).send({ error: "dir is required" })
    const result = removeDiscoverySource({ skillsDir: scopeDir, dir: dir.trim() })
    if (!result.ok) return reply.code(404).send({ error: result.error })
    return { ok: true }
  })
}
