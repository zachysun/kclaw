/**
 * Lenient context-overflow classification across OpenAI-compatible providers
 * (spec 5.6): a false positive costs one harmless early compaction, so bias
 * toward matching. Keyword-based — no provider-specific error codes exist.
 */
export function isContextOverflowError(err: unknown): boolean {
  const raw = (err as { message?: string } | null | undefined)?.message
  const msg = typeof raw === "string" ? raw : String(err)
  return /context[\s_-]?(length|window|overflow|exceeded)|maximum context|prompt (is )?too long|too many tokens|token limit|上下文(超限|过长|长度)|超出上下文/i.test(msg)
}
