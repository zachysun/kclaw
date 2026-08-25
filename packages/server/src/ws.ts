import fastifyWebsocket from "@fastify/websocket"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { join } from "node:path"
import { realpathWithin } from "@kclaw/core"
import type { SessionStore } from "@kclaw/core"
import type { EventBus } from "./bus.js"
import type { RunManager, AttachmentRef } from "./run.js"
import { tokenEquals } from "./auth.js"
import type { ConfirmationActor } from "./confirm.js"

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
   * `confirmation.resolve` command, `send_message` rides `run.enqueue` and
   * `run.cancel` rides `run.cancel`. Absent → these commands answer an error
   * frame ("run manager not available").
   */
  run?: RunManager
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
 * Auth is per connection (the HTTP bearer hook must NOT gate the upgrade):
 * the first frame must be `{type:"auth", token}` (primary) or the token may
 * arrive via the `?token=` query (fallback). Anything else before auth, or a
 * wrong token, gets `{type:"error", message:"unauthorized"}` and close 4001.
 *
 * After auth the client may send `{type:"subscribe"|"unsubscribe", sessionId}`
 * commands (acked `{type:"subscribed"|"unsubscribed", sessionId}`),
 * `{type:"confirmation.resolve", confirmationId, approved, client?}` to answer
 * a pending confirmation — `client` is an optional "cli"|"web" provenance
 * (the web UI sends "web"; omitted defaults to "cli") passed through to the
 * broker's resolution (acked `{type:"confirmation.resolved_ack",
 * confirmationId, ok:true}`, or an error frame for an unknown/settled id —
 * the confirmation.resolved EVENT on the bus is emitted by the loop, never
 * here), `{type:"send_message", sessionId, text}` to queue an agent run on
 * the session (acked `{type:"send_message_ack", sessionId}` immediately —
 * the run's progress streams as run.* events over the bus, so a long run
 * never blocks the command channel), and `{type:"run.cancel", sessionId}` to
 * abort the session's active run (acked `{type:"run_cancel_ack", sessionId}`,
 * or an error frame "no active run"). The run commands require the app's
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

  socket.on("message", (raw) => {
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
    const msg = frame as {
      type?: unknown
      token?: unknown
      sessionId?: unknown
      confirmationId?: unknown
      approved?: unknown
      client?: unknown
      text?: unknown
      attachments?: unknown
    }

    if (!authenticated) {
      if (msg.type !== "auth") return reject()
      if (typeof msg.token !== "string" || !tokenEquals(msg.token, opts.token)) return reject()
      authenticated = true
      clearTimeout(authTimer)
      opts.bus.connect(socket)
      return
    }

    switch (msg.type) {
      case "auth":
        return send(socket, { type: "error", message: "already authenticated" })
      case "subscribe":
      case "unsubscribe": {
        const { sessionId } = msg
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return send(socket, {
            type: "error",
            message: `${msg.type} requires a non-empty string sessionId`,
          })
        }
        if (msg.type === "subscribe") opts.bus.subscribe(sessionId, socket)
        else opts.bus.unsubscribe(sessionId, socket)
        const ack = msg.type === "subscribe" ? "subscribed" : "unsubscribed"
        return send(socket, { type: ack, sessionId })
      }
      case "confirmation.resolve": {
        const broker = opts.run?.broker
        if (broker === undefined) {
          return send(socket, { type: "error", message: "confirmation gateway unavailable" })
        }
        const { confirmationId, approved, client } = msg
        if (typeof confirmationId !== "string" || confirmationId.length === 0
          || typeof approved !== "boolean") {
          return send(socket, {
            type: "error",
            message: "confirmation.resolve requires a non-empty string confirmationId and a boolean approved",
          })
        }
        if (client !== undefined && client !== "cli" && client !== "web") {
          return send(socket, {
            type: "error",
            message: 'confirmation.resolve client must be "cli" or "web"',
          })
        }
        // Verdict provenance: the web UI names itself (client:"web"); the CLI
        // omits it → "cli". The broker passes it through to the resolution.
        // The resulting confirmation.resolved event comes from the loop, not
        // from here.
        const actor: ConfirmationActor = client === "web" ? "web" : "cli"
        const ok = broker.resolve(confirmationId, approved, actor)
        if (!ok) return send(socket, { type: "error", message: "unknown confirmation" })
        return send(socket, { type: "confirmation.resolved_ack", confirmationId, ok: true })
      }
      case "send_message": {
        const run = opts.run
        if (run === undefined) {
          return send(socket, { type: "error", message: "run manager not available" })
        }
        const { sessionId, text, attachments } = msg
        if (typeof sessionId !== "string" || sessionId.length === 0
          || typeof text !== "string" || text.length === 0) {
          return send(socket, {
            type: "error",
            message: "send_message requires a non-empty string sessionId and a non-empty string text",
          })
        }
        if (opts.sessions.meta(sessionId) === undefined) {
          return send(socket, { type: "error", message: "session not found" })
        }
        // Optional attachments: [{path,name,size,mimeType}] with the path
        // realpath-verified to live under this session's attachments dir —
        // arbitrary paths would let any token holder read any file the daemon
        // can reach (the run mounts the file and the model echoes it).
        const refs = parseAttachmentRefs(attachments, opts.attachmentsDir, sessionId)
        if (refs === undefined) {
          return send(socket, { type: "error", message: "send_message attachments are invalid" })
        }
        // Queue the run but NEVER await it before acking: the outcome streams
        // to subscribers as run.* events, so a long run must not block this
        // command channel. The enqueue promise settles with the outcome and
        // does not reject for provider errors (runAgent resolves those), but
        // a store failure rejects — surface that on THIS socket only, after
        // the ack.
        run.enqueue(sessionId, { userText: text, trigger: "user", ...(refs.length > 0 ? { attachments: refs } : {}) }).catch((err: unknown) => {
          send(socket, {
            type: "error",
            message: `send_message failed: ${err instanceof Error ? err.message : String(err)}`,
          })
        })
        return send(socket, { type: "send_message_ack", sessionId })
      }
      case "run.cancel": {
        const run = opts.run
        if (run === undefined) {
          return send(socket, { type: "error", message: "run manager not available" })
        }
        const { sessionId } = msg
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return send(socket, {
            type: "error",
            message: "run.cancel requires a non-empty string sessionId",
          })
        }
        if (!run.cancel(sessionId)) {
          return send(socket, { type: "error", message: "no active run" })
        }
        // The aborted outcome arrives as run.completed {stopReason:"aborted"}
        // on the bus, once the loop reaches its next abort checkpoint.
        return send(socket, { type: "run_cancel_ack", sessionId })
      }
      default:
        return send(socket, {
          type: "error",
          message: `unknown command: ${typeof msg.type === "string" ? msg.type : JSON.stringify(msg.type)}`,
        })
    }
  })

  socket.on("close", () => {
    clearTimers()
    opts.bus.unsubscribe(socket)
  })
}

/**
 * Validate and normalize `send_message` attachments. Returns undefined when
 * the array (or any entry) is malformed, or when a path escapes the session's
 * attachments dir — undefined means "reject the whole message".
 */
function parseAttachmentRefs(
  attachments: unknown,
  attachmentsDir: string | undefined,
  sessionId: string,
): AttachmentRef[] | undefined {
  if (attachments === undefined) return []
  if (!Array.isArray(attachments)) return undefined
  if (attachmentsDir === undefined) return undefined // no uploads configured
  const refs: AttachmentRef[] = []
  for (const raw of attachments) {
    if (typeof raw !== "object" || raw === null) return undefined
    const { path, name, size, mimeType } = raw as Record<string, unknown>
    if (typeof path !== "string" || typeof name !== "string" || name.length === 0
      || typeof size !== "number" || typeof mimeType !== "string") {
      return undefined
    }
    const root = realpathWithin(join(attachmentsDir, sessionId))
    const resolved = realpathWithin(path)
    if (resolved !== root && !resolved.startsWith(root + "/")) return undefined
    refs.push({ path: resolved, name, size, mimeType })
  }
  return refs
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
