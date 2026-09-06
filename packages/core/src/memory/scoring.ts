/** FTS5 bm25 rank（越负越相关）→ (0,1]，越相关越接近 1。 */
export function normalizeFtsRank(rank: number): number {
  if (rank >= 0) return 1
  return 1 - 1 / (1 - rank)
}

/** 双路融合（固定 0.5/0.5）：单边缺失降级为另一边，双边缺失 0。 */
export function fusedScore(fts: number | undefined, vec: number | undefined): number {
  if (fts === undefined && vec === undefined) return 0
  if (fts === undefined) return vec!
  if (vec === undefined) return fts
  return 0.5 * fts + 0.5 * vec
}

/** 时效因子：30 天衰减一半（1/(1+d/30)）；无日期 = 1（不打折）。 */
export function recencyFactor(dateISO: string, now: Date): number {
  if (dateISO === "") return 1
  const t = Date.parse(dateISO.length === 10 ? `${dateISO}T00:00:00Z` : dateISO)
  if (Number.isNaN(t)) return 1
  const days = Math.max(0, (now.getTime() - t) / 86_400_000)
  return 1 / (1 + days / 30)
}
