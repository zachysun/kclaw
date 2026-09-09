/**
 * Interactive chat REPL — the terminal product surface: connect
 * (auto-starting) the daemon, create or resume a session, subscribe over WS
 * and render one run's events as plain text on stdout, per line of input.
 *
 * Line input uses node:readline (NOT @clack text): deltas stream through
 * process.stdout.write while the interface idles between lines, a piped
 * stdin (tests, scripting) works line-by-line, and history/choreography stay
 * predictable. @clack/prompts is used ONLY for the confirmation prompt — the
 * readline interface is paused while the prompt owns the terminal.
 *
 * SIGINT approach: readline emits "SIGINT" on Ctrl+C when the pending line is
 * empty (a non-empty line just clears — node's default), and the process
 * receives the OS signal when stdin is not a TTY — the same handler is
 * registered on both so piped runs (tests, scripting) escalate identically.
 * Three stages, `sigints` only ever growing: the first press
 * cancels the active run (`run.cancel`; the run then ends through the normal
 * render path with run.completed {stopReason:"aborted"}) or, while idle,
 * prints the exit hint — with a queued-count warning ("还有 N 条…") whenever
 * the session holds queued messages. The second press clears the queue
 * (`queue.cancel` without messageId) when one exists, otherwise exits. The
 * third press always exits immediately (code 130, socket closed first so the
 * daemon sees a clean disconnect).
 *
 * Reconnect (basic version): when the socket drops
 * unexpectedly, re-resolve the daemon (KclawClient.connect respawns one when
 * it died), resubscribe, pull the full message list (拉全量消息，只订阅新事件，
 * 不回放 — nothing is replay-rendered) and print "[reconnected]"; frames
 * observed after a reconnect carry a 120s inactivity timeout so a dead run
 * cannot hang the REPL forever. The frame pump dies with the old socket's
 * iterator (flushing its waiters with "closed" so the render loop drives the
 * reconnect) and restarts on the new socket.
 *
 * Frame pump and render takeover: ONE resident consumer reads the socket's
 * frames (`startPump`) and hands each frame to exactly one registered one-shot
 * waiter — renderRun never owns the frames iterator, so nothing stalls while
 * the input loop keeps dispatching typed lines mid-run (that is what makes
 * /interrupt usable at all). Every send starts its render through
 * `startRender`, which bumps `renderEpoch`: the new render TAKES OVER the
 * frame stream — older renderRuns are woken with "superseded" and return
 * without rendering further — and each renderRun tracks its OWN message
 * (send_message_ack records `mine`; message.created{id===mine} or
 * message.steered{messageId===mine} sets targetSeen) so its terminal is the
 * first run.completed AFTER targetSeen. A previous run's run.completed never
 * ends someone else's render, and a queued send renders the run it waited
 * behind instead of losing it.
 *
 * Resend rule: an in-flight message is re-sent after a reconnect ONLY when
 * not a single frame was observed for it — no `send_message_ack`, no run
 * event — which means it never reached a live daemon (ws drops frames on a
 * CLOSED socket silently, and throws only while CONNECTING; both are
 * indistinguishable from "never delivered", e.g. the socket died while the
 * REPL sat idle). Once ANY frame was observed the message is presumed
 * delivered and a mid-run reconnect never re-sends: the run may already be
 * queued server-side, and a duplicate would double-run it — the 120s
 * watchdog bounds that wait instead.
 */
import { isCancel, select } from "@clack/prompts"
import { isPermissionMode, PERMISSION_MODES } from "@kclaw/core"
import type { AnyAgentEvent, ConfirmationDecision, ConfirmationRequestedPayload, MessageQueuedPayload, PermissionMode } from "@kclaw/core"
import { join } from "node:path"
import { createInterface, type Interface as RlInterface } from "node:readline"
import { KclawClient } from "./client.js"
import type { WsFrame, WsHandle } from "./client.js"
import { createRegistry, createSlashCompleter, dispatch, refreshSkillCommands as refreshSkillCommandsOp, runOrHint, slashCompleter, type AttachmentRef, type SlashCtx } from "./slash.js"
import type { SlashCommandMeta } from "@kclaw/core/commands"
import { expandFileRefs } from "./file-refs.js"

/** Session rows as served by GET /sessions (SessionStore meta shape). */
interface SessionInfo {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** Reconnect watchdog: a fully quiet run after a reconnect is presumed gone. */
const POST_RECONNECT_SILENCE_MS = 120_000

/** Budget for the `subscribed` ack after opening + subscribing a socket. */
const SUBSCRIBE_ACK_MS = 5_000

const TTY = process.stdout.isTTY === true
const dim = (s: string): string => (TTY ? `\x1b[2m${s}\x1b[22m` : s)
const red = (s: string): string => (TTY ? `\x1b[31m${s}\x1b[39m` : s)

/** Prompt string per mode: default keeps the bare "> "; other modes badge it. */
function modePrompt(m: PermissionMode): string {
  return m === "default" ? "> " : `[${m}] > `
}

/** Next mode in the Shift+Tab cycle (PERMISSION_MODES order, strictest first). */
function nextMode(m: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(m) + 1) % PERMISSION_MODES.length]!
}

export interface ChatOptions {
  home?: string
  /** Resume this session instead of creating one; unknown ids are an error. */
  session?: string
  /** Show thinking deltas (dim, "· " prefix); hidden by default. */
  showThinking?: boolean
  /** Hidden --yes: auto-approve every confirmation (tests & scripting). */
  yes?: boolean
  /** Hidden --no: auto-deny every confirmation (tests & scripting). */
  no?: boolean
}

/** Everything the render loop mutates or consults, kept in one place so a reconnect can swap the socket underneath. */
interface ChatCtx {
  home: string | undefined
  client: KclawClient
  ws: WsHandle
  sessionId: string
  rl: RlInterface
  showThinking: boolean
  /** Confirmation answering mode: flag-driven auto verdicts, or the @clack prompt. */
  auto: "yes" | "no" | "ask"
  /** Tracks whether stdout sits at column 0, so line-oriented renders can newline first. */
  io: { atLineStart: boolean }
  /** Attachments uploaded via /attach, carried on the next send_message. */
  pendingAttachments: AttachmentRef[]
  /**
   * The session's send-disposition mode: every Enter-send carries it so the
   * daemon injects (steer) or queues (wait) mid-run messages accordingly.
   * Resolved at startup (meta.dispositionOverride > config default > steer)
   * and flipped by /steer //wait; `interrupt` only ever arrives as a session
   * meta override (it is a one-shot action, not a mode the CLI sets).
   */
  disposition: "steer" | "wait" | "interrupt"
  /**
   * The session's permission mode (readonly / default / acceptEdits): shown
   * as a prompt badge (non-default only), cycled by Shift+Tab and flipped by
   * /mode. Local mirror of the daemon's session meta — the daemon re-derives
   * it per run, so this only drives the UI.
   */
  mode: PermissionMode
  /** True while a @clack prompt owns the terminal (Shift+Tab stands down). */
  inputPaused: boolean
  /**
   * The frame pump's one-shot waiters: each renderRun registers one waiter for
   * its next frame and the pump hands every arriving frame to exactly one of
   * them (FIFO). Cleared when the pump's iterator ends (socket closed) and on
   * reconnect.
   */
  frameWaiters: FrameWaiter[]
  /**
   * Frames that arrived with no waiter registered: the consumer sits
   * waiter-less for a few microtask ticks between two takes, and a busy
   * daemon's event burst lands exactly there — the pump holds such frames
 * (in arrival order) and armNextFrame drains them before registering.
   */
  pendingFrames: WsFrame[]
  /**
   * Render generation: startRender increments it per started render. A newer
   * renderRun takes over the frame stream; older ones see the bump and quit
   * without clobbering runActive (Ctrl+C stays aimed at the newest run).
   */
  renderEpoch: number
  /** The frame pump consumes ctx.ws.frames only while this is true. */
  pumpAlive: boolean
  /** In-flight reconnect, shared so concurrent renderRuns run one attempt. */
  reconnecting: Promise<boolean> | undefined
}

/**
 * One-shot frame waiter: the pump resolves it with the next frame, or with a
 * control sentinel — "closed" when the socket's iterator ended (the pump
 * flushes every waiter on its way out), "superseded" when a newer renderRun
 * took over the frame stream.
 */
type FrameWaiter = (frame: WsFrame | "closed" | "superseded") => void

/** A waiter registered into ctx.frameWaiters but not yet awaited to settlement. */
interface ArmedFrame {
  promise: Promise<WsFrame | "closed" | "superseded">
  waiter: FrameWaiter
}

/** A bus event frame has `payload`; command acks and error frames do not. */
function isAgentEvent(frame: WsFrame): frame is WsFrame & AnyAgentEvent {
  return typeof frame.type === "string" && "payload" in frame
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

function write(text: string, ctx: ChatCtx): void {
  process.stdout.write(text)
  ctx.io.atLineStart = text.endsWith("\n")
}

function ensureLineStart(ctx: ChatCtx): void {
  if (!ctx.io.atLineStart) write("\n", ctx)
}

function line(text: string, ctx: ChatCtx): void {
  ensureLineStart(ctx)
  write(`${text}\n`, ctx)
}

/**
 * Open an authenticated ws and subscribe to `sessionId`, waiting for the
 * `subscribed` ack (or failing on an error frame / timeout) so the caller
 * never send_messages onto a socket the bus is not yet fanning out to.
 */
async function openSubscribed(client: KclawClient, sessionId: string): Promise<WsHandle> {
  const ws = await client.ws()
  ws.send({ type: "subscribe", sessionId })
  const next = await Promise.race([
    ws.frames[Symbol.asyncIterator]().next(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("no subscribed ack within 5s")), SUBSCRIBE_ACK_MS),
    ),
  ])
  if (next.done || next.value.type !== "subscribed") {
    ws.close()
    const message = next.done ? "socket closed before subscribing" : String(next.value.message ?? "subscribe rejected")
    throw new Error(message)
  }
  return ws
}

/** Create a session, or verify a resume target exists ("session not found" otherwise). */
export async function resolveSessionId(client: KclawClient, session: string | undefined): Promise<string> {
  if (session === undefined) {
    const created = (await client.request("POST", "/sessions", { workdir: process.cwd() })) as SessionInfo
    return created.id
  }
  const list: unknown = await client.request("GET", "/sessions")
  const known = Array.isArray(list) && list.some((s) => (s as SessionInfo).id === session)
  if (!known) throw new Error("session not found")
  return session
}

/** Print the risk summary, collect the verdict (flags or @clack), send confirmation.resolve. */
async function handleConfirmation(p: ConfirmationRequestedPayload, ctx: ChatCtx): Promise<void> {
  line(`⚠ ${p.toolCall.name} ${p.toolCall.argsJson} · 风险 ${p.risk} · 过期 ${p.expiresAt}`, ctx)
  if (p.noteText !== undefined) line(dim(p.noteText), ctx)
  let decision: ConfirmationDecision
  if (ctx.auto === "yes") {
    line(dim("[--yes] 已自动允许（仅本次）"), ctx)
    decision = "once"
  } else if (ctx.auto === "no") {
    line(dim("[--no] 已自动拒绝"), ctx)
    decision = "reject"
  } else {
    ctx.inputPaused = true
    ctx.rl.pause() // @clack owns the terminal while our readline sits quiet
    let answer: ConfirmationDecision | symbol
    try {
      answer = await select<ConfirmationDecision>({
        message: "如何处置?",
        options: [
          { value: "once", label: "允许（仅本次）" },
          { value: "project", label: "总是允许（本项目）" },
          { value: "global", label: "总是允许（全局）" },
          { value: "reject", label: "拒绝" },
        ],
      })
    } catch {
      answer = "reject"
    } finally {
      ctx.inputPaused = false
      ctx.rl.resume()
    }
    if (isCancel(answer)) {
      line(dim("已取消，默认拒绝"), ctx)
      decision = "reject"
    } else {
      decision = answer
    }
  }
  try {
    ctx.ws.send({ type: "confirmation.resolve", confirmationId: p.confirmationId, decision })
  } catch {
    // socket dropping — the reconnect path takes over
  }
}

/**
 * Render one frame; resolves true when the run reached a terminal state
 * (run.completed / run.failed) or a command error frame arrived — anything
 * that means the caller should stop waiting for events. Exported for unit
 * tests (the runOrHint precedent).
 */
export async function renderFrame(frame: WsFrame, ctx: ChatCtx): Promise<boolean> {
  if (!isAgentEvent(frame)) {
    if (frame.type === "error") {
      line(red(`错误: ${String(frame.message ?? "unknown error")}`), ctx)
      return true // e.g. send_message rejected — no run will start
    }
    return false // acks (send_message_ack / run_cancel_ack / …)
  }
  const ev = frame
  switch (ev.type) {
    case "text.delta":
      write(ev.payload.delta, ctx)
      return false
    case "text.completed":
      ensureLineStart(ctx) // deltas never newline themselves
      return false
    case "thinking.delta":
      if (ctx.showThinking) write(dim(`· ${ev.payload.delta}`), ctx)
      return false
    case "tool_call.completed": {
      const block = ev.payload.block
      if (block.type === "tool_call") {
        line(`⚡ ${block.name} ${summarizeArgs(block.args)}`, ctx)
      }
      return false
    }
    case "tool_result.completed": {
      const block = ev.payload.block
      if (block.type === "tool_result") {
        line(`↳ ${block.status} (${Math.round(block.durationMs)}ms) ${summarizeOutput(block.output)}`, ctx)
      }
      return false
    }
    // tool_result.delta: deliberately nothing live — the completed line
    // carries the (truncated) output; live chunk buffering is deliberately
    // left out.
    case "confirmation.requested":
      await handleConfirmation(ev.payload, ctx)
      return false
    // message.created/completed (any role): deliberately nothing. The USER
    // message events (the daemon announces the user message lifecycle on the
    // wire) must not render — readline already showed the
    // typed line, so a render here would double-echo the user's text.
    // Assistant/tool messages are equally non-visual here: their content
    // streams through the text.*/tool_*/thinking.* events above.
    case "message.created":
    case "message.completed":
      return false
    // note.emitted: one dim line per note block — including the memory/job
    // notes the daemon injects onto the user message (each is announced
    // exactly once, between that message's created and completed). Compact
    // notes with the structured meta are the exception: the daemon re-
    // attaches them EVERY run (the model needs the summary), so printing the
    // full text here would repeat it every turn — the compaction.completed
    // line below announces a compaction once instead. Legacy daemons send
    // compact notes without the meta — keep the old full print for those.
    case "note.emitted": {
      const block = ev.payload.block
      if (block.type === "note" && block.kind === "compact" && block.compact !== undefined) return false
      line(dim(`[note] ${block.text}`), ctx)
      return false
    }
    // Pre-run compaction lifecycle: started prints one hint (the compaction
    // runs BEFORE run.started — without it the seconds-long summarizer calls
    // are a silent gap after Enter). Completed prints the one-line summary:
    // this event only fires when a compaction actually ran, so it is a
    // natural once-per-compaction announcement (the per-turn note re-attach
    // above stays silent).
    case "compaction.started":
      line(dim("[正在压缩早期对话…]"), ctx)
      return false
    case "compaction.completed": {
      const p = ev.payload
      if (p.result === "failed") line(dim("✱ 压缩失败，本轮继续（稍后自动重试）"), ctx)
      else if (p.result === "cancelled") line(dim("✱ 压缩已取消"), ctx)
      else line(dim(`✱ 早期对话已压缩为 ${p.segments} 段，保留最近 ${p.kept} 条原文（早期细节可用 session_search 检索）`), ctx)
      return false
    }
    // memory.written（项目级事务，广播不带 sessionId）：记忆已落盘，dim 一行
    // 提示路径，不是 run 终止事件。
    case "memory.written":
      line(dim(`已写入记忆: ${ev.payload.path}`), ctx)
      return false
    // hook.failed：用户 hook 一律 fail-open（不伤 run），但失败必须可见——
    // dim 一行警告，带钩子名与位置；phase load 表示装载期失败。
    case "hook.failed": {
      const p = ev.payload
      line(dim(`⚠ 钩子 ${p.hook} 失败（${p.position}${p.phase === "load" ? " 装载" : ""}）：${p.error}`), ctx)
      return false
    }
    case "run.failed":
      line(red(`✖ 运行失败: ${ev.payload.error.message}`), ctx)
      return true
    case "run.completed":
      ensureLineStart(ctx) // the "prompt newline": end the streamed line
      return true
    // run.started: no line — the run's first visible output is the model's
    // first delta; printing a banner here would only add noise.
    case "run.started":
    // job.* / session.renamed: the chat loop does not act on job lifecycle
    // or list-level renames (other surfaces own those).
    case "job.started":
    case "job.completed":
    case "job.failed":
    case "session.renamed":
    // Block-open events: nothing live — the completed lines below carry the
    // full blocks (deltas stream between them; tool_result.delta's chunks are
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
    // line when handled above; the broadcast needs nothing.
    case "confirmation.resolved":
    // Queue trio: the daemon's queue state is visible via /queue on demand;
    // the queued/steered/cancelled broadcasts render nothing in the CLI.
    case "message.queued":
    case "message.steered":
    case "message.queue_cancelled":
    // session.appended: the persistence announcement consumed by the webui
    // audit page (incremental refetch); the CLI renders nothing.
    case "session.appended":
      return false
    default: {
      // Compile-time exhaustiveness sentinel: a new core event type lands
      // here as a non-never `ev` and fails this assignment — it must be
      // rendered or explicitly ignored above.
      const unhandled: never = ev
      void unhandled
      return false
    }
  }
}

/**
 * The resident frame pump: one consumer reads ctx.ws.frames for the lifetime
 * of a socket and hands every arriving frame to exactly one registered one-shot
 * waiter. A frame arriving while NO waiter is registered is held in
 * ctx.pendingFrames (the consumer is only ever waiter-less for the few
 * microtask ticks it takes to process the previous frame and re-arm — a busy
 * daemon's event burst lands exactly there, so dropping would lose real
 * render input mid-run). When the iterator ends (socket closed) every pending
 * waiter is flushed with "closed" so its renderRun drives the reconnect;
 * reconnect() restarts the pump on the new socket. This replaces the old
 * "each renderRun exclusively iterating frames" shape, which stalled every
 * frame while no render happened and dropped events during multi-run handoff.
 */
function startPump(ctx: ChatCtx): void {
  ctx.pumpAlive = true
  void (async () => {
    for await (const frame of ctx.ws.frames) {
      const waiter = ctx.frameWaiters.shift()
      if (waiter !== undefined) waiter(frame)
      else ctx.pendingFrames.push(frame)
    }
    ctx.pumpAlive = false
    ctx.pendingFrames.length = 0 // socket 已死，暂存帧随旧连接作废
    for (const waiter of ctx.frameWaiters.splice(0)) waiter("closed")
  })()
}

/**
 * Take the next frame for a renderRun: any pump-buffered frame first
 * (synchronously — the burst that arrived while we processed the previous
 * one), otherwise a fresh one-shot waiter registered into the pump.
 * Synchronous by design: renderRun arms BEFORE sending so its ack can never
 * fall into an unregistered gap. A dead pump (socket closed, reconnect not
 * yet driven) resolves "closed" immediately so the caller walks the
 * reconnect path instead of hanging.
 */
function armNextFrame(ctx: ChatCtx): ArmedFrame {
  if (!ctx.pumpAlive) {
    return { promise: Promise.resolve("closed"), waiter: () => {} }
  }
  const buffered = ctx.pendingFrames.shift()
  if (buffered !== undefined) {
    return { promise: Promise.resolve(buffered), waiter: () => {} }
  }
  let waiter!: FrameWaiter
  const promise = new Promise<WsFrame | "closed" | "superseded">((resolve) => {
    waiter = resolve
  })
  ctx.frameWaiters.push(waiter)
  return { promise, waiter }
}

/**
 * Await an armed waiter, raced against an inactivity timeout ("timeout") —
 * the post-reconnect watchdog shape. A non-finite timeoutMs skips the race
 * entirely — node clamps `setTimeout(fn, Infinity)` down to 1ms, which would
 * truncate live runs. On timeout the waiter is withdrawn so a late frame is
 * never delivered to a render that already gave up.
 */
async function nextFrame(
  ctx: ChatCtx,
  armed: ArmedFrame,
  timeoutMs: number,
): Promise<WsFrame | "timeout" | "closed" | "superseded"> {
  if (!Number.isFinite(timeoutMs)) return armed.promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  const result = await Promise.race([armed.promise, timeout])
  if (timer !== undefined) clearTimeout(timer)
  if (result === "timeout") {
    const idx = ctx.frameWaiters.indexOf(armed.waiter)
    if (idx >= 0) ctx.frameWaiters.splice(idx, 1)
  }
  return result
}

/**
 * Re-resolve the daemon (spawning one when it died), resubscribe, and pull
 * the full message list per the reconnect protocol (拉全量消息 + 只订阅新事件；不回放).
 * True when waiting may continue on the new socket. Concurrent callers share
 * one attempt (a single renderRun sees "closed" — this keeps even a future
 * second one from opening rival sockets); success clears the frame waiters
 * and restarts the pump on the new socket.
 */
async function reconnect(ctx: ChatCtx): Promise<boolean> {
  if (ctx.reconnecting !== undefined) return ctx.reconnecting
  ctx.reconnecting = (async () => {
    try {
      ctx.client = await KclawClient.connect(ctx.home)
      ctx.ws = await openSubscribed(ctx.client, ctx.sessionId)
      await ctx.client
        .request("GET", `/sessions/${encodeURIComponent(ctx.sessionId)}/messages`)
        .catch(() => undefined) // resync per the reconnect protocol; nothing is rendered from it
      ctx.frameWaiters.length = 0 // 泵已随旧迭代器退出并 flush；这里兜底清空
      startPump(ctx)
      line(dim("[reconnected]"), ctx)
      return true
    } catch {
      line(red("[连接断开，重连失败 — 输入 /exit 退出]"), ctx)
      return false
    } finally {
      ctx.reconnecting = undefined
    }
  })()
  return ctx.reconnecting
}

/**
 * Send `text` and consume + render the run it triggers until ITS terminal
 * event. Terminal logic is unified across the four send paths (plain /
 * steer / wait / interrupt): the `send_message_ack` records `mine`; once the
 * stream shows `message.created{id===mine}` or `message.steered{messageId===mine}`
 * (`targetSeen`), the FIRST `run.completed` resolves the render — a completed
 * belonging to the run this message waited behind never ends someone else's
 * render. An error frame prints and returns (no run will start).
 *
 * Renders take over the frame stream: entering supersedes any still-rendering
 * predecessor (its pending frame resolves "superseded" and it returns
 * silently), so at most one renderRun renders at a time and a mid-run line
 * (/interrupt, a plain send while busy) seamlessly continues the output.
 * A render's first frame can never be a command error frame that predates
 * it: those are purged from the pump's buffer at takeover (an error reply to
 * THIS render's own send arrives through its waiter and still prints).
 *
 * The send itself lives here so the resend rule spans it: a send onto a dead
 * socket (silent drop, or the CONNECTING throw) is caught by the frames loop
 * seeing a closed socket with ZERO observed frames — the message never
 * reached a live daemon, so it is re-sent on the fresh socket. Any observed
 * frame (the ack counts — it proves the server queued the message) marks it
 * delivered; a later close never re-sends. Exported for unit tests (the
 * renderFrame precedent).
 */
export async function renderRun(ctx: ChatCtx, text: string, opts: { disposition?: "steer" | "wait" | "interrupt" } = {}): Promise<void> {
  const disposition = opts.disposition ?? ctx.disposition
  const myEpoch = ctx.renderEpoch // startRender bumps before calling; a later bump supersedes THIS render
  // 接管渲染：唤醒并摘除仍在前一次渲染里等帧的 waiter——旧渲染以 "superseded"
  // 静默收场，本渲染从这一刻起独占帧流。
  for (const waiter of ctx.frameWaiters.splice(0)) waiter("superseded")
  // 丢弃先于本渲染缓冲的命令错误帧：空闲期间到达的 error 帧（当时没有渲染
  // 在等帧）会留在 pendingFrames 里，若被本渲染当作第一帧消费，会打印陈旧
  // 错误并直接终止渲染——消息已发出而它的 run 无人渲染。此刻缓冲里的一切
  // 都早于本渲染（本渲染自己的帧只会经 waiter 到达），事件帧与 ack 保留：
  // 它们是当前 run 的渲染输入。本渲染自己 send 的错误帧不经过这里（发送前
  // waiter 已注册），照常打印。
  ctx.pendingFrames = ctx.pendingFrames.filter((f) => f.type !== "error")
  let pendingSend = true // message not yet confirmed onto a live socket
  let observedAny = false // any frame seen since entering (ack or run)
  let reconnected = false
  let mine: string | undefined // MY message id, learned from send_message_ack
  let targetSeen = false // message.created/steered for mine observed
  let queuedBeforeAck: MessageQueuedPayload | undefined
  for (;;) {
    const armed = armNextFrame(ctx) // 先注册 waiter，再发送——ack 不会落在空窗
    if (pendingSend) {
      pendingSend = false
      try {
        const attachments = [...ctx.pendingAttachments]
        ctx.ws.send({
          type: "send_message",
          sessionId: ctx.sessionId,
          text,
          disposition,
          ...(attachments.length > 0 ? { attachments } : {}),
        })
        ctx.pendingAttachments.length = 0
      } catch {
        // ws throws synchronously only while CONNECTING; a CLOSED socket
        // drops the frame silently instead. Either way nothing was
        // delivered — the closed frames loop below resends after reconnect.
      }
    }
    const frame = reconnected
      ? await nextFrame(ctx, armed, POST_RECONNECT_SILENCE_MS)
      : await nextFrame(ctx, armed, Number.POSITIVE_INFINITY) // no artificial cap on a live run

    if (frame === "superseded") return // 更新的渲染接管帧流，本渲染静默退出
    if (frame === "closed") {
      if (!(await reconnect(ctx))) return
      reconnected = true
      // Zero frames observed → the message never reached a live daemon →
      // safe (and required) to resend on the fresh socket. Otherwise the
      // run may already be queued server-side: never resend, just resume.
      if (!observedAny) pendingSend = true
      if (ctx.renderEpoch !== myEpoch) return // 重连期间被更新的渲染接管
      continue // continue waiting on the new socket
    }
    if (frame === "timeout") {
      line(red("[等待运行事件超时 — 回到提示符]"), ctx)
      return
    }
    observedAny = true

    // —— 本消息的目标追踪（四路径统一终点判定）——
    if (frame.type === "send_message_ack" && mine === undefined && typeof frame.messageId === "string") {
      mine = frame.messageId
      // 帧序补偿：message.queued 由总线在 submit 内同步扇出，先于 ws 层的
      // send_message_ack 写出——我的 queued 事件可能先到而 mine 未知，此刻补上。
      if (queuedBeforeAck !== undefined) {
        if (queuedBeforeAck.messageId === mine) printQueuedHint(ctx, queuedBeforeAck)
        queuedBeforeAck = undefined
      }
    }
    if (isAgentEvent(frame)) {
      if (frame.type === "message.queued") {
        const p = frame.payload
        if (mine === undefined) {
          if (queuedBeforeAck === undefined) queuedBeforeAck = p // ack 未到，先缓存再核对
        } else if (p.messageId === mine) {
          printQueuedHint(ctx, p)
        }
      } else if (frame.type === "message.steered") {
        if (frame.payload.messageId === mine) {
          line(dim("已注入"), ctx)
          targetSeen = true
        }
      } else if (frame.type === "message.queue_cancelled") {
        line(dim("已取消排队"), ctx)
      } else if (frame.type === "message.created") {
        if (frame.payload.message.id === mine) targetSeen = true
      }
    }
    const done = await renderFrame(frame, ctx)
    // 终点门控：targetSeen 之前的 run 终点（completed/failed）属于前一个 run
    // 的收尾——渲染继续，等「我的」run 的终点。error 帧（无 run 可启动）与
    // targetSeen 之后的终点照旧结束渲染。
    if (done && !(isAgentEvent(frame) && (frame.type === "run.completed" || frame.type === "run.failed") && !targetSeen)) return
  }
}

/** message.queued（mine）的一次性 dim 提示：有序位报位次，steer 报引导缓冲。 */
function printQueuedHint(ctx: ChatCtx, p: MessageQueuedPayload): void {
  line(dim(p.position !== undefined ? `已排队（第 ${p.position + 1} 位）` : "已进入引导缓冲"), ctx)
}

/**
 * Run the interactive chat loop (the CLI's default command). See the module
 * comment for the readline/SIGINT/reconnect design.
 */
export async function runChat(opts: ChatOptions = {}): Promise<void> {
  const auto = opts.yes === true ? "yes" : opts.no === true ? "no" : "ask"

  const client = await KclawClient.connect(opts.home)
  const sessionId = await resolveSessionId(client, opts.session)

  process.stdout.write(`kclaw · session ${sessionId}\n`)
  process.stdout.write(dim(`输入消息，/ 命令可用（Tab 补全），/exit 退出，Ctrl+C 取消当前 run\n`))

  // 初始发送处置：会话 meta 的 dispositionOverride 优先，其次配置
  // 默认，最后 steer。interrupt 覆盖原样带在本地状态里（回车直发会带上它，
  // 服务端按一次性动作入队）；刚连上的 daemon 不可达时回落 steer。
  const resolveInitialDisposition = async (): Promise<"steer" | "wait" | "interrupt"> => {
    try {
      const [meta, cfg] = await Promise.all([
        client.request("GET", `/sessions/${sessionId}`) as Promise<{ dispositionOverride?: string }>,
        client.request("GET", "/config") as Promise<{ sessions?: { defaultDisposition?: string } }>,
      ])
      if (meta.dispositionOverride === "interrupt") return "interrupt"
      if (meta.dispositionOverride === "steer" || meta.dispositionOverride === "wait") return meta.dispositionOverride
      const fallback = cfg.sessions?.defaultDisposition
      return fallback === "wait" || fallback === "interrupt" ? fallback : "steer"
    } catch {
      return "steer"
    }
  }
  const disposition = await resolveInitialDisposition()
  const resolveInitialMode = async (): Promise<PermissionMode> => {
    try {
      const meta = (await client.request("GET", `/sessions/${sessionId}`)) as { mode?: string }
      return isPermissionMode(meta.mode) ? meta.mode : "default"
    } catch {
      return "default"
    }
  }
  const initialMode = await resolveInitialMode()

  const ctx: ChatCtx = {
    pendingAttachments: [],
    home: opts.home,
    client,
    ws: await openSubscribed(client, sessionId),
    sessionId,
    rl: createInterface({ input: process.stdin, output: process.stdout, prompt: modePrompt(initialMode), completer: createSlashCompleter(() => skillCommandMetas) }),
    showThinking: opts.showThinking === true,
    auto,
    io: { atLineStart: true },
    disposition,
    mode: initialMode,
    inputPaused: false,
    frameWaiters: [],
    pendingFrames: [],
    renderEpoch: 0,
    pumpAlive: false,
    reconnecting: undefined,
  }
  startPump(ctx) // 常驻帧泵：从这一刻起所有帧都经它分发（openSubscribed 已消费订阅回执）

  // 渲染启动器：发送与渲染不再阻塞输入行（/interrupt 因此能在 run 中途派发）。
  // 每次启动递增 renderEpoch —— 新渲染接管帧流，旧渲染以 "superseded" 静默收场，
  // 且结束时只在 epoch 仍是自己时才清 runActive（Ctrl+C 始终瞄准最新的 run）。
  let runActive = false
  const inFlight = new Set<Promise<void>>()
  const startRender = (text: string, renderOpts: { disposition?: "steer" | "wait" | "interrupt" } = {}): void => {
    const myEpoch = ++ctx.renderEpoch
    runActive = true
    const pending = renderRun(ctx, text, renderOpts).finally(() => {
      inFlight.delete(pending)
      if (ctx.renderEpoch === myEpoch) runActive = false
    })
    inFlight.add(pending)
  }

  // The slash-command view over the chat loop's live state. `client` and
  // `sessionId` are getters so commands always see the CURRENT values — a
  // reconnect swaps `ctx.client`/`ctx.ws`, and `switchSession` rewrites
  // `ctx.sessionId`. `/exit` stays loop control (not a registry command), so
  // `exit()` is reserved for a future command rather than called here.
  const slashCtx: SlashCtx = {
    get client() {
      return ctx.client
    },
    get sessionId() {
      return ctx.sessionId
    },
    async switchSession(id: string) {
      ctx.ws.send({ type: "unsubscribe", sessionId: ctx.sessionId })
      ctx.sessionId = id
      ctx.ws.send({ type: "subscribe", sessionId: id })
      ctx.pendingAttachments.length = 0 // attachments are session-scoped
      refreshSkillCommands() // 项目级技能跟会话工作目录：切会话后重拉
      // The badge follows the new session's meta (best effort: a dead daemon
      // keeps the stale badge until the next Shift+Tab round-trip).
      try {
        const meta = await ctx.client.request("GET", `/sessions/${id}`) as { mode?: string }
        if (isPermissionMode(meta.mode)) {
          ctx.mode = meta.mode
          ctx.rl.setPrompt(modePrompt(meta.mode))
        }
      } catch { /* ignore — reconnect path resyncs nothing critical here */ }
    },
    exit() {
      // handled by the input loop (parsed.command === "exit" → break)
    },
    print(text: string) {
      line(text, ctx)
    },
    pauseInput() {
      ctx.inputPaused = true
      ctx.rl.pause()
    },
    resumeInput() {
      ctx.inputPaused = false
      ctx.rl.resume()
    },
    get pendingAttachments() {
      return ctx.pendingAttachments
    },
    send(text: string) {
      // Custom commands expand into a plain message through the same frame-
      // pump path as typed input (fire-and-forget inside a slash run): the
      // render starts immediately and takes over the frame stream.
      startRender(text, { disposition: ctx.disposition })
    },
    setDisposition(d: "steer" | "wait") {
      // /steer //wait flip the local mode AFTER the sticky override POST
      // succeeded; the next Enter-send carries the new disposition.
      ctx.disposition = d
    },
    setMode(m: PermissionMode) {
      // /mode flips the local mirror AFTER the POST succeeded: the badge and
      // the Shift+Tab cycle base follow the daemon-confirmed value.
      ctx.mode = m
      ctx.rl.setPrompt(modePrompt(m))
      if (!runActive) {
        process.stdout.write("\n")
        ctx.io.atLineStart = true
        ctx.rl.prompt(true)
      }
    },
    async queueCancel(target: string | "all") {
      try {
        ctx.ws.send(
          target === "all"
            ? { type: "queue.cancel", sessionId: ctx.sessionId }
            : { type: "queue.cancel", sessionId: ctx.sessionId, messageId: target },
        )
      } catch {
        // socket dropping — the reconnect path takes over
      }
    },
    sendInterrupt(text: string) {
      // One-shot interrupt-send: bump the render epoch, then start a renderRun
      // with the interrupt disposition — the daemon drops the active run and
      // queues this message at the head, and the new render takes over the
      // frame stream from whatever was rendering before. The /interrupt
      // command expands into this.
      startRender(text, { disposition: "interrupt" })
    },
    async queueSnapshot() {
      try {
        const list = (await ctx.client.request("GET", `/sessions/${encodeURIComponent(ctx.sessionId)}/queue`)) as unknown
        return Array.isArray(list) ? (list as Array<{ messageId: string; disposition: string; text: string }>) : []
      } catch {
        return []
      }
    },
    commandsDir: ctx.home !== undefined ? join(ctx.home, "commands") : undefined,
  }
  const registry = createRegistry(slashCtx)

  // Installed user-visible skills become first-class slash commands. The
  // fetch is async and best-effort: daemon unreachable → no skill commands,
  // the builtins (including /skill) still work. Re-checked per session
  // switch, since the project scope follows the session's workdir.
  let skillCommandMetas: SlashCommandMeta[] = []
  const refreshSkillCommands = (): void => {
    void refreshSkillCommandsOp(registry, slashCtx)
      .then((metas) => { skillCommandMetas = metas })
      .catch(() => {})
  }
  refreshSkillCommands()

  // Ctrl+C escalates in three stages: ① cancel the active run
  // (or, while idle, print the exit hint — always warning about a backed-up
  // queue), ② clear the queue (`queue.cancel` without messageId), ③ exit 130.
  // `sigints` only ever grows. The handler lives on the readline interface
  // (the TTY Ctrl+C path — see the module comment) AND on `process` (the OS
  // signal piped stdin delivers): a raw-mode TTY fires exactly one of the
  // two, so piped runs escalate identically instead of default-dying.
  // runActive is owned by startRender (see above).
  let sigints = 0
  const queueCount = async (): Promise<number> => {
    try {
      const list = (await ctx.client.request("GET", `/sessions/${encodeURIComponent(ctx.sessionId)}/queue`)) as unknown[]
      return Array.isArray(list) ? list.length : 0
    } catch {
      return 0
    }
  }
  const exitNow = (): void => {
    ctx.ws.close()
    ctx.rl.close()
    process.exit(130)
  }
  const onSigint = (): void => {
    sigints += 1
    if (sigints === 1) {
      if (runActive) {
        line(dim("^C 已请求取消当前 run"), ctx)
        try { ctx.ws.send({ type: "run.cancel", sessionId: ctx.sessionId }) } catch { /* closing */ }
        void queueCount().then((n) => { if (n > 0) line(dim(`还有 ${n} 条排队消息，再按一次 Ctrl+C 清空`), ctx) })
        return
      }
      void queueCount().then((n) => {
        line(dim(n > 0 ? `还有 ${n} 条排队消息，再按一次 Ctrl+C 清空` : "^C 再按一次 Ctrl+C 退出"), ctx)
      })
      return
    }
    if (sigints === 2) {
      void queueCount().then((n) => {
        if (n > 0) {
          try { ctx.ws.send({ type: "queue.cancel", sessionId: ctx.sessionId }) } catch { /* closing */ }
          line(dim("队列已清空，再按一次 Ctrl+C 退出"), ctx)
        } else exitNow()
      })
      return
    }
    exitNow()
  }
  ctx.rl.on("SIGINT", onSigint)
  process.on("SIGINT", onSigint)

  // Shift+Tab cycles the session's permission mode (readonly → default →
  // acceptEdits, Claude Code style). Stands down while a @clack prompt owns
  // stdin; mid-run presses apply from the NEXT run (the daemon gates per
  // run) — the notice prints and the badge updates on the next prompt.
  let modeBusy = false
  const cycleMode = async (): Promise<void> => {
    if (ctx.inputPaused || modeBusy || !process.stdin.isTTY) return
    modeBusy = true
    const target = nextMode(ctx.mode)
    try {
      await ctx.client.request("POST", `/sessions/${ctx.sessionId}/mode`, { mode: target })
      ctx.mode = target
      ctx.rl.setPrompt(modePrompt(target))
      line(dim(`权限模式: ${target}（Shift+Tab 继续切换）`), ctx)
      if (!runActive) {
        process.stdout.write("\n") // break off the drawn prompt line, then redraw
        ctx.io.atLineStart = true
        ctx.rl.prompt(true) // re-display the (new) prompt, preserving typed input
      }
    } catch {
      // daemon unreachable — the badge stays; the next cycle retries
    } finally {
      modeBusy = false
    }
  }
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str, key: { name?: string; shift?: boolean; sequence?: string } | undefined) => {
      if (key?.name === "tab" && key.shift === true) void cycleMode()
    })
  }

  try {
    // A piped stdin reaches EOF (and closes the interface) while the FIRST
    // line's run is still rendering — track it so late prompt() calls no-op
    // instead of throwing "readline was closed" (buffered lines still arrive
    // through the async iterator afterwards).
    let rlClosed = false
    ctx.rl.on("close", () => {
      rlClosed = true
    })

    const prompt = (): void => {
      if (!rlClosed) ctx.rl.prompt()
    }

    prompt()
    for await (const raw of ctx.rl) {
      const text = raw.trim()
      const parsed = dispatch(text, registry)
      if (parsed === null) {
        // Plain message: send and render the run it triggers — without
        // blocking the input line (a mid-run line is what makes /interrupt
        // and busy-run sends possible). /exit and EOF drain in-flight
        // renders, so output still completes before the process ends.
        if (text !== "") {
          // Expand @path file references against the session's workdir. A
          // dead daemon here must not kill the input loop: renderRun's
          // reconnect path resends after the daemon comes back.
          let workdir = process.cwd()
          try {
            workdir = ((await ctx.client.request("GET", `/sessions/${ctx.sessionId}`)) as { workdir?: string }).workdir ?? process.cwd()
          } catch {
            // daemon unreachable — proceed with the cwd fallback
          }
          const refs = expandFileRefs(text, process.cwd(), workdir)
          if ("error" in refs) {
            line(`引用失败: ${refs.error}`, ctx)
            prompt()
            continue
          }
          startRender(refs.text) // sends, renders, and (if needed) resends after reconnect
        }
      } else if (parsed.command === "exit") {
        await Promise.allSettled([...inFlight]) // 等在途渲染收尾，输出完整再退
        break
      } else {
        await runOrHint(parsed, registry, slashCtx)
      }
      prompt()
    }
    // stdin 已到 EOF：与旧的内联 await renderRun 等价——等在途渲染收尾后再关
    // socket，已缓冲的行不会打断正在输出的 run。
    await Promise.allSettled([...inFlight])
  } finally {
    ctx.ws.close()
    ctx.rl.close()
  }
}
