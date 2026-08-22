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
})
