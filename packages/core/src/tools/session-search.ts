// packages/core/src/tools/session-search.ts
/**
 * Pure search over a session's event stream (replaces the SQLite
 * SegmentIndex, spec 6.4). The server reads events.jsonl via
 * SessionStore.readEvents and hands the stream here; compaction events
 * carry the segment summaries, message events carry the original text.
 */
import type { SessionEvent } from "../session/events.js"
import { isCompactionEvent, isMessageEvent } from "../session/events.js"

export interface SessionHit { summary: string; excerpt: string }

/**
 * Naive text match inside compacted segments: for each compaction event,
 * scan the message events that segment covers — the incremental span
 * (prev segment's `upto`, own `upto`], the same per-message-once attribution
 * the old segment index had — and collect matches attributed to that
 * compaction's segmentSummary. A compaction whose `upto` is not in the
 * stream is skipped (its span is unknowable). No compaction events → [].
 * An empty query or limit <= 0 → [] (matches old tokenize("")/LIMIT 0).
 */
export async function searchSessionEvents(events: SessionEvent[], query: string, limit: number): Promise<SessionHit[]> {
  if (query.trim() === "" || limit <= 0) return []
  const compactions = events.filter(isCompactionEvent)
  const messages = events.filter(isMessageEvent)
  const hits: SessionHit[] = []
  let prevUptoIdx = -1
  for (const c of compactions) {
    const uptoIdx = messages.findIndex((m) => m.id === c.upto)
    if (uptoIdx === -1) continue // 未找到覆盖范围：跳过该压缩段，不误扫整条流
    for (const m of messages.slice(prevUptoIdx + 1, uptoIdx + 1)) {
      const blocks = m.blocks
      if (blocks === undefined) continue
      const text = JSON.stringify(blocks)
      if (!text.includes(query)) continue
      hits.push({ summary: c.segmentSummary, excerpt: text.slice(0, 200) })
      if (hits.length >= limit) return hits
    }
    prevUptoIdx = uptoIdx
  }
  return hits
}
