/**
 * WebSocket client for the kclaw daemon's event stream. Mirrors the CLI
 * client's frame queue: the first frame after open is `{type:"auth", token}`
 * (the server's per-connection auth); parsed frames flow through an async
 * iterator; a close with code 4001 (the server's auth-failure code) surfaces
 * as a {@link WsAuthError} on the iterator and the close code on onClose.
 *
 * Outbound frames sent while the socket is still CONNECTING (browser send()
 * would throw InvalidStateError) are buffered and flushed on open, AFTER the
 * auth frame, in arrival order — so a caller can subscribe immediately after
 * creating the client.
 *
 * Outbound shapes are the typed canon ClientCommand (@kclaw/core/protocol);
 * inbound frames stay unknown (the panel guards their structure).
 *
 * Reconnect is intentionally NOT included here — the App layer owns it.
 */
import type { ClientCommand } from "@kclaw/core/protocol"

/** Structural slice of WebSocket the client drives (browser or test fake). */
export interface WsLikeSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** Socket constructor seam, injectable in tests. */
export type WsSocketFactory = (url: string) => WsLikeSocket

/** Raised when the daemon closes the socket with the auth-failure code. */
export class WsAuthError extends Error {
  readonly code: number

  constructor(code = 4001) {
    super(`websocket auth failed (close ${code})`)
    this.name = "WsAuthError"
    this.code = code
  }
}

export interface WsClient {
  /** Send one typed command as a JSON frame (connection is already authenticated). */
  send(frame: ClientCommand): void
  /** Close the connection. */
  close(): void
  /**
   * Parsed frames as they arrive; the iterator ends on a normal close and
   * throws {@link WsAuthError} when the server closes with 4001.
   */
  frames: AsyncIterable<unknown>
  /** Register a close callback; fires immediately if already closed. */
  onClose(cb: (code?: number) => void): void
}

/** The server only sends JSON; a non-JSON frame is dropped. */
function defaultSocketFactory(url: string): WsLikeSocket {
  return new WebSocket(url) as unknown as WsLikeSocket
}

/**
 * Async frame queue: pushes wake exactly one waiting puller; a close resolves
 * remaining pullers with `done`, or rejects them with `error` when a failure
 * (auth) closed the socket.
 */
function frameQueue() {
  const pending: unknown[] = []
  const waiters: Array<(result: Promise<IteratorResult<unknown>>) => void> = []
  let closed = false
  let failure: Error | null = null

  const settle = (waiter: (result: Promise<IteratorResult<unknown>>) => void): void => {
    const frame = pending.shift()
    if (frame !== undefined) waiter(Promise.resolve({ value: frame, done: false }))
    else if (failure !== null) waiter(Promise.reject(failure))
    else if (closed) waiter(Promise.resolve({ value: undefined, done: true }))
    else waiters.push(waiter)
  }

  return {
    push(frame: unknown) {
      const waiter = waiters.shift()
      if (waiter === undefined) pending.push(frame)
      else waiter(Promise.resolve({ value: frame, done: false }))
    },
    close(error?: Error) {
      closed = true
      if (error !== undefined) failure = error
      for (const waiter of waiters.splice(0)) {
        if (failure !== null) waiter(Promise.reject(failure))
        else waiter(Promise.resolve({ value: undefined, done: true }))
      }
    },
    iterator: {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<unknown>> =>
            new Promise((resolve) => settle(resolve)),
        }
      },
    },
  }
}

/** The server's close code meaning "unauthorized" (see packages/server). */
const CLOSE_UNAUTHORIZED = 4001

export function createWsClient(
  url: string,
  token: string,
  socketFactory: WsSocketFactory = defaultSocketFactory,
): WsClient {
  const socket = socketFactory(url)
  const queue = frameQueue()
  const closeHandlers: Array<(code?: number) => void> = []
  // Outbound queue: a browser WebSocket's send() throws while CONNECTING, so
  // frames sent before open (e.g. the App subscribing right after creating the
  // client) are buffered here and flushed on open, AFTER the auth frame, in
  // arrival order. The inbound frame queue is untouched (single consumer).
  const pendingOut: string[] = []
  let opened = false
  let closeCode: number | undefined
  let closeNotified = false

  const notifyClose = (): void => {
    if (closeNotified) return
    closeNotified = true
    for (const cb of closeHandlers.splice(0)) cb(closeCode)
  }

  socket.onmessage = (event) => {
    try {
      queue.push(JSON.parse(String(event.data)) as unknown)
    } catch {
      // Non-JSON frame: drop.
    }
  }

  socket.onclose = (event) => {
    closeCode = event?.code
    // Auth failure is the only abnormal close the client treats specially.
    if (closeCode === CLOSE_UNAUTHORIZED) queue.close(new WsAuthError(closeCode))
    else queue.close()
    notifyClose()
  }

  socket.onerror = () => {
    // Errors are followed by a close event; nothing to surface here.
  }

  socket.onopen = () => {
    opened = true
    // Auth frame first, then the buffered commands in arrival order.
    socket.send(JSON.stringify({ type: "auth", token }))
    for (const frame of pendingOut.splice(0)) socket.send(frame)
  }

  return {
    send(frame) {
      const data = JSON.stringify(frame)
      if (opened) socket.send(data)
      else pendingOut.push(data)
    },
    close() {
      socket.close()
    },
    onClose(cb) {
      closeHandlers.push(cb)
      if (closeNotified) cb(closeCode)
    },
    frames: queue.iterator,
  }
}
