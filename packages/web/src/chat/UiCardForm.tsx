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
  /** The user-facing text this action submits as (the send_message payload):
   * `选择：<label>` for buttons, a titled line-per-field block for forms.
   * Always present on fresh interactions; absent on persisted picks (the
   * reverse-lookup view never re-sends). */
  text?: string
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

/** Human-readable value of one field for the snapshot view. */
function displayValue(field: UIField, value: string | string[] | undefined): string {
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return "（未填）"
  if (Array.isArray(value)) return value.join("、")
  return value
}

export function UiCardForm({
  card,
  onAction,
  picked,
}: {
  card: UIFormCard
  onAction?: (action: UiCardAction) => void
  picked?: UiCardAction | null
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    Object.fromEntries(card.fields.map((f) => [f.name, draftValueOf(f)])),
  )
  // A persisted pick (this form was already submitted in a previous session)
  // switches to the read-only snapshot — draft state is irrelevant then.
  const submitted = picked != null
  const values = submitted ? picked.values ?? {} : draft

  const setValue = (name: string, v: string | string[]) => setDraft((d) => ({ ...d, [name]: v }))

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
    // The submit text IS the user message: titled, one line per field, values
    // in label form — the same strings the snapshot view shows.
    const fieldLabels = new Map(card.fields.map((f) => [f.name, f.label]))
    const lines = Object.entries(filled).map(([name, v]) => `${fieldLabels.get(name) ?? name}: ${v}`)
    const text = `[表单]${card.title !== undefined ? ` ${card.title}` : ""}\n${lines.map((l) => `- ${l}`).join("\n")}`
    onAction({ values: filled, text })
  }

  return (
    <div className="ui-form" data-testid="ui-form">
      {card.title !== undefined && <div className="ui-card-title">{card.title}</div>}
      {card.fields.map((f) => (
        <FieldView key={f.name} field={f} value={values[f.name]} disabled={submitted} onChange={(v) => setValue(f.name, v)} />
      ))}
      {submitted ? (
        <div className="ui-form-done" data-testid="ui-form-done">已提交</div>
      ) : (
        <button
          className="ui-btn ui-btn-primary"
          data-testid="ui-form-submit"
          disabled={Object.keys(draft).length === 0}
          onClick={submit}
        >
          {card.submitLabel ?? "提交"}
        </button>
      )}
    </div>
  )
}

function FieldView({
  field,
  value,
  disabled,
  onChange,
}: {
  field: UIField
  value: string | string[] | undefined
  disabled: boolean
  onChange: (v: string | string[]) => void
}) {
  const label = <label className="ui-field-label">{field.label}</label>
  switch (field.kind) {
    case "input":
      return (
        <div className="ui-field" data-testid={`ui-field-${field.name}`}>
          {label}
          <input
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
