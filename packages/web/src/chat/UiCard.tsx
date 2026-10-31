/**
 * UiCardView — renders one UI Card from a tool result's `data`. The card is
 * model output: every string renders as a React text node — no HTML, no
 * markdown pipeline, no injection door. `isUiCard` gates the dispatch (data
 * may be any executor's payload); an unknown runtime kind falls back to the
 * caller's plain JSON view, never a blank.
 *
 * Interactivity: buttons and forms report through `onAction`; a persisted
 * `picked` (this card was already acted on in an earlier session) renders the
 * settled state — picked button disabled, submitted form a snapshot.
 */
import { Component, useState, type ReactNode } from "react"
import type { UIDisplayCard, UICard } from "@kclaw/core/protocol"
import { UiCardForm, type UiCardAction } from "./UiCardForm.js"

/**
 * Renders `fallback` when a card renderer throws (spec: a render error
 * degrades to the raw JSON row, never a blank). The DSL is model output —
 * one bad branch must not take down the chat tree.
 */
export class UiCardBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

const CARD_KINDS: ReadonlySet<string> = new Set([
  "button", "link", "table", "list", "card", "tag", "badge", "tabs", "collapse",
  "timeline", "tree", "carousel", "quote", "icon", "chart", "drawer", "form",
])

/** Structural sniff, not a validator: core already validated at emit time —
 * this only decides whether `data` is a card at all (any executor can put
 * anything in `data`). */
export function isUiCard(data: unknown): data is UICard {
  return (
    typeof data === "object" && data !== null && !Array.isArray(data) &&
    typeof (data as { kind?: unknown }).kind === "string" &&
    CARD_KINDS.has((data as { kind: string }).kind)
  )
}

export interface UiCardViewProps {
  card: UICard
  onAction?: (action: UiCardAction) => void
  /** The settled action from a previous session, if any (persisted pick). */
  picked?: UiCardAction | null
}

export function UiCardView({ card, onAction, picked }: UiCardViewProps) {
  switch (card.kind) {
    case "button": {
      const isPicked = picked?.optionId === card.label
      return (
        <span className="ui-row" data-testid="ui-button">
          <button
            className={`ui-btn${card.tone !== undefined && card.tone !== "default" ? ` ui-btn-${card.tone}` : ""}`}
            disabled={isPicked}
            onClick={() => onAction?.({ optionId: card.label, text: `选择：${card.label}` })}
          >
            {card.label}
          </button>
          {isPicked && <span className="ui-picked-mark">已选择</span>}
        </span>
      )
    }
    case "link":
      return (
        <a className="ui-link" href={card.url} target="_blank" rel="noreferrer" data-testid="ui-link">
          {card.text}
        </a>
      )
    case "table":
      return (
        <div className="ui-block" data-testid="ui-table">
          {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
          <div className="ui-table-scroll">
            <table className="ui-table">
              <thead>
                <tr>{card.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {card.rows.map((row, i) => (
                  <tr key={i}>{card.columns.map((c) => <td key={c.key}>{row[c.key] ?? ""}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )
    case "list": {
      const items = card.items.map((t, i) => <li key={i} className="ui-list-item">{t}</li>)
      return (
        <div className="ui-block" data-testid="ui-list">
          {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
          {card.ordered === true ? <ol className="ui-list">{items}</ol> : <ul className="ui-list">{items}</ul>}
        </div>
      )
    }
    case "tag":
      return <span className={`ui-chip${card.tone !== undefined && card.tone !== "default" ? ` ui-chip-${card.tone}` : ""}`} data-testid="ui-tag">{card.text}</span>
    case "badge":
      return <span className={`ui-chip ui-chip-solid${card.tone !== undefined && card.tone !== "default" ? ` ui-chip-${card.tone}` : ""}`} data-testid="ui-badge">{card.text}</span>
    case "timeline":
      return (
        <div className="ui-block" data-testid="ui-timeline">
          {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
          <ol className="ui-timeline">
            {card.items.map((item, i) => (
              <li key={i} className={item.tone !== undefined ? `ui-tl-${item.tone}` : undefined}>
                <span className="ui-tl-dot" />
                <span className="ui-tl-head">{item.time !== undefined && <span className="ui-tl-time">{item.time}</span>}{item.title}</span>
                {item.text !== undefined && <span className="ui-tl-text">{item.text}</span>}
              </li>
            ))}
          </ol>
        </div>
      )
    case "tree": {
      const renderNode = (node: typeof card.root, depth: number): ReactNode => (
        <div key={`${depth}-${node.label}`} className="ui-tree-node" style={{ paddingLeft: `${depth * 16}px` }}>
          <span className="ui-tree-label">{node.label}</span>
          {node.children?.map((c, i) => renderNode(c, depth + 1))}
        </div>
      )
      return (
        <div className="ui-block" data-testid="ui-tree">
          {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
          {renderNode(card.root, 0)}
        </div>
      )
    }
    case "quote":
      return (
        <blockquote className="ui-quote" data-testid="ui-quote">
          {card.text}
          {card.source !== undefined && <footer className="ui-quote-source">— {card.source}</footer>}
        </blockquote>
      )
    case "icon":
      return <span className="ui-icon" data-testid="ui-icon">{card.value}</span>
    case "chart": {
      const max = Math.max(...card.items.map((i) => Math.abs(i.value)), 1)
      return (
        <div className="ui-block" data-testid="ui-chart">
          {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
          <div className="ui-bars">
            {card.items.map((item, i) => (
              <div key={i} className="ui-bar-row">
                <span className="ui-bar-label">{item.label}</span>
                <span className="ui-bar-track">
                  <span className="ui-bar-fill" style={{ width: `${Math.max((Math.abs(item.value) / max) * 100, 2)}%` }} />
                </span>
                <span className="ui-bar-value">{item.value}{card.unit !== undefined ? ` ${card.unit}` : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }
    case "card":
      return (
        <div className="ui-card" data-testid="ui-card">
          {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
          {card.body.map((child, i) => <DisplayChild key={i} child={child} onAction={onAction} picked={picked} />)}
        </div>
      )
    case "tabs":
      return <UiTabs card={card} onAction={onAction} picked={picked} />
    case "collapse":
      return (
        <details className="ui-collapse" data-testid="ui-collapse" open={card.open === true || undefined}>
          <summary>{card.title}</summary>
          <div className="ui-collapse-body">
            {card.children.map((child, i) => <DisplayChild key={i} child={child} onAction={onAction} picked={picked} />)}
          </div>
        </details>
      )
    case "drawer":
      return (
        <details className="ui-drawer" data-testid="ui-drawer">
          <summary>{card.title}</summary>
          <div className="ui-collapse-body">
            {card.children.map((child, i) => <DisplayChild key={i} child={child} onAction={onAction} picked={picked} />)}
          </div>
        </details>
      )
    case "carousel":
      return (
        <div className="ui-carousel" data-testid="ui-carousel">
          {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
          <div className="ui-carousel-track">
            {card.slides.map((slide, i) => (
              <div key={i} className="ui-slide">
                {slide.map((child, j) => <DisplayChild key={j} child={child} onAction={onAction} picked={picked} />)}
              </div>
            ))}
          </div>
        </div>
      )
    case "form":
      return <UiCardForm card={card} onAction={onAction} picked={picked} />
    default:
      // Runtime data lied about its kind (hand-edited history, older schema):
      // report via console, render nothing — the caller's JSON fallback row
      // still shows the raw payload.
      console.warn(`[ui-card] unknown kind: ${(card as { kind?: string }).kind}`)
      return null
  }
}

function DisplayChild({ child, onAction, picked }: { child: UIDisplayCard; onAction?: (a: UiCardAction) => void; picked?: UiCardAction | null }) {
  return <UiCardView card={child} onAction={onAction} picked={picked} />
}

/** Tab switching is presentation-local state (which pane shows), nothing else. */
function UiTabs({ card, onAction, picked }: { card: Extract<UICard, { kind: "tabs" }>; onAction?: (a: UiCardAction) => void; picked?: UiCardAction | null }) {
  const [active, setActive] = useState(0)
  return (
    <div className="ui-block" data-testid="ui-tabs">
      <div className="ui-tab-bar" role="tablist">
        {card.tabs.map((tab, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={i === active}
            className={`ui-tab${i === active ? " ui-tab-active" : ""}`}
            onClick={() => setActive(i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="ui-tab-body">
        {card.tabs[active]?.content.map((child, i) => <DisplayChild key={i} child={child} onAction={onAction} picked={picked} />)}
      </div>
    </div>
  )
}
