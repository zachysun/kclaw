/**
 * Compaction audit bars — the collapsed "早期对话已压缩" context markers
 * derived from GET /sessions/:id/compactions. The record mirror and the
 * insertion-index derivation are pure; the bar itself is a native <details>
 * (summary-only body, the audit record carries no kept-segment data).
 */
import { fmtTokens } from "../audit/model.js"
import type { RenderedMessage } from "./model.js"

/**
 * 压缩审计记录的 web 侧轻量镜像（GET /sessions/:id/compactions 的 UI
 * 子集，刻意不引 @kclaw/core——web 包自包含，见 model.ts 的协议镜像决策）。
 */
export interface CompactionRecordView {
  /** 本次压缩覆盖到的最后一条消息 id（折叠条插在它后面）。 */
  upto: string
  /** 本段摘要（折叠条展开后的正文）。 */
  segmentSummary: string
  /** "auto" | "in-run" | "manual"（审计用途，暂不参与渲染）。 */
  trigger: string
  /** 超限紧急压缩标记（审计用途，暂不参与渲染）。 */
  emergency?: boolean
  /** 压缩前活跃段上下文 token（旧记录缺失）。 */
  tokensBefore?: number
  /** 压缩后等效上下文 token（旧记录缺失）。 */
  tokensAfter?: number
}

/** One audit-driven collapsed context bar to render. */
export interface CompactionAuditBar {
  key: string
  /** 折叠条插在 messages[insertIdx] 之前（= upto 气泡之后）。 */
  insertIdx: number
  /** 第 N 次压缩（记录序号 + 1）。 */
  segments: number
  summary: string
  /** 本次压缩的 token 变化（旧记录缺失）。 */
  tokens?: { before: number; after: number }
}

/**
 * Derive the audit-driven collapsed context bars: one per compaction
 * record, inserted right AFTER the record's `upto` message. Records whose
 * upto no longer exists (deleted messages) are dropped.
 */
export function compactionBars(
  messages: RenderedMessage[],
  records: CompactionRecordView[],
): CompactionAuditBar[] {
  const bars: CompactionAuditBar[] = []
  records.forEach((record, ordinal) => {
    const segments = ordinal + 1
    const uptoIdx = messages.findIndex((m) => m.id === record.upto)
    if (uptoIdx === -1) return
    const tokens = record.tokensBefore !== undefined && record.tokensAfter !== undefined
      ? { before: record.tokensBefore, after: record.tokensAfter }
      : undefined
    bars.push({ key: `compaction-${ordinal}-${record.upto}`, insertIdx: uptoIdx + 1, segments, summary: record.segmentSummary, tokens })
  })
  return bars
}

/** Audit-driven collapsed <details>, summary-only body (审计记录无 kept 数据). */
export function AuditContextNote({ bar }: { bar: CompactionAuditBar }) {
  const tokens = bar.tokens !== undefined
    ? ` · ${fmtTokens(bar.tokens.before)} → ${fmtTokens(bar.tokens.after)} token`
    : ""
  return (
    <details className="ctx-note" data-testid="ctx-note-audit">
      <summary>模型上下文：早期对话已压缩为 {bar.segments} 段{tokens}（点击展开）</summary>
      <div className="ctx-note-body">
        <p className="ctx-note-summary">{bar.summary}</p>
      </div>
    </details>
  )
}
