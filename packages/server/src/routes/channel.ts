/**
 * IM Channel admin routes (#46): the config/status snapshot for the WebUI
 * "IM Channel" tab plus the hot-config action family (save = persist + hot
 * restart, test credentials, one-click allowlist). Without a manager
 * assembly the actions answer 503 (the /mcp precedent) while the snapshot
 * stays disabled. The secret never appears in any response — only the
 * `appSecretSet` boolean does ("leave empty to keep" semantics).
 */
import type { FastifyInstance } from "fastify"
import type { FeishuDraft, FeishuSnapshot } from "../feishu/manager.js"
import type { CredentialCheck } from "../feishu/verify.js"

/** What the routes need from the channel manager (the FeishuManager surface). */
export interface ChannelRoutesView {
  snapshot(): FeishuSnapshot
  save(draft: FeishuDraft): Promise<FeishuSnapshot>
  allowAdd(openId: string): Promise<FeishuSnapshot>
  testCredentials(appId: string, appSecret?: string): Promise<CredentialCheck>
}

export interface ChannelRoutesDeps {
  channel?: ChannelRoutesView
}

const DISABLED_SNAPSHOT: FeishuSnapshot = {
  config: { enabled: false, appId: "", appSecretSet: false, allowlist: [] },
  status: { state: "disabled" },
  pendingSenders: [],
}

interface OpenIdParams {
  openId: string
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRoutesDeps): void {
  app.get("/channel", async () => deps.channel?.snapshot() ?? DISABLED_SNAPSHOT)

  app.post("/channel/config", async (request, reply) => {
    if (deps.channel === undefined) return reply.code(503).send({ error: "channel not assembled" })
    const body = request.body as Partial<FeishuDraft> | null | undefined
    if (typeof body?.enabled !== "boolean" || typeof body?.appId !== "string" || !Array.isArray(body?.allowlist)) {
      return reply.code(400).send({ error: "enabled (boolean), appId (string) and allowlist (string[]) are required" })
    }
    if (body.appSecret !== undefined && typeof body.appSecret !== "string") {
      return reply.code(400).send({ error: "appSecret must be a string when present" })
    }
    if (body.primaryOpenId !== undefined && typeof body.primaryOpenId !== "string") {
      return reply.code(400).send({ error: "primaryOpenId must be a string when present" })
    }
    try {
      return await deps.channel.save(body as FeishuDraft)
    } catch (e) {
      return reply.code(400).send({ error: message(e) })
    }
  })

  app.post("/channel/test", async (request, reply) => {
    if (deps.channel === undefined) return reply.code(503).send({ error: "channel not assembled" })
    const body = request.body as { appId?: unknown; appSecret?: unknown } | null | undefined
    if (typeof body?.appId !== "string") {
      return reply.code(400).send({ error: "appId (string) is required" })
    }
    if (body.appSecret !== undefined && typeof body.appSecret !== "string") {
      return reply.code(400).send({ error: "appSecret must be a string when present" })
    }
    return deps.channel.testCredentials(body.appId, body.appSecret)
  })

  app.post("/channel/allowlist/:openId", async (request, reply) => {
    if (deps.channel === undefined) return reply.code(503).send({ error: "channel not assembled" })
    const { openId } = request.params as OpenIdParams
    if (openId.trim() === "") return reply.code(400).send({ error: "openId is required" })
    try {
      return await deps.channel.allowAdd(openId)
    } catch (e) {
      return reply.code(400).send({ error: message(e) })
    }
  })
}
