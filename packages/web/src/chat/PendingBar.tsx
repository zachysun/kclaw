/**
 * PendingBar — the session's unresolved decision cards, pinned above the
 * composer (non-blocking UI cards scroll away; this bar keeps them visible).
 * Items locate their card on click (scroll + flash); answering still happens
 * on the card itself — the bar surfaces and navigates, it never answers.
 */
import { useState } from "react"

export interface PendingCardItem {
  /** The triggering card's tool callId (also the scroll target attribute). */
  callId: string
  messageId: string
  /** Card title when the model gave one; undefined → fallback label. */
  title?: string
  /** Shape summary, e.g. 「按钮 ×3」/「表单」. */
  summary: string
}

/** More than this many items → show the newest N plus an expander. */
const MAX_SHOWN = 8

export function PendingBar({ items, onLocate }: {
  items: PendingCardItem[]
  onLocate: (callId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const shown = expanded ? items : items.slice(0, MAX_SHOWN)
  const hidden = items.length - shown.length
  return (
    <div className="pending-bar" data-testid="pending-bar" role="region" aria-label="待拍板的卡片">
      <div className="pending-head">
        <span>待你拍板 · {items.length} 项</span>
      </div>
      <ul className="pending-list">
        {shown.map((item) => (
          <li key={item.callId}>
            <button
              type="button"
              className="pending-item"
              data-testid="pending-item"
              onClick={() => onLocate(item.callId)}
              title={item.title ?? "未命名卡片"}
            >
              <span className="pending-title">{item.title ?? "未命名卡片"}</span>
              <span className="pending-summary">{item.summary}</span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="pending-more" data-testid="pending-more" onClick={() => setExpanded(true)}>
          还有 {hidden} 项更早的
        </button>
      )}
    </div>
  )
}
