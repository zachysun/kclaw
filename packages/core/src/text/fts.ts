// packages/core/src/text/fts.ts
/**
 * CJK-aware tokenizer + FTS query assembly shared by the memory index and
 * the per-session compaction-segment index.
 *
 * FTS5's default unicode61 tokenizer treats a contiguous CJK run
 * ("用户在上海工作") as one opaque token, so a query for "上海" would never
 * match. ASCII letter/digit runs pass through as whole (lowercased) words;
 * every CJK run is emitted as adjacent character bigrams
 * (用户 户在 在上 上海 海工 工作). One- or two-character CJK queries are
 * themselves bigrams and MATCH directly; longer queries hit as an AND of
 * their bigrams. Tokens never contain FTS operators (punctuation drops
 * out), so quoting each token keeps the MATCH string injection-free.
 */
const WORD_RUN = /[A-Za-z0-9]+|[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const run of text.match(WORD_RUN) ?? []) {
    if (/^[A-Za-z0-9]+$/.test(run)) {
      tokens.push(run.toLowerCase())
      continue
    }
    const chars = Array.from(run)
    if (chars.length === 1) tokens.push(chars[0])
    else for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1])
  }
  return tokens
}

/** Quote tokens and join them: " " = FTS AND, " OR " = FTS OR. */
export function ftsQuery(tokens: string[], joiner: " " | " OR "): string {
  return tokens.map((token) => `"${token}"`).join(joiner)
}

/** Jaccard similarity of two token sets, in [0, 1]. */
export function similarity(a: string[], b: string[]): number {
  const setB = new Set(b)
  let intersection = 0
  for (const token of new Set(a)) if (setB.has(token)) intersection++
  const union = new Set([...a, ...b]).size
  return union === 0 ? 1 : intersection / union
}
