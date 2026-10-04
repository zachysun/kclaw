/**
 * The usage REST shapes (GET /usage): the single type source for the daemon
 * route and the web usage views. Types only — browser-safe via the
 * @kclaw/core/protocol subpath (same rule as every file here).
 */

/**
 * One aggregation bucket. The cache fields are `number | null` — null means
 * NO row in the bucket carried the metric (unknown, displayed as "—", never
 * as 0); a number is the sum of the known values.
 */
export interface UsageAgg {
  key: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  costUsd: number
}

/** Totals over the queried range (same cache semantics as the buckets). */
export interface UsageTotal {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  costUsd: number
}

/** GET /usage response body. */
export interface UsageBody {
  by: "day" | "session" | "model"
  buckets: UsageAgg[]
  total: UsageTotal
}
