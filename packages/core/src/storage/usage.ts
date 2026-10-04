import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Usage } from "../protocol/messages.js"
import type { UsageAgg, UsageTotal } from "../protocol/usage.js"

/** One recorded LLM run's token usage (per-run row). */
export interface UsageRow {
  id: string
  sessionId: string
  runId: string
  model: string
  inputTokens: number
  outputTokens: number
  /** Prompt-cache read tokens; omitted = the provider reported no metric. */
  cacheReadTokens?: number
  /** Prompt-cache write tokens; omitted = the provider reported no metric. */
  cacheWriteTokens?: number
  at: string // ISO-8601
}

/** Which background chore a usage row belongs to (the runId's prefix). */
export type ChoreKind = "compaction" | "autoname" | "memory" | "skill"

/**
 * Metering seam for background chore LLM calls (compaction summaries, session
 * autoname, memory extract/consolidate, skill evolution): call sites that
 * already receive the provider's usage hand it here with their kind. The
 * daemon implements it as a UsageStore row (runId prefixed by the chore,
 * goal-judge rows keep their own shape); omitted (tests, bare engine) = the
 * spend stays unrecorded.
 */
export type ChoreUsageRecorder = (r: {
  chore: ChoreKind
  /** Attributed session; undefined → the daemon skips the row (no owner). */
  sessionId?: string
  model: string
  /** Absent (stream aborted mid-way) → nothing to bill. */
  usage?: Usage
}) => void

/** Price table: USD per 1M tokens per model. Missing entries cost 0. */
export type UsagePrices = Record<string, {
  inputPerM?: number
  outputPerM?: number
  /** Cached-token prices: present → rows WITH cache data cost via the split formula. */
  cacheReadPerM?: number
  cacheWritePerM?: number
}>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
`

interface UsageDbRow {
  id: string
  session_id: string
  run_id: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  at: string
}

/**
 * Cost of a row's tokens under `prices` (USD; missing entries cost 0). When
 * the model declares cache prices AND the row carries any cache metric, cost
 * splits per class: non-cached input (= inputTokens − known cache fields),
 * cache read, cache write, output; a missing cache field counts as 0 tokens
 * (an OpenAI-compatible row has only cacheRead — gating on BOTH fields would
 * bill cached_tokens at full input price forever). Rows without cache data
 * (and old rows) bill total input at the input price — no discount guessing.
 */
export function costUsd(
  row: { inputTokens: number; outputTokens: number; cacheReadTokens?: number | null; cacheWriteTokens?: number | null },
  model: string,
  prices: UsagePrices,
): number {
  const p = prices[model]
  if (p === undefined) return 0
  const hasCachePrices = p.cacheReadPerM !== undefined || p.cacheWritePerM !== undefined
  const hasCacheData = (row.cacheReadTokens ?? null) !== null || (row.cacheWriteTokens ?? null) !== null
  if (hasCachePrices && hasCacheData) {
    const read = row.cacheReadTokens ?? 0
    const write = row.cacheWriteTokens ?? 0
    const nonCachedInput = row.inputTokens - read - write
    return (nonCachedInput / 1_000_000) * (p.inputPerM ?? 0)
      + (read / 1_000_000) * (p.cacheReadPerM ?? 0)
      + (write / 1_000_000) * (p.cacheWritePerM ?? 0)
      + (row.outputTokens / 1_000_000) * (p.outputPerM ?? 0)
  }
  return (row.inputTokens / 1_000_000) * (p.inputPerM ?? 0) + (row.outputTokens / 1_000_000) * (p.outputPerM ?? 0)
}

/** Local calendar date of an ISO timestamp, YYYY-MM-DD (day aggregation key). */
function localDay(at: string): string {
  const d = new Date(at)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/**
 * Append-only per-run token ledger in SQLite (`<home>/usage.db`). Recording is
 * fire-and-forget from the daemon's perspective: callers swallow record
 * errors (usage must never affect a run). Aggregations read over [from, to).
 */
export class UsageStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec(SCHEMA)
    // Pre-existing DBs (created before the cache columns) get them via ALTER;
    // CREATE TABLE IF NOT EXISTS does not extend an existing table.
    const cols = this.db.prepare("PRAGMA table_info(usage)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === "cache_read_tokens")) {
      this.db.exec("ALTER TABLE usage ADD COLUMN cache_read_tokens INTEGER")
    }
    if (!cols.some((c) => c.name === "cache_write_tokens")) {
      this.db.exec("ALTER TABLE usage ADD COLUMN cache_write_tokens INTEGER")
    }
  }

  /** Close the underlying db (daemon stop). */
  close(): void {
    this.db.close()
  }

  record(row: Omit<UsageRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO usage (id, session_id, run_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `u_${row.sessionId}_${row.runId}`,
        row.sessionId,
        row.runId,
        row.model,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens ?? null,
        row.cacheWriteTokens ?? null,
        row.at,
      )
  }

  /** Aggregate by day | session | model over [from, to); cost via the price table. */
  aggregate(
    by: "day" | "session" | "model",
    prices: UsagePrices,
    from?: Date,
    to?: Date,
  ): UsageAgg[] {
    const keyOf = by === "day"
      ? (r: UsageDbRow) => localDay(r.at)
      : by === "session" ? (r: UsageDbRow) => r.session_id : (r: UsageDbRow) => r.model
    const buckets = this.foldRows(this.selectRows(from, to), prices, keyOf)
    return [...buckets.entries()]
      .map(([key, b]) => ({ key, ...b }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  /** Totals over [from, to). */
  total(prices: UsagePrices, from?: Date, to?: Date): UsageTotal {
    // One implicit bucket over the whole range — same fold, same cache
    // semantics, no second hand-kept copy of the walk.
    const buckets = this.foldRows(this.selectRows(from, to), prices, () => "total")
    return buckets.get("total") ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0 }
  }

  /**
   * The one bucket fold both aggregations share: numeric fields sum; a cache
   * field stays null until a row WITH the metric arrives, then sums the known
   * values (unknown rows are skipped, not coerced to 0 — "no data" must never
   * display as "0 hits"). Cost sums per ROW (each row's own model price),
   * whatever the bucket key.
   */
  private foldRows(
    rows: UsageDbRow[],
    prices: UsagePrices,
    keyOf: (r: UsageDbRow) => string,
  ): Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number }> {
    const buckets = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheWriteTokens: number | null; costUsd: number }>()
    for (const r of rows) {
      const key = keyOf(r)
      const b = buckets.get(key) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0 }
      b.inputTokens += r.input_tokens
      b.outputTokens += r.output_tokens
      if (r.cache_read_tokens !== null) b.cacheReadTokens = (b.cacheReadTokens ?? 0) + r.cache_read_tokens
      if (r.cache_write_tokens !== null) b.cacheWriteTokens = (b.cacheWriteTokens ?? 0) + r.cache_write_tokens
      b.costUsd += costUsd(
        {
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheWriteTokens: r.cache_write_tokens,
        },
        r.model,
        prices,
      )
      buckets.set(key, b)
    }
    return buckets
  }

  private selectRows(from?: Date, to?: Date): UsageDbRow[] {
    let sql = "SELECT * FROM usage"
    const params: string[] = []
    const clauses: string[] = []
    if (from !== undefined) {
      clauses.push("at >= ?")
      params.push(from.toISOString())
    }
    if (to !== undefined) {
      clauses.push("at < ?")
      params.push(to.toISOString())
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`
    return this.db.prepare(sql).all(...params) as UsageDbRow[]
  }
}
