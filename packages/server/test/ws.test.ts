import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import WebSocket from "ws"
import { makeEvent } from "@kclaw/core"
import type { AgentEvent } from "@kclaw/core"
import type { FastifyInstance } from "fastify"
import { createApp, EventBus } from "../src/index.js"

const TOKEN = "t1"

/** Minimal in-memory stand-in for a socket, for bus unit tests. */
class FakeSocket {
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
}

function textDelta(delta: string, sessionId: string): AgentEvent {
  return makeEvent(
    "text.delta",
    { messageId: `msg_${delta}`, blockId: "blk_1", delta },
    { sessionId },
  )
}

describe("EventBus", () => {
  it("delivers an event only to sockets subscribed to its session", () => {
    const bus = new EventBus()
    const a = new FakeSocket()
    const b = new FakeSocket()
    bus.subscribe("ses_1", a)
    bus.subscribe("ses_2", b)

    bus.emit(textDelta("hi", "ses_1"))

    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(0)
    expect((JSON.parse(a.sent[0]) as AgentEvent).type).toBe("text.delta")
  })

  it("delivers the wire frame as the AgentEvent JSON envelope", () => {
    const bus = new EventBus()
    const a = new FakeSocket()
    bus.subscribe("ses_1", a)
    const e = textDelta("hi", "ses_1")

    bus.emit(e)

    expect(JSON.parse(a.sent[0])).toEqual(e)
  })

  it("broadcasts events without a sessionId to every connected socket", () => {
    const bus = new EventBus()
    const subscribed = new FakeSocket()
    const bare = new FakeSocket()
    bus.subscribe("ses_1", subscribed)
    bus.connect(bare)

    bus.emit(makeEvent("job.started", { jobId: "job_1" }))

    expect(JSON.parse(subscribed.sent[0])).toMatchObject({ type: "job.started" })
    expect(JSON.parse(bare.sent[0])).toMatchObject({ type: "job.started", payload: { jobId: "job_1" } })
  })

  it("lets one socket subscribe to multiple sessions", () => {
    const bus = new EventBus()
    const a = new FakeSocket()
    bus.subscribe("ses_1", a)
    bus.subscribe("ses_2", a)

    expect(bus.subscriberCount("ses_1")).toBe(1)
    expect(bus.subscriberCount("ses_2")).toBe(1)

    bus.emit(textDelta("one", "ses_1"))
    bus.emit(textDelta("two", "ses_2"))
    expect(a.sent).toHaveLength(2)
  })

  it("unsubscribe(socket) removes every subscription of that socket", () => {
    const bus = new EventBus()
    const a = new FakeSocket()
    bus.subscribe("ses_1", a)
    bus.subscribe("ses_2", a)

    bus.unsubscribe(a)
    expect(bus.subscriberCount("ses_1")).toBe(0)
    expect(bus.subscriberCount("ses_2")).toBe(0)

    bus.emit(textDelta("one", "ses_1"))
    bus.emit(makeEvent("job.started", { jobId: "job_1" }))
    expect(a.sent).toHaveLength(0)
  })

  it("unsubscribe(sessionId, socket) removes only that session's subscription", () => {
    const bus = new EventBus()
    const a = new FakeSocket()
    bus.subscribe("ses_1", a)
    bus.subscribe("ses_2", a)

    bus.unsubscribe("ses_1", a)

    expect(bus.subscriberCount("ses_1")).toBe(0)
    expect(bus.subscriberCount("ses_2")).toBe(1)
    bus.emit(textDelta("one", "ses_1"))
    bus.emit(textDelta("two", "ses_2"))
    expect(a.sent).toHaveLength(1)
  })

  it("subscriberCount counts distinct sockets per session", () => {
    const bus = new EventBus()
    const a = new FakeSocket()
    const b = new FakeSocket()
    bus.subscribe("ses_1", a)
    bus.subscribe("ses_1", b)
    bus.subscribe("ses_1", a) // idempotent re-subscribe

    expect(bus.subscriberCount("ses_1")).toBe(2)
    expect(bus.subscriberCount("ses_unknown")).toBe(0)
  })

  it("a subscriber whose send throws neither breaks emit nor starves the others (M-a)", () => {
    const bus = new EventBus()
    const broken = { send(): void { throw new Error("send boom") } }
    const healthy = new FakeSocket()
    // broken FIRST: the guard must keep iterating to the healthy socket
    bus.subscribe("ses_1", broken)
    bus.subscribe("ses_1", healthy)
    bus.connect(broken)
    bus.connect(healthy) // broadcast path (job.*) exercises connect()ed sockets too

    expect(() => bus.emit(textDelta("hi", "ses_1"))).not.toThrow()
    expect(() => bus.emit(makeEvent("job.started", { jobId: "job_1" }))).not.toThrow()

    // the healthy subscriber still got both the session event and the broadcast
    expect((JSON.parse(healthy.sent[0]!) as AgentEvent).type).toBe("text.delta")
    expect((JSON.parse(healthy.sent[1]!) as AgentEvent).type).toBe("job.started")
  })
})

describe("GET /ws", () => {
  let home: string
  let bus: EventBus
  let app: FastifyInstance
  let url: string
  const clients: WebSocket[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kclaw-ws-test-"))
    bus = new EventBus()
    app = await createApp({ home, token: TOKEN, bus })
    await app.listen({ host: "127.0.0.1", port: 0 })
    const addr = app.server.address()
    if (addr === null || typeof addr === "string") throw new Error("expected an AddressInfo")
    url = `ws://127.0.0.1:${(addr as AddressInfo).port}/ws`
  })

  afterEach(async () => {
    for (const ws of clients.splice(0)) await closeClient(ws)
    await app.close()
    await rm(home, { recursive: true, force: true })
  })

  it("decorates the app with the injected bus and defaults to a fresh one", async () => {
    expect(app.bus).toBe(bus)
    expect(app.bus).toBeInstanceOf(EventBus)

    const appDefault = await createApp({ home, token: TOKEN })
    try {
      expect(appDefault.bus).toBeInstanceOf(EventBus)
      expect(appDefault.bus).not.toBe(bus)
    } finally {
      await appDefault.close()
    }
  })

  it("GET /ws without an upgrade is not rejected by bearer auth (route is exempt)", async () => {
    const res = await app.inject({ method: "GET", url: "/ws" })
    expect(res.statusCode).not.toBe(401)
  })

  it("auth with a wrong token sends an error frame and closes with 4001", async () => {
    const ws = await connect()
    const frames: unknown[] = []
    ws.on("message", (data) => frames.push(JSON.parse(String(data))))

    ws.send(JSON.stringify({ type: "auth", token: "wrong" }))

    const closed = await nextClose(ws)
    expect(closed.code).toBe(4001)
    expect(frames.some((f) => (f as { type?: string }).type === "error")).toBe(true)
  })

  it("any pre-auth frame that is not a valid auth closes with 4001", async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_1" }))
    expect((await nextClose(ws)).code).toBe(4001)

    const ws2 = await connect()
    ws2.send("{not json")
    expect((await nextClose(ws2)).code).toBe(4001)
  })

  it("auth succeeds via the ?token= query without a first frame", async () => {
    const ws = await connect(`?token=${TOKEN}`)
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_1" }))
    expect(await nextMessage(ws)).toEqual({ type: "subscribed", sessionId: "ses_1" })
  })

  it("a wrong query token does not block first-frame auth", async () => {
    const ws = await connect("?token=wrong")
    ws.send(JSON.stringify({ type: "auth", token: TOKEN }))
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_1" }))
    expect(await nextMessage(ws)).toEqual({ type: "subscribed", sessionId: "ses_1" })
  })

  it("subscribe delivers that session's events and no others", async () => {
    const ws = await openAuthed()
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_1" }))
    expect(await nextMessage(ws)).toEqual({ type: "subscribed", sessionId: "ses_1" })
    expect(bus.subscriberCount("ses_1")).toBe(1)

    bus.emit(textDelta("hi", "ses_1"))
    const evt = (await nextMessage(ws)) as AgentEvent
    expect(evt.type).toBe("text.delta")
    expect(evt.sessionId).toBe("ses_1")
    expect(evt.payload).toEqual({ messageId: "msg_hi", blockId: "blk_1", delta: "hi" })

    bus.emit(textDelta("other", "ses_2"))
    await expectSilence(ws)
  })

  it("events without a sessionId are broadcast without any subscription", async () => {
    const ws = await openAuthed()
    // Roundtrip a subscribe/unsubscribe pair first: its acks prove the server
    // has already processed the auth frame (auth success itself is silent),
    // and leave the socket with no active subscription.
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_probe" }))
    expect(await nextMessage(ws)).toEqual({ type: "subscribed", sessionId: "ses_probe" })
    ws.send(JSON.stringify({ type: "unsubscribe", sessionId: "ses_probe" }))
    expect(await nextMessage(ws)).toEqual({ type: "unsubscribed", sessionId: "ses_probe" })

    bus.emit(makeEvent("job.started", { jobId: "job_1" }))

    const evt = (await nextMessage(ws)) as AgentEvent
    expect(evt.type).toBe("job.started")
    expect(evt.sessionId).toBeUndefined()
    expect(evt.payload).toEqual({ jobId: "job_1" })
  })

  it("a malformed frame gets an error frame and the connection stays open", async () => {
    const ws = await openAuthed()

    ws.send("{not json")
    const err = (await nextMessage(ws)) as { type: string; message: string }
    expect(err.type).toBe("error")
    expect(typeof err.message).toBe("string")
    expect(err.message.length).toBeGreaterThan(0)

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_1" }))
    expect(await nextMessage(ws)).toEqual({ type: "subscribed", sessionId: "ses_1" })
  })

  it("an unknown command gets an error frame and the connection stays open", async () => {
    const ws = await openAuthed()

    ws.send(JSON.stringify({ type: "dance" }))
    const err = (await nextMessage(ws)) as { type: string; message: string }
    expect(err.type).toBe("error")

    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_1" }))
    expect(await nextMessage(ws)).toEqual({ type: "subscribed", sessionId: "ses_1" })
  })

  it("subscribe with a missing or non-string sessionId gets an error frame", async () => {
    const ws = await openAuthed()

    ws.send(JSON.stringify({ type: "subscribe" }))
    expect(((await nextMessage(ws)) as { type: string }).type).toBe("error")

    ws.send(JSON.stringify({ type: "subscribe", sessionId: 42 }))
    expect(((await nextMessage(ws)) as { type: string }).type).toBe("error")
    expect(bus.subscriberCount("ses_1")).toBe(0)
  })

  it("unsubscribe stops delivery for that session", async () => {
    const ws = await openAuthed()
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_1" }))
    expect(await nextMessage(ws)).toEqual({ type: "subscribed", sessionId: "ses_1" })

    ws.send(JSON.stringify({ type: "unsubscribe", sessionId: "ses_1" }))
    expect(await nextMessage(ws)).toEqual({ type: "unsubscribed", sessionId: "ses_1" })
    expect(bus.subscriberCount("ses_1")).toBe(0)

    bus.emit(textDelta("hi", "ses_1"))
    await expectSilence(ws)

    // broadcast events still flow (only the session filter was removed)
    bus.emit(makeEvent("job.completed", { jobId: "job_1", summary: "done" }))
    expect(((await nextMessage(ws)) as AgentEvent).type).toBe("job.completed")
  })

  it("a closed connection is fully unsubscribed from the bus", async () => {
    const ws = await openAuthed()
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "ses_1" }))
    expect(await nextMessage(ws)).toEqual({ type: "subscribed", sessionId: "ses_1" })
    expect(bus.subscriberCount("ses_1")).toBe(1)

    await closeClient(ws)
    await waitUntil(() => bus.subscriberCount("ses_1") === 0)
  })

  // --- helpers -------------------------------------------------------------

  function connect(query = ""): Promise<WebSocket> {
    const ws = new WebSocket(`${url}${query}`)
    clients.push(ws)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws connect timeout")), 2000)
      ws.once("open", () => {
        clearTimeout(timer)
        resolve(ws)
      })
      ws.once("error", (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async function openAuthed(query = ""): Promise<WebSocket> {
    const ws = await connect(query)
    ws.send(JSON.stringify({ type: "auth", token: TOKEN }))
    return ws
  }
})

function nextMessage(ws: WebSocket, timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const listener = (data: unknown): void => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(String(data)))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    const timer = setTimeout(() => {
      ws.removeListener("message", listener)
      reject(new Error(`timeout after ${timeoutMs}ms waiting for a message`))
    }, timeoutMs)
    ws.once("message", listener)
  })
}

async function expectSilence(ws: WebSocket, timeoutMs = 200): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const listener = (data: unknown): void => reject(new Error(`unexpected message: ${String(data)}`))
    const timer = setTimeout(() => {
      ws.removeListener("message", listener)
      resolve()
    }, timeoutMs)
    ws.once("message", listener)
  })
}

function nextClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs)
    ws.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timer)
      resolve({ code, reason: reason.toString() })
    })
  })
}

async function closeClient(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve())
    ws.terminate()
  })
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met before timeout")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
