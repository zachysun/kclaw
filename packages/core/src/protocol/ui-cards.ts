/**
 * UI Card DSL: the typed shape of what the `ui_render` tool validates and
 * what lands in a ToolResultBlock's `data` for the web to render. The DSL is
 * wire data (events.jsonl / REST / bus all carry it verbatim), so the type
 * canon lives in protocol, per the single-canon rule — web renders from these
 * types, core validates against them; neither hand-mirrors.
 *
 * Nesting is closed at the type level: container cards' children only accept
 * display cards, so "containers all the way down" fails to compile here — the
 * validator re-enforces it at runtime because model output is `unknown`.
 * Free-text is rendered as React text nodes by the web and never as HTML:
 * the DSL carries presentation structure, never markup.
 */

export type UITone = "default" | "primary" | "ok" | "warn" | "error"

/** Button actions get the semantic triplet only (no ok/warn — a button is not a status chip). */
export type UIButtonTone = "default" | "primary" | "danger"

/** A form field is named (answers report label→value by name) and only legal inside form.fields. */
interface UIFieldBase {
  name: string
  label: string
}

export interface UIInputField extends UIFieldBase {
  kind: "input"
  placeholder?: string
  inputType?: "text" | "number" | "password"
}

export interface UITextareaField extends UIFieldBase {
  kind: "textarea"
  rows?: number
}

export interface UIOption {
  value: string
  label: string
}

export interface UIRadioField extends UIFieldBase {
  kind: "radio"
  options: UIOption[]
}

export interface UICheckboxField extends UIFieldBase {
  kind: "checkbox"
  options: UIOption[]
}

export interface UISegmentedField extends UIFieldBase {
  kind: "segmented"
  options: UIOption[]
}

export interface UISliderField extends UIFieldBase {
  kind: "slider"
  min: number
  max: number
  step?: number
  unit?: string
}

export interface UIDateField extends UIFieldBase {
  kind: "date"
}

export interface UITimeField extends UIFieldBase {
  kind: "time"
}

export type UIField =
  | UIInputField
  | UITextareaField
  | UIRadioField
  | UICheckboxField
  | UISegmentedField
  | UISliderField
  | UIDateField
  | UITimeField

/** Display cards: legal standalone, and the only children a container accepts. */
export interface UIButtonCard {
  kind: "button"
  label: string
  tone?: UIButtonTone
}

export interface UILinkCard {
  kind: "link"
  text: string
  url: string
}

export interface UITableColumn {
  key: string
  label: string
}

export interface UITableCard {
  kind: "table"
  title?: string
  columns: UITableColumn[]
  rows: Record<string, string>[]
}

export interface UIListCard {
  kind: "list"
  title?: string
  ordered?: boolean
  items: string[]
}

export interface UITagCard {
  kind: "tag"
  title?: string
  text: string
  tone?: UITone
}

export interface UIBadgeCard {
  kind: "badge"
  title?: string
  text: string
  tone?: UITone
}

export interface UITimelineItem {
  time?: string
  title: string
  text?: string
  tone?: UITone
}

export interface UITimelineCard {
  kind: "timeline"
  title?: string
  items: UITimelineItem[]
}

export interface UITreeNode {
  label: string
  children?: UITreeNode[]
}

export interface UITreeCard {
  kind: "tree"
  title?: string
  root: UITreeNode
}

export interface UIQuoteCard {
  kind: "quote"
  title?: string
  text: string
  source?: string
}

export interface UIIconCard {
  kind: "icon"
  title?: string
  value: string
}

export interface UIBarItem {
  label: string
  value: number
}

export interface UIChartCard {
  kind: "chart"
  title?: string
  /** "bar" renders horizontal bars; "line" renders a time-series polyline
   * whose points report back on click (question semantics — never disabled). */
  chartType?: "bar" | "line"
  unit?: string
  items: UIBarItem[]
}

/** One headline number (KPI): label caption, display value, optional trend.
 * `value` is a display string so the model can hand over formatted figures
 * ("1,204", "3.2s"); `delta` gets its color from its leading sign at render. */
export interface UIStatCard {
  kind: "stat"
  title?: string
  label: string
  value: string
  unit?: string
  delta?: string
}

/** A form is itself display-level: containers may embed it, model may emit it standalone. */
export interface UIFormCard {
  kind: "form"
  title?: string
  fields: UIField[]
  submitLabel?: string
}

export type UIDisplayCard =
  | UIButtonCard
  | UILinkCard
  | UITableCard
  | UIListCard
  | UITagCard
  | UIBadgeCard
  | UITimelineCard
  | UITreeCard
  | UIQuoteCard
  | UIIconCard
  | UIChartCard
  | UIStatCard
  | UIFormCard

export interface UICardBodyCard {
  kind: "card"
  title?: string
  body: UIDisplayCard[]
}

export interface UITab {
  label: string
  content: UIDisplayCard[]
}

export interface UITabsCard {
  kind: "tabs"
  title?: string
  tabs: UITab[]
}

export interface UICollapseCard {
  kind: "collapse"
  title: string
  open?: boolean
  children: UIDisplayCard[]
}

export interface UIDrawerCard {
  kind: "drawer"
  title: string
  children: UIDisplayCard[]
}

export interface UICarouselCard {
  kind: "carousel"
  title?: string
  slides: UIDisplayCard[][]
}

/** Container cards: one level deep by construction (children are display-only). */
export type UIContainerCard =
  | UICardBodyCard
  | UITabsCard
  | UICollapseCard
  | UIDrawerCard
  | UICarouselCard

export type UICard = UIDisplayCard | UIContainerCard

// ---- structural sniffing (pure, browser-safe) --------------------------------
// Single-canon helpers: the web pending bar, the ui_read tool, and the meta
// projection all decide "is this data a card / does it ask the user something"
// through these two functions — no module hand-rolls its own kind list.

const CARD_KINDS: ReadonlySet<string> = new Set([
  "button", "link", "table", "list", "card", "tag", "badge", "tabs", "collapse",
  "timeline", "tree", "carousel", "quote", "icon", "chart", "stat", "drawer", "form",
])

/** Structural sniff, not a validator: cards were validated at emit time — this
 * only decides whether some executor's `data` payload is a card at all. */
export function isUiCardData(data: unknown): data is UICard {
  return (
    typeof data === "object" && data !== null && !Array.isArray(data) &&
    typeof (data as { kind?: unknown }).kind === "string" &&
    CARD_KINDS.has((data as { kind: string }).kind)
  )
}

/** Counts the interactive (decision-shaped) nodes inside a card tree: button
 * and form cards, including ones nested in containers. Chart points are
 * question semantics, not decisions, and are deliberately not counted — the
 * pending-decision surfaces (web bar, session badge) aggregate on this. */
export function cardInteractiveNodes(card: UICard): { buttons: number; forms: number } {
  let buttons = 0
  let forms = 0
  const walk = (c: UICard): void => {
    if (c.kind === "button") buttons++
    else if (c.kind === "form") forms++
    else if (c.kind === "card") c.body.forEach(walk)
    else if (c.kind === "tabs") c.tabs.forEach((t) => t.content.forEach(walk))
    else if (c.kind === "collapse" || c.kind === "drawer") c.children.forEach(walk)
    else if (c.kind === "carousel") c.slides.forEach((s) => s.forEach(walk))
  }
  walk(card)
  return { buttons, forms }
}

/**
 * Where a user message came from when it was a UI Card interaction: the
 * triggering card's tool callId, the picked button's label, or a form's
 * reported values. Display provenance only — never a permission or semantics
 * input (a client may claim anything; that is harmless). The web reverse-
 * looks these up to render settled UI Card states across reloads.
 */
export interface UiActionRef {
  cardCallId: string
  /** Button cards: the picked label. */
  optionId?: string
  /** Form submits: field name → reported (label-form) value. */
  values?: Record<string, string>
  /** True when the action settles a decision (button pick / form submit):
   * only decision actions leave the meta.uiPending set and pin the settled
   * state. Chart-point questions are repeatable by design — a card may hold
   * a button AND a chart, and asking about a point must keep the button's
   * decision open. */
  decision?: boolean
}

/**
 * One unresolved decision card in a session's meta projection (uiPending):
 * the card's tool callId plus the message that carries it (message ids are
 * monotonic ULIDs, so edit-and-retry truncation prunes by string compare).
 * Entries leave the set when a user message reports a matching decision
 * action (`decision: true`) — the set only ever holds still-unanswered cards,
 * keeping meta.json light.
 */
export interface UiPendingRef {
  cardCallId: string
  messageId: string
}
