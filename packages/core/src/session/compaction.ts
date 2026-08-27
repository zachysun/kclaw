import type { AssistantMessage, Message } from "../protocol/messages.js"

const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/** Rough token estimate: CJK 0.75/char, everything else 0.25/char (spec 6.1.1). */
export function estimateTokens(text: string): number {
  let units = 0
  for (const ch of text) units += CJK.test(ch) ? 0.75 : 0.25
  return Math.ceil(units)
}

/**
 * Coarse render of one message for size estimation: every text-bearing
 * block's text plus tool args/results. Precision only needs to be
 * trigger-grade (spec 6.1.3).
 */
function messageText(m: Message): string {
  const parts: string[] = []
  for (const b of m.blocks as Array<{ type: string; text?: string; output?: string; argsJson?: string }>) {
    if (typeof b.text === "string") parts.push(b.text)
    if (typeof b.output === "string") parts.push(b.output)
    if (typeof b.argsJson === "string") parts.push(b.argsJson)
  }
  return parts.join(" ")
}

/**
 * Estimated size of "send the active history plus this turn's user text".
 * Anchors on the last assistant message's real usage.inputTokens (the last
 * actually-sent request size, system prompt and tool defs included — biased
 * LARGE, which only compacts earlier: the safe direction); messages after
 * it are estimated per message (spec 6.1.1).
 */
export function estimateContextTokens(active: Message[], extraText?: string): number {
  let anchorIdx = -1
  for (let i = active.length - 1; i >= 0; i--) {
    if (active[i]!.role === "assistant") { anchorIdx = i; break }
  }
  // anchorIdx only ever points at an assistant message, and assistant
  // messages always carry usage — the downcast is safe.
  const base = anchorIdx >= 0 ? (active[anchorIdx] as AssistantMessage).usage.inputTokens : 0
  let sum = 0
  for (let i = anchorIdx + 1; i < active.length; i++) sum += estimateTokens(messageText(active[i]!))
  if (extraText !== undefined) sum += estimateTokens(extraText)
  return base + sum
}

/** One compacted segment: covers history up to (including) message `upto`. */
export interface CompactionSegment { upto: string; summary: string }

/** v2 compaction state persisted on SessionMeta (spec 5.1). */
export interface CompactionState { segments: CompactionSegment[]; top: string; upto: string }

/**
 * Decide the retention boundary (spec 6.1.2). Walks NEWEST→oldest until the
 * accumulated estimate reaches budget×targetRatio — the walk marks the kept
 * part — then backs the start up to the nearest user message so both sides
 * are whole turns (tool calls never split from their results). `keepFrom` 0
 * or no user message at all → undefined (do not compact).
 */
export function chooseBoundary(
  active: Message[],
  opts: { budget: number; targetRatio: number },
): { keepFrom: number } | undefined {
  const target = opts.budget * opts.targetRatio
  let acc = 0
  let stop = 0
  for (let i = active.length - 1; i >= 0; i--) {
    acc += estimateTokens(messageText(active[i]!))
    stop = i
    if (acc >= target) break
  }
  // Accumulator never reached target: the whole history is under target.
  if (acc < target) return undefined
  for (let i = stop; i >= 0; i--) {
    if (active[i]!.role !== "user") continue
    return i === 0 ? undefined : { keepFrom: i }
  }
  return undefined
}

/**
 * Map persisted segments back to their original messages (spec 5.1/6.4.1).
 * Segment i spans (previous upto | firstFromExclusive | history start) to
 * its own upto. A stale upto yields an empty message list — callers skip it.
 */
export function segmentRanges(
  history: Message[],
  segments: Array<{ upto: string }>,
  firstFromExclusive?: string,
): Array<{ upto: string; messages: Message[] }> {
  const out: Array<{ upto: string; messages: Message[] }> = []
  let startExclusive: string | undefined = firstFromExclusive
  for (const seg of segments) {
    const from = startExclusive === undefined ? -1 : history.findIndex((m) => m.id === startExclusive)
    const to = history.findIndex((m) => m.id === seg.upto)
    out.push({
      upto: seg.upto,
      messages: to > from ? history.slice(from + 1, to + 1) : [],
    })
    startExclusive = seg.upto
  }
  return out
}
