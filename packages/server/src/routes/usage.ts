import type { FastifyInstance } from "fastify"
import type { KclawConfig, UsagePrices, UsageStore } from "@kclaw/core"

/** Dependencies for the usage routes (injected by createApp). */
export interface UsageStores {
  usage: UsageStore
  config: KclawConfig
}

const BY = new Set(["day", "session", "model"])

/**
 * Register `GET /usage?by=day|session|model` — token/cost aggregation for
 * the WebUI usage view. `by` defaults to "day". Returns `{ by, buckets,
 * total }`; costs are computed from config.usage.prices (0 without a price).
 */
export function registerUsageRoutes(app: FastifyInstance, opts: UsageStores): void {
  app.get("/usage", async (request) => {
    const by = (request.query as Record<string, unknown>).by
    const key = typeof by === "string" && BY.has(by) ? (by as "day" | "session" | "model") : "day"
    const prices: UsagePrices = opts.config.usage?.prices ?? {}
    return {
      by: key,
      buckets: opts.usage.aggregate(key, prices),
      total: opts.usage.total(prices),
    }
  })
}
