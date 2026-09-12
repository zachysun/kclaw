import type { KclawConfig } from "../storage/config.js"

/**
 * Waterlines — the five compaction threshold lines, resolved once per run
 * budget into ABSOLUTE token thresholds. Every trigger decision reads this
 * object: the budget×ratio arithmetic and the ratio defaults live here and
 * nowhere else.
 *
 * The five lines, as ratios of the effective context budget:
 * - pack  0.70 — request-assembly omission budget: tool outputs that no longer
 *   fit under this line travel as omission placeholders. Decoupled from the
 *   trigger lines on purpose — loosening the yellow line must not dilute
 *   omission.
 * - ahead 0.75 — background pre-compaction lower bound: ahead ≤ estimate < panic
 *   with no compaction in flight and no parked result kicks off a background
 *   compaction (non-blocking; its result is applied at a later iteration
 *   boundary).
 * - at    0.80 — post-run (yellow) line.
 * - panic 0.90 — mid-run (red) line.
 * - target 0.33 — post-compaction target for the verbatim window; consumed as
 *   a ratio by the boundary chooser.
 *
 * The SAME line is deliberately judged on TWO estimate bases:
 * - "full history": the trigger hooks' gate checks estimate the ENTIRE message
 *   history (the ahead window, the red pre-check, the post-run yellow check).
 * - "active span": the compactor's internal re-check estimates only the span a
 *   compaction would KEEP (below the boundary). If that smaller view does not
 *   cross the line, compacting would gain nothing — it declines and nothing is
 *   dropped. This fork is load-bearing ("the hook says compact, the compactor
 *   declines → keep everything"); the two entry points below make the basis
 *   visible at every call site.
 */

/** Ratio defaults for the five lines; owned here, applied here only. */
export const WATERLINE_DEFAULTS = {
  pack: 0.7,
  ahead: 0.75,
  at: 0.8,
  panic: 0.9,
  target: 0.33,
} as const

/** The trigger lines judged by estimate comparisons (target/pack are not). */
export type WaterlineName = "ahead" | "at" | "panic"

export interface Waterlines {
  /** The effective context budget every threshold was resolved against. */
  readonly budget: number
  /** Absolute token thresholds (budget × ratio). */
  readonly pack: number
  readonly ahead: number
  readonly at: number
  readonly panic: number
  /** Post-compaction target for the verbatim window, as a ratio of the budget. */
  readonly targetRatio: number
  /** Gate-style check: `estimate` covers the ENTIRE message history. */
  exceedsFullHistory(line: WaterlineName, estimate: number): boolean
  /** Compactor re-check: `estimate` covers only the span a compaction would keep. */
  exceedsActiveSpan(line: WaterlineName, estimate: number): boolean
}

/**
 * Resolve the five lines against `budget` (the effective context budget from
 * resolveContextTokens). Config ratios absent → the module defaults apply;
 * range/order validation is loadConfig's job, so values here are trusted.
 */
export function resolveWaterlines(config: KclawConfig, budget: number): Waterlines {
  // Both predicates compare the same way today; the two names exist so every
  // call site states which denominator it estimated against (full history vs
  // the settled active span) — the fork is the callers' estimation choice.
  const s = config.sessions
  const lines = {
    pack: budget * (s.compactPackRatio ?? WATERLINE_DEFAULTS.pack),
    ahead: budget * (s.compactAheadRatio ?? WATERLINE_DEFAULTS.ahead),
    at: budget * (s.compactAtRatio ?? WATERLINE_DEFAULTS.at),
    panic: budget * (s.compactPanicRatio ?? WATERLINE_DEFAULTS.panic),
  }
  const exceeds = (line: WaterlineName, estimate: number): boolean => estimate >= lines[line]
  return {
    budget,
    ...lines,
    targetRatio: s.compactTargetRatio ?? WATERLINE_DEFAULTS.target,
    exceedsFullHistory: exceeds,
    exceedsActiveSpan: exceeds,
  }
}

/**
 * loadConfig validation for the configured waterlines — same style as the
 * permissions.defaultMode check: a value out of (0, 1] falls back to the
 * defaults with one warning; the trigger group additionally requires the
 * designed order target < ahead < at < panic (ahead ≥ panic silently empties
 * the background pre-compaction window; target ≥ ahead would re-precompact a
 * freshly compacted session). The pack line is validated independently — it
 * is decoupled from the trigger lines by design. "Falling back" means
 * deleting the configured fields so the module defaults apply; valid fields
 * are left untouched.
 */
export function validateWaterlineConfig(sessions: KclawConfig["sessions"]): void {
  const eff = {
    pack: sessions.compactPackRatio ?? WATERLINE_DEFAULTS.pack,
    ahead: sessions.compactAheadRatio ?? WATERLINE_DEFAULTS.ahead,
    at: sessions.compactAtRatio ?? WATERLINE_DEFAULTS.at,
    panic: sessions.compactPanicRatio ?? WATERLINE_DEFAULTS.panic,
    target: sessions.compactTargetRatio ?? WATERLINE_DEFAULTS.target,
  }
  const inRange = (x: number): boolean => Number.isFinite(x) && x > 0 && x <= 1
  if (!inRange(eff.at) || !inRange(eff.ahead) || !inRange(eff.panic) || !inRange(eff.target) ||
      !(eff.target < eff.ahead && eff.ahead < eff.at && eff.at < eff.panic)) {
    delete sessions.compactAtRatio
    delete sessions.compactPanicRatio
    delete sessions.compactAheadRatio
    delete sessions.compactTargetRatio
    console.warn(
      `kclaw config: sessions.compact{Target,At,Ahead,Panic}Ratio must be in (0,1] with target < ahead < at < panic; ` +
      `falling back to defaults (${WATERLINE_DEFAULTS.target}/${WATERLINE_DEFAULTS.ahead}/${WATERLINE_DEFAULTS.at}/${WATERLINE_DEFAULTS.panic})`,
    )
  }
  if (!inRange(eff.pack)) {
    delete sessions.compactPackRatio
    console.warn(`kclaw config: sessions.compactPackRatio must be in (0,1]; falling back to ${WATERLINE_DEFAULTS.pack}`)
  }
}
