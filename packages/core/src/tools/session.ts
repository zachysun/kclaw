// packages/core/src/tools/session.ts
/**
 * session_search: search the CURRENT session's compacted segments. Same risk/concurrency class as memory tools — read-only over the
 * session event stream, safe + parallel. The search fn is injected by the
 * server per run (lazy event-stream read); absent fn → "(无可检索内容)" so the
 * tool list stays stable across session states.
 */
import type { ToolExecutor } from "../agent/tools.js"
import { def, int, makeTool, optInt, requireString, str, ToolError, type ToolEntry } from "./shared.js"

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

/** The registry-facing bundle: executor + schema owned beside each other. */
export function createSessionToolEntries(search?: Parameters<typeof createSessionTools>[0]): ToolEntry[] {
  return [
    {
      name: "session_search",
      tool: createSessionTools(search).session_search,
      def: def(
        "session_search",
        "全文检索本会话早期已被压缩的对话内容（中文友好）。每个命中返回段摘要和匹配位置的原文片段。",
        { query: str("要在早期对话里找什么"), limit: int(1, 20) },
        ["query"],
      ),
    },
  ]
}
