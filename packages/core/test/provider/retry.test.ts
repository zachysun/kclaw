import { describe, it, expect, vi } from "vitest"
import { withRetry } from "../../src/provider/retry.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"

function clientFailing(times: number, err: Error): LlmClient {
  let n = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      if (++n <= times) throw err
      yield { type: "text_delta", delta: "ok" }
    },
  }
}

describe("withRetry", () => {
  it("retries transient errors then succeeds", async () => {
    const onRetry = vi.fn()
    const c = withRetry(clientFailing(2, new Error("llm http 503: bad")), {
      baseDelayMs: 1, jitter: () => 0, onRetry,
    })
    const out: LlmStreamEvent[] = []
    for await (const e of c.stream({ model: "m", system: "", messages: [], tools: [] })) out.push(e)
    expect(out).toEqual([{ type: "text_delta", delta: "ok" }])
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0][0].attempt).toBe(1)
  })

  it("does not retry non-transient errors", async () => {
    const onRetry = vi.fn()
    const c = withRetry(clientFailing(1, new Error("llm http 401: bad key")), {
      baseDelayMs: 1, onRetry,
    })
    await expect(async () => {
      for await (const _ of c.stream({ model: "m", system: "", messages: [], tools: [] })) void _
    }).rejects.toThrow("401")
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("gives up after maxAttempts", async () => {
    const c = withRetry(clientFailing(99, new TypeError("fetch failed")), {
      maxAttempts: 3, baseDelayMs: 1, jitter: () => 0,
    })
    await expect(async () => {
      for await (const _ of c.stream({ model: "m", system: "", messages: [], tools: [] })) void _
    }).rejects.toThrow("fetch failed")
  })

  it("retries provider timeouts (`llm http timeout ...` is transient) then succeeds", async () => {
    const onRetry = vi.fn()
    const c = withRetry(clientFailing(1, new Error("llm http timeout after 50ms")), {
      baseDelayMs: 1, jitter: () => 0, onRetry,
    })
    const out: LlmStreamEvent[] = []
    for await (const e of c.stream({ model: "m", system: "", messages: [], tools: [] })) out.push(e)
    expect(out).toEqual([{ type: "text_delta", delta: "ok" }])
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("exhausts retries on persistent timeouts, surfacing the classified message", async () => {
    const c = withRetry(clientFailing(99, new Error("llm http timeout after 50ms")), {
      maxAttempts: 2, baseDelayMs: 1, jitter: () => 0,
    })
    await expect(async () => {
      for await (const _ of c.stream({ model: "m", system: "", messages: [], tools: [] })) void _
    }).rejects.toThrow(/^llm http timeout after 50ms/)
  })
})
