import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** One recorded LLM run's token usage (per-run row). */
export interface UsageRow {
  id: string
  sessionId: string
  runId: string
  model: string
  inputTokens: number
  outputTokens: number
  at: string // ISO-8601
}

/** Aggregation bucket: key is the day (local), session or model. */
export interface UsageAgg {
  key: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

/** Price table: USD per 1M tokens per model. Missing entries cost 0. */
export type UsagePrices = Record<string, { inputPerM?: number; outputPerM?: number }>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
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
  at: string
}

/** Cost of a row's tokens under `prices` (USD; missing entries cost 0). */
export function costUsd(row: { inputTokens: number; outputTokens: number }, model: string, prices: UsagePrices): number {
  const p = prices[model]
  if (p === undefined) return 0
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
  }

  /** Close the underlying db (daemon stop). */
  close(): void {
    this.db.close()
  }

  record(row: Omit<UsageRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO usage (id, session_id, run_id, model, input_tokens, output_tokens, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`u_${row.sessionId}_${row.runId}`, row.sessionId, row.runId, row.model, row.inputTokens, row.outputTokens, row.at)
  }

  /** Aggregate by day | session | model over [from, to); cost via the price table. */
  aggregate(
    by: "day" | "session" | "model",
    prices: UsagePrices,
    from?: Date,
    to?: Date,
  ): UsageAgg[] {
    const rows = this.selectRows(from, to)
    const buckets = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number }>()
    for (const r of rows) {
      const key = by === "day" ? localDay(r.at) : by === "session" ? r.session_id : r.model
      const b = buckets.get(key) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
      b.inputTokens += r.input_tokens
      b.outputTokens += r.output_tokens
      // Cost sums per ROW (each row's own model price), whatever the bucket key.
      b.costUsd += costUsd({ inputTokens: r.input_tokens, outputTokens: r.output_tokens }, r.model, prices)
      buckets.set(key, b)
    }
    return [...buckets.entries()]
      .map(([key, b]) => ({ key, ...b }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  /** Totals over [from, to). */
  total(prices: UsagePrices, from?: Date, to?: Date): { inputTokens: number; outputTokens: number; costUsd: number } {
    const rows = this.selectRows(from, to)
    let inputTokens = 0
    let outputTokens = 0
    let cost = 0
    for (const r of rows) {
      inputTokens += r.input_tokens
      outputTokens += r.output_tokens
      cost += costUsd({ inputTokens: r.input_tokens, outputTokens: r.output_tokens }, r.model, prices)
    }
    return { inputTokens, outputTokens, costUsd: cost }
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
