import { describe, expect, it } from "vitest"
import { applyEvent, isSystemEvent, type SessionEvent } from "../../src/session/events.js"
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

  it("session.set 设置 model/readonly/disposition", () => {
    const meta = applyEvent(base, { type: "session.set", at: "2026-01-02T00:00:00.000Z", model: "gpt-4", readonly: true, disposition: "wait" })
    expect(meta.model).toBe("gpt-4")
    expect(meta.readonly).toBe(true)
    expect(meta.dispositionOverride).toBe("wait")
    expect(meta.updatedAt).toBe("2026-01-02T00:00:00.000Z")
  })

  it("session.set 值为 null 删除对应键（清除）", () => {
    const withAll = applyEvent(base, { type: "session.set", at: "a", model: "gpt-4", readonly: true, disposition: "steer" })
    const cleared = applyEvent(withAll, { type: "session.set", at: "b", model: null, readonly: null, disposition: null })
    expect(cleared.model).toBeUndefined()
    expect("model" in cleared).toBe(false)
    expect(cleared.readonly).toBeUndefined()
    expect("readonly" in cleared).toBe(false)
    expect(cleared.dispositionOverride).toBeUndefined()
    expect("dispositionOverride" in cleared).toBe(false)
  })

  it("session.set 字段为 undefined 时不动该键（{} 语义，向后兼容旧事件）", () => {
    const withModel = applyEvent(base, { type: "session.set", at: "a", model: "gpt-4" })
    // 旧事件不含 null：只带 readonly，不应清除已存在的 model
    const partial = applyEvent(withModel, { type: "session.set", at: "b", readonly: true })
    expect(partial.model).toBe("gpt-4")
    expect(partial.readonly).toBe(true)
    const withReadonly = applyEvent(base, { type: "session.set", at: "a", readonly: true })
    const untouched = applyEvent(withReadonly, { type: "session.set", at: "b", model: undefined })
    expect(untouched.readonly).toBe(true)
  })

  it("system 不刷 updatedAt 且不改任何投影字段", () => {
    const meta = applyEvent(base, { type: "system", at: "2026-01-04T00:00:00.000Z", text: "系统提示词全文" })
    expect(meta.updatedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(meta).toEqual(base)
  })
})

describe("isSystemEvent", () => {
  it("接受 system 事件", () => {
    expect(isSystemEvent({ type: "system", at: "2026-01-04T00:00:00.000Z", text: "系统提示词全文" })).toBe(true)
  })

  it("拒绝其他事件类型", () => {
    const events: SessionEvent[] = [
      { type: "message", id: "m1", sessionId: "ses_1", role: "user", blocks: [], createdAt: "2026-01-02T00:00:00.000Z" },
      { type: "compaction", at: "a", trigger: "auto", from: null, upto: "m10", messages: 10, segmentSummary: "s", top: "t" },
      { type: "memory", at: "a", trigger: "follow", kind: "episode", op: "append", topic: "kclaw" },
    ]
    for (const e of events) expect(isSystemEvent(e)).toBe(false)
  })
})
