/**
 * createChoreUsageRecorder 的行为钉子：四条后台调用通道（压缩/命名/记忆/技能）
 * 的花费落同一张用量表。覆盖：正常落行（runId 前缀=通道名）、无归属会话跳过、
 * usage 缺失（流中断）跳过、零 token 跳过、同毫秒多行主键不撞（真库）。
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageStore } from "@kclaw/core"
import type { Usage, UsageRow } from "@kclaw/core"
import { createChoreUsageRecorder } from "../src/chore-usage.js"

function makeRecorder() {
  const rows: Array<Omit<UsageRow, "id">> = []
  const rec = createChoreUsageRecorder({ record: (r) => rows.push(r) })
  return { rec, rows }
}

const U = (i = 1, o = 2, extra: Partial<Usage> = {}): Usage => ({ inputTokens: i, outputTokens: o, ...extra })

describe("createChoreUsageRecorder", () => {
  it("正常调用落一行，runId 以通道名为前缀，cache 字段照抄", () => {
    const { rec, rows } = makeRecorder()
    rec({ chore: "compaction", sessionId: "ses_a", model: "m1", usage: U(10, 5, { cacheReadTokens: 4 }) })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionId: "ses_a",
      model: "m1",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 4,
    })
    expect(rows[0]!.runId.startsWith("compaction-")).toBe(true)
  })

  it("无归属会话、usage 缺失、零 token 三种情况都不落行", () => {
    const { rec, rows } = makeRecorder()
    rec({ chore: "memory", sessionId: undefined, model: "m", usage: U() })
    rec({ chore: "memory", sessionId: "", model: "m", usage: U() })
    rec({ chore: "memory", sessionId: "ses_a", model: "m", usage: undefined })
    rec({ chore: "memory", sessionId: "ses_a", model: "m", usage: U(0, 0) })
    expect(rows).toEqual([])
  })

  it("同一毫秒的多行 runId 唯一（真库主键不撞）；chore 行不进会话桶，按类型维度可见", () => {
    const dir = mkdtempSync(join(tmpdir(), "chore-usage-"))
    try {
      const store = new UsageStore(join(dir, "usage.db"))
      const rec = createChoreUsageRecorder(store)
      for (const chore of ["compaction", "compaction", "autoname", "memory", "skill"] as const) {
        rec({ chore, sessionId: "ses_a", model: "m", usage: U() })
      }
      // 会话桶只折主 run（旁路调用不稀释主对话命中率），5 行 chore 全部不可见。
      const bySession = store.aggregate("session", {}, new Date("2000-01-01"), new Date("2999-01-01"))
      expect(bySession).toHaveLength(0)
      // 落行本身无损：按类型维度 5 行分四类齐全，主键未撞。
      const byKind = store.aggregate("kind", {}, new Date("2000-01-01"), new Date("2999-01-01"))
      expect(byKind.find((b) => b.key === "compaction")).toMatchObject({ inputTokens: 2, outputTokens: 4 })
      expect(byKind.find((b) => b.key === "autoname")).toMatchObject({ inputTokens: 1 })
      expect(byKind.find((b) => b.key === "memory")).toMatchObject({ inputTokens: 1 })
      expect(byKind.find((b) => b.key === "skill")).toMatchObject({ inputTokens: 1 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
