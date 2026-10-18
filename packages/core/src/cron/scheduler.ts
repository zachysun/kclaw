import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import cronParser from "cron-parser"
import { newId } from "../protocol/ids.js"

/** Outcome of the last run of a cron, recorded by `markRun`. */
export type CronStatus = "ok" | "error"

/** A scheduled prompt: cron + prompt, persisted in SQLite. */
export interface Cron {
  id: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
  nextRunAt: string // ISO-8601
  lastRunAt?: string // ISO-8601
  lastStatus?: CronStatus
  lastError?: string
  /** Optional per-cron model override (empty/absent → daemon default). */
  model?: string
}

export interface CreateCronInput {
  name: string
  cron: string
  prompt: string
  model?: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  model TEXT
);
`

interface CronRow {
  id: string
  name: string
  cron: string
  prompt: string
  enabled: number
  next_run_at: string
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  model: string | null
}

/**
 * First cron occurrence strictly after `after` (cron-parser's `next()` is
 * exclusive of `currentDate`, even at an exact match). Invalid cron throws
 * with cron-parser's own message, untouched.
 */
function nextIsoAfter(cron: string, after: Date): string {
  return cronParser.parseExpression(cron, { currentDate: after }).next().toISOString()
}

function toCron(row: CronRow): Cron {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: (row.last_status as CronStatus | null) ?? undefined,
    model: row.model ?? undefined,
    lastError: row.last_error ?? undefined,
  }
}

/**
 * Persistent cron scheduler. All state lives in one SQLite
 * `crons` table; every instance opens the same file and sees the same rows,
 * so the daemon can tick with a fresh handle. Times are ISO strings
 * (lexicographic = chronological, so `due` compares them in SQL).
 */
export class CronScheduler {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec(SCHEMA)
    // Pre-existing DBs (created before the model column) get it via ALTER.
    const cols = this.db.prepare("PRAGMA table_info(crons)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === "model")) {
      this.db.exec("ALTER TABLE crons ADD COLUMN model TEXT")
    }
  }

  private getRow(id: string): CronRow | undefined {
    return this.db.prepare("SELECT * FROM crons WHERE id = ?").get(id) as CronRow | undefined
  }

  /** Insert a cron; `nextRunAt` is the next cron occurrence after now. */
  create(input: CreateCronInput): Cron {
    const cron: Cron = {
      id: newId("cron"),
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      enabled: true,
      nextRunAt: nextIsoAfter(input.cron, new Date()),
      ...(input.model !== undefined ? { model: input.model } : {}),
    }
    this.db
      .prepare(
        `INSERT INTO crons (id, name, cron, prompt, enabled, next_run_at, model) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(cron.id, cron.name, cron.cron, cron.prompt, 1, cron.nextRunAt, cron.model ?? null)
    return cron
  }

  /** All crons in creation (id/ULID) order. */
  list(): Cron[] {
    const rows = this.db.prepare("SELECT * FROM crons ORDER BY id").all() as CronRow[]
    return rows.map(toCron)
  }

  get(id: string): Cron | undefined {
    const row = this.getRow(id)
    return row === undefined ? undefined : toCron(row)
  }

  /**
   * Apply a partial patch. Changing `cron` recalculates `nextRunAt` from now
   * (invalid cron throws, cron-parser message passthrough); any other field —
   * including `nextRunAt` itself — is written as given (tests back-date with it).
   */
  update(id: string, patch: Partial<Cron>): Cron | undefined {
    const row = this.getRow(id)
    if (row === undefined) return undefined
    const next: Cron = {
      ...toCron(row),
      ...patch,
      nextRunAt: patch.cron !== undefined && patch.nextRunAt === undefined
        ? nextIsoAfter(patch.cron, new Date())
        : (patch.nextRunAt ?? row.next_run_at),
    }
    this.db
      .prepare(
        `UPDATE crons SET name = ?, cron = ?, prompt = ?, enabled = ?, next_run_at = ?,
           last_run_at = ?, last_status = ?, last_error = ?, model = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.cron,
        next.prompt,
        next.enabled ? 1 : 0,
        next.nextRunAt,
        next.lastRunAt ?? null,
        next.lastStatus ?? null,
        next.lastError ?? null,
        next.model ?? null,
        id,
      )
    return next
  }

  /** True if the cron existed and was deleted. */
  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM crons WHERE id = ?").run(id).changes > 0
  }

  /** Enabled crons whose `nextRunAt` has passed (ISO string compare = time compare). */
  due(now: Date): Cron[] {
    const rows = this.db
      .prepare("SELECT * FROM crons WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at")
      .all(now.toISOString()) as CronRow[]
    return rows.map(toCron)
  }

  /**
   * Atomically claim every enabled cron whose next_run_at has passed:
   * each row's next_run_at is advanced (skipping any backlog of missed
   * fire times) inside one transaction, and only rows whose CAS update
   * affected exactly one row are returned. Claim-then-execute means a
   * crash mid-run cannot re-fire the cron on restart, and a second handle
   * on the same db can never double-claim.
   */
  claimDue(now: Date): Cron[] {
    const claim = this.db.transaction((rows: CronRow[]): Cron[] => {
      const claimed: Cron[] = []
      for (const row of rows) {
        const next = nextIsoAfter(row.cron, now)
        const res = this.db
          .prepare(
            "UPDATE crons SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at <= ?",
          )
          .run(next, row.id, now.toISOString())
        if (res.changes === 1) claimed.push(toCron({ ...row, next_run_at: next }))
      }
      return claimed
    })
    const rows = this.db
      .prepare("SELECT * FROM crons WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at")
      .all(now.toISOString()) as CronRow[]
    return claim(rows)
  }

  /**
   * Record a run's outcome (lastRunAt/lastStatus/lastError; `lastError`
   * cleared on "ok"). next_run_at is NOT touched — claimDue advanced it
   * when the run was claimed. No-op if the cron is gone.
   */
  markRun(id: string, status: CronStatus, now: Date, error?: string): void {
    this.db
      .prepare(`UPDATE crons SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?`)
      .run(now.toISOString(), status, error ?? null, id)
  }
}
