import type { FastifyInstance } from "fastify"
import { isValidDailyHour, isValidDailyIntervalDays, saveConfig, type KclawConfig, type KclawPaths } from "@kclaw/core"

/** Store dependencies for the config route (injected by createApp). */
export interface ConfigStores {
  config: KclawConfig
  /** 持久化路径：PATCH 写回 config.json 用（GET 不需要）。 */
  paths?: KclawPaths
}

/**
 * Mask a secret for display: `"***" + <last 4 chars>` when at least 4 chars
 * long, plain `"***"` otherwise (also for the empty string). Never throws.
 */
export function maskSecret(secret: string): string {
  return secret.length < 4 ? "***" : `***${secret.slice(-4)}`
}

/**
 * Return a sanitized deep copy of `config`: every provider entry's `apiKey`
 * and `web.tavilyApiKey` are masked, everything else passes through as-is.
 * The input object is never mutated (the copy is made before masking).
 */
export function sanitizeConfig(config: KclawConfig): KclawConfig {
  const safe = structuredClone(config)
  for (const entry of Object.values(safe.providers.entries)) {
    entry.apiKey = maskSecret(entry.apiKey)
  }
  safe.web.tavilyApiKey = maskSecret(safe.web.tavilyApiKey)
  return safe
}

/**
 * Register the config routes: `GET /config` returns the sanitized
 * configuration; `PATCH /config` accepts a whitelisted subset of the config
 * (`daily.hour` / `daily.intervalDays`, the daily tab's settings control),
 * mutates the live config in place (the scheduler reads it each sweep, so
 * changes hot-apply) and persists through saveConfig. The parent app's
 * bearer-token auth hook still applies to both routes.
 */
export function registerConfigRoutes(app: FastifyInstance, stores: ConfigStores): void {
  app.get("/config", async () => sanitizeConfig(stores.config))

  app.patch("/config", async (req, reply) => {
    if (stores.paths === undefined) {
      return reply.code(503).send({ error: "config persistence unavailable" })
    }
    const body = req.body as { daily?: unknown } | null
    if (typeof body !== "object" || body === null || typeof body.daily !== "object" || body.daily === null) {
      return reply.code(400).send({ error: "body must be { daily: { hour, intervalDays } }" })
    }
    const daily = body.daily as { hour?: unknown; intervalDays?: unknown }
    // 合法域的单一出处在 core（isValidDailyHour/isValidDailyIntervalDays）：
    // hour 负整数 = 关闭、不超 23 的整数 = 时刻；intervalDays 正整数。
    if (!isValidDailyHour(daily.hour)) {
      return reply.code(400).send({ error: "hour must be an integer (0-23, negative disables daily)" })
    }
    if (!isValidDailyIntervalDays(daily.intervalDays)) {
      return reply.code(400).send({ error: "intervalDays must be a positive integer" })
    }
    stores.config.daily = { hour: daily.hour, intervalDays: daily.intervalDays }
    saveConfig(stores.paths, stores.config)
    return { ok: true, daily: stores.config.daily }
  })
}
