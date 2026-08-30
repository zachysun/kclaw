import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WriteLedger } from "../../src/memory/ledger.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-ledger-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("WriteLedger watermarks", () => {
  it("advances triggers independently and persists across reopen", () => {
    const p = join(dir, "state.json")
    const l = new WriteLedger(p)
    l.advance("interval", { sessionId: "ses_1", messageId: "msg_5" })
    l.advance("follow", { sessionId: "ses_1", messageId: "msg_2" })
    const reopened = new WriteLedger(p)
    expect(reopened.get("interval")).toEqual({ sessionId: "ses_1", messageId: "msg_5" })
    expect(reopened.get("follow")).toEqual({ sessionId: "ses_1", messageId: "msg_2" })
  })
  it("advanceAll pushes both triggers", () => {
    const l = new WriteLedger(join(dir, "state.json"))
    l.advanceAll({ sessionId: "ses_2", messageId: "msg_9" })
    expect(l.get("interval")).toEqual({ sessionId: "ses_2", messageId: "msg_9" })
    expect(l.get("follow")).toEqual({ sessionId: "ses_2", messageId: "msg_9" })
  })
})

describe("WriteLedger.messagesSince", () => {
  const sessions = [
    { id: "ses_1", createdAt: "2026-08-01T00:00:00Z", messages: [{ id: "m1" }, { id: "m2" }] },
    { id: "ses_2", createdAt: "2026-08-02T00:00:00Z", messages: [{ id: "m3" }, { id: "m4" }] },
  ]
  it("returns messages after the watermark across sessions", () => {
    const out = WriteLedger.messagesSince({ sessionId: "ses_1", messageId: "m2" }, sessions)
    expect(out).toEqual([{ sessionId: "ses_2", messageId: "m3" }, { sessionId: "ses_2", messageId: "m4" }])
  })
  it("merges same session tail and later sessions (project-wide range)", () => {
    const out = WriteLedger.messagesSince({ sessionId: "ses_1", messageId: "m1" }, sessions)
    expect(out).toHaveLength(3)
  })
  it("undefined watermark returns everything", () => {
    expect(WriteLedger.messagesSince(undefined, sessions)).toHaveLength(4)
  })
  it("deleted watermark session degrades to full range", () => {
    const out = WriteLedger.messagesSince({ sessionId: "ses_gone", messageId: "m0" }, sessions)
    expect(out).toHaveLength(4)
  })
})

describe("follow checks", () => {
  it("schedules, lists and clears; survives reopen", () => {
    const p = join(dir, "state.json")
    const l = new WriteLedger(p)
    l.scheduleFollowCheck("ses_1", "2026-08-29T10:00:00Z")
    expect(new WriteLedger(p).pendingFollowChecks()).toEqual([{ sessionId: "ses_1", endTurnAt: "2026-08-29T10:00:00Z" }])
    l.clearFollowCheck("ses_1")
    expect(l.pendingFollowChecks()).toEqual([])
  })
})
