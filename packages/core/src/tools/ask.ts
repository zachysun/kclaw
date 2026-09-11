// packages/core/src/tools/ask.ts
/**
 * ask_user_questions: mid-run questions to the user. The executor registers
 * a pending question on the SAME broker confirmations use (one gateway
 * object, two entry kinds), announces question.requested, and awaits the
 * three-way race — human answer / timeout / run abort — with the shared
 * raceConfirmation. The race outcome IS the tool result: answers format as
 * the result text, a timeout reports "user did not respond" (still `ok` —
 * an empty answer set is a valid outcome the model must reason about), and
 * an abort is an error result (an aborted wait is NOT an answer: no
 * question.resolved is emitted, matching the confirmation flow's rule).
 */
import { newId } from "../protocol/ids.js"
import type { EventPayloadMap, QuestionSpec } from "../protocol/index.js"
import { racePending, type ConfirmationBroker } from "../permissions/broker.js"
import type { ToolExecutor } from "../agent/tools.js"
import { ToolError, errMsg } from "./shared.js"

/** Emits the question lifecycle events with the run's session/runId context (wired by the run assembly). */
export type QuestionEventEmitter = <T extends "question.requested" | "question.resolved">(
  type: T,
  payload: EventPayloadMap[T],
) => void

export const ASK_USER_QUESTIONS_DESCRIPTION =
  "向用户提出一到几个需要当场确认的问题（选项单选/多选或自由文本）。" +
  "仅在关键分叉点使用——信息缺失会导致方案走偏、或不可逆操作前必须用户拍板时；" +
  "能从上下文或文件里推断的信息不要问。问题等待期间运行暂停，用户回答后工具返回答案文本。"

const DEFAULT_TIMEOUT_MS = 600_000

/** Validate the questions arg; throws ToolError on any shape violation. */
function requireQuestions(args: unknown): QuestionSpec[] {
  const v = (args as Record<string, unknown> | null)?.["questions"]
  if (!Array.isArray(v) || v.length === 0) throw new ToolError("args.questions must be a non-empty array")
  if (v.length > 5) throw new ToolError("args.questions accepts at most 5 questions per call")
  return v.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new ToolError(`args.questions[${i}] must be an object`)
    const q = raw as Record<string, unknown>
    if (typeof q.text !== "string" || q.text.trim() === "") {
      throw new ToolError(`args.questions[${i}].text must be a non-empty string`)
    }
    const spec: QuestionSpec = { text: q.text }
    if (q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.some((o) => typeof o !== "string" || o.trim() === "")) {
        throw new ToolError(`args.questions[${i}].options must be an array of at least 2 non-empty strings`)
      }
      spec.options = q.options as string[]
      if (q.multiSelect !== undefined) {
        if (typeof q.multiSelect !== "boolean") throw new ToolError(`args.questions[${i}].multiSelect must be a boolean`)
        if (q.multiSelect) spec.multiSelect = true
      }
    }
    return spec
  })
}

/** Human-readable tool-result text for an answer set (model-facing). */
function formatAnswers(questions: QuestionSpec[], answers: string[][]): string {
  return questions
    .map((q, i) => {
      const picked = answers[i]?.length ? answers[i].join("、") : "（未回答）"
      return `${i + 1}. ${q.text}\n   → ${picked}`
    })
    .join("\n")
}

export function createAskUserQuestionsTool(opts: {
  broker: ConfirmationBroker
  /** Question wait ceiling; the broker entry's expiry and the race use the same value. */
  timeoutMs?: number
  emit: QuestionEventEmitter
}): ToolExecutor {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    risk: "safe",
    concurrency: "parallel",
    async execute(args, ctx) {
      let questions: QuestionSpec[]
      try {
        questions = requireQuestions(args)
      } catch (e) {
        return { status: "error", output: `ask_user_questions: ${errMsg(e)}` }
      }
      const questionId = newId("q")
      const expiresAt = new Date(Date.now() + timeoutMs).toISOString()
      const resolution = opts.broker.createQuestion(questionId, questions, timeoutMs)
      opts.emit("question.requested", { questionId, questions, expiresAt })
      const raced = await racePending(resolution, timeoutMs, ctx.signal, {
        answers: [],
        by: "timeout",
      })
      if (raced === "aborted") {
        // An aborted wait is not an answer: no question.resolved — the run is
        // being torn down. Expire so a late gateway answer reports "unknown".
        opts.broker.expireQuestion(questionId)
        return { status: "error", output: "问题等待随运行中止而取消，未获得用户回答" }
      }
      if (raced.by === "timeout") {
        // The broker entry stays (its promise never settles on expiry) — drop
        // the stale entry so a late answer reports "unknown question".
        opts.broker.expireQuestion(questionId)
        opts.emit("question.resolved", { questionId, by: "timeout" })
        const minutes = Math.round(timeoutMs / 60_000)
        return {
          status: "ok",
          output: `用户未在限时（${minutes} 分钟）内回答。不要重复调用本工具；如该信息仍不可缺，请基于合理假设继续并在回复中说明假设。`,
          data: { questionId, answers: questions.map(() => [] as string[]) },
        }
      }
      opts.emit("question.resolved", { questionId, answers: raced.answers, by: raced.by })
      return {
        status: "ok",
        output: `用户回答：\n${formatAnswers(questions, raced.answers)}`,
        data: { questionId, answers: raced.answers },
      }
    },
  }
}
