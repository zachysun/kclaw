/**
 * Inline decision cards of the chat surface: the confirmation card (exec /
 * write approvals) and the ask_user_questions card. Both render below the
 * run indicators, above the composer — the space the acting user is looking
 * at. QuestionCardView owns its per-question draft state (option picks and
 * free-text), keyed by card identity in the parent's list.
 */
import { useState } from "react"
import type { ConfirmationDecision } from "@kclaw/core/protocol"
import { formatClock } from "../usage/format.js"
import type { ConfirmationCard, QuestionCard } from "./model.js"

export function ConfirmationCardView({
  card,
  onResolve,
}: {
  card: ConfirmationCard
  onResolve: (confirmationId: string, decision: ConfirmationDecision) => void
}) {
  return (
    <div className="confirm-card" data-testid="confirm-card">
      <div className="confirm-title">需要确认</div>
      <div className="confirm-tool">⚡ {card.toolName}</div>
      {/* argsJson can carry a whole file's content — it must stay inside a
          scroll-clamped block or the card swallows the chat pane and pushes
          the resolve buttons out of the viewport. */}
      <div className="confirm-args"><code>{card.argsJson}</code></div>
      <div className="confirm-meta">风险 {card.risk} · 有效至 {formatClock(card.expiresAt)}</div>
      {card.noteText !== undefined && <div className="confirm-note">{card.noteText}</div>}
      <div className="confirm-actions">
        <button data-testid="confirm-once" onClick={() => onResolve(card.confirmationId, "once")}>仅本次</button>
        <button data-testid="confirm-project" onClick={() => onResolve(card.confirmationId, "project")}>总是（本项目）</button>
        <button data-testid="confirm-global" onClick={() => onResolve(card.confirmationId, "global")}>总是（全局）</button>
        <button data-testid="confirm-reject" onClick={() => onResolve(card.confirmationId, "reject")}>拒绝</button>
      </div>
    </div>
  )
}

/**
 * One pending ask_user_questions card: each question renders as option
 * buttons (single-pick submits immediately; multiSelect toggles + a submit
 * row) or a free-text input. Submitting sends the whole answer set — one
 * string array per question — as one question.resolve frame.
 */
export function QuestionCardView({
  card,
  onAnswer,
}: {
  card: QuestionCard
  onAnswer: (questionId: string, answers: string[][]) => void
}) {
  const [textValues, setTextValues] = useState<string[]>(() => card.questions.map(() => ""))
  const [multiPicks, setMultiPicks] = useState<string[][]>(() => card.questions.map(() => []))
  // An empty answer array means "skipped" — the same contract as the CLI's
  // enter-to-skip, and the tool result renders it as （未回答）.
  const answers: string[][] = card.questions.map((q, i) => {
    if (Array.isArray(q.options) && q.options.length > 0) return multiPicks[i] ?? []
    const t = (textValues[i] ?? "").trim()
    return t === "" ? [] : [t]
  })
  return (
    <div className="question-card" data-testid="question-card">
      <div className="confirm-head">
        <span className="confirm-badge">问题待回答</span>
        <span className="confirm-when">{card.questions.length} 个问题 · 有效至 {formatClock(card.expiresAt)}</span>
      </div>
      {card.noteText !== undefined && <div className="confirm-note">{card.noteText}</div>}
      {card.questions.map((q, i) => (
        <div key={i} className="question-item" data-testid={`question-item-${i}`}>
          <div className="question-text-label">
            {Array.isArray(q.options) && q.options.length > 0 && (
              <span className={q.multiSelect === true ? "question-mode multi" : "question-mode single"}>
                {q.multiSelect === true ? "多选" : "单选"}
              </span>
            )}
            {q.text}
          </div>
          {Array.isArray(q.options) && q.options.length > 0 ? (
            <div className="question-options">
              {q.options.map((opt) => {
                const picked = multiPicks[i]?.includes(opt) ?? false
                return (
                  <button
                    key={opt}
                    data-testid={`question-${i}-option`}
                    className={picked ? "question-picked" : undefined}
                    onClick={() => {
                      setMultiPicks((prev) => {
                        const next = prev.map((p, j) => (j === i ? [...p] : p))
                        const cur = next[i] ?? []
                        if (q.multiSelect === true) {
                          next[i] = picked ? cur.filter((x) => x !== opt) : [...cur, opt]
                        } else {
                          next[i] = [opt]
                        }
                        return next
                      })
                    }}
                  >
                    {opt}
                  </button>
                )
              })}
            </div>
          ) : (
            <input
              className="question-text"
              data-testid={`question-${i}-text`}
              value={textValues[i] ?? ""}
              placeholder="自由输入，留空跳过"
              onChange={(e) => setTextValues((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
            />
          )}
        </div>
      ))}
      <div className="question-actions">
        <button className="primary" data-testid="question-submit" onClick={() => onAnswer(card.questionId, answers)}>
          提交回答
        </button>
      </div>
    </div>
  )
}
