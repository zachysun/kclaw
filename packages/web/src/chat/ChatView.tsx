/**
 * ChatView — pure presentational conversation surface for the WebUI (block
 * block rendering). No I/O: everything arrives through props and every action
 * escapes through a callback. Only local UI state lives here (the composer
 * draft); expansion/collapse uses native <details> elements, so thinking folds
 * by default and tool_result cards expand to their full output without JS.
 */
import { Fragment, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { parseSlashInput, replaceTrailingSlashToken, slashCompletions, SLASH_COMMANDS, type SlashCommandMeta } from "@kclaw/core/commands"
import { fileMentionCompletions, replaceTrailingMentionToken } from "@kclaw/core/mentions"
import { PERMISSION_MODES, type PermissionMode } from "@kclaw/core/permission-modes"
import type { AttachmentRef, ConfirmationDecision } from "@kclaw/core/protocol"
import type { ChatState, ConfirmationCard, QuestionCard, RenderedBlock, RenderedMessage } from "./model.js"
import { parseTeamMail, type TeamMailParse } from "./model.js"
import { MarkdownText } from "./Markdown.js"
import { TeamPanelCard } from "./TeamPanel.js"
import type { TeamPanel } from "@kclaw/core/protocol"
import { IconButton } from "../ui/IconButton.js"
import { PencilIcon, RefreshIcon } from "../ui/icons.js"
import { fmtTokens } from "../audit/model.js"

/**
 * How a message enters a busy session: steer injects into the live
 * run, wait queues behind it, interrupt preempts with a new run. The trio's
 * current selection; also carried explicitly on every send_message frame.
 */
export type Disposition = "steer" | "wait" | "interrupt"

/** The trio's order — also the arrow-key rotation order. */
const DISPOSITIONS = ["steer", "wait", "interrupt"] as const

/** An uploaded attachment pending on the next message (the protocol's AttachmentRef). */
export type PendingAttachment = AttachmentRef

/**
 * One suggestion-menu entry: a slash command (builtin or installed skill) or
 * a workspace file mention. Both share the composer drawer — the trailing
 * word's first character picks the list (`/` commands, `@` files), so the
 * two kinds never mix in one open menu.
 */
type ComposerCandidate = { kind: "slash"; meta: SlashCommandMeta } | { kind: "file"; path: string }

/** Slash-menu geometry constants — must stay in sync with `.slash-menu` in index.css. */
export const SLASH_MENU_MAX_HEIGHT = 280
const SLASH_MENU_GAP = 6 // CSS: bottom: calc(100% + 6px)
const SLASH_MENU_MARGIN = 8 // breathing room to the viewport top
const SLASH_MENU_MIN_HEIGHT = 48

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

export interface ChatViewProps {
  view: ChatState
  /** Send one user message (queued server-side; runs serialize like the CLI). */
  onSend: (text: string) => void
  /** Answer an inline confirmation card. */
  onResolveConfirmation: (confirmationId: string, decision: ConfirmationDecision) => void
  /** Answer an inline question card (one string array per question, in ask order). */
  onAnswerQuestion: (questionId: string, answers: string[][]) => void
  /** Attachments queued for the next message (drag-and-drop). */
  pendingAttachments: PendingAttachment[]
  /** Drop one queued attachment. */
  onRemoveAttachment: (index: number) => void
  /** Available provider model names (empty → no selector rendered). */
  models?: string[]
  /** Current session model override (undefined → daemon default). */
  sessionModel?: string
  /** Switch the session model ("" clears to default). */
  onSwitchModel?: (name: string) => void
  /** The session's permission mode (always-on selector next to the model one). */
  mode?: PermissionMode
  /** Switch the session permission mode (POSTs; applies from the next run). */
  onSwitchMode?: (m: PermissionMode) => void
  /**
   * Transient status line (command results, reconnect/auth/upload/model
   * messages) — rendered directly above the composer, next to the input that
   * triggered it. Null/undefined hides it.
   */
  notice?: string | null
  /**
   * The user typed into the composer — the owner clears the stale notice so
   * old feedback does not sit over the new message being written. Programmatic
   * draft changes (suggestion completion) do not fire this.
   */
  onDraftChange?: () => void
  /**
   * Optional click action for the notice (memory.written 跳转)。
   * Present → the notice renders as a button; absent → plain text.
   */
  noticeAction?: (() => void) | null
  /** The current send disposition (the trio's selection; the owner resolves it from meta/config). */
  disposition?: Disposition
  /** Select the trio — the owner writes the sticky override and carries it on sends. */
  onSetDisposition?: (d: Disposition) => void
  /** Cancel one queued message (its bubble's cancel button). */
  onCancelQueued?: (messageId: string) => void
  /** Cancel every still-queued message (the banner's 全部取消). */
  onCancelAllQueued?: () => void
  /** Open a subagent's audit view (the spawn row's link). */
  onOpenAudit?: (sessionId: string) => void
  /** Cancel the in-flight automatic compaction (the indicator's cancel button, compaction.cancel). */
  onCancelCompaction?: () => void
  /** Stop the active run (the run indicator's stop button; the run.cancel frame). */
  onStopRun?: () => void
  /**
   * Edit & retry / regenerate: rerun from the last user message (text = the
   * edited or original text; attachments ride along server-side, rebuilt from
   * the discarded message). The edit confirm and the regenerate button both
   * land here.
   */
  onRetry?: (fromMessageId: string, text: string) => void
  /**
   * 压缩审计记录（GET /sessions/:id/compactions 的 UI 镜像，ChatPanel
   * 在会话选中时并行拉取）。null/undefined（未加载或拉取失败）→ 不渲染
   * 审计折叠条。
   */
  compactions?: CompactionRecordView[] | null
  /** 已装用户可见技能的动态命令（/技能名）：合并进建议菜单与 /help 面板（内置优先）。 */
  extraCommands?: SlashCommandMeta[]
  /** 会话工作区内的文件（GET /fs/files，失败静默为空）：@ 文件点名的候选源。 */
  mentionFiles?: readonly string[]
  /** 文件清单在后端被截断（仓库过大）：抽屉尾部显示一行提示。 */
  mentionTruncated?: boolean
  /**
   * A child session (meta.parentSessionId set) is read-only: the
   * whole input area (model/mode selectors, attachments, composer) is replaced
   * by one hint line; the server's submit also rejects user-triggered posts.
   */
  readOnly?: boolean
  /** Back to the parent session — the read-only hint's button (a child never
   * appears in the sidebar, so this is the only visible way back). */
  onReturnToParent?: () => void
  /**
   * Agent-team panel wiring: the panel payload plus the
   * composer target. Undefined/null panel = this session has no team →
   * nothing rendered. `target` shows the "→ 组员名" chip; onTalkTo(null)
   * clears it back to the lead.
   */
  team?: {
    panel: TeamPanel
    target: string | null
    onTalkTo: (name: string | null) => void
    onStopMember: (sessionId: string) => void
  }
}

export function ChatView({ view, onSend, onResolveConfirmation, onAnswerQuestion, pendingAttachments, onRemoveAttachment, models, sessionModel, onSwitchModel, mode, onSwitchMode, notice, noticeAction, onDraftChange, disposition, onSetDisposition, onCancelQueued, onCancelAllQueued, onOpenAudit, onCancelCompaction, onStopRun, onRetry, compactions, extraCommands, mentionFiles, mentionTruncated, readOnly, onReturnToParent, team }: ChatViewProps) {
  const [draft, setDraft] = useState("")
  // Suggestion-menu state: Escape dismisses the menu until the draft changes;
  // sel is the highlighted option, clamped whenever the candidate list shrinks.
  const [dismissed, setDismissed] = useState(false)
  const [sel, setSel] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  // In-place editor state of edit & retry, keyed by the bubble being edited;
  // both confirm and Esc clear it.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)

  // 建议菜单候选（斜杠命令与 @ 文件点名共用一个抽屉）：正在输入的最后一个词
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

  // 排队列表数据（Master 2026-08-30 改版）：view.queue 本身就是
  // FIFO 行序（先排队的在下标 0），直接渲染即"先排队在上面"。
  // 独立于一次性 notice——它是状态，不随输入清除。
  const queuedRows = view.queue

  // 审计折叠条；未加载/失败（null）→ 空数组。
  const auditBars = compactions == null ? [] : compactionBars(view.messages, compactions)

  // Edit & retry / regenerate are available exactly while the session is
  // idle (no run, no queue, no in-flight compaction); hidden while generating
  // — stop first, then redo. Child sessions are read-only: never offered.
  const idle = view.runState === "idle" && view.queue.length === 0 && view.compacting !== true
  const canRetry = !readOnly && idle && onRetry !== undefined
  const lastUserIdx = findLastIdx(view.messages, (m) => m.role === "user")
  const lastAssistantIdx = findLastIdx(view.messages, (m) => m.role === "assistant")
  const lastUser = lastUserIdx === -1 ? undefined : view.messages[lastUserIdx]!

  /** Edit confirm: an empty text does not submit (same rule as the composer). */
  const confirmEdit = (): void => {
    if (editing === null) return
    const text = editing.text.trim()
    if (text === "") return
    onRetry?.(editing.id, text)
    setEditing(null)
  }

  /** Editor keys: Enter confirms, Shift+Enter breaks a line, Esc cancels (composer habits). */
  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      confirmEdit()
    } else if (event.key === "Escape") {
      setEditing(null)
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
      setHelpOpen(true)
      setDraft("")
      return
    }
    onSend(text)
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
    // Enter=发送，Shift+Enter=换行（Master 2026-09-03）：textarea 的 Enter
    // 默认插换行符，一律拦下改走发送；带 Shift 时不拦，落到原生换行。
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
    } else if (event.key === "Escape" && helpOpen) {
      setHelpOpen(false)
    }
  }

  return (
    <div className="chat" data-testid="chat-view">
      {/* The team panel floats over the chat area's top-right corner (outside
          the scrolling log): pinned to the message stream it scrolled out of
          sight with any history. The whole panel folds to a summary chip. */}
      {team !== undefined && (
        <TeamPanelCard
          panel={team.panel}
          target={team.target}
          onTalkTo={team.onTalkTo}
          onStopMember={team.onStopMember}
          onOpenAudit={onOpenAudit}
        />
      )}
      {view.error !== undefined && (
        <div className="chat-error" data-testid="chat-error" role="alert">
          {view.error}
        </div>
      )}
      {helpOpen && (
        <div className="slash-help" data-testid="slash-help">
          <div className="slash-help-head">
            <span>斜杠命令</span>
            <button type="button" data-testid="slash-help-close" aria-label="关闭命令列表" onClick={() => setHelpOpen(false)}>
              ×
            </button>
          </div>
          <ul>
            {SLASH_COMMANDS.filter((c) => c.surfaces.includes("web")).map((c) => (
              <li key={c.name}>
                <code>{c.usage}</code>
                <span>{c.description}</span>
              </li>
            ))}
            {(extraCommands ?? []).map((c) => (
              <li key={c.name}>
                <code>{c.usage}</code>
                <span>{c.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="chat-log" data-testid="chat-log">
        {view.messages.map((message, idx) => (
          <Fragment key={message.id}>
            {auditBars.filter((b) => b.insertIdx === idx).map((b) => (
              <AuditContextNote key={b.key} bar={b} />
            ))}
            {editing !== null && editing.id === message.id ? (
              <div className="message message-user" data-testid="msg-editing">
                <div className="msg-edit">
                  <textarea
                    className="msg-edit-input"
                    data-testid="msg-edit-input"
                    autoFocus
                    value={editing.text}
                    onChange={(event) => setEditing({ id: editing.id, text: event.target.value })}
                    onKeyDown={handleEditKeyDown}
                    rows={2}
                  />
                  <div className="msg-edit-actions">
                    <button type="button" className="primary" data-testid="msg-edit-confirm" onClick={confirmEdit}>重试</button>
                    <button type="button" data-testid="msg-edit-cancel" onClick={() => setEditing(null)}>取消</button>
                  </div>
                </div>
              </div>
            ) : (
              <MessageBubble
                message={message}
                onOpenAudit={onOpenAudit}
                canEdit={canRetry && idx === lastUserIdx}
                canRegenerate={canRetry && idx === lastAssistantIdx && lastUser !== undefined}
                onEditStart={(text) => setEditing({ id: message.id, text })}
                onRegenerate={lastUser === undefined ? undefined : () => onRetry?.(lastUser.id, firstRenderedText(lastUser))}
              />
            )}
          </Fragment>
        ))}
        {/* upto 是最后一条消息（收尾压缩后没有新消息）→ 折叠条挂在消息流末尾。 */}
        {auditBars.filter((b) => b.insertIdx >= view.messages.length).map((b) => (
          <AuditContextNote key={b.key} bar={b} />
        ))}
      </div>
      {view.runState === "running" && (
        <div className="run-indicator" data-testid="run-indicator" aria-live="polite">
          running…
          <button type="button" className="run-stop" data-testid="run-stop" onClick={() => onStopRun?.()}>停止</button>
        </div>
      )}
      {view.compacting === true && (
        <div className="run-indicator compacting" data-testid="compacting-indicator" aria-live="polite">
          正在压缩早期对话…
          {/* 取消按钮只在自动压缩（in-run/post-run）渲染：manual 是用户自己发起的
              压缩，服务端 cancelCompaction 也不作用于它，渲染了点了也没用。 */}
          {view.compactingPhase !== "manual" && (
            <button
              type="button"
              className="compaction-cancel"
              data-testid="compaction-cancel"
              onClick={() => onCancelCompaction?.()}
            >取消</button>
          )}
        </div>
      )}
      {view.runState === "running" && view.retryHint !== undefined && view.retryHint !== null && (
        <div className="run-retry" data-testid="run-retry" aria-live="polite">
          重试中…
        </div>
      )}
      {view.hookFailure !== undefined && view.hookFailure !== null && (
        <div className="hook-failure" data-testid="hook-failure" aria-live="polite">
          hook {view.hookFailure.hook} 失败（{view.hookFailure.position}）：{view.hookFailure.error}
        </div>
      )}
      {view.pendingConfirmations.map((card) => (
        <ConfirmationCardView key={card.confirmationId} card={card} onResolve={onResolveConfirmation} />
      ))}
      {view.pendingQuestions.map((card) => (
        <QuestionCardView key={card.questionId} card={card} onAnswer={onAnswerQuestion} />
      ))}
      {!readOnly && (models !== undefined && models.length > 0 && onSwitchModel !== undefined || onSwitchMode !== undefined) && (
        <div className="composer-selectors" data-testid="composer-selectors">
          {models !== undefined && models.length > 0 && onSwitchModel !== undefined && (
            <div className="composer-row" data-testid="model-selector-row">
              <label>模型</label>
              <select
                className="model-select"
                data-testid="model-select"
                value={sessionModel ?? ""}
                onChange={(e) => onSwitchModel(e.target.value)}
              >
                <option value="">默认</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          )}
          {onSwitchMode !== undefined && (
            // Always-on permission mode selector (session-scoped, next run
            // effective): readonly denies writes/exec, default confirms
            // out-of-bounds actions, accept-edits skips confirmation for
            // in-workspace file writes.
            <div className="composer-row" data-testid="mode-selector-row">
              <label>权限</label>
              <select
                className="mode-select"
                data-testid="mode-select"
                value={mode ?? "default"}
                onChange={(e) => onSwitchMode(e.target.value as PermissionMode)}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
      {!readOnly && pendingAttachments.length > 0 && (
        <div className="attachment-chips" data-testid="attachment-chips">
          {pendingAttachments.map((a, i) => (
            <span key={i} className="attachment-chip" data-testid="attachment-chip">
              {a.name}（{a.size} 字节）
              <button type="button" onClick={() => onRemoveAttachment(i)} aria-label={`移除 ${a.name}`}>×</button>
            </span>
          ))}
        </div>
      )}
      {notice !== undefined && notice !== null && notice !== "" && (
        <div className="chat-notice" data-testid="chat-notice" role="status">
          {noticeAction !== undefined && noticeAction !== null ? (
            // 可点击通知（写入通知）：点击执行跳转动作，其余通知保持纯文本。
            <button type="button" data-testid="chat-notice-action" className="chat-notice-link" onClick={() => noticeAction()}>
              {notice}
            </button>
          ) : (
            notice
          )}
        </div>
      )}
      {queuedRows.length > 0 && (
        <div className="queue-list" data-testid="queue-list" role="status">
          <div className="queue-list-head">
            <span>{queuedRows.length} 条排队中</span>
            <button type="button" data-testid="queue-cancel-all" onClick={() => onCancelAllQueued?.()}>全部取消</button>
          </div>
          {queuedRows.map((e) => (
            <div className="queue-row" data-testid="queue-row" key={e.messageId}>
              <span className="queue-disp" data-testid="queue-disp">
                {e.disposition === "steer" ? "引导" : e.disposition === "wait" ? "等待" : "中断"}
              </span>
              <span className="queue-text" title={e.text}>{e.text}</span>
              {/* 可取消窗口：wait 随时、steer 注入前；interrupt 入队即
                  伴随 abort 紧接着出队执行，无可取消窗口——不渲染取消按钮。 */}
              {e.disposition !== "interrupt" && (
                <button
                  type="button"
                  className="queue-cancel"
                  data-testid="queue-cancel"
                  aria-label="取消这条排队消息"
                  onClick={() => onCancelQueued?.(e.messageId)}
                >取消</button>
              )}
            </div>
          ))}
        </div>
      )}
      {readOnly ? (
        // Child sessions are read-only (spec pin: treat the subagent as a
        // tool): no composer, one hint line pointing at the audit page; the
        // server-side submit rejects user-triggered posts as the backstop.
        // The child never appears in the sidebar — the button is the only
        // visible way back to the parent.
        <div className="chat-readonly-hint" data-testid="subagent-readonly-hint">
          子代理会话只读——它的过程与结题答复在审计页查看
          {onReturnToParent !== undefined && (
            <button type="button" className="return-parent" data-testid="return-to-parent" onClick={onReturnToParent}>
              ← 返回主会话
            </button>
          )}
        </div>
      ) : (
        <form className="chat-composer" ref={composerRef} onSubmit={submit}>
        {team !== undefined && team.target !== null && (
          <div className="team-target-chip" data-testid="team-target-chip">
            → 组员 {team.target}
            <button type="button" data-testid="team-target-clear" aria-label="切回对组长对话" onClick={() => team.onTalkTo(null)}>×</button>
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
        {view.runState === "running" && (
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
      )}
    </div>
  )
}

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
function AuditContextNote({ bar }: { bar: CompactionAuditBar }) {
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

function MessageBubble({
  message,
  onOpenAudit,
  canEdit,
  canRegenerate,
  onEditStart,
  onRegenerate,
}: {
  message: RenderedMessage
  onOpenAudit?: (sessionId: string) => void
  /** While the session is idle, the last user bubble offers the edit entry (session-card hover pattern). */
  canEdit?: boolean
  /** While the session is idle, the last assistant bubble offers regenerate (rerun the last user message as-is). */
  canRegenerate?: boolean
  onEditStart?: (currentText: string) => void
  onRegenerate?: () => void
}) {
  const streaming = message.pending && message.blocks.length === 0
  // 组员来信（团队收信箱投递的用户消息）不渲染成用户气泡：改为 agent 一侧的
  // 折叠条，点开看原文——模型收到什么不变，只是聊天页的画法。
  const mail = message.role === "user" ? parseTeamMail(firstRenderedText(message)) : null
  return (
    <div
      className={`message message-${message.role}${mail !== null ? " message-mail" : ""}`}
      data-testid={`msg-${message.role}`}
    >
      {streaming && <div className="msg-pending" data-testid="msg-pending">…</div>}
      {/* Only the assistant's side renders Markdown: the user's raw words stay
          literal (a stray * or # in a typed message must not turn into markup). */}
      {mail !== null ? (
        <TeamMailView mail={mail} />
      ) : (
        message.blocks.map((block) => (
          <BlockView key={block.blockId} block={block} markdown={message.role === "assistant"} onOpenAudit={onOpenAudit} />
        ))
      )}
      {message.aborted === true && (
        <span className="msg-aborted" data-testid="msg-aborted">已中断</span>
      )}
      {(canEdit === true || canRegenerate === true) && (
        <span className="msg-actions">
          {canEdit === true && (
            <IconButton
              label="编辑"
              icon={<PencilIcon />}
              testid="msg-edit"
              onClick={() => onEditStart?.(firstRenderedText(message))}
            />
          )}
          {canRegenerate === true && (
            <IconButton
              label="重新生成"
              icon={<RefreshIcon />}
              testid="msg-regenerate"
              onClick={() => onRegenerate?.()}
            />
          )}
        </span>
      )}
    </div>
  )
}

/** First text render's text of a rendered message ("" when absent). */
function firstRenderedText(m: RenderedMessage): string {
  const first = m.blocks.find((b) => b.kind === "text")
  return first !== undefined && first.kind === "text" ? first.text : ""
}

/** 组员来信折叠条：agent 一侧的窄条，摘要是发件人列表，展开看原文。 */
function TeamMailView({ mail }: { mail: TeamMailParse }): React.ReactElement {
  const senders = [...new Set(mail.entries.map((e) => e.from))].join("、")
  return (
    <details className="msg-team-mail" data-testid="msg-team-mail">
      <summary>
        📥 {mail.entries.length === 1 ? `收到来自 ${senders} 的来信` : `收到 ${mail.entries.length} 条来信（${senders}）`}
      </summary>
      {mail.entries.map((e, i) => (
        <div key={i} className="mail-entry">
          <div className="mail-from">【来自 {e.from}】</div>
          <pre className="mail-text">{e.text}</pre>
        </div>
      ))}
    </details>
  )
}

/** Single-line preview: collapse whitespace, cap at 80 chars (full args open on click). */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed
}

/** Index of the last message matching pred; -1 when none. */
function findLastIdx(messages: RenderedMessage[], pred: (m: RenderedMessage) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (pred(messages[i]!)) return i
  }
  return -1
}

function BlockView({ block, markdown, onOpenAudit }: { block: RenderedBlock; markdown: boolean; onOpenAudit?: (sessionId: string) => void }) {
  switch (block.kind) {
    case "text":
      return markdown ? (
        <div className="blk-text md" data-testid="blk-text">
          <MarkdownText text={block.text} />
        </div>
      ) : (
        <p className="blk-text" data-testid="blk-text">{block.text}</p>
      )
    case "thinking":
      return (
        <details className="blk-thinking" data-testid="blk-thinking">
          <summary>Thinking</summary>
          <pre>{block.text === "" ? "…" : block.text}</pre>
        </details>
      )
    case "note":
      return <span className="blk-note" data-testid="blk-note">[note] {block.text}</span>
    case "tool_call":
      // Collapsed by default: the summary line is the tool name plus a
      // one-line args preview; the full argsJson opens on click (clamped —
      // a whole-file write must not swallow the chat pane).
      return (
        <details className="blk-tool-call" data-testid="blk-tool-call">
          <summary>
            ⚡ {block.name} <code>{oneLine(block.argsJson)}</code>
          </summary>
          <code className="blk-tool-call-args">{block.argsJson}</code>
        </details>
      )
    case "tool_result": {
      // A subagent dispatch row: the live status (streamed into output) is the
      // summary's latest line, and the settled result links to the child's
      // audit view via the executor-attached childSessionId.
      const childSessionId = (block.data as { childSessionId?: string } | undefined)?.childSessionId
      if (childSessionId !== undefined) {
        return (
          <details className="blk-tool-result" data-testid="blk-tool-result-subagent">
            <summary>
              ↳ 子代理 · {latestLine(block.output)}
            </summary>
            <pre>{block.output}</pre>
            {onOpenAudit !== undefined && (
              <button className="subagent-audit-link" data-testid="subagent-audit-link" onClick={() => onOpenAudit(childSessionId)}>
                查看子代理审计
              </button>
            )}
          </details>
        )
      }
      return (
        <details className="blk-tool-result" data-testid="blk-tool-result">
          <summary>
            {block.status === "ok" ? "↳ ok" : "↳ error"} · {Math.round(block.durationMs)}ms ·{" "}
            {summarizeOutput(block.output)}
          </summary>
          <pre>{block.output}</pre>
        </details>
      )
    }
    case "attachment":
      return <span className="blk-attachment" data-testid="blk-attachment">[attachment: {block.mimeType}]</span>
  }
}

function ConfirmationCardView({
  card,
  onResolve,
}: {
  card: ConfirmationCard
  onResolve: (confirmationId: string, decision: ConfirmationDecision) => void
}) {
  return (
    <div className="confirm-card" data-testid="confirm-card">
      <div className="confirm-title">需要确认</div>
      <div className="confirm-tool">⚡ {card.toolName}</div>
      {/* argsJson can carry a whole file's content — it must stay inside a
          scroll-clamped block or the card swallows the chat pane and pushes
          the resolve buttons out of the viewport. */}
      <div className="confirm-args"><code>{card.argsJson}</code></div>
      <div className="confirm-meta">风险 {card.risk} · 过期 {card.expiresAt}</div>
      {card.noteText !== undefined && <div className="confirm-note">{card.noteText}</div>}
      <div className="confirm-actions">
        <button data-testid="confirm-once" onClick={() => onResolve(card.confirmationId, "once")}>仅本次</button>
        <button data-testid="confirm-project" onClick={() => onResolve(card.confirmationId, "project")}>总是（本项目）</button>
        <button data-testid="confirm-global" onClick={() => onResolve(card.confirmationId, "global")}>总是（全局）</button>
        <button data-testid="confirm-reject" onClick={() => onResolve(card.confirmationId, "reject")}>拒绝</button>
      </div>
    </div>
  )
}

/**
 * One pending ask_user_questions card: each question renders as option
 * buttons (single-pick submits immediately; multiSelect toggles + a submit
 * row) or a free-text input. Submitting sends the whole answer set — one
 * string array per question — as one question.resolve frame.
 */
function QuestionCardView({
  card,
  onAnswer,
}: {
  card: QuestionCard
  onAnswer: (questionId: string, answers: string[][]) => void
}) {
  const [textValues, setTextValues] = useState<string[]>(() => card.questions.map(() => ""))
  const [multiPicks, setMultiPicks] = useState<string[][]>(() => card.questions.map(() => []))
  // An empty answer array means "skipped" — the same contract as the CLI's
  // enter-to-skip, and the tool result renders it as （未回答）.
  const answers: string[][] = card.questions.map((q, i) => {
    if (Array.isArray(q.options) && q.options.length > 0) return multiPicks[i] ?? []
    const t = (textValues[i] ?? "").trim()
    return t === "" ? [] : [t]
  })
  return (
    <div className="question-card" data-testid="question-card">
      <div className="confirm-title">问题待回答</div>
      <div className="confirm-meta">过期 {card.expiresAt}</div>
      {card.noteText !== undefined && <div className="confirm-note">{card.noteText}</div>}
      {card.questions.map((q, i) => (
        <div key={i} className="question-item" data-testid={`question-item-${i}`}>
          <div className="question-text-label">{q.text}</div>
          {Array.isArray(q.options) && q.options.length > 0 ? (
            <div className="confirm-actions">
              {q.options.map((opt) => {
                const picked = multiPicks[i]?.includes(opt) ?? false
                return (
                  <button
                    key={opt}
                    data-testid={`question-${i}-option`}
                    className={picked ? "question-picked" : undefined}
                    onClick={() => {
                      setMultiPicks((prev) => {
                        const next = prev.map((p, j) => (j === i ? [...p] : p))
                        const cur = next[i] ?? []
                        if (q.multiSelect === true) {
                          next[i] = picked ? cur.filter((x) => x !== opt) : [...cur, opt]
                        } else {
                          next[i] = [opt]
                        }
                        return next
                      })
                    }}
                  >
                    {opt}
                  </button>
                )
              })}
            </div>
          ) : (
            <input
              className="question-text"
              data-testid={`question-${i}-text`}
              value={textValues[i] ?? ""}
              placeholder="自由输入，留空跳过"
              onChange={(e) => setTextValues((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
            />
          )}
        </div>
      ))}
      <div className="confirm-actions">
        <button data-testid="question-submit" onClick={() => onAnswer(card.questionId, answers)}>
          提交回答
        </button>
      </div>
    </div>
  )
}

/** Whitespace-collapsed, first-80-chars summary for a tool result card. */
function summarizeOutput(output: string): string {
  const text = output.replace(/\s+/g, " ").trim()
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

/** Last non-empty line of a streaming subagent status feed (the live one-liner). */
function latestLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "")
  const last = lines[lines.length - 1] ?? ""
  return last.length > 100 ? `${last.slice(0, 100)}…` : last
}
