/**
 * Cache miss attribution: a per-request fingerprint (system hash, tool-set
 * hash, per-message hashes) plus a diff against the previous assembled
 * request. The loop computes the fingerprint after the llm-before chain (the
 * rewritten view is what the provider actually sees) and, when the caller
 * provides a `cacheProbe`, diffs it against the previous request's
 * fingerprint of the same session. Divergence reasons name WHERE the prefix
 * broke — tools changed, system changed, history rebuilt (window shift /
 * compaction), or a mid-history message changed its bytes (mention/skill
 * wrap divergence) — so a cache miss is attributable instead of guessed.
 *
 * Pure functions, no I/O; the snapshot is a JSON string held by the caller
 * (daemon keeps one per session in memory; a restart simply skips the first
 * diff).
 */
import type { CacheMissAttribution } from "../protocol/events.js"
import type { ProviderMessage, ToolDefinition } from "../provider/types.js"

export type { CacheMissAttribution }

interface Fingerprint {
  s: string
  t: string
  m: Array<{ h: string; head: string }>
}

/** FNV-1a 32-bit, base36 — stable, tiny, collision odds irrelevant here. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const HEAD_CHARS = 80

function messageText(m: ProviderMessage): string {
  if (typeof m.content === "string") return m.content
  // assistant 的 null content（纯工具调用轮）：历史只追加、写入后不变，
  // 其调用内容的变化总会伴随后续消息序列变化，指纹无需单列 toolCalls。
  if (m.content === null) return ""
  return m.content
    .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
    .join("")
}

/** Fingerprint one assembled request: system, tool set, and every message. */
export function fingerprintAssembled(
  system: string,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
): string {
  const fp: Fingerprint = {
    s: hash(system),
    t: hash(tools.map((d) => `${d.name}\u0000${d.description}\u0000${JSON.stringify(d.parameters)}`).join("\u0001")),
    m: messages.map((m) => {
      const text = `${m.role}\u0000${messageText(m)}`
      return { h: hash(text), head: text.slice(0, HEAD_CHARS) }
    }),
  }
  return JSON.stringify(fp)
}

/**
 * Diff two fingerprint snapshots. null = the previous request's message list
 * is a strict prefix of this one and system/tools are unchanged (pure
 * append — the provider should reuse its cached prefix). Anything else
 * returns the named reasons; a mid-list divergence carries the 1-based
 * index and both head excerpts.
 */
export function diffFingerprints(prevJson: string, nextJson: string): CacheMissAttribution | null {
  let prev: Fingerprint
  let next: Fingerprint
  try {
    prev = JSON.parse(prevJson) as Fingerprint
    next = JSON.parse(nextJson) as Fingerprint
  } catch {
    // A corrupted snapshot must never break a run: treat as no data.
    return null
  }
  const reasons: string[] = []
  if (prev.t !== next.t) reasons.push("tools_changed")
  if (prev.s !== next.s) reasons.push("system_changed")
  let common = 0
  while (common < prev.m.length && common < next.m.length && prev.m[common]!.h === next.m[common]!.h) common++
  if (common < prev.m.length) {
    reasons.push(common === 0 ? "history_rebuilt" : "history_diverged")
  }
  if (reasons.length === 0) return null
  return {
    reasons,
    ...(common < prev.m.length
      ? {
          divergedAt: common + 1,
          ...(prev.m[common] !== undefined ? { prevHead: prev.m[common]!.head } : {}),
          ...(next.m[common] !== undefined ? { nextHead: next.m[common]!.head } : {}),
        }
      : {}),
  }
}
