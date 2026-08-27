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
