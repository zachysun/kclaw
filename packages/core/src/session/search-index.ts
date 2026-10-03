/**
 * Cross-session message full-text index — the "how did we solve this three
 * months ago?" recall path.
 *
 * Every persisted user/assistant TEXT message lands in an FTS5 table at
 * append time (one row per message, tokenizer = the shared CJK-bigram
 * `tokenize`), so recall covers the RAW conversation history, not just the
 * distilled memory entries. Writes are the daemon's event-append callback
 * (best effort — a failed index write never disturbs the run); a startup
 * backfill fills the gap for sessions created before the feature or while
 * the daemon was down, tracked per session in a `backfilled` table so it is
 * idempotent and incremental.
 *
 * Storage sits NEXT to the sessions (one search.db per home): SQLite
 * (better-sqlite3, the one native dependency the memory indexer already
 * carries), zero services. The stance matches the memory indexer: lexical
 * FTS, no vectors.
 */
import Database from "better-sqlite3"
import type { Message } from "../protocol/messages.js"
import { ftsQuery, tokenize } from "../text/fts.js"

export interface HistoryHit {
  sessionId: string
  messageId: string
  role: "user" | "assistant"
  at: string
  text: string
  /** bm25 rank (lower = better); exposed for tests and future tuning. */
  rank: number
}

/** Extract the indexable text of one message: user/assistant text blocks only. */
function messageText(message: Message): string | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined
  const text = message.blocks
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim()
  return text === "" ? undefined : text
}

export class HistorySearchIndex {
  readonly #db: Database.Database

  private constructor(db: Database.Database) {
    this.#db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS backfilled (session_id TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE IF NOT EXISTS msgs USING fts5(
        session_id UNINDEXED, msg_id UNINDEXED, role UNINDEXED, at UNINDEXED, text, raw UNINDEXED
      );
    `)
  }

  static open(dbPath: string): HistorySearchIndex {
    return new HistorySearchIndex(new Database(dbPath))
  }

  /** One persisted message → index row. Failures are swallowed by the caller. */
  recordMessage(sessionId: string, message: Message): void {
    const text = messageText(message)
    if (text === undefined) return
    this.#db
      .prepare(`INSERT INTO msgs (session_id, msg_id, role, at, text, raw) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, message.id, message.role, message.createdAt, tokenize(text).join(" "), text)
  }

  /**
   * A truncation marker (edit & retry / regenerate): everything from
   * `fromMessageId` onward leaves the model view, so it leaves the index —
   * the corpus mirrors what readMessages returns, never more. A `from` id
   * missing from the index (races, non-text rows) degrades to dropping the
   * session's whole indexed tail = all rows (conservative, never stale).
   */
  recordTruncation(sessionId: string, fromMessageId: string): void {
    const row = this.#db
      .prepare(`SELECT rowid FROM msgs WHERE session_id = ? AND msg_id = ?`)
      .get(sessionId, fromMessageId) as { rowid: number } | undefined
    if (row === undefined) {
      this.#db.prepare(`DELETE FROM msgs WHERE session_id = ?`).run(sessionId)
      return
    }
    this.#db.prepare(`DELETE FROM msgs WHERE session_id = ? AND rowid >= ?`).run(sessionId, row.rowid)
  }

  /** A session left the store for good (purge): its rows go too. */
  removeSession(sessionId: string): void {
    this.#db.prepare(`DELETE FROM msgs WHERE session_id = ?`).run(sessionId)
    this.#db.prepare(`DELETE FROM backfilled WHERE session_id = ?`).run(sessionId)
  }

  /**
   * Lexical recall over all indexed history. Tokens are OR-recalled (BM25
   * ranks coverage), matching the memory indexer's behavior. The caller
   * re-checks each hit's session existence (purged sessions drop out at
   * rendering time).
   */
  search(query: string, limit = 5, sessionId?: string): HistoryHit[] {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []
    const match = ftsQuery(tokens, " OR ")
    const rows = (sessionId === undefined
      ? this.#db
          .prepare(`SELECT session_id, msg_id, role, at, raw AS text, bm25(msgs) AS rank FROM msgs WHERE msgs MATCH ? ORDER BY rank LIMIT ?`)
          .all(match, limit)
      : this.#db
          .prepare(`SELECT session_id, msg_id, role, at, raw AS text, bm25(msgs) AS rank FROM msgs WHERE msgs MATCH ? AND session_id = ? ORDER BY rank LIMIT ?`)
          .all(match, sessionId, limit)) as Array<{ session_id: string; msg_id: string; role: "user" | "assistant"; at: string; text: string; rank: number }>
    return rows.map((r) => ({ sessionId: r.session_id, messageId: r.msg_id, role: r.role, at: r.at, text: r.text, rank: r.rank }))
  }

  /**
   * Index everything the store already holds for sessions never backfilled
   * (and mark them). Synchronous and O(full history) — the daemon runs it
   * once at startup, after serving starts, so first-use latency is unaffected.
   * Per session the operation is a REPLACE: existing rows for that session
   * are dropped first, so a session that already recorded live rows
   * (started before its backfill) can never accumulate duplicates.
   */
  backfill(allMessages: Array<{ sessionId: string; messages: Message[] }>): number {
    const pending = new Set(
      (this.#db.prepare(`SELECT session_id FROM backfilled`).all() as Array<{ session_id: string }>).map((r) => r.session_id),
    )
    let indexed = 0
    const insert = this.#db.prepare(`INSERT INTO msgs (session_id, msg_id, role, at, text, raw) VALUES (?, ?, ?, ?, ?, ?)`)
    const clear = this.#db.prepare(`DELETE FROM msgs WHERE session_id = ?`)
    const mark = this.#db.prepare(`INSERT OR IGNORE INTO backfilled (session_id) VALUES (?)`)
    const run = this.#db.transaction((sessionId: string, messages: Message[]) => {
      clear.run(sessionId)
      for (const m of messages) {
        const text = messageText(m)
        if (text === undefined) continue
        insert.run(sessionId, m.id, m.role, m.createdAt, tokenize(text).join(" "), text)
        indexed++
      }
      mark.run(sessionId)
    })
    for (const { sessionId, messages } of allMessages) {
      if (pending.has(sessionId)) continue
      run(sessionId, messages)
    }
    return indexed
  }

  /** Whether the corpus is empty (first boot) — used to defer/skip backfill logging. */
  isEmpty(): boolean {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM backfilled`).get() as { n: number }
    return row.n === 0
  }

  close(): void {
    this.#db.close()
  }
}
