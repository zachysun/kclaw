// packages/core/src/tools/history.ts
/**
 * history_search: full-text recall over ALL sessions' raw user/assistant
 * messages (the corpus the model itself can no longer see once compacted or
 * after switching sessions). Complements memory_search (distilled facts) and
 * session_search (this session's compacted segments). Read-only over the
 * search index, safe + parallel. The search fn is injected by the daemon
 * (title resolution + purged-session filtering live there); absent fn → a
 * fixed unavailable line so the tool surface stays stable.
 */
import type { ToolExecutor } from "../agent/tools.js"
import { makeTool, optInt, requireString, ToolError } from "./shared.js"

export const HISTORY_SEARCH_DESCRIPTION =
  "跨会话检索全部历史对话的原始消息（按关键词全文匹配，返回命中会话、说话人与摘录）。记忆系统只保留沉淀后的事实；想找回某次对话里说过的原话、给过的路径或决定（如\"上次怎么修的 X\"）时用本工具。可选 session_id 限定单个会话。"

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20

export interface HistorySearchFn {
  (query: string, opts?: { limit?: number; sessionId?: string }): Promise<Array<{ sessionId: string; title: string; role: "user" | "assistant"; at: string; excerpt: string }>>
}

export function createHistoryTool(search?: HistorySearchFn): { "history_search": ToolExecutor & { name: "history_search" } } {
  const history_search = makeTool("history_search", "safe", "parallel", async (args) => {
    const query = requireString(args, "query")
    const limit = optInt(args, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT)
    const rawSession = (args as { session_id?: unknown } | undefined)?.session_id
    if (rawSession !== undefined && typeof rawSession !== "string") throw new ToolError("session_id 必须是字符串")
    if (search === undefined) return { status: "ok", output: "(历史检索不可用)" }
    try {
      const hits = await search(query, { limit, ...(typeof rawSession === "string" && rawSession !== "" ? { sessionId: rawSession } : {}) })
      if (hits.length === 0) return { status: "ok", output: "(没有匹配的历史消息)" }
      return {
        status: "ok",
        output: hits
          .map((h) => `- [${h.title}] ${h.at} ${h.role}: ${h.excerpt}（session: ${h.sessionId}）`)
          .join("\n"),
      }
    } catch (e) {
      throw new ToolError(`search failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  return { history_search }
}
