/**
 * /goal wire shapes (issue #47): the domain types behind goal.set events,
 * plus the view envelope of GET /sessions/:id/goal. Type-only (no Node
 * API) — browser builds get everything through @kclaw/core/protocol. The
 * view is the single named shape: the server host's view() product, the
 * WebUI goal panel's props and the CLI /goal status output all use it.
 */
export type {
  GoalState,
  GoalStopReason,
  GoalVerdict,
  GoalSnapshot,
  GoalJudgeResult,
  GoalGateOutcome,
  GoalJudgeErrorKind,
  GoalJudgeError,
  DerivedLoop,
} from "../goal/types.js"
import type { DerivedLoop, GoalSnapshot } from "../goal/types.js"

/** Read-only view of one session's goal loop (server GoalLoopHost.view()). */
export interface GoalView {
  goal: GoalSnapshot
  /** Counters derived from the event stream at check time. */
  derived: DerivedLoop
  /** Process-local self-continue switch (false after a daemon restart). */
  armed: boolean
  /** Mechanical limits at their current values (the "round N of M" display). */
  limits: { maxRounds: number; tokenBudget: number }
}

/** GET /sessions/:id/goal response: the view, or null when the session has no goal. */
export type GoalViewResponse = { goal: GoalView | null }
