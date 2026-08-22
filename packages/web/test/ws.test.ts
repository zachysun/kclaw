import { describe, it, expect } from "vitest"
import { createWsClient, WsAuthError, type WsLikeSocket } from "../src/ws.js"

/**
 * A controllable stand-in for a WebSocket that simulates the browser's
 * CONNECTING semantics: `send()` throws InvalidStateError until the socket has
 * opened (matching the real WebSocket readyState rules), and `open()` flips the
 * socket to OPEN before invoking `onopen` (createWsClient's handler).
 */
function makeFake() {
  const fake = {
    sent: [] as string[],
    closed: undefined as { code?: number; reason?: string } | undefined,
    _open: false,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as ((event: { code?: number }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    send(data: string) {
      if (!this._open) throw new DOMException("WebSocket is not open", "InvalidStateError")
      this.sent.push(data)
    },
    close(code?: number, reason?: string) {
      this.closed = { code, reason }
      this.onclose?.({ code })
    },
    open() {
      this._open = true
      this.onopen?.()
    },
  }
  return fake
}

/** Wire a fake into a client and open it, returning both so tests can drive the socket. */
function connect(fake: ReturnType<typeof makeFake>) {
  const client = createWsClient("ws://127.0.0.1:52143/ws", "tok-1", () => fake as unknown as WsLikeSocket)
  fake.open()
  return client
}

describe("ws.ts", () => {
  it("sends {type:auth, token} as the first frame on open", () => {
    const fake = makeFake()
    connect(fake)
    expect(fake.sent[0]).toBe(JSON.stringify({ type: "auth", token: "tok-1" }))
  })

  it("queues sends made before open and flushes them after auth, in order", () => {
    const fake = makeFake()
    const client = createWsClient("ws://127.0.0.1:52143/ws", "tok-1", () => fake as unknown as WsLikeSocket)
    // No send is possible on a CONNECTING socket, so nothing hits the wire yet.
    client.send({ type: "subscribe", sessionId: "s1" })
    client.send({ type: "send_message", sessionId: "s1", text: "hi" })
    expect(fake.sent).toEqual([])
    fake.open()
    expect(fake.sent).toEqual([
      JSON.stringify({ type: "auth", token: "tok-1" }),
      JSON.stringify({ type: "subscribe", sessionId: "s1" }),
      JSON.stringify({ type: "send_message", sessionId: "s1", text: "hi" }),
    ])
  })

  it("does not throw when sending before the socket opens", () => {
    const fake = makeFake()
    const client = createWsClient("ws://127.0.0.1:52143/ws", "tok-1", () => fake as unknown as WsLikeSocket)
    expect(() => client.send({ type: "subscribe", sessionId: "s1" })).not.toThrow()
  })

  it("delivers parsed frames in arrival order", async () => {
    const fake = makeFake()
    const client = connect(fake)
    fake.onmessage?.({ data: "1" })
    fake.onmessage?.({ data: "2" })
    fake.onmessage?.({ data: "3" })
    const iterator = client.frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toBe(1)
    expect((await iterator.next()).value).toBe(2)
    expect((await iterator.next()).value).toBe(3)
  })

  it("drops non-JSON frames without breaking the queue", async () => {
    const fake = makeFake()
    const client = connect(fake)
    fake.onmessage?.({ data: "not json" })
    fake.onmessage?.({ data: '{"type":"event"}' })
    const iterator = client.frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ type: "event" })
  })

  it("send() JSON-encodes outgoing objects", () => {
    const fake = makeFake()
    const client = connect(fake)
    client.send({ type: "subscribe", sessionId: "s1" })
    expect(fake.sent[1]).toBe(JSON.stringify({ type: "subscribe", sessionId: "s1" }))
  })

  it("calls onClose callbacks with the close code, including late registration", () => {
    const fake = makeFake()
    const client = connect(fake)
    const codes: Array<number | undefined> = []
    client.onClose((code) => codes.push(code))
    fake.onclose?.({ code: 1000 })
    client.onClose((code) => codes.push(code))
    expect(codes).toEqual([1000, 1000])
  })

  it("ends the frame iterator on a normal close", async () => {
    const fake = makeFake()
    const client = connect(fake)
    const iterator = client.frames[Symbol.asyncIterator]()
    fake.onclose?.({ code: 1000 })
    expect((await iterator.next()).done).toBe(true)
  })

  it("surfaces close 4001 as an auth failure on the frame iterator and onClose", async () => {
    const fake = makeFake()
    const client = connect(fake)
    const iterator = client.frames[Symbol.asyncIterator]()
    const codes: Array<number | undefined> = []
    client.onClose((code) => codes.push(code))
    fake.onclose?.({ code: 4001 })
    await expect(iterator.next()).rejects.toBeInstanceOf(WsAuthError)
    expect(codes).toEqual([4001])
  })

  it("close() forwards to the underlying socket", () => {
    const fake = makeFake()
    const client = connect(fake)
    client.close()
    // The browser default close() sends no explicit code; the server's own
    // close frames still surface through onclose/onClose as usual.
    expect(fake.closed).toEqual({ code: undefined, reason: undefined })
  })
})
