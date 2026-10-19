/**
 * tool_search: search the non-full tiers (directory + deferred, including
 * MCP adapter tools) and return complete tool cards; hits are promoted
 * into the run's active set so the model calls them by name directly from
 * the next step on.
 *
 * Ranking is Okapi BM25 (k1 1.2, b 0.75) over name-split tokens,
 * description, and top-level parameter names — schema bodies are noise and
 * excluded. Exact-name matches rank first unconditionally. A rare-term
 * gate (the query's highest-IDF token must hit) plus a coverage threshold
 * on multi-word queries (≥4 words need ≥50% of terms present) keep long
 * queries from flooding the slots with near-misses — precision beats
 * recall for tool discovery (both surveyed implementations gate the same
 * way; no embeddings anywhere in the surveyed field).
 *
 * Promotion is REAL, not bridged: the executor hands the hit defs to
 * ctx.promote (the loop merges them into the next request's tools array),
 * so every promoted call is an individually validated, permission-checked,
 * event-recorded call — the per-call audit granularity kclaw refuses to
 * fold into a dispatcher tool.
 */
import type { ToolDefinition } from "../provider/types.js"
import type { ToolExecutor } from "../agent/tools.js"
import { optInt } from "./shared.js"

const K1 = 1.2
const B = 0.75
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
/** Queries with at least this many terms must match at least half of them. */
const COVERAGE_MIN_TERMS = 4

interface Doc {
  def: ToolDefinition
  source: string
  tokens: string[]
  termFreq: Map<string, number>
  length: number
}

/** Split a tool name into indexable tokens (snake/camel/kebab aware). */
function nameTokens(name: string): string[] {
  return name
    .split(/[_\-\s]+/)
    .flatMap((part) => part.split(/(?=[A-Z])/))
    .filter(Boolean)
    .map((t) => t.toLowerCase())
}

function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (raw === "") continue
    out.push(raw)
    // CJK runs index as bigrams (same shape as the FTS layer): a two-char
    // Chinese word overlaps its neighbours, so substring-ish queries hit.
    const cjk = raw.match(/[\u4e00-\u9fff]{2,}/g)
    if (cjk !== null) {
      for (const run of cjk) {
        for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2))
      }
    }
  }
  return out
}

function paramNames(def: ToolDefinition): string[] {
  const props = (def.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return props === undefined ? [] : Object.keys(props).flatMap((k) => nameTokens(k))
}

export function createToolSearchTool(opts: {
  /** Everything searchable: directory + deferred defs (builtins + MCP adapters). */
  pool: ToolDefinition[]
  /** Per-server source list for the empty-result fallback (existence signal). */
  sources: string[]
}): ToolExecutor & { name: "tool_search" } {
  const docs: Doc[] = opts.pool.map((def) => {
    const tokens = [
      ...nameTokens(def.name),
      ...tokenize(def.name),
      ...tokenize(def.description),
      ...paramNames(def),
    ]
    const termFreq = new Map<string, number>()
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1)
    return { def, source: sourceOf(def.name), tokens, termFreq, length: tokens.length }
  })
  const avgLen = docs.length === 0 ? 1 : docs.reduce((a, d) => a + d.length, 0) / docs.length
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  const idf = (term: string): number =>
    Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))

  // Raw executor (not makeTool): the promote seam needs the run context,
  // which makeTool's single-argument fn shape does not carry.
  const tool_search: ToolExecutor & { name: "tool_search" } = {
    name: "tool_search",
    risk: "safe",
    concurrency: "parallel",
    execute(args, ctx) {
    const query = (args as { query?: unknown } | null)?.query
    if (typeof query !== "string" || query.trim() === "") {
      return Promise.resolve({ status: "error", output: "tool_search: args.query must be a non-empty string" })
    }
    const limit = optInt(args, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT)
    const terms = Array.from(new Set(tokenize(query).flatMap((t) => nameTokens(t).length > 0 ? [t, ...nameTokens(t)] : [t])))
    if (docs.length === 0) {
      return Promise.resolve({
        status: "ok",
        output: `(无可检索工具)\n可用来源：${opts.sources.join("、") || "(none)"}`,
      })
    }

    // Rare-term gate: the highest-IDF term PRESENT in the corpus must appear
    // in a doc for it to score at all (a common-word hit must not fill
    // slots). Terms absent from every doc are skipped — gating on a word no
    // tool mentions would nuke the whole result set.
    const ranked = terms
      .map((t) => ({ t, idf: idf(t), present: (df.get(t) ?? 0) > 0 }))
      .filter((r) => r.present)
      .sort((a, b) => b.idf - a.idf)
    const gateTerm = ranked[0]?.t

    const scored = docs
      .map((d) => {
        let matches = 0
        let score = 0
        for (const { t } of ranked) {
          const f = d.termFreq.get(t)
          if (f === undefined) continue
          matches++
          score += idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / avgLen)))
        }
        return { d, score, matches }
      })
      .filter((s) => s.matches > 0 && (gateTerm === undefined || s.d.termFreq.has(gateTerm)))

    // Coverage threshold for long queries.
    const passed =
      terms.length >= COVERAGE_MIN_TERMS
        ? scored.filter((s) => s.matches >= Math.ceil(terms.length / 2))
        : scored

    // Exact-name match ranks first unconditionally.
    const exact = docs.find((d) => d.def.name === query.trim())
    const finalRanked = (passed.length > 0 ? passed : scored).sort((a, b) => b.score - a.score)
    const hits: Doc[] = []
    if (exact !== undefined) hits.push(exact)
    for (const s of finalRanked) {
      if (hits.length >= limit) break
      if (exact !== undefined && s.d.def.name === exact.def.name) continue
      hits.push(s.d)
    }

    if (hits.length === 0) {
      return Promise.resolve({
        status: "ok",
        output: `(没有匹配的工具)\n可用来源：${opts.sources.join("、") || "(none)"}；换更具体的词（工具名、动作词）再试。`,
      })
    }

    const cards = hits.map((d) => {
      const props = (d.def.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined)
      const params = Object.entries(props?.properties ?? {})
        .map(([k, v]) => {
          const req = props?.required?.includes(k) ? "" : "?"
          const type = (v as { type?: string } | null)?.type ?? "unknown"
          const desc = (v as { description?: string } | null)?.description ?? ""
          return `  ${k}${req}: ${type}${desc !== "" ? ` — ${desc}` : ""}`
        })
        .join("\n")
      return `【${d.def.name}】（来源：${d.source}）\n${d.def.description}${params !== "" ? `\n参数：\n${params}` : "\n参数：无"}`
    })

    // Real promotion: the loop merges these defs into the next request's
    // tools array; calls to them stay individually validated and audited.
    const promote = (ctx as { promote?: (defs: ToolDefinition[]) => void }).promote
    try {
      promote?.(hits.map((h) => h.def))
    } catch {
      // promotion is best-effort; the cards still teach the model the schema
    }

      return Promise.resolve({
        status: "ok",
        output: `${hits.length} 个命中（已加入本 run 可用集，可直接按名调用）：\n\n${cards.join("\n\n")}`,
        data: { names: hits.map((h) => h.def.name) },
      })
    },
  }
  return tool_search
}

/** Source label: mcp__<server>__<tool> → that server; anything else builtin. */
function sourceOf(name: string): string {
  const m = /^mcp__([^_]+)__/.exec(name)
  return m === null ? "builtin" : `mcp:${m[1]}`
}
