import { afterEach, describe, expect, it, vi } from "vitest"
import { createCacheMarkerPolicy } from "../../src/provider/cache-markers.js"

interface Recorded {
  bodies: string[]
  statuses: Array<{ status: number; ok: boolean }>
  calls: number
}

/** post() replays the given statuses in order, recording every body sent. */
function fakePost(statuses: Array<number | { status: number; ok?: boolean }>): { rec: Recorded; post: (body: string) => Promise<Response> } {
  const rec: Recorded = { bodies: [], statuses: [], calls: 0 }
  const post = async (body: string): Promise<Response> => {
    const raw = statuses[Math.min(rec.calls, statuses.length - 1)]!
    const status = typeof raw === "number" ? raw : raw.status
    const ok = typeof raw === "number" ? status >= 200 && status < 300 : (raw.ok ?? (status >= 200 && status < 300))
    rec.bodies.push(body)
    rec.statuses.push({ status, ok })
    rec.calls++
    return new Response("x", { status })
  }
  return { rec, post }
}

const MARKED = JSON.stringify({ marked: true })
const PLAIN = JSON.stringify({ marked: false })

afterEach(() => {
  vi.restoreAllMocks()
})

describe("createCacheMarkerPolicy", () => {
  it("gate: entry opt-out and absent request payload both suppress markers", () => {
    const off = createCacheMarkerPolicy({ promptCacheEnabled: false })
    expect(off.wanted(true)).toBe(false)
    const on = createCacheMarkerPolicy({})
    expect(on.wanted(false)).toBe(false)
    expect(on.wanted(true)).toBe(true)
  })

  it("no 400 → single marked call, verdict untouched", async () => {
    const { rec, post } = fakePost([200])
    const policy = createCacheMarkerPolicy({})
    const res = await policy.send({
      wanted: policy.wanted(true),
      post,
      buildBody: (marked) => (marked ? MARKED : PLAIN),
      rejectedLogLine: "log",
    })
    expect(res.status).toBe(200)
    expect(rec.calls).toBe(1)
    expect(policy.wanted(true)).toBe(true)
  })

  it("400 → strip and retry once; success remembers the verdict", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { rec, post } = fakePost([400, 200])
    const policy = createCacheMarkerPolicy({})
    const res = await policy.send({
      wanted: policy.wanted(true),
      post,
      buildBody: (marked) => (marked ? MARKED : PLAIN),
      rejectedLogLine: "kclaw test: rejected",
    })
    expect(res.status).toBe(200)
    expect(rec.calls).toBe(2)
    expect(rec.bodies[0]).toBe(MARKED)
    expect(rec.bodies[1]).toBe(PLAIN)
    expect(errSpy).toHaveBeenCalledWith("kclaw test: rejected")
    // The verdict is remembered: the next request skips markers entirely.
    expect(policy.wanted(true)).toBe(false)
  })

  it("a retry that still fails does NOT remember the verdict", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { rec, post } = fakePost([400, 500])
    const policy = createCacheMarkerPolicy({})
    const res = await policy.send({
      wanted: policy.wanted(true),
      post,
      buildBody: (marked) => (marked ? MARKED : PLAIN),
      rejectedLogLine: "log",
    })
    // The failed retry is returned as-is; the caller surfaces llm http 500.
    expect(res.status).toBe(500)
    expect(rec.calls).toBe(2)
    expect(policy.wanted(true)).toBe(true)
  })

  it("does not strip when the request carried no markers", async () => {
    const { rec, post } = fakePost([400])
    const policy = createCacheMarkerPolicy({})
    const res = await policy.send({
      wanted: false,
      post,
      buildBody: (marked) => (marked ? MARKED : PLAIN),
      rejectedLogLine: "log",
    })
    expect(res.status).toBe(400)
    expect(rec.calls).toBe(1)
  })
})
