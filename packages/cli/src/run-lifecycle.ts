/**
 * `kclaw run` lifecycle as a pure step function: inputs (daemon frames,
 * signals, the socket closing) go in, effects (commands to send, frames that
 * belong to this run, stderr lines, the exit) come out. run-cmd.ts performs
 * the effects; the tests drive frame sequences through it.
 *
 * Which frames belong to this run (spec A10): send_message_ack names my
 * message; message.created{id===mine} carries my run's runId, and only a
 * run.completed / run.failed with that runId ends it. The loop announces
 * run.started right before that message.created, so the latest run.started
 * is held back and output once message.created shows its runId is mine. An
 * entry-level failure has no run and no runId: it is claimed through
 * payload.messageId. A queued message withdrawn by another client (WebUI,
 * IM /stop, session deleted) ends the run too. Everything that arrives before
 * my message starts executing belongs to the runs ahead of it: not output,
 * cards not answered. From then on every frame on the socket is output and
 * every card answered by policy — cards forwarded from my subagents carry the
 * child run's runId, so filtering by my runId would leave them to time out.
 *
 * Stopping only my own run (A6): while my message is queued, queue.cancel with
 * its messageId; once it executes — or when the withdrawal loses the race
 * against dequeue (error "not found") — run.cancel with the same messageId,
 * which the daemon applies only when the active run executes that message. A
 * signal before the ack is held until the ack names my message. The daemon
 * answers commands in order on the connection, so `pending` attributes each
 * reply (an error frame carries no command id) to the oldest outstanding
 * command.
 */
import type { AttachmentRef, ClientCommand, StopReason } from "@kclaw/core"
import type { WsFrame } from "./client.js"
import { isAgentEvent } from "./frame-view.js"

/** How confirmation cards are answered: --yes, --no, or neither (reject, with a warning). */
export type CardPolicy = "yes" | "no" | "default"

/** The interruptions run reacts to; EPIPE stands for "stdout's reader went away". */
export type RunSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "EPIPE"

export const SIGNAL_EXIT_CODES: Readonly<Record<RunSignal, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, EPIPE: 141 }

/** The one answer every question gets when nobody is there to answer. */
export const UNATTENDED_ANSWER = "（无人值守运行，没有人可以回答，请自行判断后继续）"

const STOP_OK: ReadonlySet<StopReason> = new Set<StopReason>(["end_turn", "stop_sequence", "tool_use"])

const STOP_FAIL_REASON: Partial<Record<StopReason, string>> = {
  aborted: "被其他客户端停止",
  max_tokens: "最后一条回复被输出上限截断",
  content_filter: "被模型服务商拦截",
}

const SIGNAL_REASON: Readonly<Record<RunSignal, string>> = {
  SIGINT: "收到 SIGINT",
  SIGTERM: "收到 SIGTERM",
  SIGHUP: "收到 SIGHUP",
  EPIPE: "stdout 的下游管道已关闭",
}

export type RunInput =
  | { type: "frame"; frame: WsFrame }
  | { type: "signal"; name: RunSignal }
  | { type: "closed" }

/** Why the run did not exit 0: the json output's `error` object. */
export interface RunFailure {
  code: string
  message: string
}

export type RunEffect =
  | { type: "send"; frame: ClientCommand }
  /** A frame that belongs to this run, for the output format to render. */
  | { type: "output"; frame: WsFrame }
  | { type: "warn"; text: string }
  /** `forced`: the second signal — exit at once without finishing the output. */
  | { type: "exit"; code: number; failure?: RunFailure; forced?: true }

export interface RunState {
  readonly sessionId: string
  readonly policy: CardPolicy
  /** sending → queued | running → done; queued → running when my message starts. */
  readonly phase: "sending" | "queued" | "running" | "done"
  /** My messageId, from send_message_ack. */
  readonly mine?: string
  /** My run's runId, from message.created{id===mine}. */
  readonly myRunId?: string
  /** The latest run.started seen before my message started: output if its runId turns out to be mine. */
  readonly heldStart?: WsFrame
  /** Commands awaiting their reply, oldest first. */
  readonly pending: readonly ClientCommand["type"][]
  /** The first signal received; it decides the exit code whatever the run's outcome. */
  readonly signal?: RunSignal
  readonly warnedReject: boolean
  readonly warnedQuestion: boolean
  /** After EPIPE nothing more is written to stdout. */
  readonly stdoutClosed: boolean
}

export interface RunStep {
  state: RunState
  effects: RunEffect[]
}

/** The opening move: send my message with disposition wait, so it never interrupts or joins someone else's run. */
export function startRun(opts: { sessionId: string; text: string; attachments: AttachmentRef[]; policy: CardPolicy }): RunStep {
  return {
    state: {
      sessionId: opts.sessionId,
      policy: opts.policy,
      phase: "sending",
      pending: ["send_message"],
      warnedReject: false,
      warnedQuestion: false,
      stdoutClosed: false,
    },
    effects: [{
      type: "send",
      frame: {
        type: "send_message",
        sessionId: opts.sessionId,
        text: opts.text,
        disposition: "wait",
        ...(opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
      },
    }],
  }
}

export function stepRun(prev: RunState, input: RunInput): RunStep {
  if (prev.phase === "done") return { state: prev, effects: [] }
  let s: RunState = prev
  const fx: RunEffect[] = []
  const update = (patch: Partial<RunState>): void => {
    s = { ...s, ...patch }
  }
  const out = (frame: WsFrame): void => {
    if (!s.stdoutClosed) fx.push({ type: "output", frame })
  }
  const send = (frame: ClientCommand): void => {
    update({ pending: [...s.pending, frame.type] })
    fx.push({ type: "send", frame })
  }
  const takeReply = (): ClientCommand["type"] | undefined => {
    const [head, ...rest] = s.pending
    update({ pending: rest })
    return head
  }

  const finish = (failure: RunFailure | undefined): void => {
    update({ phase: "done" })
    if (s.signal !== undefined) {
      const code = SIGNAL_EXIT_CODES[s.signal]
      const message = `已停止本次运行：${SIGNAL_REASON[s.signal]}`
      fx.push({ type: "warn", text: message }, { type: "exit", code, failure: { code: "interrupted", message } })
      return
    }
    if (failure === undefined) {
      fx.push({ type: "exit", code: 0 })
      return
    }
    fx.push({ type: "warn", text: failure.message }, { type: "exit", code: 1, failure })
  }

  const cancelOwn = (): void => {
    if (s.phase === "queued") send({ type: "queue.cancel", sessionId: s.sessionId, messageId: s.mine! })
    else if (s.phase === "running") send({ type: "run.cancel", sessionId: s.sessionId, messageId: s.mine! })
  }

  if (input.type === "closed") {
    finish({ code: "disconnected", message: "与 daemon 的连接断开了" })
    return { state: s, effects: fx }
  }

  if (input.type === "signal") {
    // EPIPE fires once per failed write: only the first one counts.
    if (input.name === "EPIPE" && s.stdoutClosed) return { state: s, effects: fx }
    if (input.name === "EPIPE") update({ stdoutClosed: true })
    if (s.signal !== undefined) {
      update({ phase: "done" })
      fx.push({ type: "exit", code: SIGNAL_EXIT_CODES[input.name], forced: true })
      return { state: s, effects: fx }
    }
    update({ signal: input.name })
    cancelOwn() // still sending: the ack below cancels once it names my message
    return { state: s, effects: fx }
  }

  const f = input.frame
  if (!isAgentEvent(f)) {
    switch (f.type) {
      case "send_message_ack":
        takeReply()
        update({ mine: String(f.messageId), phase: f.queued === true ? "queued" : "running" }) // queued:false = already executing
        out(f)
        if (s.signal !== undefined) cancelOwn()
        break
      case "error": {
        const head = takeReply()
        const message = String(f.message ?? "")
        if (head === "send_message") {
          out(f)
          finish({ code: "rejected", message: `daemon 拒绝了这条消息：${message}` })
        } else if (head === "queue.cancel") {
          // "not found": dequeued while the withdrawal was in flight — it executes now
          update({ phase: "running" })
          send({ type: "run.cancel", sessionId: s.sessionId, messageId: s.mine! })
        } else if (head === undefined) {
          finish({ code: "protocol_error", message: `收到无法对应到任何命令的错误帧：${message}` })
        }
        // run.cancel "no active run": my terminal frame is already on its way;
        // a card reply error: the card was settled elsewhere. Both keep waiting.
        break
      }
      case "queue.cancel_ack":
        takeReply()
        finish({ code: "withdrawn", message: "排队中的消息已撤回，没有执行" })
        break
      case "run_cancel_ack":
      case "confirmation.resolved_ack":
      case "question.resolved_ack":
        takeReply()
        break
    }
    return { state: s, effects: fx }
  }

  if (s.mine === undefined) return { state: s, effects: fx } // before the ack every event belongs to someone else
  const mine = s.mine
  switch (f.type) {
    case "message.queue_cancelled": {
      const p = f.payload
      if (p.messageId === mine || p.messageIds?.includes(mine) === true) {
        out(f)
        finish({ code: "withdrawn", message: "排队中的消息被其他客户端撤回，没有执行" })
        return { state: s, effects: fx }
      }
      break
    }
    case "message.created":
      if (f.payload.message.id === mine) {
        if (f.runId === undefined) throw new Error("自己的消息开始执行时没有带 runId，无法认领本次 run 的终帧")
        if (s.heldStart !== undefined && s.heldStart.runId === f.runId) out(s.heldStart)
        update({ myRunId: f.runId, phase: "running", heldStart: undefined })
        out(f)
        return { state: s, effects: fx }
      }
      break
    case "run.failed":
      // Entry-level failure: no run, so no runId — claimed through payload.messageId.
      if (f.runId === undefined && f.payload.messageId === mine) {
        out(f)
        finish(f.payload.error)
        return { state: s, effects: fx }
      }
      break
  }
  if (s.myRunId === undefined) {
    if (f.type === "run.started") update({ heldStart: f })
    return { state: s, effects: fx }
  }

  switch (f.type) {
    case "run.completed":
      if (f.runId !== s.myRunId) break
      out(f)
      finish(STOP_OK.has(f.payload.stopReason)
        ? undefined
        : { code: f.payload.stopReason, message: `运行未正常结束：${STOP_FAIL_REASON[f.payload.stopReason] ?? f.payload.stopReason}` })
      return { state: s, effects: fx }
    case "run.failed":
      if (f.runId !== s.myRunId) break
      out(f)
      finish(f.payload.error)
      return { state: s, effects: fx }
    case "confirmation.requested":
      out(f)
      if (s.policy === "default" && !s.warnedReject) {
        update({ warnedReject: true })
        fx.push({ type: "warn", text: "未指定 --yes：本次运行确认一律拒绝" })
      }
      send({ type: "confirmation.resolve", confirmationId: f.payload.confirmationId, decision: s.policy === "yes" ? "once" : "reject" })
      return { state: s, effects: fx }
    case "question.requested":
      out(f)
      if (!s.warnedQuestion) {
        update({ warnedQuestion: true })
        fx.push({ type: "warn", text: "无人值守运行：问题卡已自动回复「没有人可以回答」" })
      }
      send({ type: "question.resolve", questionId: f.payload.questionId, answers: f.payload.questions.map(() => [UNATTENDED_ANSWER]) })
      return { state: s, effects: fx }
  }
  out(f)
  return { state: s, effects: fx }
}
