/**
 * Daily（日报）测试：纯函数（卡片解析 / 文件读写）+ pipeline 生成 + system
 * 触发与手动重新生成。fake LLM 与临时目录沿用记忆测试的既有写法
 * （scriptedLlm + mkdtemp + 真 SessionStore）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DailyRegenerateError, DAILY_CARD_LIMIT, listDailyDates, localDateOf, localMidnightIso,
  parseDailyCards, readDailyReport, writeDailyReport,
} from "../../src/memory/daily.js"
import { MemoryPipeline } from "../../src/memory/pipeline.js"
import { MemorySystem } from "../../src/memory/system.js"
import { projectIdFor } from "../../src/memory/layout.js"
import { SessionStore } from "../../src/session/store.js"
import { defaultConfig } from "../../src/storage/config.js"
import type { ChoreUsageRecorder } from "../../src/storage/usage.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import { scriptedLlm } from "./helpers.js"

let root: string
let sessions: SessionStore
const WORKDIR = "/w/kclaw"

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kclaw-daily-"))
  sessions = new SessionStore(join(root, "sessions"))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const projectDir = (): string => join(root, "memory", "projects", projectIdFor(WORKDIR))

const card = (kind: string, title: string, body: string, options: Array<{ label: string; opener: string }> = [{ label: "继续", opener: "关于 X 的卡片…" }]) =>
  ({ kind, title, body, options })

describe("parseDailyCards", () => {
  const log = (m: string): void => { logs.push(m) }
  let logs: string[] = []
  beforeEach(() => { logs = [] })

  it("parses valid cards and keeps their options", () => {
    const raw = JSON.stringify({ cards: [card("achievement", "上线", "今天把日报功能上线了。")] })
    const cards = parseDailyCards(raw, log)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.kind).toBe("achievement")
    expect(cards[0]!.options[0]!.opener).toContain("X")
  })

  it("tolerates a fenced response", () => {
    const raw = "```json\n" + JSON.stringify({ cards: [card("lesson", "坑", "时区坑。")] }) + "\n```"
    expect(parseDailyCards(raw, log)).toHaveLength(1)
  })

  it("drops malformed cards and malformed options, keeps the legal rest", () => {
    const raw = JSON.stringify({ cards: [
      { kind: "win", title: "非法类型", body: "x" },
      { kind: "lesson", title: "", body: "缺标题" },
      { kind: "lesson", title: "好卡", body: "正文", options: [{ label: "无 opener", opener: "" }, { label: "好选项", opener: "自包含文案" }] },
    ] })
    const cards = parseDailyCards(raw, log)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.options).toEqual([{ label: "好选项", opener: "自包含文案" }])
    expect(logs.some((l) => l.includes("dropping malformed card"))).toBe(true)
    expect(logs.some((l) => l.includes("dropping malformed option"))).toBe(true)
  })

  it("caps the card list at DAILY_CARD_LIMIT", () => {
    const many = Array.from({ length: DAILY_CARD_LIMIT + 4 }, (_, i) => card("insight", `观察 ${i}`, `正文 ${i}`))
    expect(parseDailyCards(JSON.stringify({ cards: many }), log)).toHaveLength(DAILY_CARD_LIMIT)
  })

  it("returns [] for unparseable text or a missing cards array", () => {
    expect(parseDailyCards("不是 JSON", log)).toEqual([])
    expect(parseDailyCards(JSON.stringify({ actions: [] }), log)).toEqual([])
    expect(logs.some((l) => l.includes("unparseable"))).toBe(true)
  })
})

describe("daily 文件读写", () => {
  it("writes then reads back the full report; lists dates newest first", () => {
    const dir = projectDir()
    writeDailyReport(dir, { date: "2026-11-19", windowStart: "2026-11-19T00:00:00Z", windowEnd: "2026-11-19T08:00:00Z", generatedAt: "2026-11-19T08:00:00Z", cards: [card("achievement", "A", "a")] })
    writeDailyReport(dir, { date: "2026-11-18", windowStart: "2026-11-18T00:00:00Z", windowEnd: "2026-11-18T08:00:00Z", generatedAt: "2026-11-18T08:00:00Z", cards: [] })
    expect(listDailyDates(dir)).toEqual(["2026-11-19", "2026-11-18"])
    const report = readDailyReport(dir, "2026-11-19")
    expect(report?.cards).toHaveLength(1)
    expect(report?.windowStart).toBe("2026-11-19T00:00:00Z")
  })

  it("missing or corrupt file reads back undefined (派生物语义)", () => {
    const dir = projectDir()
    expect(readDailyReport(dir, "2026-11-19")).toBeUndefined()
    mkdirSync(join(dir, "daily"), { recursive: true })
    writeFileSync(join(dir, "daily", "2026-11-19.json"), "{broken", "utf8")
    expect(readDailyReport(dir, "2026-11-19")).toBeUndefined()
  })
})

describe("pipeline runDaily", () => {
  const seed = (sessionId: string, at: string, text: string): void => {
    sessions.appendMessage(sessionId, { id: `msg_${at}_${text.length}`, sessionId, role: "user", blocks: [{ id: `blk_${at}`, type: "text", text }], createdAt: at })
  }

  it("generates a report file from the messages inside the window", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seed(meta.id, "2026-11-19T02:00:00Z", "窗内第一条")
    seed(meta.id, "2026-11-19T06:00:00Z", "窗内第二条")
    seed(meta.id, "2026-11-19T23:00:00Z", "窗外（晚于窗终点）")
    const reply = JSON.stringify({ cards: [card("achievement", "日报功能上线", "今天写完了日报生成。")] })
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([reply]), model: "m" }),
      now: () => new Date("2026-11-19T08:00:00Z"),
    })
    const result = await pipe.runDaily(WORKDIR, { start: "2026-11-19T00:00:00Z", end: "2026-11-19T08:00:00Z", date: "2026-11-19" })
    expect(result.outcome).toBe("generated")
    const report = readDailyReport(projectDir(), "2026-11-19")!
    expect(report.cards).toHaveLength(1)
    expect(report.cards[0]!.title).toBe("日报功能上线")
    expect(report.windowEnd).toBe("2026-11-19T08:00:00Z")
  })

  it("feeds the windowed messages (and only them) to the LLM", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seed(meta.id, "2026-11-19T02:00:00Z", "窗内第一条")
    seed(meta.id, "2026-11-19T23:00:00Z", "窗外一条")
    const inputs: string[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        inputs.push(String((req.messages as Array<{ content: string }>)[0]?.content ?? ""))
        yield { type: "text_delta", delta: JSON.stringify({ cards: [] }) }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, { resolveLlm: () => ({ llm, model: "m" }) })
    await pipe.runDaily(WORKDIR, { start: "2026-11-19T00:00:00Z", end: "2026-11-19T12:00:00Z", date: "2026-11-19" })
    expect(inputs[0]).toContain("窗内第一条")
    expect(inputs[0]).toContain("=== 会话：")
    expect(inputs[0]).not.toContain("窗外一条")
  })

  it("returns empty (no file, no LLM call) when the window has no messages", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seed(meta.id, "2026-11-19T02:00:00Z", "窗外的历史消息")
    let calls = 0
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        calls += 1
        yield { type: "text_delta", delta: "{}" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }
      },
    }
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, { resolveLlm: () => ({ llm, model: "m" }) })
    const result = await pipe.runDaily(WORKDIR, { start: "2026-11-20T00:00:00Z", end: "2026-11-20T08:00:00Z", date: "2026-11-20" })
    expect(result.outcome).toBe("empty")
    expect(calls).toBe(0)
    expect(existsSync(join(projectDir(), "daily"))).toBe(false)
  })

  it("records the chore usage under the daily kind with the attributed session", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    seed(meta.id, "2026-11-19T02:00:00Z", "内容")
    const rows: Parameters<ChoreUsageRecorder>[0][] = []
    const pipe = new MemoryPipeline(join(root, "memory"), sessions, {
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ cards: [] })]), model: "m" }),
      recordChoreUsage: (r) => { rows.push(r) },
    })
    await pipe.runDaily(WORKDIR, { start: "2026-11-19T00:00:00Z", end: "2026-11-19T08:00:00Z", date: "2026-11-19" }, meta.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.chore).toBe("daily")
    expect(rows[0]!.sessionId).toBe(meta.id)
  })
})

describe("system triggerDaily / regenerateDaily", () => {
  function makeSystem(over: Partial<Parameters<typeof MemorySystem.prototype.constructor>[0]> = {}): MemorySystem {
    return new MemorySystem({
      memoryDir: join(root, "memory"),
      sessions,
      config: structuredClone(defaultConfig),
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ cards: [card("achievement", "首卡", "正文")] })]), model: "m" }),
      ...over,
    })
  }

  /** 在会话里种一条 createdAt 可控的消息（窗过滤测试不能依赖真实当前时刻）。 */
  const seedAt = (sessionId: string, at: string): void => {
    sessions.appendMessage(sessionId, { id: `msg_${at}`, sessionId, role: "user", blocks: [{ id: `blk_${at}`, type: "text", text: `消息 ${at}` }], createdAt: at })
  }

  /** 直接布项目目录与 workdir 标记（绕过 pipeline，供只测管理面的用例）。 */
  const ensureProjectMarker = (): void => {
    mkdirSync(projectDir(), { recursive: true })
    writeFileSync(join(projectDir(), "workdir.txt"), WORKDIR)
  }

  it("triggerDaily: generates the file named by the LOCAL date and advances the window start", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const now = new Date("2026-11-19T08:00:00")
    seedAt(meta.id, new Date(now.getTime() - 60_000).toISOString())
    const sys = makeSystem({ now: () => now })
    await sys.triggerDaily(WORKDIR)
    const report = readDailyReport(projectDir(), localDateOf(now))
    expect(report).toBeDefined()
    expect(report!.cards).toHaveLength(1)
    expect(sys.dailyLastRun(WORKDIR)).toBeUndefined() // 判重日期由调度器记，trigger 不代劳
    sys.markDailyRun(WORKDIR, localDateOf(now))
    expect(sys.dailyLastRun(WORKDIR)).toBe(localDateOf(now))
    // 首窗起点 = 当天本地 0 点
    expect(report!.windowStart).toBe(localMidnightIso(now))
  })

  it("triggerDaily: an empty window advances the window start but writes no file", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const now = new Date("2026-11-19T08:00:00")
    const sys = makeSystem({ now: () => now })
    await sys.triggerDaily(WORKDIR)
    expect(existsSync(join(projectDir(), "daily"))).toBe(false)
    // 次日窗内来了新消息：窗起点 = 上次推进到的时刻（19 日 8 点），不从 20 日 0 点起算
    const again = new Date("2026-11-20T08:00:00")
    seedAt(meta.id, new Date((now.getTime() + again.getTime()) / 2).toISOString())
    const sys2 = makeSystem({ now: () => again })
    await sys2.triggerDaily(WORKDIR)
    const report = readDailyReport(projectDir(), localDateOf(again))
    expect(report).toBeDefined()
    expect(report!.windowStart).toBe(now.toISOString())
  })

  it("triggerDaily: an LLM failure leaves the window start in place (不漏内容)", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const now = new Date("2026-11-19T08:00:00")
    seedAt(meta.id, new Date(now.getTime() - 60_000).toISOString())
    const failing: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        throw new Error("boom")
      },
    }
    const sys = makeSystem({ now: () => now, resolveLlm: () => ({ llm: failing, model: "m" }) })
    await expect(sys.triggerDaily(WORKDIR)).rejects.toThrow("boom")
    expect(existsSync(join(projectDir(), "daily"))).toBe(false)
    // 窗起点未推进：次日重试时窗仍从 19 日 0 点起，失败那天的内容在窗内
    const next = new Date("2026-11-20T08:00:00")
    const sys2 = makeSystem({ now: () => next })
    await sys2.triggerDaily(WORKDIR)
    const report = readDailyReport(projectDir(), localDateOf(next))
    expect(report).toBeDefined()
    expect(report!.windowStart).toBe(localMidnightIso(now))
  })

  it("regenerateDaily: reruns an existing day on its recorded window and overwrites", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const now = new Date("2026-11-19T08:00:00")
    seedAt(meta.id, new Date(now.getTime() - 60_000).toISOString())
    const sys = makeSystem({ now: () => now })
    await sys.triggerDaily(WORKDIR)
    // 第二版回复：手动重新生成按原窗重跑、整文件覆盖
    const sys2 = makeSystem({
      now: () => new Date("2026-11-19T12:00:00"),
      resolveLlm: () => ({ llm: scriptedLlm([JSON.stringify({ cards: [card("lesson", "重跑后的卡", "第二版正文。")] })]), model: "m" }),
    })
    const report = await sys2.regenerateDaily(projectIdFor(WORKDIR), localDateOf(now))
    expect(report.cards[0]!.title).toBe("重跑后的卡")
    expect(readDailyReport(projectDir(), localDateOf(now))!.cards[0]!.title).toBe("重跑后的卡")
    // 原窗保留（重跑不放大窗口）
    expect(report.windowEnd).toBe(now.toISOString())
  })

  it("regenerateDaily: today with no file generates immediately from the current window", async () => {
    const meta = sessions.create("s", undefined, WORKDIR)
    const now = new Date("2026-11-19T06:00:00")
    seedAt(meta.id, new Date(now.getTime() - 60_000).toISOString())
    ensureProjectMarker()
    const sys = makeSystem({ now: () => now })
    const report = await sys.regenerateDaily(projectIdFor(WORKDIR), localDateOf(now))
    expect(readDailyReport(projectDir(), localDateOf(now))!.cards).toHaveLength(1)
    expect(report.windowStart).toBe(localMidnightIso(now))
  })

  it("regenerateDaily: a past day with no file and an empty window fail with typed errors", async () => {
    const now = new Date("2026-11-19T08:00:00")
    const sys = makeSystem({ now: () => now })
    // 项目先经一次触发建目录（空窗），今天重新生成 → 空窗错误
    await sys.triggerDaily(WORKDIR)
    const today = localDateOf(now)
    await expect(sys.regenerateDaily(projectIdFor(WORKDIR), today)).rejects.toMatchObject({ status: "empty-window" })
    // 历史日期无文件 → no-file 错误
    await expect(sys.regenerateDaily(projectIdFor(WORKDIR), "2026-11-01")).rejects.toMatchObject({ status: "no-file" })
    // 未知项目 → unknown-project 错误
    await expect(sys.regenerateDaily("no-such-project", today)).rejects.toBeInstanceOf(DailyRegenerateError)
  })

  it("dailyProjects lists projects with their latest report date", async () => {
    const sys = makeSystem()
    // 手动布一个项目目录、workdir 标记与日报文件
    ensureProjectMarker()
    writeDailyReport(projectDir(), { date: "2026-11-19", windowStart: "a", windowEnd: "b", generatedAt: "c", cards: [] })
    const rows = sys.dailyProjects()
    const row = rows.find((r) => r.id === projectIdFor(WORKDIR))
    expect(row?.latest).toBe("2026-11-19")
    expect(row?.workdir).toBe(WORKDIR)
    expect(sys.dailyDates(projectIdFor(WORKDIR))).toEqual(["2026-11-19"])
  })
})
