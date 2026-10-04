/**
 * createChoreUsageRecorder 的行为钉子：四条后台杂活通道（压缩/命名/记忆/技能）
 * 的花费落同一张用量表。覆盖：正常落行（runId 前缀=通道名）、无归属会话跳过、
 * usage 缺失（流中断）跳过、零 token 跳过、同毫秒多行主键不撞。
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { UsageStore } from "@kclaw/core"
import type { Usage } from "@kclaw/core"
import { createChoreUsageRecorder } from "../src/chore-usage.js"

/** The raw run_ids the store holds for one session (aggregate doesn't expose them). */
function runIds(dbPath: string, sessionId: string): string[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare("SELECT run_id FROM usage WHERE session_id = ? ORDER BY rowid").all(sessionId)
      .map((r) => (r as { run_id: string }).run_id)
  } finally {
    db.close()
  }
}

function tempUsage(): { store: UsageStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chore-usage-"))
  return { store: new UsageStore(join(dir, "usage.db")), dir }
}

const U = (i = 1, o = 2, extra: Partial<Usage> = {}): Usage => ({ inputTokens: i, outputTokens: o, ...extra })

describe("createChoreUsageRecorder", () => {
  it("正常调用落一行，runId 以通道名为前缀，cache 字段照抄", () => {
    const { store, dir } = tempUsage()
    try {
      const rec = createChoreUsageRecorder(store)
      rec({ chore: "compaction", sessionId: "ses_a", model: "m1", usage: U(10, 5, { cacheReadTokens: 4 }) })
      const rows = store.aggregate("session", new Date("2000-01-01"), new Date("2999-01-01"))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ key: "ses_a", inputTokens: 10, outputTokens: 5, cacheReadTokens: 4 })
      // runId 前缀经原始行核验（aggregate 不暴露 runId）
      const runId = runIds(join(dir, "usage.db"), "ses_a")[0]!
      expect(runId.startsWith("compaction-")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("无归属会话、usage 缺失、零 token 三种情况都不落行", () => {
    const { store, dir } = tempUsage()
    try {
      const rec = createChoreUsageRecorder(store)
      rec({ chore: "memory", sessionId: undefined, model: "m", usage: U() })
      rec({ chore: "memory", sessionId: "", model: "m", usage: U() })
      rec({ chore: "memory", sessionId: "ses_a", model: "m", usage: undefined })
      rec({ chore: "memory", sessionId: "ses_a", model: "m", usage: U(0, 0) })
      expect(store.aggregate("session", new Date("2000-01-01"), new Date("2999-01-01"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("同一毫秒的多行 runId 唯一（主键不撞）", () => {
    const { store, dir } = tempUsage()
    try {
      const rec = createChoreUsageRecorder(store)
      for (const chore of ["compaction", "compaction", "autoname", "memory", "skill"] as const) {
        rec({ chore, sessionId: "ses_a", model: "m", usage: U() })
      }
      expect(runIds(join(dir, "usage.db"), "ses_a")).toHaveLength(5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
