import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import cronParser from "cron-parser"
import { newId } from "../protocol/ids.js"

/** Outcome of the last run of a job, recorded by `markRun`. */
export type JobStatus = "ok" | "error"

/** A scheduled prompt: cron + prompt, persisted in SQLite. */
export interface Job {
  id: string
  name: string
  cron: string
  prompt: string
  enabled: boolean
  nextRunAt: string // ISO-8601
  lastRunAt?: string // ISO-8601
  lastStatus?: JobStatus
  lastError?: string
  /** Optional per-job model override (empty/absent → daemon default). */
  model?: string
}

export interface CreateJobInput {
  name: string
  cron: string
  prompt: string
  model?: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
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

interface JobRow {
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

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: (row.last_status as JobStatus | null) ?? undefined,
    model: row.model ?? undefined,
    lastError: row.last_error ?? undefined,
  }
}

/**
 * Persistent cron scheduler. All state lives in one SQLite
 * `jobs` table; every instance opens the same file and sees the same rows,
 * so the daemon can tick with a fresh handle. Times are ISO strings
 * (lexicographic = chronological, so `due` compares them in SQL).
 */
export class JobScheduler {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec(SCHEMA)
    // Pre-existing DBs (created before the model column) get it via ALTER.
    const cols = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === "model")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN model TEXT")
    }
  }

  private getRow(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined
  }

  /** Insert a job; `nextRunAt` is the next cron occurrence after now. */
  create(input: CreateJobInput): Job {
    const job: Job = {
      id: newId("job"),
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      enabled: true,
      nextRunAt: nextIsoAfter(input.cron, new Date()),
      ...(input.model !== undefined ? { model: input.model } : {}),
    }
    this.db
      .prepare(
        `INSERT INTO jobs (id, name, cron, prompt, enabled, next_run_at, model) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(job.id, job.name, job.cron, job.prompt, 1, job.nextRunAt, job.model ?? null)
    return job
  }

  /** All jobs in creation (id/ULID) order. */
  list(): Job[] {
    const rows = this.db.prepare("SELECT * FROM jobs ORDER BY id").all() as JobRow[]
    return rows.map(toJob)
  }

  get(id: string): Job | undefined {
    const row = this.getRow(id)
    return row === undefined ? undefined : toJob(row)
  }

  /**
   * Apply a partial patch. Changing `cron` recalculates `nextRunAt` from now
   * (invalid cron throws, cron-parser message passthrough); any other field —
   * including `nextRunAt` itself — is written as given (tests back-date with it).
   */
  update(id: string, patch: Partial<Job>): Job | undefined {
    const row = this.getRow(id)
    if (row === undefined) return undefined
    const next: Job = {
      ...toJob(row),
      ...patch,
      nextRunAt: patch.cron !== undefined && patch.nextRunAt === undefined
        ? nextIsoAfter(patch.cron, new Date())
        : (patch.nextRunAt ?? row.next_run_at),
    }
    this.db
      .prepare(
        `UPDATE jobs SET name = ?, cron = ?, prompt = ?, enabled = ?, next_run_at = ?,
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

  /** True if the job existed and was deleted. */
  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes > 0
  }

  /** Enabled jobs whose `nextRunAt` has passed (ISO string compare = time compare). */
  due(now: Date): Job[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at")
      .all(now.toISOString()) as JobRow[]
    return rows.map(toJob)
  }

  /**
   * Atomically claim every enabled job whose next_run_at has passed:
   * each row's next_run_at is advanced (skipping any backlog of missed
   * fire times) inside one transaction, and only rows whose CAS update
   * affected exactly one row are returned. Claim-then-execute means a
   * crash mid-run cannot re-fire the job on restart, and a second handle
   * on the same db can never double-claim.
   */
  claimDue(now: Date): Job[] {
    const claim = this.db.transaction((rows: JobRow[]): Job[] => {
      const claimed: Job[] = []
      for (const row of rows) {
        const next = nextIsoAfter(row.cron, now)
        const res = this.db
          .prepare(
            "UPDATE jobs SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at <= ?",
          )
          .run(next, row.id, now.toISOString())
        if (res.changes === 1) claimed.push(toJob({ ...row, next_run_at: next }))
      }
      return claimed
    })
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at")
      .all(now.toISOString()) as JobRow[]
    return claim(rows)
  }

  /**
   * Record a run's outcome (lastRunAt/lastStatus/lastError; `lastError`
   * cleared on "ok"). next_run_at is NOT touched — claimDue advanced it
   * when the run was claimed. No-op if the job is gone.
   */
  markRun(id: string, status: JobStatus, now: Date, error?: string): void {
    this.db
      .prepare(`UPDATE jobs SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?`)
      .run(now.toISOString(), status, error ?? null, id)
  }
}
