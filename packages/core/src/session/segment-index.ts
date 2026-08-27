// packages/core/src/session/segment-index.ts
import Database from "better-sqlite3"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { ftsQuery, tokenize } from "../text/fts.js"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS segments (
  upto TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(text);
`

export interface SegmentEntry { upto: string; body: string; summary: string }
export interface SegmentHit { upto: string; summary: string; excerpt: string }

/** ±150 chars around the first token hit; head of the body as fallback. */
function excerptOf(body: string, tokens: string[]): string {
  for (const t of tokens) {
    const i = body.indexOf(t)
    if (i >= 0) return body.slice(Math.max(0, i - 150), i + 150)
  }
  return body.slice(0, 300)
}

/**
 * Per-session FTS5 index over compacted segments (spec 6.4.1). Purely
 * derived state: deletable at any time, rebuildable via ensure().
 */
export class SegmentIndex {
  private readonly db: Database.Database

  private constructor(db: Database.Database) {
    this.db = db
  }

  static open(dbPath: string): SegmentIndex {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.exec(SCHEMA)
    return new SegmentIndex(db)
  }

  /** Open the index, rebuilding from `entries` only when the file is absent. */
  static ensure(dbPath: string, entries: SegmentEntry[]): SegmentIndex {
    const existed = existsSync(dbPath)
    const index = SegmentIndex.open(dbPath)
    if (!existed) for (const e of entries) if (e.body !== "") index.addSegment(e.upto, e.body, e.summary)
    return index
  }

  addSegment(upto: string, body: string, summary: string): void {
    this.db
      .prepare(
        `INSERT INTO segments (upto, summary, body) VALUES (?, ?, ?)
         ON CONFLICT(upto) DO UPDATE SET summary = excluded.summary, body = excluded.body`,
      )
      .run(upto, summary, body)
    const row = this.db.prepare("SELECT rowid FROM segments WHERE upto = ?").get(upto) as { rowid: number }
    this.db.prepare("DELETE FROM segments_fts WHERE rowid = ?").run(row.rowid)
    const tokens = [...tokenize(body), ...tokenize(summary)].join(" ")
    if (tokens.length > 0) this.db.prepare("INSERT INTO segments_fts (rowid, text) VALUES (?, ?)").run(row.rowid, tokens)
  }

  search(query: string, limit: number): SegmentHit[] {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT s.upto AS upto, s.summary AS summary, s.body AS body
         FROM segments_fts f JOIN segments s ON s.rowid = f.rowid
         WHERE segments_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery(tokens, " "), limit) as Array<{ upto: string; summary: string; body: string }>
    return rows.map((r) => ({ upto: r.upto, summary: r.summary, excerpt: excerptOf(r.body, tokens) }))
  }
}
