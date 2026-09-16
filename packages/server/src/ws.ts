import fastifyWebsocket from "@fastify/websocket"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { SessionStore } from "@kclaw/core"
import type { EventBus } from "@kclaw/core"
import type { RunManager } from "./run.js"
import type { TeamHost } from "./team.js"
import { tokenEquals } from "./auth.js"
import { checkCommandFrame } from "./command-check.js"
import type { ConfirmationActor } from "@kclaw/core"

/** Dependencies of the /ws route (injected by createApp). */
export interface WsOptions {
  bus: EventBus
  /** The same bearer token the HTTP API uses; supplied per connection, not per upgrade. */
  token: string
  /**
   * The session store backing this app's routes — `send_message` consults
   * `meta(sessionId)` to reject commands aimed at sessions that do not exist
   * (queueing one would silently create an orphan JSONL directory).
   */
  sessions: SessionStore
  /**
   * The daemon's attachments dir (`<home>/attachments`): when set,
   * `send_message` accepts attachment references whose path sits under
   * `<attachmentsDir>/<sessionId>/` (realpath-verified).
   */
  attachmentsDir?: string
  /**
   * The app's RunManager: its confirmation broker answers the
   * `confirmation.resolve` command, `send_message` rides `run.submit`,
   * `queue.cancel` rides `run.queueCancel` and `run.cancel` rides
   * `run.cancel`. Absent → these commands answer an error frame
   * ("run manager not available").
   */
  run?: RunManager
  /**
   * The team host (agent-team): when set, a `send_message` carrying a
   * `target` (a member name) is delivered through the team mailbox instead
   * of a plain run on the session.
   */
  team?: TeamHost
  /**
   * Pre-auth timeout in ms: a connection that has not authenticated when it
   * fires is closed with 4002. Test-injection seam — the daemon runs on the
   * default (10s).
   */
  authTimeoutMs?: number
  /**
   * Heartbeat interval in ms: after auth, pings the client and terminates the
   * connection after two consecutive missed pongs. Test-injection seam — the
   * daemon runs on the default (30s).
   */
  heartbeatMs?: number
}

/** Close code for WS authentication failures. */
const CLOSE_UNAUTHORIZED = 4001
/** Close code for a connection that never authenticated in time. */
const CLOSE_AUTH_TIMEOUT = 4002
/** Close code for an upgrade from a disallowed browser Origin. */
const CLOSE_ORIGIN_NOT_ALLOWED = 1008

const DEFAULT_AUTH_TIMEOUT_MS = 10_000
const DEFAULT_HEARTBEAT_MS = 30_000

/** Allowed Origin hosts: the daemon is loopback-only, so browser clients come from itself. */
const ALLOWED_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

/** Non-browser clients (no Origin header) pass; a browser Origin must be a loopback host. */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const host = new URL(origin).hostname.replace(/^\[/, "").replace(/\]$/, "")
    return ALLOWED_ORIGIN_HOSTS.has(host)
  } catch {
    return false
  }
}

/**
 * Structural subset of a ws WebSocket that the /ws handler needs — keeps the
 * module free of a direct `ws` type dependency (the plugin types flow in
 * through the route overload).
 */
interface WsConnection {
  send(data: string): void
  close(code?: number, reason?: string): void
  /** Ping the client (liveness probe); absent on non-ws implementations. */
  ping?(): void
  /** Abruptly destroy the connection (dead-link reaping); absent on fakes. */
  terminate?(): void
  on(event: "message", listener: (data: unknown) => void): unknown
  on(event: "close", listener: () => void): unknown
  on(event: "pong", listener: () => void): unknown
}

declare module "fastify" {
  interface FastifyInstance {
    /** The EventBus wired into this app; decorated by createApp. */
    bus: EventBus
  }
}

/**
 * Register the `GET /ws` websocket route on the app.
 *
 * The command frame shapes are typed in @kclaw/core/protocol (ClientCommand /
 * ServerFrame — the Protocol 正本); every field rule and error text lives in
 * command-check.ts, the single validation point. This comment keeps the
 * behavioral contract (ordering, ack pairing, close codes).
 *
 * Auth is per connection (the HTTP bearer hook must NOT gate the upgrade):
 * the first frame must be `{type:"auth", token}` (primary) or the token may
 * arrive via the `?token=` query (fallback). Anything else before auth, or a
 * wrong token, gets `{type:"error", message:"unauthorized"}` and close 4001.
 *
 * After auth the client may send `{type:"subscribe"|"unsubscribe", sessionId}`
 * commands (acked `{type:"subscribed"|"unsubscribed", sessionId}`),
 * `{type:"confirmation.resolve", confirmationId, decision, client?}` to answer
 * a pending confirmation — `client` is an optional "cli"|"web" provenance
 * (the web UI sends "web"; omitted defaults to "cli") passed through to the
 * broker's resolution (acked `{type:"confirmation.resolved_ack",
 * confirmationId, ok:true}`, or an error frame for an unknown/settled id —
 * the confirmation.resolved EVENT on the bus is emitted by the loop, never
 * here), `{type:"question.resolve", questionId, answers, client?}` to answer
 * a pending ask_user_questions call the same way (`answers` is one string
 * array per question; acked `{type:"question.resolved_ack", questionId,
 * ok:true}` — the question.resolved EVENT is emitted by the tool executor),
 * `{type:"send_message", sessionId, text, disposition?, attachments?}`
 * to submit an agent run on the session (acked
 * `{type:"send_message_ack", sessionId, messageId, queued}` immediately —
 * submit decides synchronously, and the run's progress streams as run.* events
 * over the bus, so a long run never blocks the command channel; a submit
 * throw (queue full / session gone) answers an error frame instead of an ack),
 * `{type:"queue.cancel", sessionId, messageId?}` to withdraw queued messages
 * before they execute (acked
 * `{type:"queue.cancel_ack", sessionId, cancelled}`, or an error frame
 * "已注入" for an already-injected id / "not found"), and
 * `{type:"run.cancel", sessionId}` to
 * abort the session's active run (acked `{type:"run_cancel_ack", sessionId}`,
 * or an error frame "no active run"), and `{type:"compaction.cancel",
 * sessionId}` to cut the session's in-flight auto compaction (acked
 * `{type:"compaction_cancel_ack", sessionId, active}` — `active` mirrors
 * whether a compaction was really in flight; none in flight is a normal
 * no-op ack, not an error). The run commands require the app's
 * RunManager and answer "run manager not available" without it. Unknown
 * commands and malformed JSON get an `{type:"error"}` frame and the
 * connection stays open. Connections that never authenticate are reaped by a
 * pre-auth timeout (close 4002); after auth a heartbeat pings the client and
 * a connection missing two consecutive pongs is terminated and unsubscribed;
 * upgrades carrying a non-loopback browser Origin are refused with close
 * 1008 (no Origin header passes — the CLI and other non-browser clients).
 */
export async function registerWsRoutes(app: FastifyInstance, opts: WsOptions): Promise<void> {
  await app.register(fastifyWebsocket)
  app.get("/ws", { websocket: true }, (socket, request) => {
    handleConnection(socket, request, opts)
  })
}

function handleConnection(socket: WsConnection, request: FastifyRequest, opts: WsOptions): void {
  if (!originAllowed(request.headers.origin)) {
    socket.close(CLOSE_ORIGIN_NOT_ALLOWED, "origin not allowed")
    return
  }
  let authenticated = false
  let ponged = true
  let misses = 0
  const heartbeatTimer = setInterval(() => {
    if (!authenticated || typeof socket.ping !== "function") return
    if (ponged) {
      ponged = false
      misses = 0
    } else if (++misses >= 2) {
      // Dead link (TCP up, peer gone silent): abrupt close + bus cleanup.
      socket.terminate?.()
      opts.bus.unsubscribe(socket)
      clearTimers()
      return
    }
    socket.ping()
  }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
  const authTimer = setTimeout(() => {
    if (!authenticated) socket.close(CLOSE_AUTH_TIMEOUT, "auth timeout")
  }, opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS)
  const clearTimers = (): void => {
    clearTimeout(authTimer)
    clearInterval(heartbeatTimer)
  }
  socket.on("pong", () => {
    ponged = true
    misses = 0
  })

  const reject = (): void => {
    send(socket, { type: "error", message: "unauthorized" })
    socket.close(CLOSE_UNAUTHORIZED, "unauthorized")
  }

  // URL ?token= fallback (the CLI uses the first frame instead).
  const queryToken = (request.query as Record<string, unknown>).token
  if (typeof queryToken === "string" && tokenEquals(queryToken, opts.token)) {
    authenticated = true
    clearTimeout(authTimer)
    opts.bus.connect(socket)
  }

  socket.on("message", async (raw) => {
    let frame: unknown
    try {
      frame = JSON.parse(frameText(raw))
    } catch {
      if (!authenticated) return reject()
      return send(socket, { type: "error", message: "frame is not valid JSON" })
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      if (!authenticated) return reject()
      return send(socket, { type: "error", message: "frame must be a JSON object" })
    }
    // 单一校验点：规则与报错文案全部住在 command-check.ts；下面只做分发。
    const check = checkCommandFrame(frame, {
      authenticated,
      token: opts.token,
      hasRun: opts.run !== undefined,
      sessionExists: (sessionId) => opts.sessions.meta(sessionId) !== undefined,
      attachmentsDir: opts.attachmentsDir,
    })
    if (check.kind === "reject") return reject()
    if (check.kind === "error") return send(socket, { type: "error", message: check.message })
    if (check.kind === "authenticated") {
      authenticated = true
      clearTimeout(authTimer)
      opts.bus.connect(socket)
      return
    }

    switch (check.command.type) {
      case "subscribe":
        opts.bus.subscribe(check.command.sessionId, socket)
        return send(socket, { type: "subscribed", sessionId: check.command.sessionId })
      case "unsubscribe":
        opts.bus.unsubscribe(check.command.sessionId, socket)
        return send(socket, { type: "unsubscribed", sessionId: check.command.sessionId })
      case "confirmation.resolve": {
        const broker = opts.run?.broker
        if (broker === undefined) {
          return send(socket, { type: "error", message: "confirmation gateway unavailable" })
        }
        // Verdict provenance: the web UI names itself (client:"web"); the CLI
        // omits it → "cli". The consequences of the verdict — the decided-rule
        // persistence for "always allow", the archive, the grants — all live
        // in the run assembly's resolveConfirmation seam, which sees every
        // settlement a human verdict can reach. The resulting
        // confirmation.resolved EVENT comes from the loop, not from here.
        const actor: ConfirmationActor = check.command.client === "web" ? "web" : "cli"
        const ok = broker.resolve(check.command.confirmationId, check.command.decision, actor)
        if (!ok) return send(socket, { type: "error", message: "unknown confirmation" })
        return send(socket, { type: "confirmation.resolved_ack", confirmationId: check.command.confirmationId, ok: true })
      }
      case "question.resolve": {
        const broker = opts.run?.broker
        if (broker === undefined) {
          return send(socket, { type: "error", message: "question gateway unavailable" })
        }
        // Answer provenance mirrors confirmations ("web" names itself). The
        // resulting question.resolved EVENT is emitted by the tool executor
        // when its race settles — never from here.
        const actor: ConfirmationActor = check.command.client === "web" ? "web" : "cli"
        const ok = broker.resolveQuestion(check.command.questionId, check.command.answers, actor)
        if (!ok) return send(socket, { type: "error", message: "unknown question" })
        return send(socket, { type: "question.resolved_ack", questionId: check.command.questionId, ok: true })
      }
      case "send_message": {
        const run = opts.run
        if (run === undefined) {
          return send(socket, { type: "error", message: "run manager not available" })
        }
        const { sessionId, text, disposition, attachments, target } = check.command
        // Team-targeted send: through the mailbox to one member (the session
        // must be the team lead); the ack carries the mailbox entry id.
        if (target !== undefined) {
          const team = opts.team
          if (team === undefined) {
            return send(socket, { type: "error", message: "team host not available" })
          }
          try {
            const r = await team.deliverUserToMember(sessionId, target, text)
            return send(socket, { type: "send_message_ack", sessionId, messageId: r.id, queued: false })
          } catch (err) {
            return send(socket, { type: "error", message: err instanceof Error ? err.message : String(err) })
          }
        }
        // submit 同步决策：成功立即 ack（携带 messageId/queued），失败 error frame（无 ack）。
        // run 本身由驱动器异步执行，进度走 bus。
        try {
          const r = run.submit(sessionId, {
            userText: text, trigger: "user",
            ...(disposition !== undefined ? { disposition } : {}),
            ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
          })
          return send(socket, { type: "send_message_ack", sessionId, messageId: r.messageId, queued: r.queued })
        } catch (err) {
          return send(socket, { type: "error", message: err instanceof Error ? err.message : String(err) })
        }
      }
      case "message.retry": {
        const run = opts.run
        if (run === undefined) {
          return send(socket, { type: "error", message: "run manager not available" })
        }
        const { sessionId, fromMessageId, text, attachments } = check.command
        // Same shape as send_message: synchronous decision (truncation +
        // submission) acked at once; the run itself streams over the bus.
        try {
          const r = run.retry(sessionId, fromMessageId, text, attachments)
          return send(socket, { type: "message.retry_ack", sessionId, messageId: r.messageId, queued: r.queued })
        } catch (err) {
          return send(socket, { type: "error", message: err instanceof Error ? err.message : String(err) })
        }
      }
      case "queue.cancel": {
        const run = opts.run
        if (run === undefined) {
          return send(socket, { type: "error", message: "run manager not available" })
        }
        const { sessionId, messageId } = check.command
        const res = run.queueCancel(sessionId, messageId)
        if (!res.ok) {
          return send(socket, { type: "error", message: res.reason === "injected" ? "已注入" : "not found" })
        }
        return send(socket, { type: "queue.cancel_ack", sessionId, cancelled: res.cancelled })
      }
      case "run.cancel": {
        const run = opts.run
        if (run === undefined) {
          return send(socket, { type: "error", message: "run manager not available" })
        }
        const { sessionId } = check.command
        if (!run.cancel(sessionId)) {
          return send(socket, { type: "error", message: "no active run" })
        }
        // The aborted outcome arrives as run.completed {stopReason:"aborted"}
        // on the bus, once the loop reaches its next abort checkpoint.
        return send(socket, { type: "run_cancel_ack", sessionId })
      }
      case "compaction.cancel": {
        const run = opts.run
        if (run === undefined) return send(socket, { type: "error", message: "run manager not available" })
        const { sessionId } = check.command
        const active = run.cancelCompaction(sessionId)
        return send(socket, { type: "compaction_cancel_ack", sessionId, active })
      }
    }
  })

  socket.on("close", () => {
    clearTimers()
    opts.bus.unsubscribe(socket)
  })
}

function send(socket: WsConnection, frame: unknown): void {
  // A socket that died between the action and this reply gets a dropped
  // frame, never a throw — same contract as bus.deliver. WsConnection is
  // structural: send() on a dead socket may throw depending on the
  // implementation (ws 8.x drops silently, reporting only via its optional
  // callback, which we never pass), so guard regardless.
  try {
    socket.send(JSON.stringify(frame))
  } catch {
    // already closed — nothing to deliver to
  }
}
/** Decode a ws message payload (Buffer, ArrayBuffer or Buffer[]) to UTF-8 text. */
function frameText(raw: unknown): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8")
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString("utf8")
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8")
  return String(raw)
}
