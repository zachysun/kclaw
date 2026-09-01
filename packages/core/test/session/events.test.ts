import { describe, expect, it } from "vitest"
import { applyEvent, type SessionEvent } from "../../src/session/events.js"
import type { SessionMeta } from "../../src/session/store.js"

const base: SessionMeta = { id: "ses_1", title: "t", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }

describe("applyEvent", () => {
  it("session.created 初始化元数据", () => {
    const meta = applyEvent(base, { type: "session.created", at: "2026-01-01T00:00:00.000Z", title: "新会话", workdir: "/w" })
    expect(meta.title).toBe("新会话")
    expect(meta.workdir).toBe("/w")
  })

  it("message 刷 updatedAt", () => {
    const meta = applyEvent(base, { type: "message", id: "m1", sessionId: "ses_1", role: "user", blocks: [], createdAt: "2026-01-02T00:00:00.000Z" })
    expect(meta.updatedAt).toBe("2026-01-02T00:00:00.000Z")
  })

  it("memory 不刷 updatedAt 且不改任何投影字段", () => {
    const meta = applyEvent(base, { type: "memory", at: "2026-01-03T00:00:00.000Z", trigger: "follow", kind: "episode", op: "append", topic: "kclaw" })
    expect(meta.updatedAt).toBe("2026-01-01T00:00:00.000Z")
  })

  it("compaction 更新压缩状态并刷 updatedAt", () => {
    const meta = applyEvent(base, { type: "compaction", at: "2026-01-02T00:00:00.000Z", trigger: "auto", from: null, upto: "m10", messages: 10, segmentSummary: "s", top: "t" })
    expect(meta.compaction).toEqual({ segments: [{ upto: "m10", summary: "s" }], top: "t", upto: "m10" })
    expect(meta.updatedAt).toBe("2026-01-02T00:00:00.000Z")
  })

  it("compaction segments 累加", () => {
    const once = applyEvent(base, { type: "compaction", at: "a", trigger: "auto", from: null, upto: "m10", messages: 10, segmentSummary: "s1", top: "t1" })
    const twice = applyEvent(once, { type: "compaction", at: "b", trigger: "auto", from: "m10", upto: "m20", messages: 10, segmentSummary: "s2", top: "t2" })
    expect(twice.compaction!.segments).toEqual([{ upto: "m10", summary: "s1" }, { upto: "m20", summary: "s2" }])
    expect(twice.compaction!.top).toBe("t2")
  })
})
