/**
 * UiCardForm — the `form` UI Card: local draft state across its fields, one
 * submit. The draft mirrors the question-card mental model (fill, review,
 * commit once); after submit (or when a persisted pick arrives via props) the
 * form renders as a read-only snapshot. Field values never leave this
 * component except through onAction — the card is display data, not state.
 */
import { useState } from "react"
import type { UIField, UIFormCard } from "@kclaw/core/protocol"

export interface UiCardAction {
  /** Button cards: the picked label. Absent for form submits. */
  optionId?: string
  /** Form submits: field name → reported (label-form) value. */
  values?: Record<string, string>
  /** True for one-shot decisions (button pick / form submit): the card grays
   * out and its pending entry settles. Chart-point questions are repeatable
   * and omit it — no settled state, no pending-bar removal. */
  decision?: boolean
  /** The user-facing text this action submits as (the send_message payload).
   * Always present on fresh interactions; absent on persisted picks (the
   * reverse-lookup view never re-sends). */
  text?: string
}

/**
 * The one message template for every UI-card interaction (button pick, form
 * submit, chart-point question): a `[UI 卡]` prefix plus the nearest card
 * title, so the model can tell WHICH card the answer belongs to when several
 * share a turn. No title in scope → the bare `[UI 卡] <动作>` form.
 */
export function uiCardText(title: string | undefined, action: string): string {
  return title !== undefined && title !== "" ? `[UI 卡] ${title}：${action}` : `[UI 卡] ${action}`
}

type Draft = Record<string, string | string[]>

function draftValueOf(field: UIField): string | string[] {
  switch (field.kind) {
    case "checkbox":
      return []
    case "slider":
      return String(field.min)
    default:
      return ""
  }
}

export function UiCardForm({
  card,
  onAction,
  picked,
  contextTitle,
}: {
  card: UIFormCard
  onAction?: (action: UiCardAction) => void
  picked?: UiCardAction | null
  /** Nearest enclosing card title (containers thread theirs down); the
   * form's own title wins when it has one. */
  contextTitle?: string
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    Object.fromEntries(card.fields.map((f) => [f.name, draftValueOf(f)])),
  )
  // A persisted pick (this form was already submitted in a previous session)
  // switches to the read-only snapshot — draft state is irrelevant then.
  const submitted = picked != null
  const values = submitted ? picked.values ?? {} : draft

  const setValue = (name: string, v: string | string[]) => setDraft((d) => ({ ...d, [name]: v }))

  // A field counts as answered when it holds a real value (checkbox picks are
  // an array). The submit button disables on this — the visible feedback for
  // an untouched form. A slider always holds a value, so a slider-only form
  // is always submittable (the displayed value IS the answer).
  const hasAnswer = card.fields.some((f) => {
    const d = draft[f.name]
    return f.kind === "checkbox" ? Array.isArray(d) && d.length > 0 : typeof d === "string" && d !== ""
  })

  const submit = () => {
    if (onAction === undefined || submitted) return
    // Reported values are user-visible labels (the submit text IS a user
    // message): option picks map value→label, everything else passes through.
    const labelOf = (f: UIField, v: string): string =>
      f.kind === "radio" || f.kind === "checkbox" || f.kind === "segmented"
        ? f.options.find((o) => o.value === v)?.label ?? v
        : v
    const filled = Object.fromEntries(
      card.fields
        .map((f): [string, string] | null => {
          const d = draft[f.name]
          if (f.kind === "checkbox") {
            const picks = Array.isArray(d) ? d : []
            return picks.length > 0 ? [f.name, picks.map((v) => labelOf(f, v)).join("、")] : null
          }
          return typeof d === "string" && d !== "" ? [f.name, labelOf(f, d)] : null
        })
        .filter((x): x is [string, string] => x !== null),
    )
    if (Object.keys(filled).length === 0) return // 空表单不允许提交
    // The submit text IS the user message: card-context header, one line per
    // field, values in label form — the same strings the snapshot view shows.
    const fieldLabels = new Map(card.fields.map((f) => [f.name, f.label]))
    const lines = Object.entries(filled).map(([name, v]) => `${fieldLabels.get(name) ?? name}: ${v}`)
    const text = `${uiCardText(card.title ?? contextTitle, "表单提交")}\n${lines.map((l) => `- ${l}`).join("\n")}`
    onAction({ values: filled, text, decision: true })
  }

  return (
    <div className="ui-form" data-testid="ui-form">
      {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
      {card.fields.map((f, i) => (
        <FieldView key={f.name} id={`ui-f-${i}-${f.name}`} field={f} value={values[f.name]} disabled={submitted} onChange={(v) => setValue(f.name, v)} />
      ))}
      {submitted ? (
        <div className="ui-form-done" data-testid="ui-form-done">已提交</div>
      ) : (
        <button
          className="ui-btn ui-btn-primary"
          data-testid="ui-form-submit"
          disabled={!hasAnswer}
          onClick={submit}
        >
          {card.submitLabel ?? "提交"}
        </button>
      )}
    </div>
  )
}

function FieldView({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  /** Dom id for the label association (callers pass one unique per field). */
  id: string
  field: UIField
  value: string | string[] | undefined
  disabled: boolean
  onChange: (v: string | string[]) => void
}) {
  const label = <label className="ui-field-label" htmlFor={id}>{field.label}</label>
  switch (field.kind) {
    case "input":
      return (
        <div className="ui-field" data-testid={`ui-field-${field.name}`}>
          {label}
          <input
            id={id}
            className="ui-input"
            type={field.inputType ?? "text"}
            placeholder={field.placeholder}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )
    case "textarea":
      return (
        <div className="ui-field" data-testid={`ui-field-${field.name}`}>
          {label}
          <textarea
            id={id}
            className="ui-input ui-textarea"
            rows={field.rows ?? 3}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )
    case "radio":
    case "segmented":
      return (
        <div className={`ui-field${field.kind === "segmented" ? " ui-field-segmented" : ""}`} data-testid={`ui-field-${field.name}`}>
          {label}
          <div className="ui-option-row" role="radiogroup">
            {field.options.map((o) => (
              <label key={o.value} className={`ui-option${(typeof value === "string" ? value === o.value : false) ? " ui-option-picked" : ""}`}>
                <input
                  type="radio"
                  name={field.name}
                  value={o.value}
                  disabled={disabled}
                  checked={typeof value === "string" && value === o.value}
                  onChange={() => onChange(o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>
        </div>
      )
    case "checkbox":
      return (
        <div className="ui-field" data-testid={`ui-field-${field.name}`}>
          {label}
          <div className="ui-option-row">
            {field.options.map((o) => {
              const picks = Array.isArray(value) ? value : []
              return (
                <label key={o.value} className={`ui-option${picks.includes(o.value) ? " ui-option-picked" : ""}`}>
                  <input
                    type="checkbox"
                    name={field.name}
                    value={o.value}
                    disabled={disabled}
                    checked={picks.includes(o.value)}
                    onChange={() => onChange(picks.includes(o.value) ? picks.filter((v) => v !== o.value) : [...picks, o.value])}
                  />
                  {o.label}
                </label>
              )
            })}
          </div>
        </div>
      )
    case "slider":
      return (
        <div className="ui-field" data-testid={`ui-field-${field.name}`}>
          {label}
          <div className="ui-slider-row">
            <input
              id={id}
              type="range"
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              value={typeof value === "string" && value !== "" ? value : String(field.min)}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
            <span className="ui-slider-value">
              {typeof value === "string" && value !== "" ? value : field.min}
              {field.unit !== undefined ? ` ${field.unit}` : ""}
            </span>
          </div>
        </div>
      )
    case "date":
      return (
        <div className="ui-field" data-testid={`ui-field-${field.name}`}>
          {label}
          <input
            id={id}
            className="ui-input"
            type="date"
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )
    case "time":
      return (
        <div className="ui-field" data-testid={`ui-field-${field.name}`}>
          {label}
          <input
            id={id}
            className="ui-input"
            type="time"
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )
  }
}
