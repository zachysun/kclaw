/**
 * The three `kclaw run` output formats (spec A4), fed with the frames the
 * lifecycle attributes to this run. One injected `write` receives everything
 * bound for stdout; stderr lines and the exit code stay with the command.
 *
 * - text: the frame views as lines, the same shapes as the piped chat path
 *   (⚡/↳ summaries, dim system lines), streamed as frames arrive. Failures
 *   are not repeated here: the lifecycle's stderr line carries them.
 * - json: one compact object after the run ends — the last assistant
 *   message's text (text.delta grouped by messageId; earlier turns' narration
 *   stays out, codex --output-last-message), stopReason/usage from
 *   run.completed (omitted without one), the client-measured duration, and
 *   `error` for every exit-1 outcome.
 * - stream-json: send_message's reply and every event frame of this run,
 *   verbatim one per line — the wire protocol already is JSON.
 *
 * json and stream-json never carry colour.
 */
import type { RunCompletedPayload } from "@kclaw/core"
import type { WsFrame } from "./client.js"
import { dim } from "./color.js"
import { confirmationLine, frameView, isAgentEvent, questionLine, toolCallLine, toolResultLine } from "./frame-view.js"
import { UNATTENDED_ANSWER, type CardPolicy, type RunFailure } from "./run-lifecycle.js"

export const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

/** The verdict line under a confirmation card, per policy. */
const CONFIRMATION_VERDICT: Readonly<Record<CardPolicy, string>> = {
  yes: "[--yes] 已自动允许（仅本次）",
  no: "[--no] 已自动拒绝",
  default: "已自动拒绝（未指定 --yes）",
}

/** What the json object needs beyond the frames. */
export interface RunSummary {
  /** Omitted when the run failed before a session was established. */
  sessionId?: string
  /** Omitted when no message was accepted. */
  messageId?: string
  durationMs: number
  failure?: RunFailure
}

export interface RunOutput {
  /** One frame that belongs to this run. */
  frame(frame: WsFrame): void
  /** The run is over: close the text line, or print the json object. Not called once stdout is gone. */
  finish(summary: RunSummary): void
}

export function createRunOutput(opts: {
  format: OutputFormat
  policy: CardPolicy
  showThinking: boolean
  write: (chunk: string) => void
}): RunOutput {
  switch (opts.format) {
    case "text":
      return textOutput(opts)
    case "json":
      return jsonOutput(opts.write)
    case "stream-json":
      return {
        frame: (frame) => opts.write(`${JSON.stringify(frame)}\n`),
        finish: () => {},
      }
  }
}

function textOutput(opts: { policy: CardPolicy; showThinking: boolean; write: (chunk: string) => void }): RunOutput {
  let atLineStart = true
  const write = (text: string): void => {
    if (text === "") return
    opts.write(text)
    atLineStart = text.endsWith("\n")
  }
  const ensureLineStart = (): void => {
    if (!atLineStart) write("\n")
  }
  const line = (text: string): void => {
    ensureLineStart()
    write(`${text}\n`)
  }
  return {
    frame(frame) {
      const view = frameView(frame)
      switch (view.kind) {
        case "text":
          write(view.delta)
          return
        case "text-end":
        case "run-completed":
          ensureLineStart()
          return
        case "thinking":
          if (opts.showThinking) write(dim(`· ${view.delta}`))
          return
        case "tool-call":
          line(toolCallLine(view))
          return
        case "tool-result":
          line(toolResultLine(view))
          return
        case "confirmation":
          line(confirmationLine(view.payload))
          if (view.payload.noteText !== undefined) line(dim(view.payload.noteText))
          line(dim(CONFIRMATION_VERDICT[opts.policy]))
          return
        case "question":
          line(questionLine(view.payload))
          if (view.payload.noteText !== undefined) line(dim(view.payload.noteText))
          line(dim(`已自动回复：${UNATTENDED_ANSWER}`))
          return
        case "system":
          line(dim(view.text))
          return
        // run-failed / command-error: the lifecycle's stderr line carries them.
        case "run-failed":
        case "command-error":
        // thinking-end / queue views: the text output has no folded thinking
        // line and no queue display.
        case "thinking-end":
        case "queued":
        case "left-queue":
        case "silent":
          return
      }
    },
    finish() {
      ensureLineStart()
    },
  }
}

function jsonOutput(write: (chunk: string) => void): RunOutput {
  const texts = new Map<string, string>()
  let lastAssistant: string | undefined
  let completed: RunCompletedPayload | undefined
  return {
    frame(frame) {
      if (!isAgentEvent(frame)) return
      if (frame.type === "message.created" && frame.payload.message.role === "assistant") {
        lastAssistant = frame.payload.message.id
      } else if (frame.type === "text.delta") {
        const { messageId, delta } = frame.payload
        texts.set(messageId, (texts.get(messageId) ?? "") + delta)
      } else if (frame.type === "run.completed") {
        completed = frame.payload
      }
    },
    finish(summary) {
      write(`${JSON.stringify({
        ...(summary.sessionId !== undefined ? { sessionId: summary.sessionId } : {}),
        ...(summary.messageId !== undefined ? { messageId: summary.messageId } : {}),
        text: lastAssistant === undefined ? "" : texts.get(lastAssistant) ?? "",
        ...(completed !== undefined ? { stopReason: completed.stopReason, usage: completed.usage } : {}),
        durationMs: summary.durationMs,
        ...(summary.failure !== undefined ? { error: summary.failure } : {}),
      })}\n`)
    },
  }
}
