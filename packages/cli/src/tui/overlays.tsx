/**
 * The full-screen overlays (spec B8/B14). Both REPLACE the main column while
 * open (a full-screen swap renders cleaner than absolute stacking inside
 * ink's flow layout); the run keeps streaming into the store underneath and
 * shows up in the transcript's live tail.
 *
 * - Transcript (Ctrl+O): the session's full text — fetched once from
 *   GET /sessions/:id/messages (server truth replaces the live ledger) and
 *   live frames appended afterwards. Thinking verbatim, tool output
 *   verbatim: every truncation the one-line history shows has a reachable
 *   full text here. Scrolled by visual lines (wrapDisplay keeps CJK alignment).
 * - Help (?): the key binding table from tui/keybindings.ts — the single
 *   source both the handlers and this doc read.
 */
import { Box, Text, useInput, useWindowSize } from "ink"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import type { ChatController } from "../chat-surface.js"
import { fetchMessages, messagesToTranscript } from "./chat-data.js"
import { AMBER } from "./colors.js"
import { KEY_BINDINGS } from "./keybindings.js"
import type { ChatStore, TranscriptEntry } from "./store.js"
import { wrapDisplay } from "../text-width.js"

interface Line {
  text: string
  tone: "plain" | "dim" | "amber" | "red" | "user"
}

function entryLines(entry: TranscriptEntry, width: number, out: Line[]): void {
  const push = (text: string, tone: Line["tone"]): void => {
    for (const visual of wrapDisplay(text, Math.max(8, width - 2))) out.push({ text: visual, tone })
  }
  switch (entry.kind) {
    case "user":
      push(`> ${entry.text}`, "user")
      break
    case "assistant-text":
      push(entry.text, "plain")
      break
    case "thinking":
      push(entry.text, "dim")
      break
    case "tool":
      push(`⏺ ${entry.name} ${entry.argsJson}`, "amber")
      if (entry.status !== undefined) {
        push(`⎿ ${entry.status}${entry.durationMs !== undefined ? ` (${Math.round(entry.durationMs)}ms)` : ""}`, entry.status === "error" ? "red" : "dim")
        if (entry.output !== undefined && entry.output !== "") push(entry.output, "dim")
      }
      break
    case "system":
      push(entry.text, "dim")
      break
  }
  out.push({ text: "", tone: "dim" }) // 条目间空行
}

export function TranscriptOverlay({ store, controller }: { store: ChatStore; controller: ChatController }) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { columns, rows } = useWindowSize()
  const [offset, setOffset] = useState<number | undefined>(undefined) // undefined = 跟随末尾
  const [error, setError] = useState<string | undefined>(undefined)

  // 打开即拉全量消息（服务器真相替换实时账本）；之后的实时帧照常追加
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await fetchMessages(controller.client, controller.sessionId)
        if (!cancelled) store.replaceTranscript(messagesToTranscript(list))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [controller.client, controller.sessionId, store])

  const lines = useMemo(() => {
    const out: Line[] = []
    for (const entry of state.transcript) entryLines(entry, columns, out)
    if (error !== undefined) out.push({ text: `拉取消息失败: ${error}`, tone: "red" })
    return out
  }, [state.transcript, columns, error])

  const viewport = Math.max(1, rows - 2)
  const maxOffset = Math.max(0, lines.length - viewport)
  const current = offset === undefined ? maxOffset : Math.min(Math.max(0, offset), maxOffset)

  useInput((input, key) => {
    const page = Math.max(1, viewport - 1)
    const jumpUser = (dir: 1 | -1): void => {
      let i = current + dir
      while (i >= 0 && i < lines.length) {
        if (lines[i]!.tone === "user") {
          setOffset(i)
          return
        }
        i += dir
      }
    }
    if (key.escape || input === "q") {
      store.setOverlays({ transcript: false })
      return
    }
    if (key.upArrow || input === "k") setOffset(Math.max(0, current - 1))
    else if (key.downArrow || input === "j") setOffset(current + 1 >= maxOffset ? undefined : current + 1)
    else if (key.pageUp) setOffset(Math.max(0, current - page))
    else if (key.pageDown) setOffset(current + page >= maxOffset ? undefined : current + page)
    else if (input === "g") setOffset(0)
    else if (input === "G") setOffset(undefined)
    else if (input === "{") jumpUser(-1)
    else if (input === "}") jumpUser(1)
  })

  const visible = lines.slice(current, current + viewport)
  return (
    <Box flexDirection="column" height={rows}>
      <Text dimColor>
        {" "}
        转录 {controller.sessionId.slice(0, 8)} · {lines.length} 行 · ↑↓/j/k 滚动 g/G 头尾 {"{"} {"}"} 用户消息 q 关闭{" "}
      </Text>
      {visible.length === 0 && <Text dimColor>（无消息）</Text>}
      {visible.map((line, idx) => (
        <LineRow key={current + idx} line={line} />
      ))}
    </Box>
  )
}

function LineRow({ line }: { line: Line }) {
  if (line.tone === "dim") return <Text dimColor>{line.text}</Text>
  if (line.tone === "amber") return <Text color={AMBER}>{line.text}</Text>
  if (line.tone === "red") return <Text color="red">{line.text}</Text>
  return <Text>{line.text}</Text>
}

export function HelpOverlay({ store }: { store: ChatStore }) {
  useInput((input, key) => {
    if (key.escape || input === "q" || input === "?") store.setOverlays({ help: false })
  })
  const groups = ["输入", "覆盖层", "全局"] as const
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color={AMBER}>快捷键帮助（q / Esc 关闭）</Text>
      {groups.map((group) => (
        <Box key={group} flexDirection="column">
          <Text dimColor>── {group} ──</Text>
          {KEY_BINDINGS.filter((b) => b.context === group).map((binding) => (
            <Text key={binding.keys}>
              <Text color={AMBER}>{binding.keys}</Text>
              {"  "}
              {binding.description}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}
