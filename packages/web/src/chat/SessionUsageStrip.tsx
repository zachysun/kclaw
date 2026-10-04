/**
 * SessionUsageStrip — 一行灰色小字，挂在对话页输入框下方：当前会话累计
 * 输入/输出 token 与提示词缓存命中率。数据来自 `GET /usage?by=session`
 * （usage 表在 run 收尾时已写好缓存字段），父组件在每次 run 收尾时递增
 * `refreshKey` 驱动刷新。定位是"仪表"不是"台账"：缓存读/写明细只在用量
 * 页显示，这里只给总量与命中率。缓存指标缺失（端点不返回）显示 "—"，
 * 绝不显示 0%——未知不是零，与用量页同一口径。
 */
import { useEffect, useState } from "react"
import type { ApiClient } from "../api.js"

import type { UsageAgg, UsageBody } from "@kclaw/core/protocol"

/** 紧凑 token 数：980 / 14.2k / 3.1M——一行小字放不下 toLocaleString。 */
export function fmtCompact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
  }
  return `${Math.round((n / 1_000_000) * 10) / 10}M`
}

/** 缓存读 / 输入总量（inputTokens 恒等式 = 非缓存 + 缓存写 + 缓存读）。 */
export function hitRateText(bucket: UsageAgg | undefined): string {
  if (bucket === undefined || bucket.cacheReadTokens === null) return "—"
  return `${Math.round((bucket.cacheReadTokens / Math.max(1, bucket.inputTokens)) * 100)}%`
}

export function SessionUsageStrip({ api, sessionId, refreshKey }: {
  api: ApiClient
  sessionId: string
  /** 父组件每次 run 收尾时 +1；0 = 只在挂载/切会话时拉一次。 */
  refreshKey: number
}) {
  const [bucket, setBucket] = useState<UsageAgg | undefined>(undefined)
  useEffect(() => {
    let alive = true
    api.get<UsageBody>("/usage?by=session")
      .then((body) => {
        if (alive) setBucket(body.buckets.find((b) => b.key === sessionId))
      })
      // 状态条拿不到数不是故障：保留旧值、静默不打断对话（对齐 MCP 页轮询的静默约定）。
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [api, sessionId, refreshKey])
  return (
    <div
      className="session-usage-strip"
      data-testid="session-usage-strip"
      title="当前会话累计用量；缓存读/写明细见用量页"
    >
      in {fmtCompact(bucket?.inputTokens ?? 0)} · out {fmtCompact(bucket?.outputTokens ?? 0)} · cache {hitRateText(bucket)}
    </div>
  )
}
