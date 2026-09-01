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
 * scan the message events it covers (up to and including its `upto`) and
 * collect matches, attributed to the compaction's segmentSummary. No
 * compaction events → []. An empty query → [] (matches the old
 * tokenize("") → no-tokens behavior).
 */
export async function searchSessionEvents(events: SessionEvent[], query: string, limit: number): Promise<SessionHit[]> {
  if (query.trim() === "") return []
  const compactions = events.filter(isCompactionEvent)
  const messages = events.filter(isMessageEvent)
  const hits: SessionHit[] = []
  for (const c of compactions) {
    const uptoIdx = messages.findIndex((m) => m.id === c.upto)
    const span = uptoIdx === -1 ? messages : messages.slice(0, uptoIdx + 1)
    for (const m of span) {
      const text = JSON.stringify(m.blocks)
      if (!text.includes(query)) continue
      hits.push({ summary: c.segmentSummary, excerpt: text.slice(0, 200) })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}
