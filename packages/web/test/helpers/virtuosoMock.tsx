/**
 * Shared react-virtuoso test mock: a plain map that renders every row, plus a
 * recording scrollToIndex. jsdom has no layout, so the real library renders
 * nothing; the audit tests exercise data flow, not virtualization.
 */
import React from "react"

export interface ScrollCall {
  index: number
  align?: string
}

const scrollState = globalThis as unknown as { __auditScrollCalls?: ScrollCall[] }
scrollState.__auditScrollCalls = []

export function scrollCalls(): ScrollCall[] {
  return scrollState.__auditScrollCalls!
}

export const Virtuoso = React.forwardRef(function VirtuosoMock(
  props: { data?: unknown[]; itemContent?: (index: number, row: unknown) => React.ReactNode },
  ref: React.Ref<{ scrollToIndex: (args: ScrollCall) => void }>,
) {
  React.useImperativeHandle(ref, () => ({
    scrollToIndex: (args: ScrollCall) => {
      scrollState.__auditScrollCalls!.push(args)
    },
  }))
  return (
    <div data-testid="audit-list">
      {(props.data ?? []).map((row, index) => props.itemContent?.(index, row))}
    </div>
  )
}) as unknown as React.ComponentType<Record<string, unknown>>
