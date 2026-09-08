/**
 * Shared react-virtuoso test mock: a plain map that renders every row, plus a
 * recording scrollToIndex. jsdom has no layout, so the real library renders
 * nothing; the audit tests exercise data flow, not virtualization. Follow
 * semantics go through the captured props: fireAtBottom invokes the
 * atBottomStateChange callback the view wired up.
 */
import React from "react"

export interface ScrollCall {
  index: number
  align?: string
}

interface CapturedProps {
  data?: unknown[]
  itemContent?: (index: number, row: unknown) => React.ReactNode
  followOutput?: unknown
  atBottomStateChange?: (atBottom: boolean) => void
  initialTopMostItemIndex?: number
  [key: string]: unknown
}

const state = globalThis as unknown as {
  __auditScrollCalls?: ScrollCall[]
  __auditVirtuosoProps?: CapturedProps
}
state.__auditScrollCalls = []

export function scrollCalls(): ScrollCall[] {
  return state.__auditScrollCalls!
}

/** Props from the most recent Virtuoso render (data, followOutput, …). */
export function virtuosoProps(): CapturedProps {
  if (state.__auditVirtuosoProps === undefined) throw new Error("Virtuoso has not rendered yet")
  return state.__auditVirtuosoProps
}

/** Simulate the user scrolling away from / back to the bottom of the list. */
export function fireAtBottom(atBottom: boolean): void {
  virtuosoProps().atBottomStateChange?.(atBottom)
}

export const Virtuoso = React.forwardRef(function VirtuosoMock(
  props: CapturedProps,
  ref: React.Ref<{ scrollToIndex: (args: ScrollCall) => void }>,
) {
  state.__auditVirtuosoProps = props
  React.useImperativeHandle(ref, () => ({
    scrollToIndex: (args: ScrollCall) => {
      state.__auditScrollCalls!.push(args)
    },
  }))
  return (
    <div data-testid="audit-list">
      {(props.data ?? []).map((row, index) => props.itemContent?.(index, row))}
    </div>
  )
}) as unknown as React.ComponentType<Record<string, unknown>>
