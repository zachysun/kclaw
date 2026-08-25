/**
 * UsageView — token/cost ledger: daily curve + per-session detail from
 * `GET /usage`, with a JSON export (client-side download). Prices come from
 * the daemon's config; unconfigured models show tokens with cost 0.
 */
import { useEffect, useState } from "react"
import type { ApiClient } from "../api.js"

interface UsageBucket { key: string; inputTokens: number; outputTokens: number; costUsd: number }
interface UsageBody { by: string; buckets: UsageBucket[]; total: { inputTokens: number; outputTokens: number; costUsd: number } }

export function UsageView({ api }: { api: ApiClient }) {
  const [daily, setDaily] = useState<UsageBody | null>(null)
  const [bySession, setBySession] = useState<UsageBody | null>(null)
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
    return () => {
      cancelled = true
    }
  }, [api])

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
  const fmtCost = (c: number) => (c === 0 ? "—" : `$${c.toFixed(4)}`)

  if (error !== null) return <p className="muted" data-testid="usage-error">用量加载失败: {error}</p>

  return (
    <div className="usage-view" data-testid="usage-view">
      <h3>用量统计</h3>
      <p className="muted">
        总计: {daily === null ? "…" : `${fmt(daily.total.inputTokens)} 输入 / ${fmt(daily.total.outputTokens)} 输出 token，${fmtCost(daily.total.costUsd)}`}
        <button className="usage-export" onClick={exportJson}>导出 JSON</button>
      </p>
      <h4>按天</h4>
      <table data-testid="usage-day-table">
        <thead><tr><th>日期</th><th>输入</th><th>输出</th><th>费用</th></tr></thead>
        <tbody>
          {(daily?.buckets ?? []).map((b) => (
            <tr key={b.key}><td>{b.key}</td><td>{fmt(b.inputTokens)}</td><td>{fmt(b.outputTokens)}</td><td>{fmtCost(b.costUsd)}</td></tr>
          ))}
        </tbody>
      </table>
      <h4>按会话</h4>
      <table data-testid="usage-session-table">
        <thead><tr><th>会话</th><th>输入</th><th>输出</th><th>费用</th></tr></thead>
        <tbody>
          {(bySession?.buckets ?? []).map((b) => (
            <tr key={b.key}><td>{b.key}</td><td>{fmt(b.inputTokens)}</td><td>{fmt(b.outputTokens)}</td><td>{fmtCost(b.costUsd)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
