import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { ftsQuery, tokenize } from "../text/fts.js"
import { deserializeVector, serializeVector } from "./embeddings.js"

/** 一条可检索条目：情节（项目库）或认知文件（全局库），两库 schema 同构。 */
export interface IndexEntry {
  key: string; text: string
  topic?: string; title?: string; date?: string; updatedAt: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  key TEXT PRIMARY KEY,
  topic TEXT, title TEXT, date TEXT, updated TEXT, text TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(text);
CREATE TABLE IF NOT EXISTS vectors (
  key TEXT PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);
`

/** markdown 是真相、本库是派生物（spec 2.1）：删除 vectors.db 后可全量重建。 */
export class VectorIndex {
  readonly #db: Database.Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.#db = new Database(dbPath)
    this.#db.exec(SCHEMA)
  }

  upsert(entry: IndexEntry, vector?: Float32Array): void {
    this.#db
      .prepare(`INSERT INTO entries (key, topic, title, date, updated, text) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET topic = excluded.topic, title = excluded.title,
                  date = excluded.date, updated = excluded.updated, text = excluded.text`)
      .run(entry.key, entry.topic ?? null, entry.title ?? null, entry.date ?? null, entry.updatedAt, entry.text)
    const row = this.#db.prepare("SELECT rowid FROM entries WHERE key = ?").get(entry.key) as { rowid: number }
    this.#db.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(row.rowid)
    const tokens = tokenize(entry.text).join(" ")
    if (tokens !== "") this.#db.prepare("INSERT INTO entries_fts (rowid, text) VALUES (?, ?)").run(row.rowid, tokens)
    this.#db.prepare("DELETE FROM vectors WHERE key = ?").run(entry.key)
    if (vector !== undefined) {
      this.#db.prepare("INSERT INTO vectors (key, dim, vec) VALUES (?, ?, ?)")
        .run(entry.key, vector.length, serializeVector(vector))
    }
  }

  remove(key: string): void {
    const row = this.#db.prepare("SELECT rowid FROM entries WHERE key = ?").get(key) as { rowid: number } | undefined
    if (row !== undefined) {
      this.#db.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(row.rowid)
      this.#db.prepare("DELETE FROM entries WHERE key = ?").run(key)
    }
    this.#db.prepare("DELETE FROM vectors WHERE key = ?").run(key)
  }

  keys(): Set<string> {
    const rows = this.#db.prepare("SELECT key FROM entries").all() as { key: string }[]
    return new Set(rows.map((r) => r.key))
  }

  /**
   * FTS5 召回（spec 7.2）：token 间 OR —— 任一 bigram 命中即召回，bm25 自然把
   * 命中更多 token 的条目排更前。检索是召回优先（模型侧二次判断），不是 AND 精确。
   */
  searchFts(query: string, limit: number): Array<{ key: string; rank: number }> {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []
    return (this.#db
      .prepare(`SELECT rowid, bm25(entries_fts) AS rank FROM entries_fts
                WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(ftsQuery(tokens, " OR "), limit) as { rowid: number; rank: number }[])
      .map((r) => {
        const e = this.#db.prepare("SELECT key FROM entries WHERE rowid = ?").get(r.rowid) as { key: string } | undefined
        return e === undefined ? null : { key: e.key, rank: r.rank }
      })
      .filter((x): x is { key: string; rank: number } => x !== null)
  }

  vectorOf(key: string): Float32Array | undefined {
    const row = this.#db.prepare("SELECT vec FROM vectors WHERE key = ?").get(key) as { vec: Buffer } | undefined
    return row === undefined ? undefined : deserializeVector(row.vec)
  }

  metaOf(key: string): IndexEntry | undefined {
    const row = this.#db.prepare("SELECT key, topic, title, date, updated, text FROM entries WHERE key = ?").get(key) as
      | { key: string; topic: string | null; title: string | null; date: string | null; updated: string; text: string }
      | undefined
    if (row === undefined) return undefined
    return {
      key: row.key,
      text: row.text,
      ...(row.topic !== null ? { topic: row.topic } : {}),
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.date !== null ? { date: row.date } : {}),
      updatedAt: row.updated,
    }
  }

  close(): void {
    this.#db.close()
  }
}
