// packages/core/src/tools/session.ts
/**
 * session_search: search the CURRENT session's compacted segments (spec
 * 6.4.2). Same risk/concurrency class as memory tools — read-only over the
 * session event stream, safe + parallel. The search fn is injected by the
 * server per run (lazy event-stream read); absent fn → "(无可检索内容)" so the
 * tool list stays stable across session states.
 */
import type { ToolExecutor } from "../agent/tools.js"
import { makeTool, optInt, requireString, ToolError } from "./shared.js"

export type SessionSearchFn = (query: string, limit: number) => Promise<Array<{ summary: string; excerpt: string }>>

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20

export function createSessionTools(search?: SessionSearchFn): { "session_search": ToolExecutor & { name: "session_search" } } {
  const session_search = makeTool("session_search", "safe", "parallel", async (args) => {
    const query = requireString(args, "query")
    const limit = optInt(args, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT)
    if (search === undefined) return { status: "ok", output: "(无可检索内容)" }
    try {
      const hits = await search(query, limit)
      return {
        status: "ok",
        output: hits.length === 0 ? "(无可检索内容)" : hits.map((h) => `- ${h.summary}\n  ${h.excerpt}`).join("\n"),
      }
    } catch (e) {
      throw new ToolError(`search failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  return { session_search }
}
