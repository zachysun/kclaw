import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageStore, costUsd } from "../../src/storage/usage.js"

function makeStore(): { store: UsageStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kclaw-usage-"))
  const store = new UsageStore(join(dir, "usage.db"))
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const PRICES = { glm: { inputPerM: 1, outputPerM: 2 }, deep: { inputPerM: 0.5 } }
const CACHE_PRICES = { ...PRICES, glm: { ...PRICES.glm, cacheReadPerM: 0.1, cacheWritePerM: 1.25 } }

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
      { key: "deep", inputTokens: 300, outputTokens: 30, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.00015 },
      { key: "glm", inputTokens: 300, outputTokens: 30, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.00036 },
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

describe("UsageStore 缓存字段", () => {
  it("records cache fields and reads them back; omitted fields stay NULL (unknown, not 0)", () => {
    const { store, cleanup } = makeStore()
    store.record({ sessionId: "s1", runId: "r1", model: "glm", inputTokens: 100, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 30, at: "2026-08-25T10:00:00.000Z" })
    store.record({ sessionId: "s1", runId: "r2", model: "glm", inputTokens: 50, outputTokens: 5, at: "2026-08-25T11:00:00.000Z" })
    const agg = store.aggregate("model", PRICES)
    expect(agg[0]).toEqual({ key: "glm", inputTokens: 150, outputTokens: 15, costUsd: agg[0]!.costUsd, cacheReadTokens: 60, cacheWriteTokens: 30 })
    cleanup()
  })

  it("bucket NULL semantics: all-NULL bucket → null; mixed rows → sum of the known values", () => {
    const { store, cleanup } = makeStore()
    // s-all: two rows, neither carries cache metrics → null (unknown)
    store.record({ sessionId: "s-all", runId: "r1", model: "glm", inputTokens: 100, outputTokens: 10, at: "2026-08-25T10:00:00.000Z" })
    store.record({ sessionId: "s-all", runId: "r2", model: "glm", inputTokens: 100, outputTokens: 10, at: "2026-08-25T10:05:00.000Z" })
    // s-mix: one row without, one with → sum of the known values only
    store.record({ sessionId: "s-mix", runId: "r1", model: "glm", inputTokens: 100, outputTokens: 10, at: "2026-08-25T11:00:00.000Z" })
    store.record({ sessionId: "s-mix", runId: "r2", model: "glm", inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 20, at: "2026-08-25T11:05:00.000Z" })

    const bySession = store.aggregate("session", PRICES)
    const all = bySession.find((a) => a.key === "s-all")!
    expect(all.cacheReadTokens).toBeNull()
    expect(all.cacheWriteTokens).toBeNull()
    const mix = bySession.find((a) => a.key === "s-mix")!
    expect(mix.cacheReadTokens).toBe(40)
    expect(mix.cacheWriteTokens).toBe(20)

    const t = store.total(PRICES)
    expect(t.cacheReadTokens).toBe(40)
    expect(t.cacheWriteTokens).toBe(20)
    cleanup()
  })

  it("migrates a pre-cache-column db: columns added, old rows read as NULL, new rows insertable", () => {
    const dir = mkdtempSync(join(tmpdir(), "kclaw-usage-old-"))
    const dbPath = join(dir, "usage.db")
    const legacy = new Database(dbPath)
    legacy.exec(`CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, at TEXT NOT NULL
    );`)
    legacy.prepare("INSERT INTO usage (id, session_id, run_id, model, input_tokens, output_tokens, at) VALUES (?,?,?,?,?,?,?)")
      .run("u_old", "s1", "r0", "glm", 1000, 100, "2026-08-01T00:00:00.000Z")
    legacy.close()

    const store = new UsageStore(dbPath)
    store.record({ sessionId: "s1", runId: "r1", model: "glm", inputTokens: 100, outputTokens: 10, cacheReadTokens: 70, at: "2026-08-25T10:00:00.000Z" })
    const bySession = store.aggregate("session", PRICES)
    expect(bySession).toHaveLength(1)
    expect(bySession[0]).toMatchObject({ inputTokens: 1100, outputTokens: 110, cacheReadTokens: 70, cacheWriteTokens: null })
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("costUsd 缓存价目", () => {
  it("charges non-cached input, read, write and output separately when cache prices exist and the row has cache data", () => {
    // input 1000 = non-cached 270 + read 600 + write 130; output 100
    const cost = costUsd({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 130 }, "glm", CACHE_PRICES)
    // 270*1/1M + 600*0.1/1M + 130*1.25/1M + 100*2/1M
    expect(cost).toBeCloseTo(0.000270 + 0.00006 + 0.0001625 + 0.0002, 10)
  })

  it("treats a missing cache field as 0 tokens in the new formula (OpenAI rows carry only cacheRead)", () => {
    const cost = costUsd({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600 }, "glm", CACHE_PRICES)
    // non-cached = 1000-600 = 400 (write unknown → 0), read 600, write 0
    expect(cost).toBeCloseTo(0.0004 + 0.00006 + 0 + 0.0002, 10)
  })

  it("keeps the legacy formula when the row carries no cache data at all", () => {
    const cost = costUsd({ inputTokens: 1000, outputTokens: 100 }, "glm", CACHE_PRICES)
    expect(cost).toBeCloseTo(0.001 + 0.0002, 10)
  })

  it("keeps the legacy formula when the model has no cache prices (不猜折扣)", () => {
    const cost = costUsd({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600 }, "glm", PRICES)
    expect(cost).toBeCloseTo(0.001 + 0.0002, 10)
  })
})

/** Local date string for a Date (mirrors the store's bucket key). */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
