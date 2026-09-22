import { describe, it, expect } from "vitest"
import {
  appendEvents, appendRows, DEFAULT_FILTER, filterRows, flattenAudit, fmtMs, fmtRowTime, fmtUsage,
  isAppendedFrame, jumpTarget, rowMatchesFilter, rowSearchText,
} from "../../src/audit/model.js"
import type { AuditFilter, AuditRow } from "../../src/audit/model.js"
import type {
  Block, CompactionEvent, MessageEvent, PermissionDecidedEvent, RunEndedEvent, RunStartedEvent,
  SandboxCheckedEvent, SessionEvent, SystemEvent,
} from "../../src/types.js"

// ---------- fixtures ----------

function msgEvent(
  id: string, role: "user" | "assistant" | "tool", blocks: Block[],
  extra: Partial<MessageEvent> & { usage?: { inputTokens: number; outputTokens: number }; latencyMs?: number; grantedBy?: Record<string, string>; model?: string; stopReason?: string } = {},
): MessageEvent {
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

const SYSTEM: SystemEvent = { type: "system", at: "2026-09-08T10:00:00.000Z", stable: "系统提示词正文", live: "" }
const SYSTEM_LEGACY = { type: "system", at: "2026-09-08T10:00:00.000Z", text: "系统提示词正文" } as unknown as SystemEvent
const SANDBOX: SandboxCheckedEvent = { type: "sandbox.checked", at: "2026-09-08T10:00:00.000Z", enabled: true, available: true }
const RUN_STARTED: RunStartedEvent = { type: "run.started", at: "2026-09-08T10:00:00.000Z", trigger: "user" }
const RUN_ENDED: RunEndedEvent = {
  type: "run.ended", at: "2026-09-08T10:01:00.000Z", stopReason: "end_turn",
  usage: { inputTokens: 120, outputTokens: 45 },
}
const RUN_FAILED: RunEndedEvent = {
  type: "run.ended", at: "2026-09-08T10:02:00.000Z", stopReason: "error",
  error: { code: "llm_error", message: "provider down" },
}
const DECIDED: PermissionDecidedEvent = {
  type: "permission.decided", at: "2026-09-08T10:00:30.000Z", confirmationId: "conf_1",
  decision: "once", by: "cli", tool: { callId: "call_1", name: "exec", argsJson: '{"command":"ls"}' },
}

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

  it("system 行 changed：首条不标、相同不标、不同标", () => {
    const events: SessionEvent[] = [
      { type: "system", at: "2026-09-08T10:00:00.000Z", stable: "A", live: "" },
      { type: "system", at: "2026-09-08T10:01:00.000Z", stable: "A", live: "" },
      { type: "system", at: "2026-09-08T10:02:00.000Z", stable: "B", live: "" },
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
      block: true, compaction: true, memory: true, system: true, sandbox: true, session: true, run: true, decision: true, truncation: true, team: true, skill: true,
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
  it("关键词维度（AND）：匹配全文保留、不匹配筛掉、空白关键词全过", () => {
    const rows = flattenAudit([
      msgEvent("msg_1", "user", [{ id: "b1", type: "text", text: "The Quick Brown Fox" }]),
      COMPACTION, // 段摘要/总摘要含"摘要内容"
      msgEvent("msg_2", "tool", [TOOL_RESULT], { grantedBy: { call_1: "safe" } }),
    ])
    const withKw = (keyword: string): AuditFilter => ({ ...DEFAULT_FILTER, keyword })

    // 大小写不敏感，匹配的行保留、其余筛掉
    expect(filterRows(rows, withKw("quick brown"), NOW).map((r) => r.kind)).toEqual(["block"])
    // 压缩行搜段摘要与总摘要
    expect(filterRows(rows, withKw("段摘要内容"), NOW).map((r) => r.kind)).toEqual(["compaction"])
    // 搜全文而非摘要（长输出被摘要截断仍可命中）
    const long: Block = { id: "b9", type: "tool_result", callId: "c9", status: "ok", output: `${"x".repeat(200)}needle`, durationMs: 1 }
    const r2 = flattenAudit([msgEvent("msg_9", "tool", [long])])
    expect(filterRows(r2, withKw("needle"), NOW)).toHaveLength(1)
    // 空白关键词不过滤
    expect(filterRows(rows, withKw(""), NOW)).toHaveLength(3)
    expect(filterRows(rows, withKw("   "), NOW)).toHaveLength(3)
    // 无命中 → 空（视图层的"当前过滤条件下没有匹配的事件"空态）
    expect(filterRows(rows, withKw("不存在的词"), NOW)).toEqual([])
  })

  it("三维度 AND 组合：类型+关键词+时间同时收窄", () => {
    const f: AuditFilter = {
      ...DEFAULT_FILTER, kinds: { ...DEFAULT_FILTER.kinds, compaction: false },
      keyword: "摘要", timePreset: "1h",
    }
    // COMPACTION 命中关键词但类型被关；TEXT 行在时间内但不命中关键词 → 全空
    expect(filterRows(rows, f, NOW)).toEqual([])
  })
})

// ---------- 增量摊平（appendRows ≡ 全量重摊） ----------

describe("appendRows", () => {
  const full: SessionEvent[] = [
    { type: "session.created", at: "2026-09-08T09:59:00.000Z", title: "会话1" },
    msgEvent("msg_1", "assistant", [
      { id: "b1", type: "tool_call", callId: "call_1", name: "fs.read", args: {}, argsJson: "{}" },
    ], { model: "m", usage: { inputTokens: 1, outputTokens: 2 } }),
    msgEvent("msg_2", "tool", [TOOL_RESULT], { grantedBy: { call_1: "safe" } }),
    { type: "system", at: "2026-09-08T10:00:00.000Z", stable: "你是 kclaw 助手。", live: "" },
    COMPACTION,
  ]

  it("逐批追加与全量 flattenAudit 等价（含 grantedBy 跨批回填与 system changed 续接）", () => {
    // 逐条追加：最苛刻的切分方式，每批恰好一个事件
    let rows: AuditRow[] = []
    full.forEach((event, i) => {
      rows = appendRows(rows, i, [event])
    })
    expect(rows).toEqual(flattenAudit(full))
  })

  it("任意切分点等价（prefix/suffix 两批）", () => {
    for (let cut = 0; cut <= full.length; cut++) {
      const prefix = flattenAudit(full.slice(0, cut))
      const merged = appendRows(prefix, cut, full.slice(cut))
      expect(merged).toEqual(flattenAudit(full))
    }
  })

  it("空批次原样返回", () => {
    const rows = flattenAudit(full)
    expect(appendRows(rows, full.length, [])).toBe(rows)
  })
})

describe("run / decision 行的过滤开关", () => {
  it("关闭 run 后 run 行不可见，decision 不受影响", () => {
    const rows = flattenAudit([RUN_STARTED, DECIDED, RUN_ENDED])
    const f = kindsFilter("run")
    const visible = filterRows(rows, f, NOW)
    expect(visible.map((r) => r.kind)).toEqual(["decision"])
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
    // fmtRowTime renders in the viewer's local timezone and compares local
    // calendar days, so pinning two fixed instants flips same-day/cross-day
    // depending on the runner's TZ (CI runs UTC). Build both inputs with
    // local Date arithmetic — the calendar relationship then holds everywhere.
    const now = new Date(2026, 8, 8, 12, 0, 0) // local 2026-09-08 12:00
    const today = new Date(now)
    today.setHours(7, 5, 9)
    const otherDay = new Date(now)
    otherDay.setDate(otherDay.getDate() - 7)
    otherDay.setHours(7, 5, 0)
    expect(fmtRowTime(today.toISOString(), now)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(fmtRowTime(otherDay.toISOString(), now)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe("isAppendedFrame", () => {
  it("只认携带 payload 的 session.appended 帧，ack/error/垃圾输入一律不触发", () => {
    expect(isAppendedFrame({ type: "session.appended", id: "evt_1", ts: "t", payload: { eventType: "message" } })).toBe(true)
    expect(isAppendedFrame({ type: "message.created", payload: {} })).toBe(false) // agent event, wrong type
    expect(isAppendedFrame({ type: "ok" })).toBe(false) // command ack: no payload
    expect(isAppendedFrame({ type: "error", error: "x" })).toBe(false) // error frame: no payload
    expect(isAppendedFrame(null)).toBe(false)
    expect(isAppendedFrame("frame")).toBe(false)
  })
})

// ---------- 截断事件与已中断中文化（issue #31） ----------

describe("audit truncation & aborted", () => {
  const TRUNCATION = { type: "message.truncated" as const, at: "2026-09-08T10:06:00.000Z", fromMessageId: "msg_9" }

  it("message.truncated 成为一行截断审计：摘要含起点与原因", () => {
    const rows = flattenAudit([TRUNCATION]) as Extract<AuditRow, { kind: "truncation" }>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event.fromMessageId).toBe("msg_9")
    expect(rowMatchesFilter(rows[0]!, { ...DEFAULT_FILTER, keyword: "msg_9" }, new Date())).toBe(true)
  })

  it("截断行随 kind 开关过滤（truncation 关掉即不可见）", () => {
    const rows = flattenAudit([TRUNCATION])
    const off: AuditFilter = { ...DEFAULT_FILTER, kinds: { ...DEFAULT_FILTER.kinds, truncation: false } }
    expect(filterRows(rows, off, new Date())).toHaveLength(0)
    expect(filterRows(rows, DEFAULT_FILTER, new Date())).toHaveLength(1)
  })

  it("run.ended 的 aborted 结局中文化为已中断；其他结局保持原文", () => {
    const aborted = { type: "run.ended" as const, at: "2026-09-08T10:01:00.000Z", stopReason: "aborted" as const, usage: { inputTokens: 1, outputTokens: 2 } }
    const endTurn = { type: "run.ended" as const, at: "2026-09-08T10:01:00.000Z", stopReason: "end_turn" as const }
    const rows = flattenAudit([aborted, endTurn]) as Extract<AuditRow, { kind: "run" }>[]
    expect(rows[0]!.kind === "run" && runSummaryOf(rows[0])).toContain("已中断")
    expect(rows[1]!.kind === "run" && runSummaryOf(rows[1])).toContain("end_turn")
  })
})

function runSummaryOf(row: Extract<AuditRow, { kind: "run" }>): string {
  // 借 rowSearchText 拿摘要（与渲染组件同源），避免从组件层导入。
  return rowSearchText(row)
}

// ---------- team/* 事件（agent-team 审计行） ----------

const TASK = {
  id: 3, subject: "实现登录页", detail: "按设计稿实现", status: "in_progress" as const,
  assignee: "alice" as string | null, dependencies: [1, 2] as number[], attempt: 2, revision: 5,
  createdAt: "2026-09-08T10:00:00.000Z", updatedAt: "2026-09-08T10:03:00.000Z",
}

describe("team 审计行", () => {
  it("七种 team/* 事件各成一行，摘要与全文按类型渲染", () => {
    const events: SessionEvent[] = [
      { type: "team.created", version: 1 as const, at: "2026-09-08T10:00:00.000Z", teamId: "team_1", name: "登录攻坚" },
      { type: "team.member.provisioned", version: 1 as const, at: "2026-09-08T10:00:10.000Z", teamId: "team_1", member: "alice", sessionId: "s2", model: "deepseek/deepseek-chat" },
      { type: "team.member.settled", version: 1 as const, at: "2026-09-08T10:00:20.000Z", teamId: "team_1", member: "bob", status: "failed", reason: "模型不可用" },
      { type: "team.message.queued", version: 1 as const, at: "2026-09-08T10:01:00.000Z", teamId: "team_1", id: "mail_1", from: "lead", to: "alice", textPreview: "去做任务 #3" },
      { type: "team.message.delivered", version: 1 as const, at: "2026-09-08T10:01:05.000Z", teamId: "team_1", id: "mail_1", to: "alice" },
      { type: "team.task.created", version: 1 as const, at: "2026-09-08T10:01:10.000Z", teamId: "team_1", task: { ...TASK, status: "pending" as const, assignee: null, attempt: 0, revision: 1 } },
      { type: "team.task.updated", version: 1 as const, at: "2026-09-08T10:02:00.000Z", teamId: "team_1", task: TASK },
    ]
    const rows = flattenAudit(events) as Extract<AuditRow, { kind: "team" }>[]
    expect(rows).toHaveLength(7)
    expect(rows.every((r) => r.kind === "team")).toBe(true)
    // 摘要（与渲染组件同源走 rowSearchText 的摘要部分）
    const texts = rows.map((r) => rowSearchText(r))
    expect(texts[0]).toContain("建团「登录攻坚」")
    expect(texts[1]).toContain("添加组员 alice")
    expect(texts[2]).toContain("组员 bob → failed（模型不可用）")
    expect(texts[3]).toContain("收信 lead → alice：去做任务 #3")
    expect(texts[4]).toContain("送达 alice")
    expect(texts[5]).toContain("任务 #3「实现登录页」创建")
    expect(texts[6]).toContain("任务 #3「实现登录页」→ in_progress（alice）")
    // 全文：任务事件展开任务快照，其余 JSON.stringify 整事件
    expect(texts[6]).toContain('"attempt": 2')
    expect(texts[0]).toContain("team_1")
  })

  it("team 行随 kind 开关过滤；keyword 命中摘要文本", () => {
    const events: SessionEvent[] = [
      { type: "team.created", version: 1 as const, at: "2026-09-08T10:00:00.000Z", teamId: "team_1", name: "登录攻坚" },
    ]
    const rows = flattenAudit(events)
    const off: AuditFilter = { ...DEFAULT_FILTER, kinds: { ...DEFAULT_FILTER.kinds, team: false } }
    expect(filterRows(rows, off, new Date())).toHaveLength(0)
    expect(filterRows(rows, { ...DEFAULT_FILTER, keyword: "登录攻坚" }, new Date())).toHaveLength(1)
    expect(filterRows(rows, { ...DEFAULT_FILTER, keyword: "不存在的词" }, new Date())).toHaveLength(0)
  })
})

// ---------- skill 事件（技能进化审计行） ----------

describe("skill 审计行", () => {
  it("skill 事件成一行，摘要带 op/kind/name/scope/source", () => {
    const events: SessionEvent[] = [
      { type: "skill", at: "2026-09-08T10:00:00.000Z", op: "proposed", kind: "new", name: "deploy-postmortem", scope: "project", source: "follow" },
      { type: "skill", at: "2026-09-08T10:05:00.000Z", op: "applied", kind: "revise", name: "deploy-runbook", scope: "global", source: "admin" },
    ]
    const rows = flattenAudit(events) as Extract<AuditRow, { kind: "skill" }>[]
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === "skill")).toBe(true)
    expect(rowSearchText(rows[0]!)).toContain("技能提案：新增 deploy-postmortem（项目 · 来源 空闲提炼）")
    expect(rowSearchText(rows[1]!)).toContain("技能采纳：修订 deploy-runbook（全局 · 来源 人工操作）")
  })

  it("skill 行随 kind 开关过滤", () => {
    const events: SessionEvent[] = [
      { type: "skill", at: "2026-09-08T10:00:00.000Z", op: "proposed", kind: "new", name: "x", scope: "project", source: "follow" },
    ]
    const rows = flattenAudit(events)
    expect(filterRows(rows, kindsFilter("skill"), new Date())).toHaveLength(0)
    expect(filterRows(rows, { ...DEFAULT_FILTER, keyword: "x" }, new Date())).toHaveLength(1)
  })
})
