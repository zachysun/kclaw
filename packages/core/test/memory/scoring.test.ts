import { describe, it, expect } from "vitest"
import { normalizeFtsRank, fusedScore, recencyFactor } from "../../src/memory/scoring.js"

describe("normalizeFtsRank", () => {
  it("maps bm25 negatives to (0,1] with better ranks higher", () => {
    expect(normalizeFtsRank(-3)).toBeGreaterThan(normalizeFtsRank(-1))
    expect(normalizeFtsRank(0)).toBe(1)
  })
})

describe("fusedScore", () => {
  it("fuses both sides 50/50", () => {
    expect(fusedScore(0.8, 0.4)).toBeCloseTo(0.6)
  })
  it("degrades to the available side", () => {
    expect(fusedScore(0.8, undefined)).toBe(0.8)
    expect(fusedScore(undefined, 0.4)).toBe(0.4)
    expect(fusedScore(undefined, undefined)).toBe(0)
  })
})

describe("recencyFactor", () => {
  it("halves at 30 days", () => {
    const now = new Date("2026-08-30T00:00:00Z")
    expect(recencyFactor("2026-08-30", now)).toBeCloseTo(1)
    expect(recencyFactor("2026-07-31", now)).toBeCloseTo(0.5, 0) // 30 天 → 1/(1+1)
  })
  it("returns 1 for undated content", () => {
    expect(recencyFactor("", new Date())).toBe(1)
  })
})
