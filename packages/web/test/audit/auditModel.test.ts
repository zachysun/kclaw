import { describe, it, expect } from "vitest"
import {
  appendEvents, DEFAULT_FILTER, filterRows, flattenAudit, fmtMs, fmtRowTime, fmtUsage,
  jumpTarget, matchRowIndexes, rowMatchesFilter,
} from "../../src/audit/model.js"
import type { AuditFilter, AuditRow } from "../../src/audit/model.js"
import type {
  Block, CompactionEvent, MessageEvent, SandboxCheckedEvent, SessionEvent, SystemEvent,
} from "../../src/types.js"

// ---------- fixtures ----------

function msgEvent(id: string, role: "user" | "assistant" | "tool", blocks: Block[], extra: Partial<MessageEvent> = {}): MessageEvent {
  return {
    type: "message", id, sessionId: "s1", role, blocks,
    createdAt: `2026-09-08T10:00:0${id.length % 10}.000Z`, ...extra,
  } as MessageEvent
}

const TEXT: Block = { id: "b1", type: "text", text: "你好世界" }
const TOOL_CALL: Block = { id: "b2", type: "tool_call", callId: "call_1", name: "exec", args: {}, argsJson: '{"command":"ls"}' }
const TOOL_RESULT: Block = { id: "b3", type: "tool_result", callId: "call_1", status: "ok", output: "file.txt", durationMs: 1250 }

const COMPACTION: CompactionEvent = {
  type: "compaction", at: "2026-09-08T10:05:00.000Z", trigger: "manual", from: null,
  upto: "msg_2", messages: 12, segmentSummary: "段摘要内容", top: "总摘要内容",
}

const SYSTEM: SystemEvent = { type: "system", at: "2026-09-08T10:00:00.000Z", text: "系统提示词正文" }
const SANDBOX: SandboxCheckedEvent = { type: "sandbox.checked", at: "2026-09-08T10:00:00.000Z", enabled: true, available: true }

// ---------- flattenAudit ----------

describe("flattenAudit", () => {
  it("渲染全部十种持久化事件：session 五类各成一行", () => {
    const events: SessionEvent[] = [
      { type: "session.created", at: "2026-09-08T09:00:00.000Z", title: "新会话" },
      { type: "session.renamed", at: "2026-09-08T09:01:00.000Z", title: "改名了" },
      { type: "session.set", at: "2026-09-08T09:02:00.000Z", mode: "acceptEdits" },
      { type: "session.deleted", at: "2026-09-08T09:03:00.000Z" },
      { type: "session.restored", at: "2026-09-08T09:04:00.000Z" },
    ]
    const rows = flattenAudit(events)
    expect(rows.map((r) => r.kind)).toEqual(["session", "session", "session", "session", "session"])
    expect(rows.every((r) => r.index >= 0)).toBe(true)
  })

  it("混合流：块行/压缩/记忆/系统/沙箱按事件序渲染，key 携带事件下标", () => {
    const events: SessionEvent[] = [
      { type: "session.created", at: "2026-09-08T09:00:00.000Z", title: "t" },
      msgEvent("msg_1", "user", [TEXT]),
      COMPACTION,
      { type: "memory", at: "2026-09-08T10:06:00.000Z", trigger: "immediate", kind: "episode", op: "append" },
      SYSTEM,
      SANDBOX,
    ]
    const rows = flattenAudit(events)
    expect(rows.map((r) => r.kind)).toEqual(["session", "block", "compaction", "memory", "system", "sandbox"])
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(rows[1]!.key).toBe("1-0")
    expect(rows[2]!.key).toBe("2")
  })

  it("assistant 消息块行带 usage/latencyMs，最后一块 messageTail=true", () => {
    const events: SessionEvent[] = [
      msgEvent("msg_1", "assistant", [TOOL_CALL, TEXT], {
        model: "m", usage: { inputTokens: 1234, outputTokens: 567 }, stopReason: "end_turn", latencyMs: 2300,
      }),
    ]
    const rows = flattenAudit(events) as Extract<AuditRow, { kind: "block" }>[]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.usage).toEqual({ inputTokens: 1234, outputTokens: 567 })
    expect(rows[0]!.latencyMs).toBe(2300)
    expect(rows[0]!.messageTail).toBe(false)
    expect(rows[1]!.messageTail).toBe(true) // token/时延显示在消息最后一块
  })

  it("user 与 tool 消息块行不带 usage/latencyMs", () => {
    const rows = flattenAudit([
      msgEvent("msg_1", "user", [TEXT]),
      msgEvent("msg_2", "tool", [TOOL_RESULT], { grantedBy: { call_1: "whitelist" } }),
    ]) as Extract<AuditRow, { kind: "block" }>[]
    expect(rows.every((r) => r.usage === undefined && r.latencyMs === undefined)).toBe(true)
  })

  it("tool 行 grantedBy 按 callId 跨消息关联（既有语义）", () => {
    const events: SessionEvent[] = [
      msgEvent("msg_1", "assistant", [TOOL_CALL]),
      msgEvent("msg_2", "tool", [TOOL_RESULT], { grantedBy: { call_1: "confirmed" } }),
    ]
    const rows = flattenAudit(events) as Extract<AuditRow, { kind: "block" }>[]
    expect(rows[0]!.grantedBy).toBe("confirmed")
    expect(rows[1]!.grantedBy).toBe("confirmed")
  })

  it("system 行 changed：首条不标、相同不标、不同标（既有语义）", () => {
    const events: SessionEvent[] = [
      { type: "system", at: "2026-09-08T10:00:00.000Z", text: "A" },
      { type: "system", at: "2026-09-08T10:01:00.000Z", text: "A" },
      { type: "system", at: "2026-09-08T10:02:00.000Z", text: "B" },
    ]
    const rows = flattenAudit(events) as Extract<AuditRow, { kind: "system" }>[]
    expect(rows.map((r) => r.changed)).toEqual([false, false, true])
  })

  it("空数组与 null", () => {
    expect(flattenAudit([])).toEqual([])
  })
})

// ---------- 过滤 ----------

function kindsFilter(off: AuditRow["kind"]): AuditFilter {
  return {
    ...DEFAULT_FILTER,
    kinds: {
      block: true, compaction: true, memory: true, system: true, sandbox: true, session: true,
      [off]: false,
    },
  }
}

const NOW = new Date("2026-09-08T12:00:00+08:00")

describe("rowMatchesFilter / filterRows", () => {
  const rows = flattenAudit([
    { type: "session.created", at: "2026-09-07T09:00:00.000Z", title: "昨天" },
    msgEvent("msg_1", "user", [TEXT]),
    COMPACTION,
  ])

  it("类型开关：关掉的行被筛掉", () => {
    expect(filterRows(rows, kindsFilter("compaction"), NOW).map((r) => r.kind)).not.toContain("compaction")
    expect(filterRows(rows, DEFAULT_FILTER, NOW)).toHaveLength(3)
  })

  it("时间预设 1h：只保留最近一小时内的行", () => {
    const f: AuditFilter = { ...DEFAULT_FILTER, timePreset: "1h" }
    const kept = filterRows(rows, f, NOW)
    expect(kept.map((r) => r.kind)).toEqual(["block", "compaction"]) // session.created 是昨天
  })

  it("时间预设 today：本地时区当天零点起的行", () => {
    const f: AuditFilter = { ...DEFAULT_FILTER, timePreset: "today" }
    const kept = filterRows(rows, f, NOW)
    expect(kept.map((r) => r.kind)).toEqual(["block", "compaction"])
  })

  it("custom：from/to 边界为闭区间，空串侧不设限", () => {
    const fromOnly: AuditFilter = { ...DEFAULT_FILTER, timePreset: "custom", timeFrom: "2026-09-08T00:00:00Z" }
    expect(filterRows(rows, fromOnly, NOW)).toHaveLength(2)
    const both: AuditFilter = {
      ...DEFAULT_FILTER, timePreset: "custom",
      timeFrom: "2026-09-08T09:59:00Z", timeTo: "2026-09-08T10:05:00Z",
    }
    // COMPACTION at 10:05 落在 to 上（含）；msg at 10:00:0x 落在区间内
    expect(filterRows(rows, both, NOW).map((r) => r.kind)).toEqual(["block", "compaction"])
  })
})

// ---------- 关键词（搜索不筛行，供高亮与跳转） ----------

describe("matchRowIndexes", () => {
  const rows = flattenAudit([
    msgEvent("msg_1", "user", [{ id: "b1", type: "text", text: "The Quick Brown Fox" }]),
    COMPACTION, // 段摘要/总摘要含"摘要内容"
    msgEvent("msg_2", "tool", [TOOL_RESULT], { grantedBy: { call_1: "safe" } }),
  ])

  it("大小写不敏感", () => {
    expect(matchRowIndexes(rows, "quick brown")).toEqual([0])
  })

  it("搜全文而非摘要（长输出被摘要截断仍可命中）", () => {
    const long: Block = { id: "b9", type: "tool_result", callId: "c9", status: "ok", output: `${"x".repeat(200)}needle`, durationMs: 1 }
    const r2 = flattenAudit([msgEvent("msg_9", "tool", [long])])
    expect(matchRowIndexes(r2, "needle")).toEqual([0])
  })

  it("压缩行搜段摘要与总摘要", () => {
    expect(matchRowIndexes(rows, "段摘要内容")).toEqual([1])
  })

  it("空关键词无命中", () => {
    expect(matchRowIndexes(rows, "")).toEqual([])
    expect(matchRowIndexes(rows, "   ")).toEqual([])
  })
})

// ---------- 跳转 ----------

describe("jumpTarget", () => {
  const candidates = [2, 5, 9]

  it("dir=1 找 from 之后最近的候选", () => {
    expect(jumpTarget(candidates, 0, 1)).toBe(2)
    expect(jumpTarget(candidates, 5, 1)).toBe(9)
  })

  it("dir=-1 找 from 之前最近的候选", () => {
    expect(jumpTarget(candidates, 9, -1)).toBe(5)
    expect(jumpTarget(candidates, 3, -1)).toBe(2)
  })

  it("到尾/到头回绕", () => {
    expect(jumpTarget(candidates, 9, 1)).toBe(2)
    expect(jumpTarget(candidates, 2, -1)).toBe(9)
  })

  it("无候选返回 null", () => {
    expect(jumpTarget([], 0, 1)).toBeNull()
  })
})

// ---------- 增量合并 ----------

describe("appendEvents", () => {
  it("append-only 拼接", () => {
    const a = [{ type: "session.created", at: "2026-09-08T09:00:00.000Z", title: "t" }] as SessionEvent[]
    const b = [msgEvent("msg_1", "user", [TEXT])]
    expect(appendEvents(a, b)).toHaveLength(2)
    expect(appendEvents(a, [])).toBe(a)
  })
})

// ---------- 格式化 ----------

describe("fmtMs", () => {
  it("毫秒/秒/分秒三档", () => {
    expect(fmtMs(450)).toBe("450ms")
    expect(fmtMs(2300)).toBe("2.3s")
    expect(fmtMs(64_000)).toBe("1m04s")
  })
})

describe("fmtUsage", () => {
  it("千分位与入出标注", () => {
    expect(fmtUsage({ inputTokens: 1234, outputTokens: 567 })).toBe("入 1,234 · 出 567")
  })
})

describe("fmtRowTime", () => {
  it("今天的行只显示时分秒，跨天显示月日时分", () => {
    const now = new Date("2026-09-08T12:00:00")
    expect(fmtRowTime("2026-09-08T07:05:09+08:00", now)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(fmtRowTime("2026-09-01T07:05:00+08:00", now)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})
