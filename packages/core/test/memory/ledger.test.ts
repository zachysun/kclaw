import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WriteLedger } from "../../src/memory/ledger.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-ledger-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("WriteLedger watermarks (per session)", () => {
  it("advances triggers independently per session and persists across reopen", () => {
    const p = join(dir, "state.json")
    const l = new WriteLedger(p)
    l.advance("ses_1", "interval", "msg_5")
    l.advance("ses_1", "follow", "msg_2")
    l.advance("ses_2", "follow", "msg_9")
    const reopened = new WriteLedger(p)
    expect(reopened.get("ses_1", "interval")).toBe("msg_5")
    expect(reopened.get("ses_1", "follow")).toBe("msg_2")
    expect(reopened.get("ses_2", "follow")).toBe("msg_9")
    expect(reopened.get("ses_2", "interval")).toBeUndefined()
  })
  it("advanceAll pushes both triggers of one session only", () => {
    const l = new WriteLedger(join(dir, "state.json"))
    l.advanceAll("ses_2", "msg_9")
    expect(l.get("ses_2", "interval")).toBe("msg_9")
    expect(l.get("ses_2", "follow")).toBe("msg_9")
    expect(l.get("ses_1", "interval")).toBeUndefined()
  })
  it("treats a legacy project-wide ledger as empty (no migration)", () => {
    // 旧结构顶层只有 interval/follow 键（2026-09-02 之前的项目级水位）：不迁移，
    // 视作空账本 —— 首次触发全量重扫，重复由提取去重 + 合并写兜底。
    const p = join(dir, "state.json")
    writeFileSync(p, JSON.stringify({
      watermarks: { interval: { sessionId: "ses_1", messageId: "msg_5" }, follow: { sessionId: "ses_1", messageId: "msg_2" } },
      intervalLastRun: "2026-09-01T00:00:00Z",
    }))
    const l = new WriteLedger(p)
    expect(l.get("ses_1", "interval")).toBeUndefined()
    expect(l.get("ses_1", "follow")).toBeUndefined()
    // 同文件的其余字段不受影响
    expect(l.getIntervalLastRun()).toBe("2026-09-01T00:00:00Z")
  })
})

describe("WriteLedger.later", () => {
  const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }]
  it("returns the later of two watermarks within one session", () => {
    expect(WriteLedger.later(messages, "m1", "m3")).toBe("m3")
    expect(WriteLedger.later(messages, "m3", "m1")).toBe("m3")
  })
  it("single side or missing messages resolve to the present one", () => {
    expect(WriteLedger.later(messages, "m2")).toBe("m2")
    expect(WriteLedger.later(messages, undefined, "m1")).toBe("m1")
    expect(WriteLedger.later(messages, "m_gone", "m2")).toBe("m2")
    expect(WriteLedger.later(messages, "m2", "m_gone")).toBe("m2")
  })
})

describe("WriteLedger.since", () => {
  const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }]
  it("returns messages after the watermark", () => {
    expect(WriteLedger.since("m1", messages)).toEqual([{ id: "m2" }, { id: "m3" }])
    expect(WriteLedger.since("m3", messages)).toEqual([])
  })
  it("undefined watermark returns everything", () => {
    expect(WriteLedger.since(undefined, messages)).toHaveLength(3)
  })
  it("deleted watermark message degrades to full range (prefer re-extract over loss)", () => {
    expect(WriteLedger.since("m_gone", messages)).toHaveLength(3)
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

describe("nightly fields", () => {
  it("persists the nightly baseline and last-run date across reopen", () => {
    const p = join(dir, "state.json")
    const l = new WriteLedger(p)
    expect(new WriteLedger(p).getNightlyBaseline()).toBeUndefined()
    expect(new WriteLedger(p).getNightlyLastRun()).toBeUndefined()
    l.setNightlyBaseline("2026-09-01")
    l.setNightlyLastRun("2026-09-02")
    const reopened = new WriteLedger(p)
    expect(reopened.getNightlyBaseline()).toBe("2026-09-01")
    expect(reopened.getNightlyLastRun()).toBe("2026-09-02")
  })
})
