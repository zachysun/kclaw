/**
 * ChatView — pure presentational conversation surface for the WebUI (block
 * block rendering). No I/O: everything arrives through props and every action
 * escapes through a callback. Only local UI state lives here (the composer
 * draft); expansion/collapse uses native <details> elements, so thinking folds
 * by default and tool_result cards expand to their full output without JS.
 */
import { Fragment, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { parseSlashInput, slashCompletions, SLASH_COMMANDS } from "@kclaw/core/commands"
import type { ChatState, ConfirmationCard, NoteRender, RenderedBlock, RenderedMessage } from "./model.js"

/**
 * How a message enters a busy session (spec §6): steer injects into the live
 * run, wait queues behind it, interrupt preempts with a new run. The trio's
 * current selection; also carried explicitly on every send_message frame.
 */
export type Disposition = "steer" | "wait" | "interrupt"

/** The trio's order — also the arrow-key rotation order (spec §7.1: 方向键+回车). */
const DISPOSITIONS = ["steer", "wait", "interrupt"] as const

/** An uploaded attachment pending on the next message (mirrors the daemon shape). */
export interface PendingAttachment {
  path: string
  name: string
  size: number
  mimeType: string
}

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
  onResolveConfirmation: (confirmationId: string, approved: boolean) => void
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
   * Optional click action for the notice (spec 9.1 memory.written 跳转)。
   * Present → the notice renders as a button; absent → plain text.
   */
  noticeAction?: (() => void) | null
  /** The current send disposition (the trio's selection; the owner resolves it from meta/config). */
  disposition?: Disposition
  /** Select the trio — the owner writes the sticky override (spec §6) and carries it on sends. */
  onSetDisposition?: (d: Disposition) => void
  /** Cancel one queued message (its bubble's cancel button). */
  onCancelQueued?: (messageId: string) => void
  /** Cancel every still-queued message (the banner's 全部取消). */
  onCancelAllQueued?: () => void
  /** Cancel the in-flight automatic compaction (the indicator's 取消, v3 compaction.cancel). */
  onCancelCompaction?: () => void
  /**
   * v3 压缩审计记录（GET /sessions/:id/compactions 的 UI 镜像，ChatPanel
   * 在会话选中时并行拉取）。null/undefined（未加载或拉取失败）→ 不渲染
   * 审计折叠条；旧会话的 compact note 路径（contextBarFor）不受影响。
   */
  compactions?: CompactionRecordView[] | null
}

export function ChatView({ view, onSend, onResolveConfirmation, pendingAttachments, onRemoveAttachment, models, sessionModel, onSwitchModel, notice, noticeAction, onDraftChange, disposition, onSetDisposition, onCancelQueued, onCancelAllQueued, onCancelCompaction, compactions }: ChatViewProps) {
  const [draft, setDraft] = useState("")
  // Slash-suggestion state: Escape dismisses the menu until the draft changes;
  // sel is the highlighted option, clamped whenever the candidate list shrinks.
  const [dismissed, setDismissed] = useState(false)
  const [sel, setSel] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)

  const completions = dismissed ? [] : slashCompletions(draft, "web")
  const active = Math.min(sel, Math.max(0, completions.length - 1))

  // 排队列表数据（spec §7.1，Master 2026-08-30 改版）：view.queue 本身就是
  // FIFO 行序（先排队的在下标 0），直接渲染即"先排队在上面"。
  // 独立于一次性 notice——它是状态，不随输入清除。
  const queuedRows = view.queue

  // v3 审计折叠条（压缩不再挂 compact note 后的唯一新来源）；未加载/失败
  // （null）→ 空数组，消息流与旧版完全一致。
  const auditBars = compactions == null ? [] : compactionBars(view.messages, compactions)

  /** 三选的方向键旋转（spec §7.1：方向键+回车与点击皆可；回车/空格是按钮原生行为）。 */
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

  const submit = (event: FormEvent): void => {
    event.preventDefault()
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

  /** Replace the draft with the chosen command plus a trailing space (ready for args); the space closes the menu. */
  const complete = (name: string): void => {
    setDraft(`/${name} `)
    setDismissed(true)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (completions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setSel((active + 1) % completions.length)
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        setSel((active - 1 + completions.length) % completions.length)
      } else if (event.key === "Tab") {
        event.preventDefault()
        complete(completions[active]!.name)
      } else if (event.key === "Enter") {
        // While the menu is open, Enter ACCEPTS the highlighted suggestion —
        // submitting the raw draft would run a half-typed word ("没有这个命
        // 令"). Only a draft that already IS the complete command falls
        // through to the native form submit.
        if (draft.trim() !== `/${completions[active]!.name}`) {
          event.preventDefault()
          complete(completions[active]!.name)
        }
      } else if (event.key === "Escape") {
        setDismissed(true)
      }
    } else if (event.key === "Escape" && helpOpen) {
      setHelpOpen(false)
    }
  }

  return (
    <div className="chat" data-testid="chat-view">
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
          </ul>
        </div>
      )}
      <div className="chat-log" data-testid="chat-log">
        {view.messages.map((message, idx) => {
          const context = contextBarFor(view.messages, idx)
          return (
            <Fragment key={message.id}>
              {auditBars.filter((b) => b.insertIdx === idx).map((b) => (
                <AuditContextNote key={b.key} bar={b} />
              ))}
              {context !== null && <CompactContextNote context={context} />}
              <MessageBubble message={message} />
            </Fragment>
          )
        })}
        {/* upto 是最后一条消息（收尾压缩后没有新消息）→ 折叠条挂在消息流末尾。 */}
        {auditBars.filter((b) => b.insertIdx >= view.messages.length).map((b) => (
          <AuditContextNote key={b.key} bar={b} />
        ))}
      </div>
      {view.runState === "running" && (
        <div className="run-indicator" data-testid="run-indicator" aria-live="polite">
          running…
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
      {view.pendingConfirmations.map((card) => (
        <ConfirmationCardView key={card.confirmationId} card={card} onResolve={onResolveConfirmation} />
      ))}
      {(models !== undefined && models.length > 0 && onSwitchModel !== undefined) && (
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
      {pendingAttachments.length > 0 && (
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
            // 可点击通知（spec 9.1 写入通知）：点击执行跳转动作，其余通知保持纯文本。
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
              {/* 可取消窗口（spec §5.6）：wait 随时、steer 注入前；interrupt 入队即
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
      <form className="chat-composer" ref={composerRef} onSubmit={submit}>
        {completions.length > 0 && (
          <ul
            className="slash-menu"
            data-testid="slash-menu"
            role="listbox"
            aria-label="斜杠命令联想"
            style={menuMaxHeight !== undefined ? { maxHeight: menuMaxHeight } : undefined}
          >
            {completions.map((c, i) => (
              <li key={c.name} role="option" aria-selected={i === active} className={i === active ? "slash-option active" : "slash-option"}>
                <button
                  type="button"
                  data-testid="slash-option"
                  // mousedown so the input keeps focus (a click would blur it)
                  onMouseDown={(event) => {
                    event.preventDefault()
                    complete(c.name)
                  }}
                >
                  <code>{c.usage}</code>
                  <span>{c.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <span className="composer-prompt" aria-hidden="true">❯</span>
        <input
          className="chat-input"
          data-testid="chat-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setDismissed(false)
            setSel(0)
            onDraftChange?.()
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type a message…"
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
        <button type="submit" data-testid="send-button">Send</button>
      </form>
    </div>
  )
}

/** Everything the collapsed context bar shows for one compaction. */
export interface CompactContextInfo {
  segments: number
  kept: number
  /** The compact note's full text (summary + retrieval hint). */
  summary: string
  /** The kept verbatim messages preceding this user message, in order. */
  keptMessages: { role: string; text: string }[]
}

/**
 * Compaction context for the user message at `idx`, or null when it shows no
 * bar. The server re-attaches the compact note EVERY turn (the model needs the
 * summary each request), and `kept` counts the user's own message — so a bar
 * renders only when the segment count changes (a real new compaction), and the
 * kept-message preview excludes the message itself.
 */
export function contextBarFor(messages: RenderedMessage[], idx: number): CompactContextInfo | null {
  const message = messages[idx]!
  if (message.role !== "user") return null
  const note = message.blocks.find(
    (b): b is NoteRender => b.kind === "note" && b.noteKind === "compact" && b.compact !== undefined,
  )
  if (note === undefined || note.compact === undefined) return null
  let seen: number | null = null
  for (let i = 0; i < idx; i++) {
    for (const b of messages[i]!.blocks) {
      if (b.kind === "note" && b.noteKind === "compact" && b.compact !== undefined) seen = b.compact.segments
    }
  }
  if (seen === note.compact.segments) return null
  const precedingKept = Math.max(0, note.compact.kept - 1)
  const keptMessages = messages
    .slice(Math.max(0, idx - precedingKept), idx)
    .map((m) => ({ role: m.role, text: flattenText(m.blocks) }))
  return { segments: note.compact.segments, kept: note.compact.kept, summary: note.text, keptMessages }
}

/** First text block, whitespace-collapsed, capped for the preview line. */
function flattenText(blocks: RenderedBlock[]): string {
  const first = blocks.find((b) => b.kind === "text")
  const text = first !== undefined && first.kind === "text" ? first.text : ""
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed
}

/**
 * v3 压缩审计记录的 web 侧轻量镜像（GET /sessions/:id/compactions 的 UI
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
}

/** One audit-driven collapsed context bar to render. */
export interface CompactionAuditBar {
  key: string
  /** 折叠条插在 messages[insertIdx] 之前（= upto 气泡之后）。 */
  insertIdx: number
  /** 第 N 次压缩（记录序号 + 1）——与旧 note 的 compact.segments 同源。 */
  segments: number
  summary: string
}

/**
 * Derive the audit-driven collapsed context bars (v3): one per compaction
 * record, inserted right AFTER the record's `upto` message. Records whose
 * upto no longer exists (deleted messages) are dropped.
 *
 * 去重（旧 v2 会话兼容）：v2 的同一次压缩还会在"压缩后新一轮的用户消息"
 * 上挂 compact note（note.compact.segments === 记录序号+1，且该消息必然在
 * upto 之后——中间隔着保留窗口）。这样一条 note 存在时，contextBarFor 已经
 * 为该压缩渲染了折叠条，审计条必须跳过（同一压缩不显示两个折叠条）；note
 * 缺失（消息被删/未持久化）时 note 条本来也不渲染，审计条照常补位。
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
    const supersededByNote = messages.some(
      (m, i) =>
        i > uptoIdx &&
        m.role === "user" &&
        m.blocks.some(
          (b) => b.kind === "note" && b.noteKind === "compact" && b.compact !== undefined && b.compact.segments === segments,
        ),
    )
    if (supersededByNote) return
    bars.push({ key: `compaction-${ordinal}-${record.upto}`, insertIdx: uptoIdx + 1, segments, summary: record.segmentSummary })
  })
  return bars
}

/** Audit-driven collapsed <details> — same shape/style as the note bar, summary-only body (审计记录无 kept 数据). */
function AuditContextNote({ bar }: { bar: CompactionAuditBar }) {
  return (
    <details className="ctx-note" data-testid="ctx-note-audit">
      <summary>模型上下文：早期对话已压缩为 {bar.segments} 段（点击展开）</summary>
      <div className="ctx-note-body">
        <p className="ctx-note-summary">{bar.summary}</p>
      </div>
    </details>
  )
}

/** Collapsed-by-default <details> listing what the model sees for early context. */
function CompactContextNote({ context }: { context: CompactContextInfo }) {
  return (
    <details className="ctx-note" data-testid="ctx-note">
      <summary>模型上下文：早期对话已压缩为 {context.segments} 段（点击展开）</summary>
      <div className="ctx-note-body">
        <p className="ctx-note-summary">{context.summary}</p>
        {context.keptMessages.length > 0 && (
          <div className="ctx-note-kept" data-testid="ctx-note-kept">
            <div className="ctx-note-kept-head">保留的原文（最近 {context.keptMessages.length} 条）：</div>
            {context.keptMessages.map((m, i) => (
              <div key={i} className="ctx-note-kept-line">
                {m.role === "user" ? "用户" : "助手"}：{m.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  )
}

function MessageBubble({ message }: { message: RenderedMessage }) {
  const streaming = message.pending && message.blocks.length === 0
  return (
    <div className={`message message-${message.role}`} data-testid={`msg-${message.role}`}>
      {streaming && <div className="msg-pending" data-testid="msg-pending">…</div>}
      {message.blocks.map((block) => <BlockView key={block.blockId} block={block} />)}
    </div>
  )
}

function BlockView({ block }: { block: RenderedBlock }) {
  switch (block.kind) {
    case "text":
      return <p className="blk-text" data-testid="blk-text">{block.text}</p>
    case "thinking":
      return (
        <details className="blk-thinking" data-testid="blk-thinking">
          <summary>Thinking</summary>
          <pre>{block.text === "" ? "…" : block.text}</pre>
        </details>
      )
    case "note":
      // Compact notes render as the collapsed context bar above their message
      // (contextBarFor); a legacy one without meta falls through to inline.
      if (block.noteKind === "compact" && block.compact !== undefined) return null
      return <span className="blk-note" data-testid="blk-note">[note] {block.text}</span>
    case "tool_call":
      return (
        <div className="blk-tool-call" data-testid="blk-tool-call">
          ⚡ {block.name} <code>{block.argsJson}</code>
        </div>
      )
    case "tool_result":
      return (
        <details className="blk-tool-result" data-testid="blk-tool-result">
          <summary>
            {block.status === "ok" ? "↳ ok" : "↳ error"} · {Math.round(block.durationMs)}ms ·{" "}
            {summarizeOutput(block.output)}
          </summary>
          <pre>{block.output}</pre>
        </details>
      )
    case "attachment":
      return <span className="blk-attachment" data-testid="blk-attachment">[attachment: {block.mimeType}]</span>
  }
}

function ConfirmationCardView({
  card,
  onResolve,
}: {
  card: ConfirmationCard
  onResolve: (confirmationId: string, approved: boolean) => void
}) {
  return (
    <div className="confirm-card" data-testid="confirm-card">
      <div className="confirm-title">Confirmation requested</div>
      <div className="confirm-tool">⚡ {card.toolName} <code>{card.argsJson}</code></div>
      <div className="confirm-meta">risk: {card.risk} · expires {card.expiresAt}</div>
      <div className="confirm-actions">
        <button data-testid="confirm-allow" onClick={() => onResolve(card.confirmationId, true)}>Allow</button>
        <button data-testid="confirm-deny" onClick={() => onResolve(card.confirmationId, false)}>Deny</button>
      </div>
    </div>
  )
}

/** Whitespace-collapsed, first-80-chars summary for a tool result card. */
function summarizeOutput(output: string): string {
  const text = output.replace(/\s+/g, " ").trim()
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}
