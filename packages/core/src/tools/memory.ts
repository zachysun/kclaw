/**
 * memory tools (spec §7/§8): thin arg-validation + formatting wrappers around
 * MemoryStore (markdown files are the truth, SQLite FTS5 is the derived index).
 *
 * Both safe + parallel: they only touch the notes dir / index, never the
 * workspace itself, so calls need no confirmation and may run concurrently
 * with other tools. (better-sqlite3 is synchronous, so "parallel" only means
 * the scheduler isn't forced to serialize them.)
 *
 * - `memory_save {text, tags?}` → store.save(...), ok output `saved memory <id>`.
 *   Store-side merging applies: a very similar existing note is updated in
 *   place instead of duplicated. Saved with source "model" (this is the
 *   model-facing tool; the auto pipeline and humans write through other paths).
 * - `memory_search {query, limit?}` → store.search(...), one `- <text>` line
 *   per hit, ranked by relevance; no hit → "(no memories)".
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { MemoryStore } from "../memory/store.js"
import { errMsg, makeTool, optInt, optStringArray, requireString, ToolError } from "./shared.js"

const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 20

export function createMemoryTools(memory: MemoryStore): {
  "memory_save": ToolExecutor & { name: "memory_save" }
  "memory_search": ToolExecutor & { name: "memory_search" }
} {
  const memory_save = makeTool("memory_save", "safe", "parallel", async (args) => {
    const text = requireString(args, "text")
    const tags = optStringArray(args, "tags")
    try {
      const note = await memory.save({ text, tags, source: "model" })
      return { status: "ok", output: `saved memory ${note.id}` }
    } catch (e) {
      throw new ToolError(`save failed: ${errMsg(e)}`)
    }
  })

  const memory_search = makeTool("memory_search", "safe", "parallel", async (args) => {
    const query = requireString(args, "query")
    const limit = optInt(args, "limit", DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
    try {
      const notes = await memory.search(query, limit)
      const output = notes.length > 0
        ? notes.map((n) => `- ${n.text}`).join("\n")
        : "(no memories)"
      return { status: "ok", output }
    } catch (e) {
      throw new ToolError(`search failed: ${errMsg(e)}`)
    }
  })

  return { memory_save, memory_search }
}
