/**
 * The TUI's one state store: every ChatSurface call from the orchestrator
 * lands here as an immutable state update, and React reads it through
 * useSyncExternalStore. Two ledgers are maintained side by side from the
 * same frames (spec B3/B8):
 *
 * - history items — what <Static> prints to the terminal scrollback:
 *   completed text blocks, folded thinking, tool call+result pairs, system
 *   lines, notices, user input echoes. Append-only; Static only prints new
 *   entries, so old scrollback is never redrawn.
 * - transcript entries — the Ctrl+O view's data: the same content with FULL
 *   text (thinking verbatim, tool output verbatim) plus the user echoes.
 *   A fetch of GET /sessions/:id/messages replaces it when the overlay opens
 *   (server truth wins); live frames keep appending once the fetch landed.
 */
import { PROVENANCE_NOTE_KINDS } from "@kclaw/core"
import type { ConfirmationDecision, ConfirmationRequestedPayload, Message, PermissionMode, QuestionRequestedPayload } from "@kclaw/core"
import type { DisplayView, NoticeTone, ChoiceOption } from "../chat-surface.js"
import { summarizeOutputInfo } from "../frame-view.js"
import { CONFIRM_VERDICT_LABELS } from "../surface-cards.js"
import { toolArgLine } from "./tool-format.js"

/** One completed entry the <Static> region prints (never re-rendered). */
export type HistoryItem =
  | { id: number; kind: "echo"; text: string }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "thinking"; seconds: number }
  | { id: number; kind: "tool"; name: string; argsSummary: string; status: string; durationMs: number; outputSummary: string; outputTruncated: boolean }
  | { id: number; kind: "system"; text: string }
  | { id: number; kind: "notice"; text: string; tone: NoticeTone }

/** One full-text entry of the Ctrl+O transcript view. */
export type TranscriptEntry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant-text"; text: string }
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "tool"; name: string; argsJson: string; status: string | undefined; durationMs: number | undefined; output: string | undefined }
  | { id: number; kind: "system"; text: string }

/** In-flight rows of the dynamic area. */
export interface DynamicState {
  /** The assistant's still-streaming text block (display buffer). */
  streamingText: string
  /** Live thinking text; shown only when --show-thinking unfolded it. */
  thinkingText: string | undefined
  thinkingStartedAt: number | undefined
  runningTools: Array<{ callId: string; name: string; argsSummary: string; startedAt: number }>
  /** A render is in flight (drives the spinner row and the terminal title). */
  busy: boolean
  busySince: number | undefined
  /** Messages sitting in the daemon's run queue (queued → left-queue lifecycle). */
  queuedIds: string[]
}

/** The bottom status line's data (spec B3). */
export interface StatusState {
  mode: PermissionMode
  model: string
  title: string
  sessionId: string
  /** Last completed run's usage (run.completed); absent until one lands. */
  inputTokens: number | undefined
  outputTokens: number | undefined
}

interface PendingState {
  confirms: Array<{ payload: ConfirmationRequestedPayload; resolve: (decision: ConfirmationDecision) => void }>
  questions: Array<{ payload: QuestionRequestedPayload; resolve: (answers: string[][]) => void }>
  choices: Array<{ message: string; options: readonly ChoiceOption[]; resolve: (value: string | undefined) => void }>
}

export interface ChatState {
  history: HistoryItem[]
  dynamic: DynamicState
  status: StatusState
  pending: PendingState
  overlays: { transcript: boolean; help: boolean }
  /** The session's user-typed lines for ↑↓ and Ctrl+R (no machine-sent messages). */
  inputHistory: string[]
  /** Workspace file list for the @ menu (lazy per session; undefined = not fetched yet). */
  files: { sessionId: string; files: string[] } | undefined
  /**
   * Whether live frames may append to `transcript` — false between overlay
   * open and the messages fetch landing, so the fetched snapshot never
   * interleaves with frames it already contains.
   */
  transcriptLive: boolean
  transcript: TranscriptEntry[]
  /** True once /exit was accepted — the editor must not accept further input while the exit drains. */
  exiting: boolean
}

interface ChatStoreOptions {
  /** Streams thinking text live in the dynamic area (the --show-thinking flag). */
  showThinking: boolean
  /** Fired once the input loop decided to leave (/exit) — run() resolves. */
  onExit: () => void
}

export class ChatStore {
  readonly options: ChatStoreOptions
  private state: ChatState
  private listeners = new Set<() => void>()
  private nextId = 1
  /** callId → the call side of a tool pair (kept after pairing: late results still resolve their call). */
  private calls = new Map<string, { name: string; argsSummary: string; argsJson: string }>()
  /** callId → transcript index of the open tool entry, until its result closes it. */
  private openTools = new Map<string, number>()
  private openText: number | undefined
  private openThinking: number | undefined

  constructor(options: ChatStoreOptions) {
    this.options = options
    this.state = {
      history: [],
      dynamic: { streamingText: "", thinkingText: undefined, thinkingStartedAt: undefined, runningTools: [], busy: false, busySince: undefined, queuedIds: [] },
      status: { mode: "default", model: "default", title: "", sessionId: "", inputTokens: undefined, outputTokens: undefined },
      pending: { confirms: [], questions: [], choices: [] },
      overlays: { transcript: false, help: false },
      inputHistory: [],
      files: undefined,
      transcriptLive: false,
      transcript: [],
      exiting: false,
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): ChatState => this.state

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  // —— ChatSurface：帧视图入账 ——

  show(view: DisplayView): void {
    switch (view.kind) {
      case "text": {
        const dynamic = { ...this.state.dynamic, streamingText: this.state.dynamic.streamingText + view.delta }
        if (this.state.transcriptLive) {
          const transcript = [...this.state.transcript]
          const openIdx = this.openText
          const open = openIdx !== undefined ? transcript[openIdx] : undefined
          if (openIdx === undefined || open === undefined || open.kind !== "assistant-text") {
            this.openText = transcript.length
            transcript.push({ id: this.nextId++, kind: "assistant-text", text: view.delta })
          } else {
            transcript[openIdx] = { ...open, text: open.text + view.delta }
          }
          this.set({ dynamic, transcript })
        } else {
          this.set({ dynamic })
        }
        return
      }
      case "text-end": {
        const buffer = this.state.dynamic.streamingText
        const patch: Partial<ChatState> = { dynamic: { ...this.state.dynamic, streamingText: "" } }
        const history = [...this.state.history]
        if (buffer !== "") {
          history.push({ id: this.nextId++, kind: "text", text: buffer })
          patch.history = history
        }
        this.openText = undefined
        this.set(patch)
        return
      }
      case "thinking": {
        const dynamic = { ...this.state.dynamic }
        if (dynamic.thinkingStartedAt === undefined) dynamic.thinkingStartedAt = Date.now()
        if (this.options.showThinking) dynamic.thinkingText = (dynamic.thinkingText ?? "") + view.delta
        if (this.state.transcriptLive) {
          const transcript = [...this.state.transcript]
          const openIdx = this.openThinking
          const open = openIdx !== undefined ? transcript[openIdx] : undefined
          if (openIdx === undefined || open === undefined || open.kind !== "thinking") {
            this.openThinking = transcript.length
            transcript.push({ id: this.nextId++, kind: "thinking", text: view.delta })
          } else {
            transcript[openIdx] = { ...open, text: open.text + view.delta }
          }
          this.set({ dynamic, transcript })
        } else {
          this.set({ dynamic })
        }
        return
      }
      case "thinking-end": {
        const startedAt = this.state.dynamic.thinkingStartedAt
        const seconds = startedAt === undefined ? 0 : Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        this.openThinking = undefined
        this.set({
          dynamic: { ...this.state.dynamic, thinkingText: undefined, thinkingStartedAt: undefined },
          history: [...this.state.history, { id: this.nextId++, kind: "thinking", seconds }],
        })
        return
      }
      case "tool-call": {
        const argsSummary = toolArgLine(view.name, view.args)
        this.calls.set(view.callId, { name: view.name, argsSummary, argsJson: JSON.stringify(view.args ?? {}) })
        const dynamic = {
          ...this.state.dynamic,
          runningTools: [...this.state.dynamic.runningTools, { callId: view.callId, name: view.name, argsSummary, startedAt: Date.now() }],
        }
        if (this.state.transcriptLive) {
          const transcript = [...this.state.transcript]
          this.openTools.set(view.callId, transcript.length)
          transcript.push({ id: this.nextId++, kind: "tool", name: view.name, argsJson: JSON.stringify(view.args ?? {}), status: undefined, durationMs: undefined, output: undefined })
          this.set({ dynamic, transcript })
        } else {
          this.set({ dynamic })
        }
        return
      }
      case "tool-result": {
        const call = this.calls.get(view.callId)
        const dynamic = { ...this.state.dynamic, runningTools: this.state.dynamic.runningTools.filter((t) => t.callId !== view.callId) }
        const summary = summarizeOutputInfo(view.output)
        const history = [...this.state.history, {
          id: this.nextId++,
          kind: "tool" as const,
          name: call?.name ?? "未知工具",
          argsSummary: call?.argsSummary ?? "",
          status: view.status,
          durationMs: view.durationMs,
          outputSummary: summary.text,
          outputTruncated: summary.truncated,
        }]
        const patch: Partial<ChatState> = { dynamic, history }
        const openIdx = this.openTools.get(view.callId)
        if (openIdx !== undefined && this.state.transcriptLive) {
          const transcript = [...this.state.transcript]
          const open = transcript[openIdx]
          if (open !== undefined && open.kind === "tool") {
            transcript[openIdx] = { ...open, status: view.status, durationMs: view.durationMs, output: view.output }
            patch.transcript = transcript
          }
          this.openTools.delete(view.callId)
        }
        this.set(patch)
        return
      }
      case "system":
        this.set({
          history: [...this.state.history, { id: this.nextId++, kind: "system", text: view.text }],
          ...(this.state.transcriptLive ? { transcript: [...this.state.transcript, { id: this.nextId++, kind: "system", text: view.text }] } : {}),
        })
        return
      case "run-failed":
        this.notice(`✖ 运行失败: ${view.message}`, "error")
        if (this.state.transcriptLive) {
          this.set({ transcript: [...this.state.transcript, { id: this.nextId++, kind: "system", text: view.message }] })
        }
        return
      case "run-completed":
        this.set({ status: { ...this.state.status, inputTokens: view.usage.inputTokens, outputTokens: view.usage.outputTokens } })
        return
      case "command-error":
        this.notice(`错误: ${view.message}`, "error")
        return
      // 队列三帧：维护动态区的灰色常驻条目（spec B3，与 web 端排队可视面
      // 同一语义）——入队计数、离队（注入/取消）消行；编排器的 notice 仍
      // 负责一次性提示。
      case "queued":
        if (!this.state.dynamic.queuedIds.includes(view.messageId)) {
          this.set({ dynamic: { ...this.state.dynamic, queuedIds: [...this.state.dynamic.queuedIds, view.messageId] } })
        }
        return
      case "left-queue": {
        const leaving = new Set(view.messageIds)
        this.set({ dynamic: { ...this.state.dynamic, queuedIds: this.state.dynamic.queuedIds.filter((id) => !leaving.has(id)) } })
        return
      }
    }
  }

  notice(text: string, tone: NoticeTone): void {
    this.set({ history: [...this.state.history, { id: this.nextId++, kind: "notice", text, tone }] })
  }

  /** The input line the user just submitted: echoed to history; plain messages also land in the transcript. */
  pushEcho(line: string): void {
    const transcript = this.state.transcriptLive && !line.startsWith("/")
      ? [...this.state.transcript, { id: this.nextId++, kind: "user" as const, text: line }]
      : this.state.transcript
    this.set({
      history: [...this.state.history, { id: this.nextId++, kind: "echo", text: line }],
      transcript,
    })
  }

  confirm(p: ConfirmationRequestedPayload): Promise<ConfirmationDecision> {
    return new Promise((resolve) => {
      this.set({ pending: { ...this.state.pending, confirms: [...this.state.pending.confirms, { payload: p, resolve }] } })
    })
  }

  /** The visible card picked a verdict: pop it, resolve the orchestrator, leave a verdict line. */
  resolveConfirm(decision: ConfirmationDecision): void {
    const head = this.state.pending.confirms[0]
    if (head === undefined) return
    const label = CONFIRM_VERDICT_LABELS[decision]
    this.set({
      pending: { ...this.state.pending, confirms: this.state.pending.confirms.slice(1) },
      history: [...this.state.history, { id: this.nextId++, kind: "notice", text: label, tone: decision === "reject" ? "dim" : "plain" }],
    })
    head.resolve(decision)
  }

  ask(p: QuestionRequestedPayload): Promise<string[][]> {
    return new Promise((resolve) => {
      this.set({ pending: { ...this.state.pending, questions: [...this.state.pending.questions, { payload: p, resolve }] } })
    })
  }

  /** One question answered (answers[i] = the selections for question i, [] = skipped). */
  resolveQuestion(answers: string[][]): void {
    const head = this.state.pending.questions[0]
    if (head === undefined) return
    this.set({ pending: { ...this.state.pending, questions: this.state.pending.questions.slice(1) } })
    head.resolve(answers)
  }

  choose(message: string, options: readonly ChoiceOption[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.set({ pending: { ...this.state.pending, choices: [...this.state.pending.choices, { message, options, resolve }] } })
    })
  }

  resolveChoice(value: string | undefined): void {
    const head = this.state.pending.choices[0]
    if (head === undefined) return
    this.set({ pending: { ...this.state.pending, choices: this.state.pending.choices.slice(1) } })
    head.resolve(value)
  }

  modeChanged(mode: PermissionMode): void {
    this.set({ status: { ...this.state.status, mode } })
  }

  busyChanged(busy: boolean): void {
    this.set({ dynamic: { ...this.state.dynamic, busy, busySince: busy ? Date.now() : undefined } })
  }

  /** Session switched: the live ledgers reset; scrollback already printed stays. */
  sessionChanged(sessionId: string): void {
    this.openText = undefined
    this.openThinking = undefined
    this.openTools.clear()
    this.set({
      status: { ...this.state.status, sessionId, inputTokens: undefined, outputTokens: undefined },
      dynamic: { streamingText: "", thinkingText: undefined, thinkingStartedAt: undefined, runningTools: [], busy: false, busySince: undefined, queuedIds: [] },
      transcript: [],
      transcriptLive: false,
      inputHistory: [],
      files: undefined,
    })
  }

  setStatusMeta(meta: { model?: string; title?: string }): void {
    this.set({
      status: {
        ...this.state.status,
        model: meta.model !== undefined && meta.model !== "" ? meta.model : this.state.status.model,
        title: meta.title ?? this.state.status.title,
      },
    })
  }

  // —— 输入历史（spec B3）：用户发过的消息，带来源说明块的机器消息排除 ——

  setInputHistory(messages: Message[]): void {
    const lines: string[] = []
    for (const message of messages) {
      if (message.role !== "user") continue
      const hasProvenance = message.blocks.some((b) => b.type === "note" && (PROVENANCE_NOTE_KINDS as readonly string[]).includes(b.kind))
      if (hasProvenance) continue
      const text = message.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("")
      if (text.trim() !== "") lines.push(text)
    }
    this.set({ inputHistory: lines })
  }

  appendInputHistory(line: string): void {
    this.set({ inputHistory: [...this.state.inputHistory, line] })
  }

  setFiles(sessionId: string, files: string[]): void {
    this.set({ files: { sessionId, files } })
  }

  // —— 转录视图 ——

  setOverlays(patch: Partial<ChatState["overlays"]>): void {
    this.set({ overlays: { ...this.state.overlays, ...patch } })
  }

  /**
   * Overlay open: stop live appends until the fetched snapshot has replaced
   * the ledger. The open-entry indexes die with the old ledger — a delta
   * after the replace opens a fresh entry instead of appending to a fetched
   * one.
   */
  beginTranscriptSync(): void {
    this.openText = undefined
    this.openThinking = undefined
    this.openTools.clear()
    this.set({ overlays: { ...this.state.overlays, transcript: true }, transcriptLive: false })
  }

  replaceTranscript(entries: TranscriptEntry[]): void {
    this.set({ transcript: entries, transcriptLive: true })
  }

  requestExit(): void {
    this.set({ exiting: true })
    this.options.onExit()
  }
}
