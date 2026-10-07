/**
 * usage 显示策略（两个视图共用）：命中率算式、紧凑 token 数、"缺数据显示
 * —"。记录页（UsageView）与仪表条（SessionUsageStrip）分组件渲染，但策略
 * 不随组件走——改分母口径或缩写规则，这里一处生效两处。
 */
import type { UsageAgg } from "@kclaw/core/protocol"

/**
 * 缓存读 / 输入总量；缓存读未知（null）时返回 null，由调用方渲染 "—"。
 * 分母口径 = inputTokens 恒等式（非缓存 + 缓存写 + 缓存读，
 * docs/core/provider.md），max(1, ·) 防 0 输入除零。
 */
export function hitRate(b: UsageAgg): string | null {
  if (b.cacheReadTokens === null) return null
  return `${Math.round((b.cacheReadTokens / Math.max(1, b.inputTokens)) * 100)}%`
}

/** 缓存命中率文本形：连桶都没有或未知（null）一律 "—"，绝不显示 0%。 */
export function hitRateText(bucket: UsageAgg | undefined): string {
  if (bucket === undefined) return "—"
  return hitRate(bucket) ?? "—"
}

/** 紧凑 token 数：980 / 14.2k / 3.1M——一行小字放不下 toLocaleString。 */
export function fmtCompact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
  }
  return `${Math.round((n / 1_000_000) * 10) / 10}M`
}
