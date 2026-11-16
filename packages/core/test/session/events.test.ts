import { describe, expect, it } from "vitest"
import { applyEvent, isSandboxCheckedEvent, isSystemEvent, type SessionEvent } from "../../src/session/events.js"
import type { SessionMeta } from "../../src/session/store.js"

const base: SessionMeta = { id: "ses_1", title: "t", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }

describe("applyEvent", () => {
  it("session.created 初始化元数据", () => {
    const meta = applyEvent(base, { type: "session.created", at: "2026-01-01T00:00:00.000Z", title: "新会话", workdir: "/w" })
    expect(meta.title).toBe("新会话")
    expect(meta.workdir).toBe("/w")
  })

  it("session.created 带 mode 时投影进 meta.mode；不带则不设（旧事件流）", () => {
    const withMode = applyEvent(base, { type: "session.created", at: "a", title: "只读会话", mode: "readonly" })
    expect(withMode.mode).toBe("readonly")
    const legacy = applyEvent(base, { type: "session.created", at: "a", title: "旧会话" })
    expect("mode" in legacy).toBe(false)
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

  it("session.set 设置 model/mode/disposition", () => {
    const meta = applyEvent(base, { type: "session.set", at: "2026-01-02T00:00:00.000Z", model: "gpt-4", mode: "acceptEdits", disposition: "wait" })
    expect(meta.model).toBe("gpt-4")
    expect(meta.mode).toBe("acceptEdits")
    expect(meta.dispositionOverride).toBe("wait")
    expect(meta.updatedAt).toBe("2026-01-02T00:00:00.000Z")
  })

  it("session.set 值为 null 删除对应键（清除）", () => {
    const withAll = applyEvent(base, { type: "session.set", at: "a", model: "gpt-4", mode: "acceptEdits", disposition: "steer" })
    const cleared = applyEvent(withAll, { type: "session.set", at: "b", model: null, mode: null, disposition: null })
    expect(cleared.model).toBeUndefined()
    expect("model" in cleared).toBe(false)
    expect(cleared.mode).toBeUndefined()
    expect("mode" in cleared).toBe(false)
    expect(cleared.dispositionOverride).toBeUndefined()
    expect("dispositionOverride" in cleared).toBe(false)
  })

  it("session.set 字段为 undefined 时不动该键（{} 语义，向后兼容旧事件）", () => {
    const withModel = applyEvent(base, { type: "session.set", at: "a", model: "gpt-4" })
    // 旧事件不含 null：只带 mode，不应清除已存在的 model
    const partial = applyEvent(withModel, { type: "session.set", at: "b", mode: "readonly" })
    expect(partial.model).toBe("gpt-4")
    expect(partial.mode).toBe("readonly")
    const withMode = applyEvent(base, { type: "session.set", at: "a", mode: "readonly" })
    const untouched = applyEvent(withMode, { type: "session.set", at: "b", model: undefined })
    expect(untouched.mode).toBe("readonly")
  })

  it("system 双段逐段 upsert：不刷 updatedAt、基线外字段不动；段文本未变保留 frozenAt；compaction 清除基线", () => {
    // 双段事件：逐段冻结
    const meta = applyEvent(base, {
      type: "system", at: "2026-01-04T00:00:00.000Z",
      stable: "人设与注入约定", live: "认知与技能清单",
    })
    expect(meta.updatedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(meta.systemBaseline).toEqual({
      stable: { text: "人设与注入约定", frozenAt: "2026-01-04T00:00:00.000Z" },
      live: { text: "认知与技能清单", frozenAt: "2026-01-04T00:00:00.000Z" },
    })
    const { systemBaseline: _drop, ...rest } = meta
    const { systemBaseline: _dropBase, ...restBase } = base
    expect(rest).toEqual(restBase)
    // live 单独刷新：stable 的 frozenAt 保留（该文本仍是当初那份）
    const liveRefreshed = applyEvent(meta, {
      type: "system", at: "2026-01-04T12:00:00.000Z",
      stable: "人设与注入约定", live: "认知与技能清单（新技能）",
    })
    expect(liveRefreshed.systemBaseline!.stable).toEqual({ text: "人设与注入约定", frozenAt: "2026-01-04T00:00:00.000Z" })
    expect(liveRefreshed.systemBaseline!.live).toEqual({ text: "认知与技能清单（新技能）", frozenAt: "2026-01-04T12:00:00.000Z" })
    // stable 单独重冻结：live 的 frozenAt 保留
    const stableRefrozen = applyEvent(liveRefreshed, {
      type: "system", at: "2026-01-05T00:00:00.000Z",
      stable: "人设与注入约定（改）", live: "认知与技能清单（新技能）",
    })
    expect(stableRefrozen.systemBaseline!.stable.frozenAt).toBe("2026-01-05T00:00:00.000Z")
    expect(stableRefrozen.systemBaseline!.live.frozenAt).toBe("2026-01-04T12:00:00.000Z")
    const compacted = applyEvent(meta, { type: "compaction", at: "2026-01-05T00:00:00.000Z", trigger: "auto", from: null, upto: "m1", messages: 1, segmentSummary: "s", top: "t" })
    expect(compacted.systemBaseline).toBeUndefined()
    expect("systemBaseline" in compacted).toBe(false)
  })

  it("sandbox.checked 不刷 updatedAt 且不改任何投影字段（审计事件）", () => {
    const meta = applyEvent(base, {
      type: "sandbox.checked", at: "2026-01-05T00:00:00.000Z",
      enabled: true, available: false, unavailableReason: "bwrap not found on PATH",
    })
    expect(meta.updatedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(meta).toEqual(base)
  })

  it("run.started / run.ended / permission.decided 不刷 updatedAt 且不改任何投影字段（审计事件）", () => {
    const runStarted = applyEvent(base, {
      type: "run.started", at: "2026-01-05T00:00:00.000Z", trigger: "user",
    })
    expect(runStarted.updatedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(runStarted).toEqual(base)

    const runEnded = applyEvent(base, {
      type: "run.ended", at: "2026-01-05T00:00:00.000Z",
      stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 45 },
    })
    expect(runEnded.updatedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(runEnded).toEqual(base)

    const failed = applyEvent(base, {
      type: "run.ended", at: "2026-01-05T00:00:00.000Z",
      stopReason: "error", error: { code: "llm_error", message: "boom" },
    })
    expect(failed.updatedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(failed).toEqual(base)

    const decided = applyEvent(base, {
      type: "permission.decided", at: "2026-01-05T00:00:00.000Z",
      confirmationId: "conf_1", decision: "once", by: "cli",
      tool: { callId: "call_1", name: "bash", argsJson: '{"command":"ls"}' },
    })
    expect(decided.updatedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(decided).toEqual(base)
  })
})

describe("isSandboxCheckedEvent", () => {
  it("接受 sandbox.checked 事件", () => {
    expect(isSandboxCheckedEvent({ type: "sandbox.checked", at: "a", enabled: true, available: true })).toBe(true)
  })

  it("拒绝其他事件类型", () => {
    const events: SessionEvent[] = [
      { type: "message", id: "m1", sessionId: "ses_1", role: "user", blocks: [], createdAt: "2026-01-02T00:00:00.000Z" },
      { type: "system", at: "a", text: "x" },
      { type: "memory", at: "a", trigger: "follow", kind: "episode", op: "append", topic: "kclaw" },
    ]
    for (const e of events) expect(isSandboxCheckedEvent(e)).toBe(false)
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

// ---- uiPending 折叠（未决 UI 卡投影） -----------------------------------------

const buttonCard = { kind: "button", label: "批准" }
const chartCard = { kind: "chart", items: [{ label: "a", value: 1 }] }

/** tool 消息事件：一条 tool_result 块携带给定 data。 */
const toolEvent = (id: string, callId: string, data: unknown): SessionEvent => ({
  type: "message", id, sessionId: "ses_1", role: "tool", createdAt: "2026-01-02T00:00:00.000Z",
  blocks: [{ id: `blk_${id}`, type: "tool_result", callId, status: "ok", output: "ok", data, durationMs: 1 }],
})
const userPick = (callId: string): SessionEvent => ({
  type: "message", id: `msg_pick_${callId}`, sessionId: "ses_1", role: "user", createdAt: "2026-01-03T00:00:00.000Z",
  blocks: [], uiAction: { cardCallId: callId, optionId: "批准", decision: true },
})

describe("applyEvent uiPending fold", () => {
  it("tool 消息的交互卡进 uiPending；展示卡（chart）不进", () => {
    const withCard = applyEvent(base, toolEvent("msg_1", "call_1", buttonCard))
    expect(withCard.uiPending).toEqual([{ cardCallId: "call_1", messageId: "msg_1" }])
    const withChart = applyEvent(base, toolEvent("msg_1", "call_1", chartCard))
    expect(withChart.uiPending).toBeUndefined()
  })

  it("同一条 tool 消息多张交互卡逐块登记；重复事件按 callId 幂等", () => {
    const two: SessionEvent = {
      type: "message", id: "msg_1", sessionId: "ses_1", role: "tool", createdAt: "t",
      blocks: [
        { id: "b1", type: "tool_result", callId: "call_1", status: "ok", output: "ok", data: buttonCard, durationMs: 1 },
        { id: "b2", type: "tool_result", callId: "call_2", status: "ok", output: "ok", data: { kind: "form", title: "f", fields: [{ kind: "input", name: "a", label: "A" }] }, durationMs: 1 },
      ],
    }
    const both = applyEvent(base, two)
    expect(both.uiPending).toEqual([{ cardCallId: "call_1", messageId: "msg_1" }, { cardCallId: "call_2", messageId: "msg_1" }])
    const replayed = applyEvent(both, two)
    expect(replayed.uiPending).toEqual(both.uiPending)
  })

  it("带 decision 的用户消息移除对应条目；清空后删除字段", () => {
    const two = applyEvent(applyEvent(base, toolEvent("msg_1", "call_1", buttonCard)), toolEvent("msg_2", "call_2", buttonCard))
    const oneLeft = applyEvent(two, userPick("call_1"))
    expect(oneLeft.uiPending).toEqual([{ cardCallId: "call_2", messageId: "msg_2" }])
    const noneLeft = applyEvent(oneLeft, { ...userPick("call_2"), id: "msg_pick_2" })
    expect(noneLeft.uiPending).toBeUndefined()
    // 摘除不存在的 callId：数组保持原样（引用不换）
    const untouched = applyEvent(two, userPick("call_x"))
    expect(untouched.uiPending).toBe(two.uiPending)
  })

  it("提问类回传（无 decision）不移除条目：混合卡上追问折线点位，按钮决策保持未决", () => {
    // 混合卡：容器同卡装按钮与折线（登记判据认按钮），点位追问是提问语义。
    const mixedCard = {
      kind: "card", title: "发布",
      body: [buttonCard, { kind: "chart", chartType: "line", items: [{ label: "周三", value: 200 }] }],
    }
    const withMixed = applyEvent(base, toolEvent("msg_1", "call_1", mixedCard))
    expect(withMixed.uiPending).toEqual([{ cardCallId: "call_1", messageId: "msg_1" }])
    const question: SessionEvent = {
      type: "message", id: "msg_q1", sessionId: "ses_1", role: "user", createdAt: "t",
      blocks: [], uiAction: { cardCallId: "call_1", optionId: "周三" },
    }
    expect(applyEvent(withMixed, question).uiPending).toEqual(withMixed.uiPending)
  })

  it("message.truncated 按 messageId 清理截断区间内的条目", () => {
    const two = applyEvent(applyEvent(base, toolEvent("msg_a1", "call_1", buttonCard)), toolEvent("msg_b2", "call_2", buttonCard))
    const cut = applyEvent(two, { type: "message.truncated", at: "t", fromMessageId: "msg_b2" })
    expect(cut.uiPending).toEqual([{ cardCallId: "call_1", messageId: "msg_a1" }])
    const allGone = applyEvent(cut, { type: "message.truncated", at: "t", fromMessageId: "msg_a1" })
    expect(allGone.uiPending).toBeUndefined()
  })
})
