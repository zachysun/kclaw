/**
 * UsageView — token/cost ledger: daily curve + per-session detail from
 * `GET /usage`, with a JSON export (client-side download). Prices come from
 * the daemon's config; when no model has a price the cost column is omitted
 * entirely instead of showing a column of dashes. Session rows resolve raw
 * bucket keys to titles via GET /sessions (unknown ids fall back to the key).
 * The 分布 bar is pure CSS, scaled to each table's busiest row.
 */
import { useEffect, useMemo, useState } from "react"
import type { ApiClient } from "../api.js"
import type { SessionMeta } from "../types.js"

interface UsageBucket { key: string; inputTokens: number; outputTokens: number; costUsd: number }
interface UsageBody { by: string; buckets: UsageBucket[]; total: { inputTokens: number; outputTokens: number; costUsd: number } }

/** A cost column only earns its place when at least one cent shows up. */
function hasCost(body: UsageBody | null): boolean {
  if (body === null) return false
  return body.total.costUsd > 0 || body.buckets.some((b) => b.costUsd > 0)
}

export function UsageView({ api }: { api: ApiClient }) {
  const [daily, setDaily] = useState<UsageBody | null>(null)
  const [bySession, setBySession] = useState<UsageBody | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.get<UsageBody>("/usage?by=day"), api.get<UsageBody>("/usage?by=session")])
      .then(([d, s]) => {
        if (cancelled) return
        setDaily(d)
        setBySession(s)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    // Titles are cosmetic — a failed lookup silently degrades to raw ids.
    api
      .get<SessionMeta[]>("/sessions")
      .then((metas) => {
        if (!cancelled) setSessions(metas)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [api])

  const titleOf = useMemo(() => {
    const byId = new Map((sessions ?? []).map((s) => [s.id, s.title]))
    return (key: string): string => byId.get(key) ?? key
  }, [sessions])

  const exportJson = (): void => {
    api.get<UsageBody>("/usage?by=session").then((body) => {
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "kclaw-usage.json"
      a.click()
      URL.revokeObjectURL(url)
    })
  }

  const fmt = (n: number) => n.toLocaleString()
  const fmtCost = (c: number) => `$${c.toFixed(4)}`
  const total = (b: UsageBucket) => b.inputTokens + b.outputTokens
  const maxOf = (body: UsageBody | null): number =>
    Math.max(1, ...(body?.buckets.map(total) ?? [0]))

  if (error !== null) return <p className="muted" data-testid="usage-error">用量加载失败: {error}</p>

  const showDailyCost = hasCost(daily)
  const showSessionCost = hasCost(bySession)

  return (
    <div className="usage-view" data-testid="usage-view">
      <h2 className="view-title">用量统计</h2>
      <p className="muted">
        总计: {daily === null ? "…" : `${fmt(daily.total.inputTokens)} 输入 / ${fmt(daily.total.outputTokens)} 输出 token${showDailyCost ? `，${fmtCost(daily.total.costUsd)}` : ""}`}
        <button className="usage-export" onClick={exportJson}>导出 JSON</button>
      </p>
      <h4>按天</h4>
      <table data-testid="usage-day-table">
        <thead>
          <tr>
            <th>日期</th><th>输入</th><th>输出</th><th>合计</th><th>分布</th>
            {showDailyCost && <th>费用</th>}
          </tr>
        </thead>
        <tbody>
          {(daily?.buckets ?? []).map((b) => (
            <tr key={b.key}>
              <td>{b.key}</td>
              <td className="num">{fmt(b.inputTokens)}</td>
              <td className="num">{fmt(b.outputTokens)}</td>
              <td className="num">{fmt(total(b))}</td>
              <td className="usage-bar-cell" title={`${fmt(total(b))} token`}>
                <span className="usage-bar-track">
                  <span className="usage-bar" style={{ width: `${(total(b) / maxOf(daily)) * 100}%` }} />
                </span>
              </td>
              {showDailyCost && <td className="num">{b.costUsd === 0 ? "—" : fmtCost(b.costUsd)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <h4>按会话</h4>
      <table data-testid="usage-session-table">
        <thead>
          <tr>
            <th>会话</th><th>输入</th><th>输出</th><th>合计</th><th>分布</th>
            {showSessionCost && <th>费用</th>}
          </tr>
        </thead>
        <tbody>
          {(bySession?.buckets ?? []).map((b) => (
            <tr key={b.key}>
              <td className="usage-session-name" title={b.key}>{titleOf(b.key)}</td>
              <td className="num">{fmt(b.inputTokens)}</td>
              <td className="num">{fmt(b.outputTokens)}</td>
              <td className="num">{fmt(total(b))}</td>
              <td className="usage-bar-cell" title={`${fmt(total(b))} token`}>
                <span className="usage-bar-track">
                  <span className="usage-bar" style={{ width: `${(total(b) / maxOf(bySession)) * 100}%` }} />
                </span>
              </td>
              {showSessionCost && <td className="num">{b.costUsd === 0 ? "—" : fmtCost(b.costUsd)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
