/**
 * One audit row (memoized): a type chip, a one-line summary, a timestamp, and
 * per-kind badges — grant reason on tool rows, input/output tokens + LLM
 * latency on the tail block of an assistant message, tool duration on
 * tool_result rows, the "已变化" marker on changed system rows. Click toggles
 * the full payload (`<pre>`). All display strings come from audit/model.ts.
 */
import { memo } from "react"
import type { AuditRow } from "./model.js"
import { fmtMs, fmtRowTime, fmtUsage, rowTime, rowTypeDef } from "./model.js"

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
      <span className="audit-summary">{rowTypeDef(row).summary(row)}</span>
      {rowBadges(row)}
      <span className="audit-meta muted">{time}</span>
    </button>
  )

  const full = expanded ? (
    <pre className="audit-full" data-testid={`audit-full-${row.key}`}>
      {rowTypeDef(row).full(row)}
    </pre>
  ) : null

  return (
    <li key={row.key} className="audit-row-item">
      {head}
      {full}
    </li>
  )
})

/** Type-chip label: the registry's per-row override (block names its block
 *  type) or its constant label. */
function rowLabel(row: AuditRow): string {
  const def = rowTypeDef(row)
  return def.rowLabel !== undefined ? def.rowLabel(row) : def.label
}

function rowBadges(row: AuditRow) {
  return (
    <>
      {row.kind === "block" && row.role === "user" && row.uiAction !== undefined && (
        <span className="audit-grant" data-testid={`audit-ui-action-${row.key}`}>
          来自 UI 卡
        </span>
      )}
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
