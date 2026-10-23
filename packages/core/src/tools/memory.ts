/**
 * memory tools: thin arg-validation + formatting wrappers around MemorySystem
 * (v2 facade — episodes in project thread files, cognitions in global files;
 * markdown is the truth, SQLite FTS5 + vectors the derived index).
 *
 * Both safe + parallel: they only touch the memory system, never the workspace
 * itself, so calls need no confirmation and may run concurrently with other
 * tools.
 *
 * - `memory_save {text}` → 当场触发当前会话的写入 pipeline（system.triggerImmediate）。
 *   text 是"要记内容的提示"；多余字段忽略。
 *   immediateEnabled=false 时返回固定错误文本（写入走后台定时/跟随触发）；触发后
 *   按是否真有提取批次区分回复——无增量时明说"没有需要沉淀的新内容"，不谎报写入。
 * - `memory_search {query, limit?}` → system.searchAll(query, limit)，跨项目
 *   经历 + 全局认知，每行 `- [经历|认知] [scope] text`；无命中 → "（没有相关记忆）"。
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { MemoryQuery, MemoryTriggers } from "../memory/system.js"
import { def, errMsg, int, makeTool, optInt, requireString, str, ToolError, type ToolEntry } from "./shared.js"

const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 20
const IMMEDIATE_CLOSED_MSG = "立即写入已关闭（memory.write.immediate=false），该内容将在后台定时/跟随触发时沉淀"

export function createMemoryTools(ctx: {
  system: Pick<MemoryTriggers, "triggerImmediate"> & Pick<MemoryQuery, "searchAll">
  sessionId: string
  workdir: string
  immediateEnabled: boolean
}): { "memory_save": ToolExecutor & { name: "memory_save" }; "memory_search": ToolExecutor & { name: "memory_search" } } {
  const memory_save = makeTool("memory_save", "safe", "parallel", async (args) => {
    requireString(args, "text") // 多余字段忽略
    if (!ctx.immediateEnabled) return { status: "error", output: IMMEDIATE_CLOSED_MSG }
    try {
      const wrote = await ctx.system.triggerImmediate(ctx.sessionId)
      // wrote=false = 该会话无增量（本轮消息已处理过）：不谎报"已写入"，
      // 2026-09-02 改名事故里这条固定文案曾把空转伪装成成功。
      return wrote
        ? { status: "ok", output: "已触发记忆写入（处理当前这轮对话）" }
        : { status: "ok", output: "该轮没有需要沉淀的新内容" }
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

/** The registry-facing bundle: executors + schemas owned beside each other. */
export function createMemoryToolEntries(ctx: Parameters<typeof createMemoryTools>[0]): ToolEntry[] {
  const tools = createMemoryTools(ctx)
  return [
    {
      name: "memory_save",
      tool: tools.memory_save,
      def: def(
        "memory_save",
        "立即把当前这轮对话沉淀进长期记忆（触发记忆写入 pipeline，处理当前轮）。判断权在你：用户明确要求记住时调用；对话里刚敲定重要决定、暴露稳定偏好、得出关键结论时也应自主调用。text 用一句话说明要记什么。",
        { text: str("要记内容的提示（说明这轮什么内容值得沉淀）") },
        ["text"],
      ),
    },
    {
      name: "memory_search",
      tool: tools.memory_search,
      def: def(
        "memory_search",
        "跨项目经历与全局认知的混合检索（关键词+向量）。每个命中带 [经历]/[认知] 与 [project:<id>]/[global] 标注。",
        { query: str("要在长期记忆里找什么"), limit: int(1, 20) },
        ["query"],
      ),
    },
  ]
}
