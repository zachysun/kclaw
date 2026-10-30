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
  tone?: UITone
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
  /** v1 renders "bar" only; the field reserves the extension slot. */
  chartType?: "bar"
  unit?: string
  items: UIBarItem[]
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
