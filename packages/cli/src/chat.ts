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
 * empty (a non-empty line just clears — node's default). First SIGINT during
 * an active run sends `run.cancel` (the run then ends through the normal
 * render path with run.completed {stopReason:"aborted"}); first SIGINT while
 * idle prints the exit hint; a second SIGINT always exits immediately
 * (code 130, socket closed first so the daemon sees a clean disconnect).
 *
 * Reconnect (basic version): when the socket drops
 * unexpectedly, re-resolve the daemon (KclawClient.connect respawns one when
 * it died), resubscribe, pull the full message list (拉全量消息，只订阅新事件，
 * 不回放 — nothing is replay-rendered) and print "[reconnected]"; frames
 * observed after a reconnect carry a 120s inactivity timeout so a dead run
 * cannot hang the REPL forever.
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
import { confirm, isCancel } from "@clack/prompts"
import type { AgentEvent, ConfirmationRequestedPayload } from "@kclaw/core"
import { createInterface, type Interface as RlInterface } from "node:readline"
import { KclawClient } from "./client.js"
import type { WsFrame, WsHandle } from "./client.js"
import { createRegistry, dispatch, runOrHint, type AttachmentRef, type SlashCtx } from "./slash.js"

/** AgentEvent distributed over its event types, so `switch (ev.type)` narrows `ev.payload`. */
type AnyAgentEvent = { [K in AgentEvent["type"]]: AgentEvent<K> }[AgentEvent["type"]]

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
  let approved: boolean
  if (ctx.auto === "yes") {
    line(dim("[--yes] 已自动允许"), ctx)
    approved = true
  } else if (ctx.auto === "no") {
    line(dim("[--no] 已自动拒绝"), ctx)
    approved = false
  } else {
    ctx.rl.pause() // @clack owns the terminal while our readline sits quiet
    let answer: boolean | symbol
    try {
      answer = await confirm({ message: "允许执行?" })
    } catch {
      answer = false
    } finally {
      ctx.rl.resume()
    }
    approved = answer === true // cancel symbol / anything not exactly true denies
    if (isCancel(answer)) line(dim("已取消，默认拒绝"), ctx)
  }
  try {
    ctx.ws.send({ type: "confirmation.resolve", confirmationId: p.confirmationId, approved })
  } catch {
    // socket dropping — the reconnect path takes over
  }
}

/**
 * Render one frame; resolves true when the run reached a terminal state
 * (run.completed / run.failed) or a command error frame arrived — anything
 * that means the caller should stop waiting for events.
 */
async function renderFrame(frame: WsFrame, ctx: ChatCtx): Promise<boolean> {
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
    // exactly once, between that message's created and completed).
    case "note.emitted":
      line(dim(`[note] ${ev.payload.block.text}`), ctx)
      return false
    case "run.failed":
      line(red(`✖ 运行失败: ${ev.payload.error.message}`), ctx)
      return true
    case "run.completed":
      ensureLineStart(ctx) // the "prompt newline": end the streamed line
      return true
    default:
      return false
  }
}

/**
 * frames.next() raced against an inactivity timeout ("timeout") or socket end
 * ("closed"). A non-finite timeoutMs skips the race entirely — node clamps
 * `setTimeout(fn, Infinity)` down to 1ms, which would truncate live runs.
 */
async function nextFrame(
  frames: AsyncIterator<WsFrame>,
  timeoutMs: number,
): Promise<WsFrame | "timeout" | "closed"> {
  if (!Number.isFinite(timeoutMs)) {
    const untimed = await frames.next()
    return untimed.done ? "closed" : untimed.value
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  const result = await Promise.race([
    frames.next().then((n) => (n.done ? ("closed" as const) : n.value)),
    timeout,
  ])
  if (timer !== undefined) clearTimeout(timer)
  return result
}

/**
 * Re-resolve the daemon (spawning one when it died), resubscribe, and pull
 * the full message list per the reconnect protocol (拉全量消息 + 只订阅新事件；不回放).
 * True when waiting may continue on the new socket.
 */
async function reconnect(ctx: ChatCtx): Promise<boolean> {
  try {
    ctx.client = await KclawClient.connect(ctx.home)
    ctx.ws = await openSubscribed(ctx.client, ctx.sessionId)
    await ctx.client
      .request("GET", `/sessions/${encodeURIComponent(ctx.sessionId)}/messages`)
      .catch(() => undefined) // resync per the reconnect protocol; nothing is rendered from it
    line(dim("[reconnected]"), ctx)
    return true
  } catch {
    line(red("[连接断开，重连失败 — 输入 /exit 退出]"), ctx)
    return false
  }
}

/**
 * Send `text` and consume + render the run it triggers until its terminal
 * event. An unexpected socket close triggers {@link reconnect}; frames
 * observed after a reconnect are watchdogged (a dead daemon's run will never
 * complete, and the REPL must not hang forever waiting for it).
 *
 * The send itself lives here so the resend rule spans it: a send onto a dead
 * socket (silent drop, or the CONNECTING throw) is caught by the frames loop
 * seeing a closed socket with ZERO observed frames — the message never
 * reached a live daemon, so it is re-sent on the fresh socket. Any observed
 * frame (the ack counts — it proves the server queued the message) marks it
 * delivered; a later close never re-sends.
 */
async function renderRun(ctx: ChatCtx, text: string): Promise<void> {
  let pendingSend = true // message not yet confirmed onto a live socket
  let observedAny = false // any frame seen since entering (ack or run)
  let reconnected = false
  for (;;) {
    if (pendingSend) {
      pendingSend = false
      try {
        const attachments = [...ctx.pendingAttachments]
        ctx.ws.send({
          type: "send_message",
          sessionId: ctx.sessionId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        })
        ctx.pendingAttachments.length = 0
      } catch {
        // ws throws synchronously only while CONNECTING; a CLOSED socket
        // drops the frame silently instead. Either way nothing was
        // delivered — the closed frames loop below resends after reconnect.
      }
    }
    const frames = ctx.ws.frames[Symbol.asyncIterator]()
    for (;;) {
      const frame = reconnected
        ? await nextFrame(frames, POST_RECONNECT_SILENCE_MS)
        : await nextFrame(frames, Number.POSITIVE_INFINITY) // no artificial cap on a live run

      if (frame === "closed") {
        if (!(await reconnect(ctx))) return
        reconnected = true
        // Zero frames observed → the message never reached a live daemon →
        // safe (and required) to resend on the fresh socket. Otherwise the
        // run may already be queued server-side: never resend, just resume.
        if (!observedAny) pendingSend = true
        break // continue waiting on the new socket
      }
      if (frame === "timeout") {
        line(red("[等待运行事件超时 — 回到提示符]"), ctx)
        return
      }
      observedAny = true
      if (await renderFrame(frame, ctx)) return
    }
  }
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
  process.stdout.write(dim(`输入消息，/exit 退出，/new 新会话，/sessions 列表，Ctrl+C 取消当前 run\n`))

  const ctx: ChatCtx = {
    pendingAttachments: [],
    home: opts.home,
    client,
    ws: await openSubscribed(client, sessionId),
    sessionId,
    rl: createInterface({ input: process.stdin, output: process.stdout, prompt: "> " }),
    showThinking: opts.showThinking === true,
    auto,
    io: { atLineStart: true },
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
      ctx.ws.send({ type: "subscribe", sessionId: ctx.sessionId })
      ctx.pendingAttachments.length = 0 // attachments are session-scoped
    },
    exit() {
      // handled by the input loop (parsed.command === "exit" → break)
    },
    print(text: string) {
      line(text, ctx)
    },
    pauseInput() {
      ctx.rl.pause()
    },
    resumeInput() {
      ctx.rl.resume()
    },
    get pendingAttachments() {
      return ctx.pendingAttachments
    },
  }
  const registry = createRegistry(slashCtx)

  // Ctrl+C: cancel the active run first; a second press always exits. See
  // the module comment for why the handler lives on the readline interface.
  let runActive = false
  let sigints = 0
  ctx.rl.on("SIGINT", () => {
    sigints += 1
    if (sigints === 1) {
      if (runActive) {
        line(dim("^C 已请求取消当前 run（再按一次 Ctrl+C 退出）"), ctx)
        try {
          ctx.ws.send({ type: "run.cancel", sessionId: ctx.sessionId })
        } catch {
          // socket already closing — the run dies with the daemon anyway
        }
      } else {
        line(dim("^C 再按一次 Ctrl+C 退出"), ctx)
      }
      return
    }
    ctx.ws.close()
    ctx.rl.close()
    process.exit(130)
  })

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
        // Plain message: send and render the run it triggers.
        if (text !== "") {
          runActive = true
          await renderRun(ctx, text) // sends, renders, and (if needed) resends after reconnect
          runActive = false
        }
      } else if (parsed.command === "exit") {
        break
      } else {
        await runOrHint(parsed, registry, slashCtx)
      }
      prompt()
    }
  } finally {
    ctx.ws.close()
    ctx.rl.close()
  }
}
