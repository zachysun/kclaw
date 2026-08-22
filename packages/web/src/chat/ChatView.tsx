/**
 * ChatView — pure presentational conversation surface (spec §10 WebUI, §5.2
 * block rendering). No I/O: everything arrives through props and every action
 * escapes through a callback. Only local UI state lives here (the composer
 * draft); expansion/collapse uses native <details> elements, so thinking folds
 * by default and tool_result cards expand to their full output without JS.
 */
import { useState, type FormEvent } from "react"
import type { ChatState, ConfirmationCard, RenderedBlock, RenderedMessage } from "./model.js"

export interface ChatViewProps {
  view: ChatState
  /** Send one user message (queued server-side; runs serialize like the CLI). */
  onSend: (text: string) => void
  /** Answer an inline confirmation card. */
  onResolveConfirmation: (confirmationId: string, approved: boolean) => void
}

export function ChatView({ view, onSend, onResolveConfirmation }: ChatViewProps) {
  const [draft, setDraft] = useState("")

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const text = draft.trim()
    if (text === "") return
    onSend(text)
    setDraft("")
  }

  return (
    <div className="chat" data-testid="chat-view">
      {view.error !== undefined && (
        <div className="chat-error" data-testid="chat-error" role="alert">
          {view.error}
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
      {view.runState === "running" && view.retryHint !== undefined && view.retryHint !== null && (
        <div className="run-retry" data-testid="run-retry" aria-live="polite">
          重试中…
        </div>
      )}
      {view.pendingConfirmations.map((card) => (
        <ConfirmationCardView key={card.confirmationId} card={card} onResolve={onResolveConfirmation} />
      ))}
      <form className="chat-composer" onSubmit={submit}>
        <input
          className="chat-input"
          data-testid="chat-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
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
