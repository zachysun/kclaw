/**
 * history_search 数据面（server 侧）：索引召回 + 标题解析 + 回收站过滤。
 *
 * "已删除（回收站）或不存在的会话必须从结果里消失"是这条链路的正确性
 * 不变量——search-index 的注释把存活性复查交给调用方，这里就是那个调用
 * 方。提为具名工厂是为了让不变量有测试面（真 SessionStore + 桩索引即可
 * 单测），不必拉起整个 daemon 才能验证。
 */
import type { HistoryHit, HistorySearchFn, SessionStore } from "@kclaw/core"

/** 索引面的最小形状（真 HistorySearchIndex 或测试桩）。 */
export interface HistorySearchIndexFace {
  search(query: string, limit?: number, sessionId?: string): HistoryHit[]
}

export function createHistorySearch(deps: {
  index: HistorySearchIndexFace
  sessions: Pick<SessionStore, "meta">
}): HistorySearchFn {
  return async (query, opts = {}) => {
    // limit 兜底 = 工具面的默认 5；两个调用面（工具 5 / HTTP 10）各自显式
    // 传参，上限统一封在 core 的 HISTORY_SEARCH_MAX_LIMIT。
    const hits = deps.index.search(query, opts.limit ?? 5, opts.sessionId)
    return hits
      .map((hit) => ({ hit, meta: deps.sessions.meta(hit.sessionId) }))
      .filter((r): r is { hit: HistoryHit; meta: NonNullable<ReturnType<typeof deps.sessions.meta>> } =>
        r.meta !== undefined && r.meta.deleted !== true)
      .map(({ hit, meta }) => ({ sessionId: hit.sessionId, title: meta.title, role: hit.role, at: hit.at, excerpt: hit.text }))
  }
}
