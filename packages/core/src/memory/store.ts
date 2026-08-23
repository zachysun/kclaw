import Database from "better-sqlite3"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { parse, stringify } from "yaml"
import { newId } from "../protocol/ids.js"

/** Where a note came from: model extraction, auto pipeline, or human editing. */
export type MemorySource = "model" | "auto" | "human"

/** One memory note; `path` points at the authoritative markdown file. */
export interface MemoryNote {
  id: string
  path: string
  tags: string[]
  source: MemorySource
  created: string // ISO-8601
  updated: string // ISO-8601
  text: string
}

export interface MemoryStoreOptions {
  /** Directory holding one `<id>.md` note per file — the source of truth. */
  notesDir: string
  /** SQLite index path; created (with tables) if absent. Purely derived state. */
  indexDb: string
}

export interface SaveNoteInput {
  text: string
  tags?: string[]
  source?: MemorySource
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  tags TEXT NOT NULL,
  source TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text);
`

/**
 * CJK-aware tokenizer shared by the index and the query side.
 *
 * FTS5's default unicode61 tokenizer treats a contiguous CJK run ("用户在上海工作")
 * as one opaque token, so a query for "上海" would never match. Strategy:
 * ASCII letter/digit runs pass through as whole (lowercased) words — "oolong tea"
 * matches via whole words — while every CJK run is emitted as its adjacent character
 * bigrams (用户 户在 在上 上海 海工 工作). A one- or two-character CJK query is itself a
 * bigram, so it MATCHes directly; longer CJK queries hit as an AND of their bigrams.
 * Tokens never contain FTS operators (punctuation is dropped), so quoting each
 * token keeps the assembled MATCH string injection-free.
 */
const WORD_RUN = /[A-Za-z0-9]+|[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g

function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const run of text.match(WORD_RUN) ?? []) {
    if (/^[A-Za-z0-9]+$/.test(run)) {
      tokens.push(run.toLowerCase())
      continue
    }
    const chars = Array.from(run)
    if (chars.length === 1) tokens.push(chars[0])
    else for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1])
  }
  return tokens
}

/** Quote tokens and join them: " " = FTS AND, " OR " = FTS OR. */
function ftsQuery(tokens: string[], joiner: " " | " OR "): string {
  return tokens.map((token) => `"${token}"`).join(joiner)
}

/** Jaccard similarity of two texts' token sets, in [0, 1]. */
function similarity(a: string[], b: string[]): number {
  const setB = new Set(b)
  let intersection = 0
  for (const token of new Set(a)) if (setB.has(token)) intersection++
  const union = new Set([...a, ...b]).size
  return union === 0 ? 1 : intersection / union
}

/** Notes this similar to an incoming save are treated as the same memory (merge threshold). */
const MERGE_SIMILARITY = 0.5

/** How much of `text` feeds the similarity lookup on save. */
const MERGE_QUERY_CHARS = 100

const SOURCES: readonly MemorySource[] = ["model", "auto", "human"]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toSource(value: unknown): MemorySource {
  return SOURCES.includes(value as MemorySource) ? (value as MemorySource) : "human"
}

/** Serialize a note as frontmatter (yaml) + blank line + body. */
function renderMarkdown(note: MemoryNote): string {
  const frontmatter = stringify({
    id: note.id,
    tags: note.tags,
    created: note.created,
    updated: note.updated,
    source: note.source,
  })
  return `---\n${frontmatter}---\n\n${note.text}\n`
}

/**
 * Parse one note file. Undefined means "not a note we index": missing file,
 * no opening `---`, no closing terminator, or unparseable frontmatter.
 * `id` falls back to the filename stem; hand-written files default to
 * source "human"; a bare `tags: foo` string is accepted as a one-tag list.
 */
function parseNoteFile(path: string): MemoryNote | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  const lines = raw.split("\n")
  if (lines[0] !== "---") return undefined
  const end = lines.indexOf("---", 1)
  if (end === -1) return undefined
  let frontmatter: unknown
  try {
    frontmatter = parse(lines.slice(1, end).join("\n"))
  } catch {
    return undefined
  }
  if (!isPlainObject(frontmatter)) return undefined
  const text = lines.slice(end + 1).join("\n").replace(/^\n/, "").replace(/\n$/, "")
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.map(String)
    : typeof frontmatter.tags === "string" && frontmatter.tags !== ""
      ? [frontmatter.tags]
      : []
  const now = new Date().toISOString()
  return {
    id: typeof frontmatter.id === "string" && frontmatter.id !== "" ? frontmatter.id : basename(path, ".md"),
    path,
    tags,
    source: toSource(frontmatter.source),
    created: typeof frontmatter.created === "string" ? frontmatter.created : now,
    updated: typeof frontmatter.updated === "string" ? frontmatter.updated : now,
    text,
  }
}

/**
 * Markdown-truth memory store: humans read/write notes/*.md, machines
 * query a derived SQLite FTS5 index. The file is authoritative — `reconcile()`
 * syncs the index to whatever is on disk, and `search()` returns note bodies
 * re-read from the files, so hand edits and deletions always win.
 */
export class MemoryStore {
  private readonly notesDir: string
  private readonly db: Database.Database

  constructor(opts: MemoryStoreOptions) {
    this.notesDir = opts.notesDir
    mkdirSync(this.notesDir, { recursive: true })
    mkdirSync(dirname(opts.indexDb), { recursive: true })
    this.db = new Database(opts.indexDb)
    this.db.exec(SCHEMA)
  }

  /**
   * Bring the index in line with notes/*.md: new files get indexed, files that
   * vanished (or became unparseable) get dropped, and entries whose file
   * changed on disk (frontmatter or — since hand edits usually skip the
   * frontmatter — body text, detected by comparing indexed tokens) are
   * re-indexed. A missing/empty index is just the extreme case: every file is
   * new, so this is also the full rebuild. Changed-but-present files are
   * refreshed without being counted in `added`.
   */
  reconcile(): { added: number; removed: number } {
    const noteFiles = readdirSync(this.notesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => join(this.notesDir, entry.name))
    const onDisk = new Map<string, MemoryNote>()
    let added = 0
    for (const path of noteFiles) {
      const note = parseNoteFile(path)
      if (note === undefined) continue
      onDisk.set(note.id, note)
      const row = this.db.prepare("SELECT id FROM notes WHERE id = ?").get(note.id)
      if (row === undefined) {
        this.indexNote(note)
        added++
      } else {
        this.refreshIfChanged(note)
      }
    }
    let removed = 0
    const rows = this.db.prepare("SELECT id FROM notes").all() as { id: string }[]
    for (const row of rows) {
      if (onDisk.has(row.id)) continue
      this.removeNote(row.id)
      removed++
    }
    return { added, removed }
  }

  /**
   * Merge-aware write: look for an existing note similar to `text` (first
   * ${MERGE_QUERY_CHARS} chars, FTS OR over tokens, best Jaccard similarity
   * >= ${MERGE_SIMILARITY}); on a hit update that note's text/tags/updated in
   * place (replace, never duplicate), otherwise create `<id>.md`.
   */
  async save(input: SaveNoteInput): Promise<MemoryNote> {
    const existing = this.findSimilar(input.text)
    const now = new Date().toISOString()
    let note: MemoryNote
    if (existing !== undefined) {
      note = {
        ...existing,
        text: input.text,
        tags: input.tags ?? existing.tags,
        source: input.source ?? existing.source,
        updated: now,
      }
    } else {
      const id = newId("mem")
      note = {
        id,
        path: join(this.notesDir, `${id}.md`),
        tags: input.tags ?? [],
        source: input.source ?? "auto",
        created: now,
        updated: now,
        text: input.text,
      }
    }
    writeFileSync(note.path, renderMarkdown(note), "utf8")
    this.indexNote(note)
    return note
  }

  /** FTS5 MATCH ranked by relevance; bodies are read back from the files. */
  async search(query: string, limit = 5): Promise<MemoryNote[]> {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []
    const hits = this.db
      .prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(ftsQuery(tokens, " "), limit) as { rowid: number }[]
    const notes: MemoryNote[] = []
    for (const hit of hits) {
      const row = this.db.prepare("SELECT path FROM notes WHERE rowid = ?").get(hit.rowid) as
        | { path: string }
        | undefined
      if (row === undefined) continue
      const note = parseNoteFile(row.path) // file is truth: stale/missing files drop out
      if (note !== undefined) notes.push(note)
    }
    return notes
  }

  /** Best note whose token overlap with `text` clears the merge threshold. */
  private findSimilar(text: string): MemoryNote | undefined {
    const queryTokens = tokenize(text.slice(0, MERGE_QUERY_CHARS))
    if (queryTokens.length === 0) return undefined
    const hits = this.db
      .prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH ? LIMIT 10")
      .all(ftsQuery(queryTokens, " OR ")) as { rowid: number }[]
    let best: { note: MemoryNote; score: number } | undefined
    for (const hit of hits) {
      const row = this.db.prepare("SELECT path FROM notes WHERE rowid = ?").get(hit.rowid) as
        | { path: string }
        | undefined
      if (row === undefined) continue
      const note = parseNoteFile(row.path)
      if (note === undefined) continue
      const score = similarity(queryTokens, tokenize(note.text))
      if (best === undefined || score > best.score) best = { note, score }
    }
    return best !== undefined && best.score >= MERGE_SIMILARITY ? best.note : undefined
  }

  /** Upsert the metadata row and re-tokenize the FTS entry for `note`. */
  private indexNote(note: MemoryNote): void {
    this.db
      .prepare(
        `INSERT INTO notes (id, path, tags, source, updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, tags = excluded.tags,
           source = excluded.source, updated = excluded.updated`,
      )
      .run(note.id, note.path, note.tags.join(","), note.source, note.updated)
    const tokens = tokenize(note.text).join(" ")
    this.reindexFts(note.id, tokens)
  }

  /** Re-index only when the file actually differs from what was indexed. */
  private refreshIfChanged(note: MemoryNote): void {
    const row = this.db
      .prepare("SELECT rowid, path, tags, source, updated FROM notes WHERE id = ?")
      .get(note.id) as { rowid: number; path: string; tags: string; source: string; updated: string }
    const indexed = this.db
      .prepare("SELECT text FROM notes_fts WHERE rowid = ?")
      .get(row.rowid) as { text: string } | undefined
    const tokens = tokenize(note.text).join(" ")
    if (
      row.path === note.path &&
      row.tags === note.tags.join(",") &&
      row.source === note.source &&
      row.updated === note.updated &&
      indexed?.text === tokens
    ) {
      return
    }
    this.reindexFts(note.id, tokens)
    this.db
      .prepare("UPDATE notes SET path = ?, tags = ?, source = ?, updated = ? WHERE id = ?")
      .run(note.path, note.tags.join(","), note.source, note.updated, note.id)
  }

  /** Replace the FTS entry for `id` (empty text → unsearchable, still tracked). */
  private reindexFts(id: string, tokens: string): void {
    const row = this.db.prepare("SELECT rowid FROM notes WHERE id = ?").get(id) as { rowid: number } | undefined
    if (row === undefined) return
    this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(row.rowid)
    if (tokens.length > 0) this.db.prepare("INSERT INTO notes_fts (rowid, text) VALUES (?, ?)").run(row.rowid, tokens)
  }

  private removeNote(id: string): void {
    const row = this.db.prepare("SELECT rowid FROM notes WHERE id = ?").get(id) as { rowid: number } | undefined
    if (row === undefined) return
    this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(row.rowid)
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id)
  }
}
