/**
 * KclawClient: the CLI's typed-ish handle on the daemon's HTTP
 * + WS API. Plain fetch with the home's Bearer token for HTTP; a `ws`
 * WebSocket to `ws://127.0.0.1:<port>/ws` whose first frame is
 * `{type:"auth", token}` (the server's per-connection auth) for events.
 *
 * `connect()` is the auto-lifecycle seam: it resolves the daemon from
 * `<home>/daemon.json` and, when nothing healthy is serving, runs
 * {@link ensureDaemon} first — so any command transparently works on a cold
 * machine (fresh token included: the spawned launch creates `<home>/token`).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import WebSocket from "ws"
import type { ClientCommand } from "@kclaw/core"
import { httpRequest } from "@kclaw/core/client-http"
import { defaultHome, ensureDaemon, probeHealth, readDaemonJson } from "./daemon-ctl.js"

/** The daemon only ever binds loopback (127.0.0.1). */
const HOST = "127.0.0.1"

/** Budget for the post-ensure health retry (belt and braces; ensureDaemon already polled). */
const CONNECT_RETRY_MS = 5_000

/** One parsed WS frame from the daemon, or an async iterator over them. */
export type WsFrame = Record<string, unknown>

/** Handle over one authenticated websocket connection to the daemon. */
export interface WsHandle {
  /** Send one typed command frame (@kclaw/core ClientCommand) on the authenticated connection. */
  send(frame: ClientCommand): void
  /** Close the connection (server keeps its own state cleanup). */
  close(): void
  /**
   * Parsed frames as they arrive; the iterator ends when the socket closes.
   * Bus events (run.*, job.*, session.*) for subscribed sessions plus every
   * broadcast (sessionId-less) event flow here after auth.
   */
  frames: AsyncIterable<WsFrame>
}

/**
 * Async frame queue shared by the ws event handlers and the iterator: pushes
 * wake exactly one waiting puller; a close resolves every remaining puller
 * with `{done: true}` (a rejected open never reaches the iterator).
 */
function frameQueue(): {
  push(frame: WsFrame): void
  close(): void
  iterator: AsyncIterable<WsFrame>
} {
  const pending: WsFrame[] = []
  const waiters: Array<(result: IteratorResult<WsFrame>) => void> = []
  let closed = false

  const settle = (waiter: (result: IteratorResult<WsFrame>) => void): void => {
    const frame = pending.shift()
    if (frame !== undefined) waiter({ value: frame, done: false })
    else if (closed) waiter({ value: undefined, done: true })
    else waiters.push(waiter)
  }

  return {
    push(frame) {
      const waiter = waiters.shift()
      if (waiter === undefined) pending.push(frame)
      else waiter({ value: frame, done: false })
    },
    close() {
      closed = true
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    },
    iterator: {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<WsFrame>> =>
            new Promise((resolve) => settle(resolve)),
        }
      },
    },
  }
}

/** Read `<home>/token` (created by the daemon launch when absent). */
function readToken(home: string): string {
  try {
    return readFileSync(join(home, "token"), "utf8").trim()
  } catch {
    throw new Error(`no token file in ${home} — start the daemon first ('kclaw daemon start')`)
  }
}

export class KclawClient {
  /** Base origin the daemon serves on, e.g. `http://127.0.0.1:52143`. */
  readonly base: string
  /** Bearer token from `<home>/token`. */
  readonly token: string

  constructor(base: string, token: string) {
    this.base = base
    this.token = token
  }

  /**
   * Connect to the daemon in `home` (default: KCLAW_HOME ?? ~/.kclaw),
   * spawning one when nothing healthy serves. Resolves with a client whose
   * base port and token were read AFTER any respawn.
   */
  static async connect(home?: string): Promise<KclawClient> {
    const h = home ?? defaultHome()
    let info = readDaemonJson(h)
    if (info === undefined || !(await probeHealth(info.port))) {
      await ensureDaemon(h)
      info = readDaemonJson(h)
      if (info === undefined) {
        throw new Error(`daemon started but ${join(h, "daemon.json")} is missing`)
      }
    }

    const client = new KclawClient(`http://${HOST}:${info.port}`, readToken(h))

    // Retry the probe briefly: the daemon may still be settling after a
    // concurrent respawn (ensureDaemon already saw it healthy once).
    const deadline = Date.now() + CONNECT_RETRY_MS
    while (!(await probeHealth(info.port))) {
      if (Date.now() >= deadline) throw new Error(`daemon on port ${info.port} stopped answering`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return client
  }

  /**
   * One HTTP request with the Bearer token; JSON in, JSON out. Non-2xx
   * throws with the server's `body.error` (fallback: `HTTP <status>`) —
   * the shared `httpRequest` base (@kclaw/core/client-http).
   */
  request(method: string, path: string, body?: unknown): Promise<unknown> {
    return httpRequest(`${this.base}${path}`, {
      method,
      body,
      getToken: () => this.token,
    })
  }

  /**
   * Open one authenticated websocket to the daemon: the connection resolves
   * after the socket is open AND the first frame (`{type:"auth", token}`)
   * has been written. Frames arrive parsed via {@link WsHandle.frames};
   * a failed open (refused, auth-rejected close) rejects the promise.
   */
  async ws(): Promise<WsHandle> {
    const socket = new WebSocket(`ws://${HOST}:${new URL(this.base).port}/ws`)
    const queue = frameQueue()

    const opened = new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", (err: Error) => reject(err))
      socket.once("close", () => reject(new Error("websocket closed before opening")))
    })
    socket.on("message", (raw: unknown) => {
      try {
        queue.push(JSON.parse(String(raw)) as WsFrame)
      } catch {
        // The server only sends JSON; a non-JSON frame is dropped.
      }
    })
    socket.on("close", () => queue.close())
    // An unlistened 'error' (e.g. ECONNRESET when the daemon is SIGKILLed
    // mid-connection) would crash the whole process as an uncaught exception.
    // 'close' always follows and ends the frames iterator; the reconnect
    // path takes over from there, so the error itself carries no action.
    socket.on("error", () => {})

    // A close after open only rejects the (already settled) open promise —
    // a no-op — so the pre-open listeners can stay; frames end via queue.close().
    await opened
    socket.send(JSON.stringify({ type: "auth", token: this.token }))
    return {
      send: (frame) => socket.send(JSON.stringify(frame)),
      close: () => socket.close(),
      frames: queue.iterator,
    }
  }

  /**
   * Upload a raw attachment body to a session's attachments dir. Returns the
   * stored file info; the returned path/name feed the send_message
   * `attachments` array.
   */
  uploadAttachment(sessionId: string, filename: string, body: Buffer, mimeType: string): Promise<{ file: { path: string; name: string; size: number } }> {
    return httpRequest(`${this.base}/sessions/${encodeURIComponent(sessionId)}/attachments?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      body,
      contentType: mimeType,
      getToken: () => this.token,
    }) as Promise<{ file: { path: string; name: string; size: number } }>
  }
}
