/**
 * usage 显示策略与会话列表/管理页的时间戳、对话页卡片时钟共用：命中率算式、
 * 紧凑 token 数、"缺数据显示 —"、三类时间格式化。改分母口径、缩写规则或
 * 时区呈现，这里一处生效所有调用点（全站唯一时间格式化实现）。
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

/** "2026-09-06T12:34:56.789Z" → "2026-09-06 12:34"（本地时区；解析失败原样返回）。 */
export function formatStamp(input: string): string {
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) return input
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 列表紧凑戳（全站唯一实现，原 SessionList.formatWhen 口径）：今天 →
 * HH:mm，今年 → MM/DD HH:mm，往年 → YYYY/MM/DD HH:mm。input 接受 ISO 字符
 * 串或 epoch 毫秒；解析失败原样返回。`now` 仅供测试注入。
 */
export function formatCompactStamp(input: string | number, now: Date = new Date()): string {
  const raw = typeof input === "number" ? new Date(input).toISOString() : input
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  const pad = (n: number): string => String(n).padStart(2, "0")
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return hhmm
  const md = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hhmm}`
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}/${md}`
}

/** "…T12:34:56.789Z" → "12:34:56"（本地时区，秒级——确认卡的有限期截点）。解析失败原样返回。 */
export function formatClock(input: string): string {
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) return input
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
