/**
 * The TUI input box: single-line editor with a visible block cursor, ↑↓
 * history, Ctrl+R reverse search, / command menu and @ file-mention menu
 * (spec B3/B4/B5). Completion shares the WebUI's helpers
 * (`slashCompletions`/`fileMentionCompletions` + the replace-trailing-token
 * appliers), so menu ranking, insertion and boundary rules are identical on
 * both frontends. Pasted text (usePaste) inserts with newlines flattened —
 * the editor stays single-line; typed Enter always submits.
 *
 * Key ownership: this handler is active only when no overlay and no card is
 * open; Ctrl+C escalation lives here in that state (the root app owns it
 * otherwise), so exactly one handler sees every Ctrl+C.
 */
import { Box, Text, useInput, usePaste } from "ink"
import { useEffect, useState, useSyncExternalStore } from "react"
import { fileMentionCompletions, replaceTrailingMentionToken } from "@kclaw/core/mentions"
import { replaceTrailingSlashToken, slashCompletions } from "@kclaw/core/commands"
import type { SlashCommandMeta } from "@kclaw/core/commands"
import type { ChatController } from "../chat-surface.js"
import { fetchSessionMeta, fetchWorkspaceFiles } from "./chat-data.js"
import { AMBER } from "./colors.js"
import type { ChatStore } from "./store.js"

/** Candidates above the input: either slash commands or file mentions. */
type Candidate = { kind: "slash"; meta: SlashCommandMeta } | { kind: "mention"; path: string }

const MENU_VISIBLE = 8

interface SearchState {
  query: string
  /** Newest-first match index into the history (0 = most recent), -1 = none yet. */
  matchIdx: number
}

export function InputEditor({ store, controller, active }: { store: ChatStore; controller: ChatController; active: boolean }) {
  const [value, setValue] = useState("")
  const [cursor, setCursor] = useState(0)
  const [browse, setBrowse] = useState<number | undefined>(undefined)
  const [draft, setDraft] = useState("")
  const [search, setSearch] = useState<SearchState | undefined>(undefined)
  const [menuSelected, setMenuSelected] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  // 全量订阅：@ 候选清单、输入历史都经 store 异步到位，任何写入都要重排
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const inputHistory = state.inputHistory

  // @ 候选源：接入会话（与切换会话）时按会话工作目录拉一次；失败静默——菜单
  // 没有候选，打字与发送不受影响。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const meta = await fetchSessionMeta(controller.client, controller.sessionId)
        if (cancelled) return
        const files = await fetchWorkspaceFiles(controller.client, meta.workdir)
        if (!cancelled) store.setFiles(controller.sessionId, files)
      } catch {
        // daemon 不可达：@ 菜单静默无候选
      }
    })()
    return () => {
      cancelled = true
    }
  }, [controller.sessionId, controller.client, store])

  const filesEntry = store.getState().files
  // 含空白字符的路径不进候选：键盘菜单无法像 WebUI 抽屉那样把不可选项标灰
  // 跳过，直接过滤是同一语义的最干净画法（过滤放在取用处，清单怎么来的都成立）。
  const files = filesEntry !== undefined && filesEntry.sessionId === controller.sessionId
    ? filesEntry.files.filter((f) => !/\s/.test(f))
    : []
  const slashCandidates = slashCompletions(value, "cli", controller.skillCommands())
  const mentionPaths = fileMentionCompletions(value, files)
  const candidates: Candidate[] =
    slashCandidates.length > 0
      ? slashCandidates.map((meta) => ({ kind: "slash" as const, meta }))
      : mentionPaths.map((path) => ({ kind: "mention" as const, path }))
  const menuOpen = candidates.length > 0 && !menuDismissed && search === undefined && browse === undefined
  const selected = Math.min(menuSelected, candidates.length - 1)

  /** The single candidate already equals the typed text — Enter submits instead of re-accepting. */
  const exactSingleMatch = (): boolean => {
    if (candidates.length !== 1) return false
    const head = candidates[0]!
    return head.kind === "slash" ? value === `/${head.meta.name}` : value === `@${head.path}`
  }

  /** A draft edit: re-arms the menu and leaves history browsing. */
  const replace = (next: string, nextCursor: number): void => {
    setValue(next)
    setCursor(nextCursor)
    setMenuSelected(0)
    setMenuDismissed(false)
    setBrowse(undefined)
  }

  const insert = (text: string): void => {
    if (text === "") return
    replace(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length)
  }

  const acceptCandidate = (): void => {
    const head = candidates[selected]
    if (head === undefined) return
    const next = head.kind === "slash" ? replaceTrailingSlashToken(value, head.meta.name) : replaceTrailingMentionToken(value, head.path)
    setValue(next)
    setCursor(next.length)
    setMenuSelected(0)
    setMenuDismissed(false)
  }

  const historyOlder = (): void => {
    if (inputHistory.length === 0) return
    const next = browse === undefined ? 0 : Math.min(browse + 1, inputHistory.length - 1)
    if (browse === undefined) setDraft(value)
    setBrowse(next)
    const line = inputHistory[inputHistory.length - 1 - next] ?? ""
    setValue(line)
    setCursor(line.length)
    setMenuSelected(0)
    setMenuDismissed(false)
  }

  const historyNewer = (): void => {
    if (browse === undefined) return
    if (browse <= 0) {
      setBrowse(undefined)
      setValue(draft)
      setCursor(draft.length)
      return
    }
    const next = browse - 1
    setBrowse(next)
    const line = inputHistory[inputHistory.length - 1 - next] ?? ""
    setValue(line)
    setCursor(line.length)
  }

  const findMatch = (query: string, fromIdx: number): number | undefined => {
    if (query === "") return fromIdx >= 0 && fromIdx < inputHistory.length ? fromIdx : undefined
    for (let i = fromIdx + 1; i < inputHistory.length; i++) {
      if ((inputHistory[inputHistory.length - 1 - i] ?? "").includes(query)) return i
    }
    return undefined
  }

  const searchCycle = (): void => {
    if (search === undefined) {
      setSearch({ query: value, matchIdx: findMatch(value, -1) ?? -1 })
      return
    }
    const next = findMatch(search.query, search.matchIdx)
    if (next !== undefined) setSearch({ ...search, matchIdx: next })
  }

  const submit = async (): Promise<void> => {
    const text = value.trim()
    if (text === "") return
    store.pushEcho(text)
    if (!text.startsWith("/")) store.appendInputHistory(text)
    setValue("")
    setCursor(0)
    setBrowse(undefined)
    setDraft("")
    setSearch(undefined)
    setMenuSelected(0)
    setMenuDismissed(false)
    const result = await controller.submit(text)
    if (result === "exit") store.requestExit()
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      controller.interrupt()
      return
    }
    if (key.tab && key.shift) {
      void controller.cycleMode()
      return
    }
    if (input === "\x0f") {
      // Ctrl+O：转录视图（覆盖层自己的按键接管滚动与关闭）
      store.beginTranscriptSync()
      return
    }
    if (input === "?" && value === "") {
      store.setOverlays({ help: true })
      return
    }
    if (key.escape) {
      if (search !== undefined) {
        setSearch(undefined)
        return
      }
      if (browse !== undefined) {
        setBrowse(undefined)
        setValue(draft)
        setCursor(draft.length)
        return
      }
      if (menuOpen) {
        setMenuDismissed(true)
        return
      }
      if (controller.busy) controller.stopRun()
      return
    }
    if (key.upArrow) {
      if (menuOpen) {
        setMenuSelected((selected + candidates.length - 1) % candidates.length)
        return
      }
      historyOlder()
      return
    }
    if (key.downArrow) {
      if (menuOpen) {
        setMenuSelected((selected + 1) % candidates.length)
        return
      }
      historyNewer()
      return
    }
    if (key.return) {
      if (search !== undefined) {
        const match = search.matchIdx >= 0 ? inputHistory[inputHistory.length - 1 - search.matchIdx] : undefined
        const line = match ?? value
        setSearch(undefined)
        setValue(line)
        setCursor(line.length)
        return
      }
      if (menuOpen && !exactSingleMatch()) {
        acceptCandidate()
        return
      }
      void submit()
      return
    }
    if (key.tab) {
      if (menuOpen) acceptCandidate()
      return
    }
    if (input === "\x12") {
      searchCycle()
      return
    }
    if (search !== undefined) {
      // 搜索态的打字与退格都在改查询词，并重置匹配位置
      if (key.backspace) {
        const query = search.query.slice(0, -1)
        setSearch({ query, matchIdx: findMatch(query, -1) ?? -1 })
        return
      }
      if (input.length > 0 && !key.ctrl && !key.meta && input >= " ") {
        const query = search.query + input
        setSearch({ query, matchIdx: findMatch(query, -1) ?? -1 })
      }
      return
    }
    if (input === "\x01" || key.home) {
      setCursor(0)
      return
    }
    if (input === "\x05" || key.end) {
      setCursor(value.length)
      return
    }
    if (input === "\x17") {
      // Ctrl+W：向前删一个词（先吃光标前的空白，再吃一个非空白段）
      const head = value.slice(0, cursor)
      let end = cursor
      while (end > 0 && /\s/.test(head[end - 1] ?? "")) end -= 1
      let start = end
      while (start > 0 && !/\s/.test(head[start - 1] ?? "")) start -= 1
      replace(head.slice(0, start) + value.slice(cursor), start)
      return
    }
    if (input === "\x0b") {
      // Ctrl+K：删到行尾
      replace(value.slice(0, cursor), cursor)
      return
    }
    if (input === "\x15") {
      // Ctrl+U：清空输入
      replace("", 0)
      return
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1))
      return
    }
    if (key.backspace) {
      if (cursor > 0) replace(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
      return
    }
    if (key.delete) {
      if (cursor < value.length) replace(value.slice(0, cursor) + value.slice(cursor + 1), cursor)
      return
    }
    if (input.length > 0 && !key.ctrl && !key.meta && input >= " ") insert(input)
  }, { isActive: active })

  usePaste((text) => {
    if (!active) return
    // 单行编辑器：粘贴内容里的换行折叠成空格（长文本多行请分段发送或用 /attach）
    insert(text.replace(/\r?\n/g, " "))
  }, { isActive: active })

  const start = Math.max(0, Math.min(selected - (MENU_VISIBLE - 1), Math.max(0, candidates.length - MENU_VISIBLE)))
  const visible = candidates.slice(start, start + MENU_VISIBLE)
  const searchMatch = search !== undefined && search.matchIdx >= 0 ? inputHistory[inputHistory.length - 1 - search.matchIdx] : undefined
  const cursorChar = cursor < value.length ? value[cursor]! : " "

  return (
    <Box flexDirection="column">
      {search !== undefined && (
        <Text dimColor>
          历史搜索: {search.query}
          {searchMatch !== undefined ? ` — ${searchMatch}` : "（无匹配）"}
        </Text>
      )}
      {menuOpen && (
        <Box flexDirection="column" paddingLeft={2}>
          {visible.map((candidate) => {
            const isSel = candidates.indexOf(candidate) === selected
            const label =
              candidate.kind === "slash"
                ? `/${candidate.meta.name} ${candidate.meta.description}`
                : candidate.path
            const key = candidate.kind === "slash" ? `/${candidate.meta.name}` : candidate.path
            return (
              <Text key={key} color={isSel ? AMBER : undefined} dimColor={!isSel}>
                {isSel ? "❯ " : "  "}
                {label}
              </Text>
            )
          })}
          {candidates.length > start + MENU_VISIBLE && <Text dimColor>… 还有 {candidates.length - start - MENU_VISIBLE} 个</Text>}
        </Box>
      )}
      <Box borderStyle="round" paddingLeft={1}>
        <Text>
          {"> "}
          {value === "" ? (
            <Text dimColor>输入消息（/ 命令、@ 引用文件、? 快捷键帮助）</Text>
          ) : (
            <>
              {value.slice(0, cursor)}
              <Text inverse>{cursorChar}</Text>
              {value.slice(cursor + (cursor < value.length ? 1 : 0))}
            </>
          )}
        </Text>
      </Box>
    </Box>
  )
}
