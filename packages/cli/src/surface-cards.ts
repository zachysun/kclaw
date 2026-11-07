/**
 * Confirmation/question card SEMANTICS shared by every presenter — the
 * readline surface (@clack prompts), the ink cards, and the unattended
 * `kclaw run` renderer. Option labels, verdict notices and auto-answer
 * lines live here exactly once so the surfaces cannot drift (the drift
 * already happened once: multiselect empty-submit differed between the
 * two surfaces until the review caught it). Renderers keep their own key
 * state machines; this module pins WHAT the answers and copy mean:
 *
 * - the confirmation card is a four-choice verdict (once/project/global/
 *   reject), Esc/cancel means reject;
 * - a question answer is an array of option TEXTS per question — an empty
 *   array means "skipped", free text submits trimmed or nothing.
 */
import type { ConfirmationDecision } from "@kclaw/core"

/** The confirmation card's four verdict options, verbatim on every surface. */
export const CONFIRM_OPTIONS: ReadonlyArray<{ value: ConfirmationDecision; label: string }> = [
  { value: "once", label: "允许（仅本次）" },
  { value: "project", label: "总是允许（本项目）" },
  { value: "global", label: "总是允许（全局）" },
  { value: "reject", label: "拒绝" },
]

/** The notice a surface leaves after the user picked a verdict. */
export const CONFIRM_VERDICT_LABELS: Readonly<Record<ConfirmationDecision, string>> = {
  once: "已允许（仅本次）",
  project: "已允许（本项目）",
  global: "已允许（全局）",
  reject: "已拒绝",
}

/**
 * The line shown when a verdict is answered WITHOUT asking anyone — keyed
 * by the unattended policy (`--yes`/`--no` flags, and `default` for `kclaw
 * run` invoked with neither, which must never hang on a card).
 */
export const AUTO_CONFIRM_VERDICTS: Readonly<Record<"yes" | "no" | "default", string>> = {
  yes: "[--yes] 已自动允许（仅本次）",
  no: "[--no] 已自动拒绝",
  default: "已自动拒绝（未指定 --yes）",
}
