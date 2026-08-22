import type { AgentEvent } from "@kclaw/core"

/**
 * Structural stand-in for a connected client socket. Only `send` is required,
 * so the bus works with real ws WebSockets and test fakes alike.
 */
export interface BusSocket {
  send(data: string): void
}

/**
 * In-process fan-out for AgentEvents, keyed by session.
 *
 * - `subscribe(sessionId, socket)`: the socket receives every event whose
 *   `sessionId` matches. One socket may subscribe to many sessions;
 *   re-subscribing is idempotent.
 * - `connect(socket)`: registers an authenticated connection that has not
 *   (yet) subscribed to anything. Connected sockets receive every event
 *   WITHOUT a `sessionId` (job.*) — broadcasts go to all connections,
 *   not only subscribed ones.
 * - `emit(e)`: `JSON.stringify(e)` to the matching sockets only. Each
 *   delivery is guarded — a socket whose send throws is skipped, never
 *   allowed to starve the other subscribers or the emitter.
 * - `unsubscribe(socket)`: removes ALL state of that socket (used on
 *   disconnect); `unsubscribe(sessionId, socket)` drops one filter.
 */
export class EventBus {
  /** socket -> the set of sessionIds it subscribes to (may be empty). */
  private readonly sockets = new Map<BusSocket, Set<string>>()
  /** sessionId -> the set of sockets subscribed to it. */
  private readonly sessions = new Map<string, Set<BusSocket>>()

  /** Register a connected socket so it receives broadcast (sessionId-less) events. */
  connect(socket: BusSocket): void {
    if (!this.sockets.has(socket)) this.sockets.set(socket, new Set())
  }

  subscribe(sessionId: string, socket: BusSocket): void {
    let filters = this.sockets.get(socket)
    if (filters === undefined) {
      filters = new Set()
      this.sockets.set(socket, filters)
    }
    filters.add(sessionId)

    let subscribers = this.sessions.get(sessionId)
    if (subscribers === undefined) {
      subscribers = new Set()
      this.sessions.set(sessionId, subscribers)
    }
    subscribers.add(socket)
  }

  unsubscribe(socket: BusSocket): void
  unsubscribe(sessionId: string, socket: BusSocket): void
  unsubscribe(a: BusSocket | string, b?: BusSocket): void {
    // unsubscribe("ses_1", socket): drop this socket's filter for one session.
    if (typeof a === "string") {
      const socket = b
      if (socket === undefined) return
      const filters = this.sockets.get(socket)
      if (filters === undefined || !filters.delete(a)) return
      this.removeSubscriber(a, socket)
      return
    }

    // unsubscribe(socket): disconnect — drop every filter of this socket.
    const filters = this.sockets.get(a)
    if (filters === undefined) return
    this.sockets.delete(a)
    for (const sessionId of filters) this.removeSubscriber(sessionId, a)
  }

  /** Send `e` to the sockets subscribed to `e.sessionId`, or to all connections when it has none. */
  emit(e: AgentEvent): void {
    const data = JSON.stringify(e)
    if (e.sessionId === undefined) {
      for (const socket of this.sockets.keys()) this.deliver(socket, data)
      return
    }
    const subscribers = this.sessions.get(e.sessionId)
    if (subscribers === undefined) return
    for (const socket of subscribers) this.deliver(socket, data)
  }

  /** Number of distinct sockets currently subscribed to `sessionId`. */
  subscriberCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0
  }

  private removeSubscriber(sessionId: string, socket: BusSocket): void {
    const subscribers = this.sessions.get(sessionId)
    if (subscribers === undefined) return
    subscribers.delete(socket)
    if (subscribers.size === 0) this.sessions.delete(sessionId)
  }

  /**
   * One recipient, guarded (final-review M-a): a socket whose `send` throws
   * synchronously (e.g. a ws that already died) must neither abort the
   * remaining deliveries nor propagate into the emitter — scheduler-tick's
   * job.* broadcasts and RunManager's run events share this path, and a
   * throwing subscriber there would mark a healthy job failed. The broken
   * socket stays registered: unsubscribing is the ws layer's job on close.
   */
  private deliver(socket: BusSocket, data: string): void {
    try {
      socket.send(data)
    } catch {
      // dead subscriber — dropped frames until its close handler unsubscribes
    }
  }
}
