/**
 * createHistorySearch（history_search 数据源）的行为钉子：核心不变量是
 * "已删除（回收站）或不存在的会话必须从结果里消失"——search-index 把存活性
 * 复查交给调用方，这里验证那个复查。标题解析、limit/sessionId 透传一并覆盖。
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "@kclaw/core"
import type { HistoryHit } from "@kclaw/core"
import { createHistorySearch } from "../src/history-search.js"

/** 桩索引：返回预设命中并记录调用参数。 */
function stubIndex(hits: HistoryHit[]): { index: Parameters<typeof createHistorySearch>[0]["index"]; calls: Array<{ query: string; limit?: number; sessionId?: string }> } {
  const calls: Array<{ query: string; limit?: number; sessionId?: string }> = []
  return {
    index: {
      search(query, limit, sessionId) {
        calls.push({ query, limit, sessionId })
        return hits
      },
    },
    calls,
  }
}

function hit(sessionId: string): HistoryHit {
  return { sessionId, msgId: `msg_${sessionId}`, role: "user", at: "2026-10-04T00:00:00.000Z", text: "爆米花怎么修来着" }
}

let dir: string

describe("createHistorySearch", () => {
  it("软删除与 meta 缺失的会话不命中，正常会话解析标题", async () => {
    dir = mkdtempSync(join(tmpdir(), "hsearch-"))
    try {
      const sessions = new SessionStore(join(dir, "s"))
      const live = sessions.create("活会话")
      const dead = sessions.create("待删会话")
      sessions.delete(dead.id)
      const { index } = stubIndex([hit(live.id), hit(dead.id), hit("ses_missing")])
      const search = createHistorySearch({ index, sessions })
      const results = await search("爆米花")
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ sessionId: live.id, title: "活会话", role: "user", excerpt: "爆米花怎么修来着" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("limit 与 sessionId 透传给索引；limit 默认回退 5", async () => {
    dir = mkdtempSync(join(tmpdir(), "hsearch-"))
    try {
      const sessions = new SessionStore(join(dir, "s"))
      const { index, calls } = stubIndex([])
      const search = createHistorySearch({ index, sessions })
      await search("q1", { limit: 10, sessionId: "ses_x" })
      await search("q2")
      expect(calls[0]).toEqual({ query: "q1", limit: 10, sessionId: "ses_x" })
      expect(calls[1]!.limit).toBe(5)
      expect(calls[1]!.sessionId).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
