/**
 * UiCardView — renders one UI Card from a tool result's `data`. The card is
 * model output: every string renders as a React text node — no HTML, no
 * markdown pipeline, no injection door. `isUiCardData` (protocol canon) gates
 * the dispatch; an unknown runtime kind falls back to the caller's plain JSON
 * view, never a blank.
 *
 * Interactivity: buttons, forms and chart points report through `onAction`.
 * Buttons/forms are decisions — a persisted `picked` renders the settled
 * state (disabled / snapshot). Chart points are questions — repeatable, never
 * disabled, and their uiAction still carries provenance.
 */
import { Component, useState, type ReactNode } from "react"
import type { UIDisplayCard, UICard } from "@kclaw/core/protocol"
import { UiCardForm, uiCardText, type UiCardAction } from "./UiCardForm.js"

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

export interface UiCardViewProps {
  card: UICard
  onAction?: (action: UiCardAction) => void
  /** The settled action from a previous session, if any (persisted pick). */
  picked?: UiCardAction | null
  /** Title of the nearest enclosing card (containers thread theirs down) —
   * rides the action message so the model knows which card was answered. */
  contextTitle?: string
}

export function UiCardView({ card, onAction, picked, contextTitle }: UiCardViewProps) {
  switch (card.kind) {
    case "button": {
      const isPicked = picked?.optionId === card.label
      return (
        <span className="ui-row" data-testid="ui-button">
          <button
            className={`ui-btn${card.tone !== undefined && card.tone !== "default" ? ` ui-btn-${card.tone}` : ""}`}
            disabled={isPicked}
            onClick={() => onAction?.({ optionId: card.label, text: uiCardText(contextTitle, `选择 ${card.label}`), decision: true })}
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
          {card.chartType === "line" ? (
            <UiLineChart card={card} onAction={onAction} />
          ) : (
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
          )}
        </div>
      )
    }
    case "stat": {
      // Delta color rides the leading sign (+ up / - down) — no extra field.
      const deltaClass = card.delta?.startsWith("+") ? " ui-stat-up" : card.delta?.startsWith("-") ? " ui-stat-down" : ""
      return (
        <div className="ui-stat" data-testid="ui-stat">
          {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
          <div className="ui-stat-label">{card.label}</div>
          <div className="ui-stat-value">
            {card.value}
            {card.unit !== undefined && <span className="ui-stat-unit"> {card.unit}</span>}
          </div>
          {card.delta !== undefined && <span className={`ui-stat-delta${deltaClass}`}>{card.delta}</span>}
        </div>
      )
    }
    case "card":
      return (
        <div className="ui-card" data-testid="ui-card">
          {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
          {card.body.map((child, i) => <DisplayChild key={i} child={child} onAction={onAction} picked={picked} contextTitle={card.title ?? contextTitle} />)}
        </div>
      )
    case "tabs":
      return <UiTabs card={card} onAction={onAction} picked={picked} contextTitle={contextTitle} />
    case "collapse":
      return (
        <details className="ui-collapse" data-testid="ui-collapse" open={card.open === true || undefined}>
          <summary>{card.title}</summary>
          <div className="ui-collapse-body">
            {card.children.map((child, i) => <DisplayChild key={i} child={child} onAction={onAction} picked={picked} contextTitle={card.title ?? contextTitle} />)}
          </div>
        </details>
      )
    case "drawer":
      return (
        <details className="ui-drawer" data-testid="ui-drawer">
          <summary>{card.title}</summary>
          <div className="ui-collapse-body">
            {card.children.map((child, i) => <DisplayChild key={i} child={child} onAction={onAction} picked={picked} contextTitle={card.title ?? contextTitle} />)}
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
                {slide.map((child, j) => <DisplayChild key={j} child={child} onAction={onAction} picked={picked} contextTitle={card.title ?? contextTitle} />)}
              </div>
            ))}
          </div>
        </div>
      )
    case "form":
      return <UiCardForm card={card} onAction={onAction} picked={picked} contextTitle={contextTitle} />
    default:
      // Runtime data lied about its kind (hand-edited history, older schema):
      // report via console, render nothing — the caller's JSON fallback row
      // still shows the raw payload.
      console.warn(`[ui-card] unknown kind: ${(card as { kind?: string }).kind}`)
      return null
  }
}

function DisplayChild({ child, onAction, picked, contextTitle }: { child: UIDisplayCard; onAction?: (a: UiCardAction) => void; picked?: UiCardAction | null; contextTitle?: string }) {
  return <UiCardView card={child} onAction={onAction} picked={picked} contextTitle={contextTitle} />
}

/** Tab switching is presentation-local state (which pane shows), nothing else. */
function UiTabs({ card, onAction, picked, contextTitle }: { card: Extract<UICard, { kind: "tabs" }>; onAction?: (a: UiCardAction) => void; picked?: UiCardAction | null; contextTitle?: string }) {
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
        {card.tabs[active]?.content.map((child, i) => <DisplayChild key={i} child={child} onAction={onAction} picked={picked} contextTitle={card.title ?? contextTitle} />)}
      </div>
    </div>
  )
}

/**
 * Line chart: an SVG polyline over evenly spaced items (order = x axis), with
 * each point as a real button overlaid on the plot — repeatable questions,
 * never disabled (decision graying does not apply to question semantics).
 */
function UiLineChart({ card, onAction }: { card: Extract<UICard, { kind: "chart" }>; onAction?: (a: UiCardAction) => void }) {
  const values = card.items.map((it) => it.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1 // flat series still places points inside the plot
  const PAD = 12 // percent of plot height kept clear above/below the line
  const xPct = (i: number) => (card.items.length === 1 ? 50 : (i / (card.items.length - 1)) * 100)
  const yPct = (v: number) => PAD + (1 - (v - min) / span) * (100 - 2 * PAD)
  const points = card.items.map((it, i) => `${xPct(i)},${yPct(it.value)}`).join(" ")
  const zeroVisible = min < 0 && max > 0
  return (
    <div className="ui-line" data-testid="ui-line-chart" role="img" aria-label={card.title !== undefined ? `折线图《${card.title}》` : "折线图"}>
      <svg className="ui-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {zeroVisible && <line className="ui-line-zero" x1="0" x2="100" y1={yPct(0)} y2={yPct(0)} />}
        {/* 单点序列 polyline 不渲染线段，退化为点位两侧的短平线。 */}
        {card.items.length === 1
          ? <line className="ui-line-path" x1={Math.max(xPct(0) - 2, 0)} x2={Math.min(xPct(0) + 2, 100)} y1={yPct(values[0])} y2={yPct(values[0])} />
          : <polyline className="ui-line-path" points={points} />}
      </svg>
      {card.items.map((item, i) => (
        <button
          key={i}
          type="button"
          className="ui-line-point"
          data-testid="ui-line-point"
          style={{ left: `${xPct(i)}%`, top: `${yPct(item.value)}%` }}
          aria-label={`${item.label} ${item.value}${card.unit !== undefined ? ` ${card.unit}` : ""}，点击追问`}
          title={`${item.label} · ${item.value}${card.unit !== undefined ? ` ${card.unit}` : ""}`}
          onClick={() => onAction?.({ optionId: item.label, text: uiCardText(card.title, `询问 ${item.label} 这个点的详情`) })}
        />
      ))}
      <div className="ui-line-labels" aria-hidden="true">
        {card.items.map((item, i) => <span key={i} className="ui-line-label">{item.label}</span>)}
      </div>
    </div>
  )
}
