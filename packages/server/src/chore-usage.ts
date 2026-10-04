import { randomUUID } from "node:crypto"
import type { ChoreUsageRecorder, UsageStore } from "@kclaw/core"

/**
 * The daemon's chore metering implementation: every background chore LLM call
 * (compaction summaries, autoname, memory extract/consolidate, skill
 * evolution) lands as a UsageStore row, runId prefixed by the chore kind —
 * the same ledger the goal judge writes (its rows keep their
 * `goal-judge-*` shape). A row is skipped when the call has no attributable
 * session (manual memory admin on a session-less project), when the stream
 * died before message_done (usage unknown), or when the provider reported
 * zero tokens. The random suffix keeps the `u_<session>_<runId>` primary key
 * unique when two chores land within the same millisecond.
 */
export function createChoreUsageRecorder(usage: UsageStore): ChoreUsageRecorder {
  return (r) => {
    const u = r.usage
    if (r.sessionId === undefined || r.sessionId === "") return
    if (u === undefined || (u.inputTokens === 0 && u.outputTokens === 0)) return
    usage.record({
      sessionId: r.sessionId,
      runId: `${r.chore}-${randomUUID()}`,
      model: r.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
      ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
      at: new Date().toISOString(),
    })
  }
}
