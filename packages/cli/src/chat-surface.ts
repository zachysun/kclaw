/**
 * The seam between the chat orchestration (chat.ts: frame pump, render
 * takeover, reconnect, slash registry, Ctrl+C escalation, mode cycling) and
 * the two terminal surfaces that display it — the readline line surface
 * (pipes, or a terminal missing a TTY on either end) and the ink TUI (stdin
 * and stdout both TTYs, spec B2). The orchestrator never writes to the
 * terminal itself: every line, card and picker goes through ChatSurface, and
 * every typed line or chat key comes back through ChatController.
 */
import type { ConfirmationDecision, ConfirmationRequestedPayload, PermissionMode, QuestionRequestedPayload } from "@kclaw/core"
import type { SlashCommandMeta } from "@kclaw/core/commands"
import type { KclawClient } from "./client.js"
import type { FrameView } from "./frame-view.js"

/** The views a surface draws: cards travel through confirm/ask, silent frames never leave the orchestrator. */
export type DisplayView = Exclude<FrameView, { kind: "confirmation" | "question" | "silent" }>

/** Tone of an orchestrator line: slash command output is plain, status hints dim, failures red. */
export type NoticeTone = "plain" | "dim" | "error"

export interface ChoiceOption {
  value: string
  label: string
}

export interface ChatSurface {
  show(view: DisplayView): void
  notice(text: string, tone: NoticeTone): void
  /** Ask for a verdict on one confirmation card (the --yes/--no policies never reach here). */
  confirm(p: ConfirmationRequestedPayload): Promise<ConfirmationDecision>
  /** One answer list per question, in ask order; an empty list means skipped. */
  ask(p: QuestionRequestedPayload): Promise<string[][]>
  /** Pick one option; undefined means the user backed out. */
  choose(message: string, options: readonly ChoiceOption[]): Promise<string | undefined>
  /**
   * The local permission-mode mirror moved. `redraw` is true when no run is
   * active, so a line surface may redraw its prompt right away.
   */
  modeChanged(mode: PermissionMode, redraw: boolean): void
  /** A render started (true) or the newest render ended (false). */
  busyChanged(busy: boolean): void
  /** The chat moved to another session. */
  sessionChanged(sessionId: string): void
}

/** What a surface drives: typed lines and chat keys go in, the orchestrator does the rest. */
export interface ChatController {
  /** The current client (a reconnect swaps it). */
  readonly client: KclawClient
  readonly sessionId: string
  readonly mode: PermissionMode
  /** A render is in flight (a sent message has not reached its terminal yet). */
  readonly busy: boolean
  /** One typed line: a slash command, `/exit` (resolves "exit" once renders drained) or a plain message. */
  submit(line: string): Promise<"exit" | "continue">
  /** Ctrl+C: the three-stage escalation (cancel the run → clear the queue → exit 130). */
  interrupt(): void
  /** Stop the active run (Esc in the TUI); a no-op while idle. */
  stopRun(): void
  /** Shift+Tab: the next permission mode, applied after the daemon confirms it. */
  cycleMode(): Promise<void>
  /** Builtin plus installed-skill slash commands for completion (refreshed lazily, at most every 2s). */
  skillCommands(): readonly SlashCommandMeta[]
  /** Wait for in-flight renders to finish (EOF and exit paths). */
  drain(): Promise<void>
}

/** A surface that also owns the input side: run() returns once the user left (/exit, EOF). */
export interface ChatUi extends ChatSurface {
  run(controller: ChatController): Promise<void>
  /** Release the terminal synchronously (the Ctrl+C third stage exits right after). */
  close(): void
}
