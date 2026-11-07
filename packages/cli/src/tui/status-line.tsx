/**
 * The bottom status line (spec B3): `[权限模式] 模型 · ↑in ↓out tokens（最近
 * run）· 会话 <短id>` — the permission-mode mirror, the session's model
 * override ("default" when unset), the last run.completed usage, and the
 * short session id. Runs' usage updates ride on run-completed frames; mode
 * updates on the orchestrator's modeChanged calls.
 */
import { Text } from "ink"
import { useSyncExternalStore } from "react"
import type { ChatStore } from "./store.js"
import { AMBER } from "./colors.js"

export function StatusLine({ store }: { store: ChatStore }) {
  const { status } = useSyncExternalStore(store.subscribe, store.getState)
  const usage =
    status.inputTokens !== undefined && status.outputTokens !== undefined
      ? `↑${status.inputTokens} ↓${status.outputTokens} tokens（最近 run）`
      : undefined
  return (
    <Text>
      <Text color={AMBER}>[{status.mode}]</Text>
      {" · "}
      {status.model}
      {usage !== undefined ? ` · ${usage}` : ""}
      {" · "}
      <Text dimColor>会话 {status.sessionId.slice(0, 8)}</Text>
    </Text>
  )
}
