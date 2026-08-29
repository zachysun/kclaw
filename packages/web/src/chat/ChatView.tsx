/**
 * ChatView — pure presentational conversation surface for the WebUI (block
 * block rendering). No I/O: everything arrives through props and every action
 * escapes through a callback. Only local UI state lives here (the composer
 * draft); expansion/collapse uses native <details> elements, so thinking folds
 * by default and tool_result cards expand to their full output without JS.
 */
import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { parseSlashInput, slashCompletions, SLASH_COMMANDS } from "@kclaw/core/commands"
import type { ChatState, ConfirmationCard, RenderedBlock, RenderedMessage } from "./model.js"

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
}

export function ChatView({ view, onSend, onResolveConfirmation, pendingAttachments, onRemoveAttachment, models, sessionModel, onSwitchModel }: ChatViewProps) {
  const [draft, setDraft] = useState("")
  // Slash-suggestion state: Escape dismisses the menu until the draft changes;
  // sel is the highlighted option, clamped whenever the candidate list shrinks.
  const [dismissed, setDismissed] = useState(false)
  const [sel, setSel] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)

  const completions = dismissed ? [] : slashCompletions(draft, "web")
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
        {view.messages.map((message) => <MessageBubble key={message.id} message={message} />)}
      </div>
      {view.runState === "running" && (
        <div className="run-indicator" data-testid="run-indicator" aria-live="polite">
          running…
        </div>
      )}
      {view.compacting === true && (
        <div className="run-indicator compacting" data-testid="compacting-indicator" aria-live="polite">
          正在压缩早期对话…
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
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type a message…"
          autoFocus
        />
        <button type="submit" data-testid="send-button">Send</button>
      </form>
    </div>
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
