/**
 * What one daemon frame means for a terminal surface, decided in ONE switch:
 * the readline chat and `kclaw run` both map these views to their own output.
 * The compile-time exhaustiveness check lives here, so a new core event type
 * must be classified once, not once per surface.
 *
 * Pure: no IO and no colour. Line helpers return plain text; the surface
 * applies its own tone.
 */
import type { AnyAgentEvent, ConfirmationRequestedPayload, QuestionRequestedPayload } from "@kclaw/core"
import type { WsFrame } from "./client.js"

export type FrameView =
  /** Streamed answer text, written as it arrives (no newline of its own). */
  | { kind: "text"; delta: string }
  /** The text block ended: whatever follows starts on a new line. */
  | { kind: "text-end" }
  | { kind: "thinking"; delta: string }
  | { kind: "tool-call"; name: string; args: unknown }
  | { kind: "tool-result"; status: string; durationMs: number; output: string }
  | { kind: "confirmation"; payload: ConfirmationRequestedPayload }
  | { kind: "question"; payload: QuestionRequestedPayload }
  /** One system line: note, compaction, memory or hook. */
  | { kind: "system"; text: string }
  | { kind: "run-failed"; message: string }
  | { kind: "run-completed" }
  /** A command was rejected (no run will start for it). */
  | { kind: "command-error"; message: string }
  /** Nothing to show. */
  | { kind: "silent" }

const SILENT: FrameView = { kind: "silent" }

/** A bus event frame has `payload`; command acks and error frames do not. */
export function isAgentEvent(frame: WsFrame): frame is WsFrame & AnyAgentEvent {
  return typeof frame.type === "string" && "payload" in frame
}

export function frameView(frame: WsFrame): FrameView {
  if (!isAgentEvent(frame)) {
    return frame.type === "error"
      ? { kind: "command-error", message: String(frame.message ?? "unknown error") } // e.g. send_message rejected — no run will start
      : SILENT // acks (send_message_ack / run_cancel_ack / …)
  }
  const ev = frame
  switch (ev.type) {
    case "text.delta":
      return { kind: "text", delta: ev.payload.delta }
    case "text.completed":
      return { kind: "text-end" } // deltas never newline themselves
    case "thinking.delta":
      return { kind: "thinking", delta: ev.payload.delta }
    case "tool_call.completed": {
      const block = ev.payload.block
      return block.type === "tool_call" ? { kind: "tool-call", name: block.name, args: block.args } : SILENT
    }
    case "tool_result.completed": {
      const block = ev.payload.block
      return block.type === "tool_result"
        ? { kind: "tool-result", status: block.status, durationMs: block.durationMs, output: block.output }
        : SILENT
    }
    // tool_result.delta: deliberately nothing live — the completed line
    // carries the (truncated) output; live chunk buffering is deliberately
    // left out.
    case "confirmation.requested":
      return { kind: "confirmation", payload: ev.payload }
    case "question.requested":
      return { kind: "question", payload: ev.payload }
    // question.resolved: the pending question already collected its answers;
    // the broadcast needs nothing.
    case "question.resolved":
      return SILENT
    // message.created/completed (any role): deliberately nothing. The USER
    // message events (the daemon announces the user message lifecycle on the
    // wire) must not render — the typed line is already on screen, so a render
    // here would double-echo the user's text. Assistant/tool messages are
    // equally non-visual here: their content streams through the
    // text.*/tool_*/thinking.* events above.
    case "message.created":
    case "message.completed":
      return SILENT
    // note.emitted: one line per note block — including the memory/cron notes
    // the daemon injects onto the user message (each is announced exactly
    // once, between that message's created and completed).
    case "note.emitted":
      return { kind: "system", text: `[note] ${ev.payload.block.text}` }
    // Pre-run compaction lifecycle: started prints one hint (the compaction
    // runs BEFORE run.started — without it the seconds-long summarizer calls
    // are a silent gap after Enter). Completed prints the one-line summary:
    // this event only fires when a compaction actually ran, so it is a
    // natural once-per-compaction announcement (the per-turn note re-attach
    // above stays silent).
    case "compaction.started":
      return { kind: "system", text: "[正在压缩早期对话…]" }
    case "compaction.completed": {
      const p = ev.payload
      if (p.result === "failed") return { kind: "system", text: "✱ 压缩失败，本轮继续（稍后自动重试）" }
      if (p.result === "cancelled") return { kind: "system", text: "✱ 压缩已取消" }
      return { kind: "system", text: `✱ 早期对话已压缩为 ${p.segments} 段，保留最近 ${p.kept} 条原文（早期细节可用 session_search 检索）` }
    }
    // memory.written（项目级事务，广播不带 sessionId）：记忆已写入，一行提示
    // 路径，不是 run 终止事件。
    case "memory.written":
      return { kind: "system", text: `已写入记忆: ${ev.payload.path}` }
    // hook.failed：用户 hook 一律 fail-open（不伤 run），但失败必须可见——
    // 一行警告，带钩子名与位置；phase load 表示装载期失败。
    case "hook.failed": {
      const p = ev.payload
      return { kind: "system", text: `⚠ hook ${p.hook} 失败（${p.position}${p.phase === "load" ? " 装载" : ""}）：${p.error}` }
    }
    case "run.failed":
      return { kind: "run-failed", message: ev.payload.error.message }
    case "run.completed":
      return { kind: "run-completed" }
    // run.started: no line — the run's first visible output is the model's
    // first delta; printing a banner here would only add noise.
    case "run.started":
    // cron.* / session.renamed: the chat loop does not act on cron lifecycle
    // or list-level renames (other surfaces own those).
    case "cron.started":
    case "cron.completed":
    case "cron.failed":
    // process.*: 后台进程生命周期广播；完成通知以排队的 run 到达属主会话，
    // 裸广播在聊天视图不渲染。
    case "process.started":
    case "process.completed":
    case "process.failed":
    case "session.renamed":
    // Block-open events: nothing live — the completed lines carry the full
    // blocks (deltas stream between them; tool_result.delta's chunks are
    // deliberately not buffered, the completed line truncates the output).
    case "text.created":
    case "thinking.created":
    case "thinking.completed":
    case "tool_call.created":
    case "tool_call.delta":
    case "tool_result.created":
    case "tool_result.delta":
    case "attachment.created":
    case "attachment.completed":
    // llm.*: raw provider-call bookkeeping — the retry hint is not rendered
    // in the CLI (a retried call keeps streaming; the final failure surfaces
    // via run.failed / run.completed).
    case "llm.started":
    case "llm.completed":
    case "llm.failed":
    // confirmation.resolved: the pending confirm already printed its verdict
    // line when handled; the broadcast needs nothing.
    case "confirmation.resolved":
    // Queue trio: the daemon's queue state is visible via /queue on demand;
    // the queued/steered/cancelled broadcasts render nothing here.
    case "message.queued":
    case "message.steered":
    case "message.queue_cancelled":
    // Edit & retry / regenerate: the truncation broadcast only reshapes the
    // webui chat view; the CLI has no retry entry and renders nothing.
    case "message.truncated":
    // session.appended: the persistence announcement consumed by the webui
    // audit page (incremental refetch); the CLI renders nothing.
    case "session.appended":
      return SILENT
    default: {
      // Compile-time exhaustiveness check: a new core event type lands here
      // as a non-never `ev` and fails this assignment — it must be classified
      // or explicitly ignored above.
      const unhandled: never = ev
      void unhandled
      return SILENT
    }
  }
}

/** Args summary for the `⚡ <name> <args>` line: compact JSON, capped at 60 chars. */
function summarizeArgs(args: unknown): string {
  let text: string
  try {
    text = JSON.stringify(args ?? {}) ?? "{}"
  } catch {
    text = String(args)
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

/** Output summary for the `↳ <status>` line: whitespace-collapsed, first 80 chars. */
function summarizeOutput(output: string): string {
  const text = output.replace(/\s+/g, " ").trim()
  return text.length > 80 ? `${text.slice(0, 80)}...` : text
}

export function toolCallLine(view: { name: string; args: unknown }): string {
  return `⚡ ${view.name} ${summarizeArgs(view.args)}`
}

export function toolResultLine(view: { status: string; durationMs: number; output: string }): string {
  return `↳ ${view.status} (${Math.round(view.durationMs)}ms) ${summarizeOutput(view.output)}`
}

export function confirmationLine(p: ConfirmationRequestedPayload): string {
  return `⚠ ${p.toolCall.name} ${p.toolCall.argsJson} · 风险 ${p.risk} · 过期 ${p.expiresAt}`
}

export function questionLine(p: QuestionRequestedPayload): string {
  return `❓ ${p.questions.length} 个问题待回答`
}
