/**
 * createChoreUsageRecorder 的行为钉子：四条后台杂活通道（压缩/命名/记忆/技能）
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

  it("同一毫秒的多行 runId 唯一（真库主键不撞）", () => {
    const dir = mkdtempSync(join(tmpdir(), "chore-usage-"))
    try {
      const store = new UsageStore(join(dir, "usage.db"))
      const rec = createChoreUsageRecorder(store)
      for (const chore of ["compaction", "compaction", "autoname", "memory", "skill"] as const) {
        rec({ chore, sessionId: "ses_a", model: "m", usage: U() })
      }
      const buckets = store.aggregate("session", {}, new Date("2000-01-01"), new Date("2999-01-01"))
      expect(buckets).toHaveLength(1)
      expect(buckets[0]).toMatchObject({ key: "ses_a", inputTokens: 5, outputTokens: 10 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
