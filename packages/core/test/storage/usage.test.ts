import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageStore, costUsd } from "../../src/storage/usage.js"

function makeStore(): { store: UsageStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kclaw-usage-"))
  const store = new UsageStore(join(dir, "usage.db"))
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const PRICES = { glm: { inputPerM: 1, outputPerM: 2 }, deep: { inputPerM: 0.5 } }

describe("UsageStore", () => {
  it("records rows and totals tokens with cost from the price table", () => {
    const { store, cleanup } = makeStore()
    store.record({ sessionId: "s1", runId: "r1", model: "glm", inputTokens: 1_000_000, outputTokens: 500_000, at: "2026-08-25T10:00:00.000Z" })
    store.record({ sessionId: "s1", runId: "r2", model: "deep", inputTokens: 2_000_000, outputTokens: 0, at: "2026-08-25T11:00:00.000Z" })
    const t = store.total(PRICES)
    expect(t.inputTokens).toBe(3_000_000)
    expect(t.outputTokens).toBe(500_000)
    // glm: 1*1 + 0.5*2 = 2; deep: 2*0.5 = 1 → 3
    expect(t.costUsd).toBeCloseTo(3)
    cleanup()
  })

  it("costs 0 for models without a price entry", () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0 }, "unknown", PRICES)).toBe(0)
  })

  it("aggregates by model, session and local day", () => {
    const { store, cleanup } = makeStore()
    store.record({ sessionId: "s1", runId: "r1", model: "glm", inputTokens: 100, outputTokens: 10, at: "2026-08-24T23:00:00.000Z" })
    store.record({ sessionId: "s2", runId: "r2", model: "glm", inputTokens: 200, outputTokens: 20, at: "2026-08-25T01:00:00.000Z" })
    store.record({ sessionId: "s1", runId: "r3", model: "deep", inputTokens: 300, outputTokens: 30, at: "2026-08-25T02:00:00.000Z" })

    const byModel = store.aggregate("model", PRICES)
    expect(byModel).toEqual([
      { key: "deep", inputTokens: 300, outputTokens: 30, costUsd: 0.00015 },
      { key: "glm", inputTokens: 300, outputTokens: 30, costUsd: 0.00036 },
    ])

    const bySession = store.aggregate("session", PRICES)
    expect(bySession.find((a) => a.key === "s1")).toMatchObject({ inputTokens: 400, outputTokens: 40 })
    expect(bySession.find((a) => a.key === "s2")).toMatchObject({ inputTokens: 200, outputTokens: 20 })

    const byDay = store.aggregate("day", PRICES)
    expect(byDay.map((a) => a.key)).toContain(localDayKey(new Date("2026-08-24T23:00:00.000Z")))
    expect(byDay.map((a) => a.key)).toContain(localDayKey(new Date("2026-08-25T01:00:00.000Z")))
    cleanup()
  })

  it("filters by time range", () => {
    const { store, cleanup } = makeStore()
    store.record({ sessionId: "s1", runId: "r1", model: "glm", inputTokens: 100, outputTokens: 0, at: "2026-08-24T00:00:00.000Z" })
    store.record({ sessionId: "s1", runId: "r2", model: "glm", inputTokens: 200, outputTokens: 0, at: "2026-08-25T00:00:00.000Z" })
    const t = store.total({}, new Date("2026-08-25T00:00:00.000Z"), new Date("2026-08-26T00:00:00.000Z"))
    expect(t.inputTokens).toBe(200)
    cleanup()
  })
})

/** Local date string for a Date (mirrors the store's bucket key). */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
