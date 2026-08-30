import { describe, it, expect } from "vitest"
import { makeEvent } from "../../src/protocol/events.js"

describe("makeEvent", () => {
  it("builds envelope with ulid id and iso ts", () => {
    const e = makeEvent("text.delta", { messageId: "msg_1", blockId: "blk_1", delta: "a" }, { sessionId: "ses_1", runId: "run_1" })
    expect(e.id).toMatch(/^evt_/)
    expect(e.type).toBe("text.delta")
    expect(e.sessionId).toBe("ses_1")
    expect(new Date(e.ts).getTime()).toBeGreaterThan(0)
  })
  it("strips undefined sessionId/runId", () => {
    const e = makeEvent("job.started", { jobId: "job_1" })
    expect(e).not.toHaveProperty("sessionId")
    expect(e).not.toHaveProperty("runId")
  })
  it("builds compaction lifecycle events", () => {
    const started = makeEvent("compaction.started", { phase: "post-run" }, { sessionId: "ses_1" })
    expect(started.type).toBe("compaction.started")
    const completed = makeEvent("compaction.completed", { segments: 2, kept: 5, phase: "post-run", result: "ok" }, { sessionId: "ses_1" })
    expect(completed.payload).toEqual({ segments: 2, kept: 5, phase: "post-run", result: "ok" })
  })
  it("compaction.started 携带 phase，completed 携带 phase 与 result", () => {
    const started = makeEvent("compaction.started", { phase: "in-run" }, { sessionId: "s1" })
    const done = makeEvent("compaction.completed", { segments: 2, kept: 5, phase: "in-run", result: "ok" }, { sessionId: "s1" })
    expect(started.payload.phase).toBe("in-run")
    expect(done.payload.result).toBe("ok")
  })
})

describe("queue events", () => {
  it("makeEvent carries the three new payloads with session context", () => {
    const q = makeEvent("message.queued", { messageId: "msg_1", disposition: "wait", position: 2 }, { sessionId: "ses_1" })
    expect(q.type).toBe("message.queued")
    expect(q.payload).toEqual({ messageId: "msg_1", disposition: "wait", position: 2 })
    const s = makeEvent("message.steered", { messageId: "msg_1" }, { sessionId: "ses_1", runId: "run_1" })
    expect(s.runId).toBe("run_1")
    const c = makeEvent("message.queue_cancelled", { all: true }, { sessionId: "ses_1" })
    expect(c.payload.all).toBe(true)
  })
})
