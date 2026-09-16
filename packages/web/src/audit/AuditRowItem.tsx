/**
 * One audit row (memoized): a type chip, a one-line summary, a timestamp, and
 * per-kind badges — grant reason on tool rows, input/output tokens + LLM
 * latency on the tail block of an assistant message, tool duration on
 * tool_result rows, the "已变化" marker on changed system rows. Click toggles
 * the full payload (`<pre>`). All display strings come from audit/model.ts.
 */
import { memo } from "react"
import type { AuditRow } from "./model.js"
import {
  blockFullContent, blockSummary, blockTypeLabel, decisionFullContent, decisionSummary, fmtMs, fmtRowTime, fmtUsage,
  memoryFullContent, memorySummary, rowTime, runSummary, sandboxFullContent, sandboxSummary, truncationSummary,
  sessionFullContent, sessionSummary, summarize, systemFullText, teamFullContent, teamSummary,
} from "./model.js"

export interface AuditRowItemProps {
  row: AuditRow
  expanded: boolean
  onToggle: (key: string) => void
}

export const AuditRowItem = memo(function AuditRowItem({ row, expanded, onToggle }: AuditRowItemProps) {
  const toggle = () => onToggle(row.key)
  const time = fmtRowTime(rowTime(row))

  const head = (
    <button
      type="button"
      className="audit-row"
      data-testid={`${row.kind === "block" ? "audit" : row.kind}-row-${row.key}`}
      onClick={toggle}
    >
      <span className="audit-type">{rowLabel(row)}</span>
      <span className="audit-summary">{rowSummary(row)}</span>
      {rowBadges(row)}
      <span className="audit-meta muted">{time}</span>
    </button>
  )

  const full = expanded ? (
    <pre className="audit-full" data-testid={`audit-full-${row.key}`}>
      {rowFull(row)}
    </pre>
  ) : null

  return (
    <li key={row.key} className="audit-row-item">
      {head}
      {full}
    </li>
  )
})

function rowLabel(row: AuditRow): string {
  switch (row.kind) {
    case "block":
      return blockTypeLabel(row.block)
    case "compaction":
      return "compaction"
    case "memory":
      return "memory"
    case "system":
      return "system"
    case "sandbox":
      return "sandbox"
    case "session":
      return "session"
    case "run":
      return "run"
    case "decision":
      return "permission"
    case "truncation":
      return "truncation"
    case "team":
      return "team"
  }
}

function rowSummary(row: AuditRow): string {
  switch (row.kind) {
    case "block":
      return blockSummary(row.block)
    case "compaction":
      return compactionSummary(row.record)
    case "memory":
      return memorySummary(row.event)
    case "system": {
      const full = systemFullText(row.event)
      return `${summarize(full, 60)} · ${full.length} 字`
    }
    case "sandbox":
      return sandboxSummary(row.event)
    case "session":
      return sessionSummary(row.event)
    case "run":
      return runSummary(row.event)
    case "decision":
      return decisionSummary(row.event)
    case "truncation":
      return truncationSummary(row.event)
    case "team":
      return teamSummary(row.event)
  }
}

function rowBadges(row: AuditRow) {
  return (
    <>
      {row.kind === "block" && row.grantedBy !== undefined && (
        <span className="audit-grant" data-testid={`audit-grant-${row.key}`}>
          放行: {row.grantedBy}
        </span>
      )}
      {row.kind === "block" && row.role === "assistant" && row.messageTail && row.usage !== undefined && (
        <span className="audit-usage" data-testid={`audit-usage-${row.key}`}>
          {fmtUsage(row.usage)}
          {row.latencyMs !== undefined ? ` · ${fmtMs(row.latencyMs)}` : " · —"}
        </span>
      )}
      {row.kind === "block" && row.block.type === "tool_result" && (
        <span className="audit-duration" data-testid={`audit-duration-${row.key}`}>
          {fmtMs(row.block.durationMs)}
        </span>
      )}
      {row.kind === "system" && row.changed && (
        <span className="audit-grant" data-testid={`audit-changed-${row.key}`}>
          已变化
        </span>
      )}
    </>
  )
}

function rowFull(row: AuditRow): string {
  switch (row.kind) {
    case "block":
      return blockFullContent(row.block)
    case "compaction":
      return `段摘要：\n${row.record.segmentSummary}\n\n总摘要：\n${row.record.top}`
    case "memory":
      return memoryFullContent(row.event)
    case "system":
      return row.event.text !== undefined
        ? row.event.text
        : `【稳定段】\n${row.event.stable}\n\n【实时段】\n${row.event.live ?? ""}`
    case "sandbox":
      return sandboxFullContent(row.event)
    case "session":
      return sessionFullContent(row.event)
    case "run":
      return JSON.stringify(row.event, null, 2)
    case "decision":
      return decisionFullContent(row.event)
    case "truncation":
      return JSON.stringify(row.event, null, 2)
    case "team":
      return teamFullContent(row.event)
  }
}

function compactionSummary(record: Extract<AuditRow, { kind: "compaction" }>["record"]): string {
  const trigger =
    record.trigger === "manual"
      ? `手动${record.focus ? `（${record.focus}）` : ""}`
      : record.trigger === "in-run"
        ? "自动（运行中）"
        : "自动（收尾）"
  return `${trigger}${record.emergency === true ? "·超限急救" : ""} · ${record.from ?? "会话开头"} – ${record.upto} · ${record.messages} 条`
}
