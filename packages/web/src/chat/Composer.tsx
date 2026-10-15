/**
 * Composer — the chat input area: slash-command / file-mention suggestion
 * menu, the auto-growing textarea, the send disposition trio (while a run is
 * active), the team target chip, and the send button. Owns the draft state —
 * nobody outside needs it. Submit hands the text to `onSend`, whose boolean
 * result decides whether the draft clears: `false` (send rejected — socket
 * down, attachments still uploading) keeps the typed text for a retry.
 */
import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { parseSlashInput, replaceTrailingSlashToken, slashCompletions, type SlashCommandMeta } from "@kclaw/core/commands"
import { fileMentionCompletions, replaceTrailingMentionToken } from "@kclaw/core/mentions"
import type { Disposition } from "./ChatView.js"

/**
 * The trio's order — also the arrow-key rotation order.
 */
const DISPOSITIONS = ["steer", "wait", "interrupt"] as const

/** Slash-menu geometry constants — must stay in sync with `.slash-menu` in styles/chat.css. */
export const SLASH_MENU_MAX_HEIGHT = 280
const SLASH_MENU_GAP = 6 // CSS: bottom: calc(100% + 6px)
const SLASH_MENU_MARGIN = 8 // breathing room to the viewport top
const SLASH_MENU_MIN_HEIGHT = 48

/**
 * One suggestion-menu entry: a slash command (builtin or installed skill) or
 * a workspace file mention. Both share the composer drawer — the trailing
 * word's first character picks the list (`/` commands, `@` files), so the
 * two kinds never mix in one open menu.
 */
type ComposerCandidate = { kind: "slash"; meta: SlashCommandMeta } | { kind: "file"; path: string }

/**
 * The menu floats above the composer (absolute, bottom: calc(100% + 6px)); when
 * the composer sits high in the viewport (fresh session, few messages) it would
 * overflow the top edge and put the first option out of reach. Cap its height
 * to the room actually available above the composer (from the fixed top bar
 * down, when one is present), with a floor so a couple of options always stay
 * visible/clickable.
 */
export function availableSlashMenuMaxHeight(composerTop: number, topBoundary = 0): number {
  const available = composerTop - topBoundary - SLASH_MENU_GAP - SLASH_MENU_MARGIN
  return Math.max(SLASH_MENU_MIN_HEIGHT, Math.min(SLASH_MENU_MAX_HEIGHT, available))
}

export interface ComposerProps {
  /**
   * Submit the (trimmed) draft. `true` = accepted, the draft clears;
   * `false` = rejected (connection down, upload in flight), the draft stays.
   */
  onSend: (text: string) => boolean
  /** The /help command renders the command panel above the log (view concern). */
  onHelpRequest: () => void
  /** Escape with no suggestion menu open (dismiss overlays owned above: the /help panel). */
  onEscape?: () => void
  /** Installed-skill dynamic commands merged after the builtins. */
  extraCommands?: SlashCommandMeta[]
  /** Workspace file candidates for @ mentions (empty → no file menu). */
  mentionFiles?: readonly string[]
  /** The file list was truncated server-side (tail note in the menu). */
  mentionTruncated?: boolean
  /** While a run is active the disposition trio renders next to the input. */
  running: boolean
  disposition?: Disposition
  onSetDisposition?: (d: Disposition) => void
  /** Talking to a team member (the chip above the input; × returns to the lead). */
  teamTarget?: string | null
  onClearTeamTarget?: () => void
  /**
   * The user typed into the composer — the owner clears the stale notice so
   * old feedback does not sit over the new message being written. Programmatic
   * draft changes (suggestion completion) do not fire this.
   */
  onDraftChange?: () => void
}

export function Composer({ onSend, onHelpRequest, onEscape, extraCommands, mentionFiles, mentionTruncated, running, disposition, onSetDisposition, teamTarget, onClearTeamTarget, onDraftChange }: ComposerProps) {
  // Suggestion-menu state: Escape dismisses the menu until the draft changes;
  // sel is the highlighted option, clamped whenever the candidate list shrinks.
  const [draft, setDraft] = useState("")
  const [dismissed, setDismissed] = useState(false)
  const [sel, setSel] = useState(0)

  // 建议菜单候选（斜杠命令与 @ 文件指定共用一个抽屉）：正在输入的最后一个词
  // 以 / 开头出命令、以 @ 开头出工作区文件，首字符互斥所以两类不同时出现。
  const slashItems = dismissed ? [] : slashCompletions(draft, "web", extraCommands)
  const fileItems =
    dismissed || mentionFiles === undefined || mentionFiles.length === 0
      ? []
      : fileMentionCompletions(draft, mentionFiles)
  const completions: ComposerCandidate[] =
    slashItems.length > 0
      ? slashItems.map((meta) => ({ kind: "slash" as const, meta }))
      : fileItems.map((path) => ({ kind: "file" as const, path }))
  const active = Math.min(sel, Math.max(0, completions.length - 1))

  // Keep the suggestion menu inside the viewport: measure how much room sits
  // above the composer and cap the menu height to it (fresh sessions leave
  // little room; the absolute menu would otherwise overflow the top edge).
  const composerRef = useRef<HTMLFormElement>(null)
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const composer = composerRef.current
    if (completions.length === 0 || composer === null) {
      return
    }
    const update = (): void => {
      const topBoundary = document.querySelector("header.topbar")?.getBoundingClientRect().bottom ?? 0
      setMenuMaxHeight(availableSlashMenuMaxHeight(composer.getBoundingClientRect().top, topBoundary))
    }
    update()
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [completions.length])

  // Auto-grow composer (textarea): track the content up to a ~5-line cap,
  // then scroll internally instead of pushing the log away.
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = inputRef.current
    if (el === null) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft])

  const submitDraft = (): void => {
    const text = draft.trim()
    if (text === "") return
    // /help renders the command panel right here — it is a view concern, so
    // it never escapes through onSend (the dispatcher treats it as a no-op).
    if (parseSlashInput(text)?.command === "help") {
      onHelpRequest()
      setDraft("")
      return
    }
    // 发送被拒（连接断开、附件仍在上传）时保留草稿：文本是用户重新出发的
    // 起点，不清空（交互契约：提交失败保留已输入内容）。
    if (!onSend(text)) return
    setDraft("")
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    submitDraft()
  }

  /** 文件候选里含空白的路径没法无歧义写进消息：抽屉里可见但禁选。 */
  const isDisabledFile = (item: ComposerCandidate): boolean => item.kind === "file" && /\s/.test(item.path)

  /** Replace the trailing in-progress token with the chosen candidate plus a trailing space; the space closes the menu. A disabled file entry never completes. */
  const completeCandidate = (item: ComposerCandidate): void => {
    if (isDisabledFile(item)) return
    setDraft(item.kind === "slash" ? replaceTrailingSlashToken(draft, item.meta.name) : replaceTrailingMentionToken(draft, item.path))
    setDismissed(true)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter=发送，Shift+Enter=换行：textarea 的 Enter 默认插换行符，一律拦下
    // 改走发送；带 Shift 时不拦，落到原生换行。
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      // While the menu is open, Enter ACCEPTS the highlighted suggestion —
      // submitting the raw draft would run a half-typed word. Only a draft
      // whose trailing token already IS the complete candidate goes straight
      // to the submit; on a disabled file entry Enter does neither (the token
      // cannot be completed and sending it raw would be broken).
      if (completions.length > 0) {
        const item = completions[active]!
        if (isDisabledFile(item)) return
        const finished = item.kind === "slash" ? `/${item.meta.name}` : `@${item.path}`
        if (draft.trim() !== finished) {
          completeCandidate(item)
          return
        }
      }
      submitDraft()
      return
    }
    if (completions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setSel((active + 1) % completions.length)
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        setSel((active - 1 + completions.length) % completions.length)
      } else if (event.key === "Tab") {
        event.preventDefault()
        completeCandidate(completions[active]!)
      } else if (event.key === "Escape") {
        setDismissed(true)
      }
    } else if (event.key === "Escape") {
      // 无联想菜单时的 Escape：交给上层关浮层（/help 面板），保持旧键盘习惯。
      onEscape?.()
    }
  }

  /** 三选的方向键旋转（方向键+回车与点击皆可；回车/空格是按钮原生行为）。 */
  const handleTrioKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (onSetDisposition === undefined || disposition === undefined) return
    const idx = DISPOSITIONS.indexOf(disposition)
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 :
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0
    if (delta === 0) return
    event.preventDefault()
    onSetDisposition(DISPOSITIONS[(idx + delta + DISPOSITIONS.length) % DISPOSITIONS.length]!)
  }

  return (
    <form className="chat-composer" ref={composerRef} onSubmit={submit}>
      {teamTarget !== undefined && teamTarget !== null && (
        <div className="team-target-chip" data-testid="team-target-chip">
          → 组员 {teamTarget}
          <button type="button" data-testid="team-target-clear" aria-label="切回对组长对话" onClick={() => onClearTeamTarget?.()}>×</button>
        </div>
      )}
      {completions.length > 0 && (
        <ul
          className="slash-menu"
          data-testid="slash-menu"
          role="listbox"
          aria-label={completions[0]!.kind === "slash" ? "斜杠命令联想" : "文件联想"}
          style={menuMaxHeight !== undefined ? { maxHeight: menuMaxHeight } : undefined}
        >
          {completions.map((c, i) =>
            c.kind === "slash" ? (
              <li key={`/${c.meta.name}`} role="option" aria-selected={i === active} className={i === active ? "slash-option active" : "slash-option"}>
                <button
                  type="button"
                  data-testid="slash-option"
                  // mousedown so the input keeps focus (a click would blur it)
                  onMouseDown={(event) => {
                    event.preventDefault()
                    completeCandidate(c)
                  }}
                >
                  <code>{c.meta.usage}</code>
                  <span>{c.meta.description}</span>
                </button>
              </li>
            ) : (
              <li
                key={`@${c.path}`}
                role="option"
                aria-selected={i === active}
                aria-disabled={isDisabledFile(c) || undefined}
                className={i === active ? "slash-option file-option active" : "slash-option file-option"}
              >
                <button
                  type="button"
                  data-testid="file-option"
                  // mousedown so the input keeps focus (a click would blur it)
                  onMouseDown={(event) => {
                    event.preventDefault()
                    completeCandidate(c)
                  }}
                >
                  <code>@{c.path}</code>
                </button>
              </li>
            ),
          )}
          {completions[0]!.kind === "file" && mentionTruncated === true && (
            <li className="slash-note" data-testid="mention-truncated">文件过多，列表已截断</li>
          )}
        </ul>
      )}
      <span className="composer-prompt" aria-hidden="true">❯</span>
      <textarea
        className="chat-input"
        data-testid="chat-input"
        ref={inputRef}
        rows={1}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setDismissed(false)
          setSel(0)
          onDraftChange?.()
        }}
        onKeyDown={handleKeyDown}
        placeholder="输入消息…"
        autoFocus
      />
      {running && (
        <div className="disposition-trio" data-testid="disposition-trio" role="radiogroup" aria-label="发送处置" onKeyDown={handleTrioKeyDown}>
          {DISPOSITIONS.map((d) => (
            <button
              key={d} type="button" role="radio" aria-checked={disposition === d}
              data-testid={`disposition-${d}`}
              onClick={() => onSetDisposition?.(d)}
            >{d === "steer" ? "引导" : d === "wait" ? "等待" : "中断"}</button>
          ))}
        </div>
      )}
      <button type="submit" data-testid="send-button">发送</button>
    </form>
  )
}
