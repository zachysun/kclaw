import type { FastifyInstance } from "fastify"
import { BUILTIN_HOOK_SPECS, type HookRegistry } from "@kclaw/core"

/**
 * /hooks 路由族（spec issue #6）：只读 hook 管理面。builtin = 引擎内置钩子
 * 的静态清单（迁移进位置网格的循环行为），user = HookRegistry 的现况
 * （健康/停用/装载失败，失败带原因）。每次请求读 registry 的当前账本，
 * 与 run 时的装载同源。
 */
export function registerHookRoutes(app: FastifyInstance, opts: { hooks?: HookRegistry }): void {
  app.get("/hooks", async () => {
    return {
      builtin: BUILTIN_HOOK_SPECS.map((s) => ({ ...s, origin: "builtin" as const })),
      user: opts.hooks?.list() ?? [],
    }
  })
}
