import { describe, it, expect, vi, afterEach } from "vitest"
import {
  resolveWaterlines,
  validateWaterlineConfig,
  WATERLINE_DEFAULTS,
} from "../../src/session/waterlines.js"
import { defaultConfig } from "../../src/storage/config.js"
import type { KclawConfig } from "../../src/storage/config.js"

function configWith(sessions: Partial<KclawConfig["sessions"]>): KclawConfig {
  return { ...defaultConfig, sessions: { ...defaultConfig.sessions, ...sessions } }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("resolveWaterlines", () => {
  it("applies module defaults when the config carries no ratios", () => {
    const wl = resolveWaterlines(configWith({}), 100_000)
    expect(wl.budget).toBe(100_000)
    expect(wl.pack).toBe(70_000)
    expect(wl.ahead).toBe(75_000)
    expect(wl.at).toBe(80_000)
    expect(wl.panic).toBe(90_000)
    expect(wl.targetRatio).toBe(WATERLINE_DEFAULTS.target)
  })

  it("resolves configured ratios into absolute thresholds", () => {
    const wl = resolveWaterlines(configWith({ compactAtRatio: 0.5, compactPackRatio: 0.25 }), 2_000)
    expect(wl.at).toBe(1_000)
    expect(wl.pack).toBe(500)
    expect(wl.ahead).toBe(1_500)
    expect(wl.panic).toBe(1_800)
  })

  it("exceeds predicates treat exactly-at-line as above (>= semantics)", () => {
    const wl = resolveWaterlines(configWith({}), 1_000)
    expect(wl.exceedsFullHistory("at", 800)).toBe(true)
    expect(wl.exceedsFullHistory("at", 799)).toBe(false)
    expect(wl.exceedsActiveSpan("panic", 900)).toBe(true)
    expect(wl.exceedsActiveSpan("panic", 899)).toBe(false)
    expect(wl.exceedsFullHistory("ahead", 750)).toBe(true)
  })

  it("both estimate bases compare against the same absolute line", () => {
    // The two bases differ in WHICH estimate the caller feeds (full history vs
    // the kept span), never in the threshold — pin that here.
    const wl = resolveWaterlines(configWith({}), 1_000)
    for (const line of ["ahead", "at", "panic"] as const) {
      for (const est of [0, 400, 750, 800, 900, 1200]) {
        expect(wl.exceedsActiveSpan(line, est)).toBe(wl.exceedsFullHistory(line, est))
      }
    }
  })
})

describe("validateWaterlineConfig", () => {
  it("leaves a valid fully-configured group untouched", () => {
    const sessions = configWith({
      compactTargetRatio: 0.2,
      compactAheadRatio: 0.6,
      compactAtRatio: 0.7,
      compactPanicRatio: 0.85,
      compactPackRatio: 0.4,
    }).sessions
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    validateWaterlineConfig(sessions)
    expect(warn).not.toHaveBeenCalled()
    expect(sessions.compactAtRatio).toBe(0.7)
    expect(sessions.compactPackRatio).toBe(0.4)
  })

  it("falls the trigger group back to defaults when a value is out of (0,1]", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sessions = configWith({ compactAtRatio: 1.5, compactAheadRatio: 0.7 }).sessions
    validateWaterlineConfig(sessions)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(sessions.compactAtRatio).toBeUndefined()
    expect(sessions.compactAheadRatio).toBeUndefined()
    expect(sessions.compactPanicRatio).toBeUndefined()
    expect(sessions.compactTargetRatio).toBeUndefined()
  })

  it("falls the trigger group back when the configured order is inverted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // ahead above panic: the pre-compaction window would be silently empty.
    const sessions = configWith({ compactAheadRatio: 0.95 }).sessions
    validateWaterlineConfig(sessions)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(sessions.compactAheadRatio).toBeUndefined()
    expect(sessions.compactAtRatio).toBeUndefined()
  })

  it("validates pack independently: a bad pack leaves the trigger group alone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sessions = configWith({ compactPackRatio: 0, compactAtRatio: 0.85 }).sessions
    validateWaterlineConfig(sessions)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(sessions.compactPackRatio).toBeUndefined()
    expect(sessions.compactAtRatio).toBe(0.85)
  })

  it("accepts a partially configured group that orders correctly against defaults", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sessions = configWith({ compactAtRatio: 0.85 }).sessions
    validateWaterlineConfig(sessions)
    expect(warn).not.toHaveBeenCalled()
    expect(sessions.compactAtRatio).toBe(0.85)
  })
})
