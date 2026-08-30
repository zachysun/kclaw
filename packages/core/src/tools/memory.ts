/**
 * memory tools: thin arg-validation + formatting wrappers around MemorySystem
 * (v2 facade — episodes in project thread files, cognitions in global files;
 * markdown is the truth, SQLite FTS5 + vectors the derived index).
 *
 * Both safe + parallel: they only touch the memory system, never the workspace
 * itself, so calls need no confirmation and may run concurrently with other
 * tools.
 *
 * - `memory_save {text}` → 当场触发当前会话的写入管线（system.triggerImmediate，
 *   spec 7.3）。text 是"要记内容的提示"；v1 的 tags 已删（spec 7.3），多余字段忽略。
 *   immediateEnabled=false 时返回固定错误文本（写入走后台定时/跟随触发）。
 * - `memory_search {query, limit?}` → system.searchAll(query, limit)，跨项目
 *   经历 + 全局认知，每行 `- [经历|认知] [scope] text`；无命中 → "（没有相关记忆）"。
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { MemorySystem } from "../memory/system.js"
import { errMsg, makeTool, optInt, requireString, ToolError } from "./shared.js"

const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 20
const IMMEDIATE_CLOSED_MSG = "立即写入已关闭（memory.write.immediate=false），该内容将在后台定时/跟随触发时沉淀"

export function createMemoryTools(ctx: {
  system: MemorySystem
  sessionId: string
  workdir: string
  immediateEnabled: boolean
}): { "memory_save": ToolExecutor & { name: "memory_save" }; "memory_search": ToolExecutor & { name: "memory_search" } } {
  const memory_save = makeTool("memory_save", "safe", "parallel", async (args) => {
    requireString(args, "text") // tags 已删（spec 7.3）：多余字段忽略
    if (!ctx.immediateEnabled) return { status: "error", output: IMMEDIATE_CLOSED_MSG }
    try {
      await ctx.system.triggerImmediate(ctx.sessionId)
      return { status: "ok", output: "已触发记忆写入（处理当前这轮对话）" }
    } catch (e) {
      throw new ToolError(`save failed: ${errMsg(e)}`)
    }
  })

  const memory_search = makeTool("memory_search", "safe", "parallel", async (args) => {
    const query = requireString(args, "query")
    const limit = optInt(args, "limit", DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
    try {
      const hits = await ctx.system.searchAll(query, limit)
      const output = hits.length > 0
        ? hits.map((h) => `- [${h.kind === "episode" ? "经历" : "认知"}] [${h.scope}] ${h.text}`).join("\n")
        : "（没有相关记忆）"
      return { status: "ok", output }
    } catch (e) {
      throw new ToolError(`search failed: ${errMsg(e)}`)
    }
  })

  return { memory_save, memory_search }
}
