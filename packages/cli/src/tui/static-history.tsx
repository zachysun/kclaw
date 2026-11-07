/**
 * The <Static> region: completed entries printed permanently to the terminal
 * scrollback (spec B3). Static only renders entries not yet flushed, so the
 * native scrollback and text selection stay intact while the array grows.
 * Rows are memoized per item — streaming deltas re-render the dynamic area,
 * never these.
 */
import { memo } from "react"
import { Static, Text } from "ink"
import type { HistoryItem } from "./store.js"
import type { ChatStore } from "./store.js"
import { useSyncExternalStore } from "react"
import { AMBER, ICONS } from "./colors.js"

const HistoryRow = memo(function HistoryRow({ item }: { item: HistoryItem }) {
  switch (item.kind) {
    case "echo":
      return (
        <Text>
          <Text dimColor>{"> "}</Text>
          {item.text}
        </Text>
      )
    case "text":
      return <Text>{item.text}</Text>
    case "thinking":
      return (
        <Text dimColor>
          {ICONS.thinking} 思考 {item.seconds}s
        </Text>
      )
    case "tool":
      return (
        <Text>
          <Text color={AMBER}>
            {ICONS.tool} {item.name} {item.argsSummary}
          </Text>
          {"\n"}
          <Text dimColor={item.status !== "error"}>
            {"  "}
            {ICONS.result} {item.status} ({Math.round(item.durationMs)}ms) {item.outputSummary}
            {item.outputTruncated ? "（完整输出在转录视图，Ctrl+O）" : ""}
          </Text>
        </Text>
      )
    case "system":
      return <Text dimColor>{item.text}</Text>
    case "notice":
      return item.tone === "error" ? <Text color="red">{item.text}</Text> : item.tone === "dim" ? <Text dimColor>{item.text}</Text> : <Text>{item.text}</Text>
  }
})

export function StaticHistory({ store }: { store: ChatStore }) {
  const { history } = useSyncExternalStore(store.subscribe, store.getState)
  return <Static items={history}>{(item) => <HistoryRow key={item.id} item={item} />}</Static>
}
