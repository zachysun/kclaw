import { randomUUID } from "node:crypto"
import type { ChoreUsageRecorder, UsageRow, UsageStore } from "@kclaw/core"

/** The one UsageStore method the recorder needs (a test spy satisfies it). */
type UsageSink = Pick<UsageStore, "record">

/**
 * The daemon's chore metering implementation: every background chore LLM call
 * (compaction summaries, autoname, memory extract/consolidate, skill
 * evolution) lands as a usage row, runId prefixed by the chore kind — the
 * same ledger the goal judge writes (its rows keep their `goal-judge-*`
 * shape). A row is skipped when the call has no attributable session (manual
 * memory admin on a session-less project), when the stream died before
 * message_done (usage unknown), or when the provider reported zero tokens.
 * The random suffix keeps the `u_<session>_<runId>` primary key unique when
 * two chores land within the same millisecond.
 */
export function createChoreUsageRecorder(usage: UsageSink): ChoreUsageRecorder {
  return (r) => {
    const u = r.usage
    if (r.sessionId === undefined || r.sessionId === "") return
    if (u === undefined || (u.inputTokens === 0 && u.outputTokens === 0)) return
    // 记录绝不反噬业务（UsageStore 自己的承诺，usage-ledger 同款）：库故障
    // 只打一行日志，压缩/命名/记忆/技能照常。
    try {
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
    } catch (err) {
      console.error(`kclaw usage: chore ${r.chore} record failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
