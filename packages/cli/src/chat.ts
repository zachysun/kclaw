/**
 * Interactive chat — the terminal product surface: connect (auto-starting)
 * the daemon, create or resume a session, subscribe over WS and render each
 * run's events per typed line. This module is the orchestration both
 * terminal surfaces share (spec B2/B11); what the user sees lives behind
 * ChatSurface: the ink TUI when stdin and stdout are both TTYs
 * (`tui/`), the readline line surface otherwise (`chat-readline.ts`).
 *
 * Ctrl+C escalates in three stages, `sigints` only ever growing: the first
 * press cancels the active run (`run.cancel`; the run then ends through the
 * normal render path with run.completed {stopReason:"aborted"}) or, while
 * idle, prints the exit hint — with a queued-count warning ("还有 N 条…")
 * whenever the session holds queued messages. The second press clears the
 * queue (`queue.cancel` without messageId) when one exists, otherwise exits.
 * The third press always exits immediately (code 130, socket closed first so
 * the daemon sees a clean disconnect).
 *
 * Reconnect (basic version): when the socket drops
 * unexpectedly, re-resolve the daemon (KclawClient.connect respawns one when
 * it died), resubscribe, pull the full message list (拉全量消息，只订阅新事件，
 * 不回放 — nothing is replay-rendered) and print "[reconnected]"; frames
 * observed after a reconnect carry a 120s inactivity timeout so a dead run
 * cannot hang the chat forever. The frame pump dies with the old socket's
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
 * chat sat idle). Once ANY frame was observed the message is presumed
 * delivered and a mid-run reconnect never re-sends: the run may already be
 * queued server-side, and a duplicate would double-run it — the 120s
 * watchdog bounds that wait instead.
 */
import { isPermissionMode, PERMISSION_MODES } from "@kclaw/core"
import type { ConfirmationDecision, ConfirmationRequestedPayload, MessageQueuedPayload, PermissionMode, QuestionRequestedPayload } from "@kclaw/core"
import { parseSendDisposition, resolveSendDisposition } from "@kclaw/core/protocol"
import { join } from "node:path"
import { openReadline, createReadlineUi } from "./chat-readline.js"
import type { ChatController, ChatSurface, ChatUi } from "./chat-surface.js"
import { KclawClient, openSubscribed } from "./client.js"
import type { WsFrame, WsHandle } from "./client.js"
import { dim } from "./color.js"
import { confirmationLine, frameView, isAgentEvent } from "./frame-view.js"
import { createRegistry, dispatch, refreshSkillCommands as refreshSkillCommandsOp, runOrHint, type AttachmentRef, type SlashCtx } from "./slash.js"
import type { SlashCommandMeta } from "@kclaw/core/commands"

/** Session rows as served by GET /sessions (SessionStore meta shape). */
interface SessionInfo {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** Reconnect watchdog: a fully quiet run after a reconnect is presumed gone. */
const POST_RECONNECT_SILENCE_MS = 120_000

/** Next mode in the Shift+Tab cycle (PERMISSION_MODES order, strictest first). */
function nextMode(m: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(m) + 1) % PERMISSION_MODES.length]!
}

export interface ChatOptions {
  home?: string
  /** Resume this session instead of creating one; unknown ids are an error. */
  session?: string
  /** Show thinking text (the line chat streams it dim; the TUI unfolds its thinking lines). */
  showThinking?: boolean
  /** Hidden --yes: auto-approve every confirmation (tests & scripting). */
  yes?: boolean
  /** Hidden --no: auto-deny every confirmation (tests & scripting). */
  no?: boolean
}

/** Everything the render loop mutates or consults, kept in one place so a reconnect can swap the socket underneath. */
export interface ChatCtx {
  home: string | undefined
  client: KclawClient
  ws: WsHandle
  sessionId: string
  /** Where every line, card and picker goes (the TUI or the readline surface). */
  surface: ChatSurface
  /** Confirmation answering mode: flag-driven auto verdicts, or the surface's card. */
  auto: "yes" | "no" | "ask"
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
   * The session's permission mode: shown by the surface (the line prompt's
   * badge, the TUI status line), cycled by Shift+Tab and flipped by /mode.
   * Local mirror of the daemon's session meta — the daemon re-derives it per
   * run, so this only drives the UI.
   */
  mode: PermissionMode
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

/** Collect the verdict (flag policy or the surface's card), then send confirmation.resolve. */
async function handleConfirmation(p: ConfirmationRequestedPayload, ctx: ChatCtx): Promise<void> {
  let decision: ConfirmationDecision
  if (ctx.auto === "ask") {
    decision = await ctx.surface.confirm(p)
  } else {
    ctx.surface.notice(confirmationLine(p), "plain")
    if (p.noteText !== undefined) ctx.surface.notice(p.noteText, "dim")
    ctx.surface.notice(ctx.auto === "yes" ? "[--yes] 已自动允许（仅本次）" : "[--no] 已自动拒绝", "dim")
    decision = ctx.auto === "yes" ? "once" : "reject"
  }
  try {
    ctx.ws.send({ type: "confirmation.resolve", confirmationId: p.confirmationId, decision })
  } catch {
    // socket dropping — the reconnect path takes over
  }
}

/** Collect the answers for one pending question through the surface, then send question.resolve. */
async function handleQuestion(p: QuestionRequestedPayload, ctx: ChatCtx): Promise<void> {
  const answers = await ctx.surface.ask(p)
  try {
    ctx.ws.send({ type: "question.resolve", questionId: p.questionId, answers })
  } catch {
    // socket dropping — the reconnect path takes over
  }
}

/**
 * Render one frame; resolves true when the run reached a terminal state
 * (run.completed / run.failed) or a command error frame arrived — anything
 * that means the caller should stop waiting for events. Every view kind is
 * listed (no default), so a new kind fails compilation here until it is
 * routed. Exported for unit tests (the runOrHint precedent).
 */
export async function renderFrame(frame: WsFrame, ctx: ChatCtx): Promise<boolean> {
  const view = frameView(frame)
  switch (view.kind) {
    case "confirmation":
      await handleConfirmation(view.payload, ctx)
      return false
    case "question":
      await handleQuestion(view.payload, ctx)
      return false
    case "silent":
      return false
    case "run-failed":
    case "run-completed":
    case "command-error":
      ctx.surface.show(view)
      return true
    case "text":
    case "text-end":
    case "thinking":
    case "thinking-end":
    case "tool-call":
    case "tool-result":
    case "system":
    case "queued":
    case "left-queue":
      ctx.surface.show(view)
      return false
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
    ctx.pendingFrames.length = 0 // socket 已断开，暂存帧随旧连接作废
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
      ctx.frameWaiters.length = 0 // 泵已随旧迭代器退出并 flush；这里保底清空
      startPump(ctx)
      ctx.surface.notice("[reconnected]", "dim")
      return true
    } catch {
      ctx.surface.notice("[连接断开，重连失败。输入 /exit 退出]", "error")
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
  // 在等帧）会留在 pendingFrames 里，若被本渲染当作第一帧处理，会打印陈旧
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
      ctx.surface.notice("[等待运行事件超时 — 回到提示符]", "error")
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
          ctx.surface.notice("已注入", "dim")
          targetSeen = true
        }
      } else if (frame.type === "message.queue_cancelled") {
        ctx.surface.notice("已取消排队", "dim")
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
  ctx.surface.notice(p.position !== undefined ? `已排队（第 ${p.position + 1} 位）` : "已进入引导缓冲", "dim")
}

/**
 * Run the interactive chat (the CLI's default command): resolve the session,
 * subscribe, then hand the input side to a surface — the ink TUI when stdin
 * and stdout are both TTYs (ink switches stdin to raw mode, which a pipe
 * cannot do: `echo hi | kclaw chat` stays on the line surface), the readline
 * line surface otherwise. See the module comment for the escalation and
 * reconnect design.
 */
export async function runChat(opts: ChatOptions = {}): Promise<void> {
  const auto = opts.yes === true ? "yes" : opts.no === true ? "no" : "ask"
  const showThinking = opts.showThinking === true

  const client = await KclawClient.connect(opts.home)
  const sessionId = await resolveSessionId(client, opts.session)
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true

  if (!tty) {
    process.stdout.write(`kclaw · session ${sessionId}\n`)
    process.stdout.write(dim(`输入消息，/ 命令可用（Tab 补全），/exit 退出，Ctrl+C 取消当前 run\n`))
  }

  // 初始发送处置（链正本在 core protocol/wire.ts）：会话覆盖 > 配置默认 >
  // steer。interrupt 覆盖原样带在本地状态里（回车直发会带上它，服务端按
  // 一次性动作入队）；刚连上的 daemon 不可达时回退 steer。
  const resolveInitialDisposition = async (): Promise<"steer" | "wait" | "interrupt"> => {
    try {
      const [meta, cfg] = await Promise.all([
        client.request("GET", `/sessions/${sessionId}`) as Promise<{ dispositionOverride?: unknown }>,
        client.request("GET", "/config") as Promise<{ sessions?: { defaultDisposition?: unknown } }>,
      ])
      return resolveSendDisposition({
        override: parseSendDisposition(meta.dispositionOverride),
        configDefault: parseSendDisposition(cfg.sessions?.defaultDisposition),
      })
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
  const ws = await openSubscribed(client, sessionId)

  // The TUI module (ink, react, chalk) loads only on this branch: a piped
  // chat never pays for it, and chalk settles on colour after the CLI's
  // colour module already wrote its verdict into the environment.
  const ui: ChatUi = tty
    ? (await import("./tui/tui.js")).createTuiUi({ sessionId, mode: initialMode, showThinking })
    : createReadlineUi({ rl: openReadline(initialMode, () => controller.skillCommands()), showThinking })

  const ctx: ChatCtx = {
    pendingAttachments: [],
    home: opts.home,
    client,
    ws,
    sessionId,
    surface: ui,
    auto,
    disposition,
    mode: initialMode,
    frameWaiters: [],
    pendingFrames: [],
    renderEpoch: 0,
    pumpAlive: false,
    reconnecting: undefined,
  }
  startPump(ctx) // 常驻帧泵：从这一刻起所有帧都经它分发（openSubscribed 已处理订阅回执）

  // 渲染启动器：发送与渲染不再阻塞输入行（/interrupt 因此能在 run 中途派发）。
  // 每次启动递增 renderEpoch —— 新渲染接管帧流，旧渲染以 "superseded" 静默收场，
  // 且结束时只在 epoch 仍是自己时才清 runActive（Ctrl+C 始终瞄准最新的 run）。
  let runActive = false
  const inFlight = new Set<Promise<void>>()
  const startRender = (text: string, renderOpts: { disposition?: "steer" | "wait" | "interrupt" } = {}): void => {
    const myEpoch = ++ctx.renderEpoch
    runActive = true
    ui.busyChanged(true)
    const pending = renderRun(ctx, text, renderOpts).finally(() => {
      inFlight.delete(pending)
      if (ctx.renderEpoch === myEpoch) {
        runActive = false
        ui.busyChanged(false)
      }
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
      ui.sessionChanged(id)
      refreshSkillCommands() // 项目级技能跟会话工作目录：切会话后重拉
      // The badge follows the new session's meta (best effort: a dead daemon
      // keeps the stale badge until the next Shift+Tab round-trip).
      try {
        const meta = await ctx.client.request("GET", `/sessions/${id}`) as { mode?: string }
        if (isPermissionMode(meta.mode)) {
          ctx.mode = meta.mode
          ui.modeChanged(meta.mode, false)
        }
      } catch { /* ignore — reconnect path resyncs nothing critical here */ }
    },
    exit() {
      // handled by the input loop (parsed.command === "exit" → break)
    },
    print(text: string) {
      ui.notice(text, "plain")
    },
    choose(message, options) {
      return ui.choose(message, options)
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
      ui.modeChanged(m, !runActive)
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
  let skillMetasAt = 0 // 上次触发重拉的时刻（补全节流用）
  const refreshSkillCommands = (): void => {
    skillMetasAt = Date.now()
    void refreshSkillCommandsOp(registry, slashCtx)
      .then((metas) => { skillCommandMetas = metas })
      .catch(() => {})
  }
  refreshSkillCommands()

  // Ctrl+C escalates in three stages: ① cancel the active run
  // (or, while idle, print the exit hint — always warning about a backed-up
  // queue), ② clear the queue (`queue.cancel` without messageId), ③ exit 130.
  // `sigints` only ever grows. The process signal (a piped stdin delivers
  // the OS SIGINT) is wired here; each surface wires its own Ctrl+C key to
  // the same escalation (readline's "SIGINT" event, the TUI's key handler),
  // so every path escalates identically instead of default-dying.
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
    ui.close()
    process.exit(130)
  }
  const onSigint = (): void => {
    sigints += 1
    if (sigints === 1) {
      if (runActive) {
        ui.notice("^C 已请求取消当前 run", "dim")
        try { ctx.ws.send({ type: "run.cancel", sessionId: ctx.sessionId }) } catch { /* closing */ }
        void queueCount().then((n) => { if (n > 0) ui.notice(`还有 ${n} 条排队消息，再按一次 Ctrl+C 清空`, "dim") })
        return
      }
      void queueCount().then((n) => {
        ui.notice(n > 0 ? `还有 ${n} 条排队消息，再按一次 Ctrl+C 清空` : "^C 再按一次 Ctrl+C 退出", "dim")
      })
      return
    }
    if (sigints === 2) {
      void queueCount().then((n) => {
        if (n > 0) {
          try { ctx.ws.send({ type: "queue.cancel", sessionId: ctx.sessionId }) } catch { /* closing */ }
          ui.notice("队列已清空，再按一次 Ctrl+C 退出", "dim")
        } else exitNow()
      })
      return
    }
    exitNow()
  }
  process.on("SIGINT", onSigint)

  // Shift+Tab cycles the session's permission mode (readonly → default →
  // acceptEdits, Claude Code style); the surface stands down while one of
  // its prompts owns the keyboard. Mid-run presses apply from the NEXT run
  // (the daemon gates per run) — the notice prints right away.
  let modeBusy = false
  const cycleMode = async (): Promise<void> => {
    if (modeBusy) return
    modeBusy = true
    const target = nextMode(ctx.mode)
    try {
      await ctx.client.request("POST", `/sessions/${ctx.sessionId}/mode`, { mode: target })
      ctx.mode = target
      ui.notice(`权限模式: ${target}（Shift+Tab 继续切换）`, "dim")
      ui.modeChanged(target, !runActive)
    } catch {
      // daemon unreachable — the badge stays; the next cycle retries
    } finally {
      modeBusy = false
    }
  }

  const submit = async (raw: string): Promise<"exit" | "continue"> => {
    const text = raw.trim()
    const parsed = dispatch(text, registry)
    if (parsed === null) {
      // Plain message: send and render the run it triggers — without
      // blocking the input (a mid-run line is what makes /interrupt and
      // busy-run sends possible). /exit and EOF drain in-flight renders, so
      // output still completes before the process ends.
      if (text !== "") startRender(text) // sends, renders, and (if needed) resends after reconnect
    } else if (parsed.command === "exit") {
      await Promise.allSettled([...inFlight]) // 等正在进行的渲染收尾，输出完整再退
      return "exit"
    } else if (registry.has(parsed.command)) {
      await runOrHint(parsed, registry, slashCtx)
    } else {
      // 未注册：可能只是技能清单过期（技能刚在 WebUI 复用/提案采纳/外部
      // 新增）——重新获取一次再判定，避免把新技能误报成"没有这个命令"。
      await refreshSkillCommandsOp(registry, slashCtx).catch(() => {})
      await runOrHint(parsed, registry, slashCtx)
    }
    return "continue"
  }

  const controller: ChatController = {
    get client() {
      return ctx.client
    },
    get sessionId() {
      return ctx.sessionId
    },
    get mode() {
      return ctx.mode
    },
    get busy() {
      return runActive
    },
    submit,
    interrupt: onSigint,
    stopRun() {
      if (!runActive) return
      ui.notice("已请求停止当前 run", "dim")
      try { ctx.ws.send({ type: "run.cancel", sessionId: ctx.sessionId }) } catch { /* closing */ }
    },
    cycleMode,
    skillCommands() {
      // 技能增删改（WebUI 复用/提案采纳、外部编辑）不在本进程发生，无法
      // 推送——补全时惰性重新获取（2s 节流，fire-and-forget）：本次按键仍用旧
      // 清单，下一次即最新，与服务端"每次 run 现扫、下一次交互边界生效"
      // 同语义。
      if (Date.now() - skillMetasAt > 2000) refreshSkillCommands()
      return skillCommandMetas
    },
    async drain() {
      await Promise.allSettled([...inFlight])
    },
  }

  try {
    await ui.run(controller)
  } finally {
    ctx.ws.close()
    ui.close()
  }
}
