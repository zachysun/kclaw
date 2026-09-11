import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../../src/session/store.js"
import { isSandboxCheckedEvent, isSystemEvent } from "../../src/session/events.js"
import { newMessage } from "../../src/protocol/messages.js"
import type { CompactionRecord } from "../../src/session/compaction.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-sess-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("SessionStore", () => {
  it("create + list + meta roundtrip", () => {
    const s = new SessionStore(dir)
    const m = s.create("早报会话", "job_1")
    expect(m.title).toBe("早报会话")
    expect(m.jobId).toBe("job_1")
    expect(s.list()).toHaveLength(1)
    expect(s.meta(m.id)!.title).toBe("早报会话")
  })

  it("parentSessionId rides session.created into the projection and listByParent finds children", () => {
    const s = new SessionStore(dir)
    const parent = s.create("主线", undefined, "/w", "default")
    const child = s.create("子代理 · 扫 TODO", undefined, "/w", "default", parent.id)
    expect(s.meta(child.id)!.parentSessionId).toBe(parent.id)
    expect(s.meta(parent.id)!.parentSessionId).toBeUndefined()
    // The parent link survives a projection rebuild from the event stream.
    expect(s.rebuildMeta(child.id)!.parentSessionId).toBe(parent.id)
    // listByParent spans the recycle bin (delete/purge cascade input).
    s.delete(child.id)
    expect(s.listByParent(parent.id).map((m) => m.id)).toEqual([child.id])
    expect(s.listByParent("ses_none")).toEqual([])
  })

  it("listByJob returns one job's non-deleted sessions newest-updated first", async () => {
    const s = new SessionStore(dir)
    const older = s.create("旧", "job_a")
    await new Promise((r) => setTimeout(r, 5)) // distinct updatedAt for the order check
    const newer = s.create("新", "job_a")
    s.create("别的", "job_b") // different job: excluded
    expect(s.listByJob("job_a").map((m) => m.id)).toEqual([newer.id, older.id])
    s.delete(older.id) // deleted: excluded (recycle-bin territory)
    expect(s.listByJob("job_a").map((m) => m.id)).toEqual([newer.id])
  })

  it("appendMessage writes one JSONL line per message and updates updatedAt", async () => {
    const s = new SessionStore(dir)
    const m = s.create()
    const before = s.meta(m.id)!.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    s.appendMessage(m.id, newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "hi" }]))
    s.appendMessage(m.id, newMessage(m.id, "assistant", [{ id: "blk_2", type: "text", text: "hello" }]))
    const events = s.readEvents(m.id)
    expect(events.filter((e) => e.type === "message")).toHaveLength(2)
    const raw = readFileSync(join(dir, m.id, "events.jsonl"), "utf8").trim().split("\n")
    expect(raw).toHaveLength(3) // session.created + 2 message 事件
    expect(s.meta(m.id)!.updatedAt > before).toBe(true)
    expect(s.readMessages(m.id)).toHaveLength(2)
    expect(s.readMessages(m.id)[0].blocks[0].text).toBe("hi")
  })

  it("truncates corrupt trailing line, throws on corrupt middle line", () => {
    const s = new SessionStore(dir)
    const m = s.create()
    s.appendMessage(m.id, newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "ok" }]))
    const f = join(dir, m.id, "events.jsonl")
    writeFileSync(f, readFileSync(f, "utf8") + '{"type":"message","id":"msg_x","role":"user","blocks":[{broken')
    expect(s.readMessages(m.id)).toHaveLength(1) // 尾行损坏被丢弃
    const lines = readFileSync(f, "utf8").trim().split("\n")
    writeFileSync(f, ["{broken-middle", ...lines.slice(1)].join("\n"))
    expect(() => s.readMessages(m.id)).toThrow()
  })

  it("newline-separates appends after a torn crash line so only the torn message is lost", () => {
    const s = new SessionStore(dir)
    const m = s.create()
    const f = join(dir, m.id, "events.jsonl")
    writeFileSync(f, '{"type":"message","id":"msg_torn","role":"user","blocks":[{broken') // 崩溃残留：无结尾换行
    const msg = newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "ok" }])
    s.appendMessage(m.id, msg)
    const out = s.readMessages(m.id)
    expect(out).toHaveLength(1) // 只丢撕裂行，新消息完好
    expect(out[0].id).toBe(msg.id)
    const raw = readFileSync(f, "utf8").trim().split("\n")
    expect(JSON.parse(raw[raw.length - 1]).id).toBe(msg.id) // 末行是完整可解析的新消息
  })

  it("truncates torn tail at a byte offset so multibyte lines survive the repair", () => {
    const s = new SessionStore(dir)
    const m = s.create()
    const f = join(dir, m.id, "events.jsonl")
    const chinese = newMessage(m.id, "user", [{ id: "blk_0", type: "text", text: "你好世界" }])
    writeFileSync(f, JSON.stringify({ type: "message", ...chinese }) + "\n" + '{"type":"message","id":"msg_torn","role":"user","blocks":[{broken') // 有效中文行 + 撕裂尾行
    const msg = newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "ok" }])
    s.appendMessage(m.id, msg)
    const out = s.readMessages(m.id)
    expect(out.map((x) => x.id)).toEqual([chinese.id, msg.id]) // 中文旧行 + 新消息都在，仅撕裂碎片被丢弃
    const raw = readFileSync(f, "utf8").trim().split("\n")
    expect(raw).toHaveLength(2)
    expect(JSON.parse(raw[0]).blocks[0].text).toBe("你好世界") // 旧行字节完好
    expect(JSON.parse(raw[1]).id).toBe(msg.id)
  })

  it("create 带 workdir 写入 meta", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t", undefined, "/projects/x")
    expect(store.meta(meta.id)?.workdir).toBe("/projects/x")
  })

  it("create 不带 workdir 时 meta 无 workdir 字段", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    expect("workdir" in meta).toBe(false)
    expect(store.meta(meta.id)?.workdir).toBeUndefined()
  })

  it("create uses msg-prefix-free session ids and tolerates restart", () => {
    const s = new SessionStore(dir)
    const m = s.create()
    const s2 = new SessionStore(dir) // 新实例=重启
    expect(s2.list().map((x) => x.id)).toEqual([m.id])
  })

  it("list 跳过 meta 与事件流都损坏的会话，而不是让整个列表抛错", () => {
    const store = new SessionStore(dir)
    const good = store.create("好会话")
    const bad = store.create("坏会话")
    store.appendMessage(bad.id, { id: "m1", sessionId: bad.id, role: "user", blocks: [], createdAt: new Date().toISOString() })
    // 同时损坏坏会话的 meta.json 与事件流第一行（其后仍有合法行 → 中部损坏而非撕裂尾行）：
    // meta() 会尝试 rebuildMeta，但事件流也损坏 → 修复前 rebuildMeta 的异常会从 list() 抛出去。
    writeFileSync(join(dir, bad.id, "meta.json"), "{broken")
    const f = join(dir, bad.id, "events.jsonl")
    const lines = readFileSync(f, "utf8").trim().split("\n")
    expect(lines.length).toBeGreaterThan(1) // 确保损坏行不是最后一行（否则被当作撕裂尾行丢弃）
    writeFileSync(f, ["{broken-middle", ...lines.slice(1)].join("\n"))
    expect(() => store.list()).not.toThrow()
    expect(store.list().map((m) => m.id)).toEqual([good.id])
  })

  it("软删后不在默认列表、可在回收站列表、可恢复", () => {
    const store = new SessionStore(dir)
    const meta = store.create("标题")
    expect(store.list().map((m) => m.id)).toContain(meta.id)

    const del = store.delete(meta.id)
    expect(del.deleted).toBe(true)
    expect(del.deletedAt).toBeDefined()
    expect(store.list().map((m) => m.id)).not.toContain(meta.id)
    expect(store.list({ deleted: true }).map((m) => m.id)).toContain(meta.id)

    const restored = store.restore(meta.id)
    expect(restored.deleted).toBeUndefined()
    expect(store.list().map((m) => m.id)).toContain(meta.id)
  })

  it("updateMeta persists compaction fields and clearing with undefined removes them", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    store.updateMeta(meta.id, { compactedSummary: "sum of history", compactedUpto: "msg_1" })
    const back = store.meta(meta.id)!
    expect(back.compactedSummary).toBe("sum of history")
    expect(back.compactedUpto).toBe("msg_1")
    store.updateMeta(meta.id, { compactedSummary: undefined })
    const cleared = store.meta(meta.id)!
    expect(cleared.compactedSummary).toBeUndefined()
    expect("compactedSummary" in cleared).toBe(false)
    expect(cleared.compactedUpto).toBe("msg_1") // untouched field survives
  })

  it("compaction state is event-sourced via appendCompaction, not via updateMeta", () => {
    const store = new SessionStore(dir)
    const meta = store.create("压缩会话")
    const state = { segments: [{ upto: "m3", summary: "摘要" }], top: "总摘要", upto: "m3" }
    // updateMeta 不直接写 compaction：run.ts 对同一压缩会同时调用
    // updateMeta({compaction}) 与 appendCompaction，若都写会重复计段。
    store.updateMeta(meta.id, { compaction: state })
    expect(store.meta(meta.id)!.compaction).toBeUndefined()
    // compaction 事件是 meta.compaction 的唯一来源
    store.appendCompaction(meta.id, { at: "2026-01-02T00:00:00.000Z", trigger: "auto", from: null, upto: "m3", messages: 1, segmentSummary: "摘要", top: "总摘要" })
    expect(store.meta(meta.id)!.compaction).toEqual(state)
    // 清空：事件流没有新的 compaction 事件可清，updateMeta({compaction: undefined}) 亦不应产生字段
    store.updateMeta(meta.id, { compaction: undefined })
    expect(store.meta(meta.id)!.compaction).toEqual(state)
  })

  it("purge 永久删除会话目录", () => {
    const store = new SessionStore(dir)
    const meta = store.create("标题")
    store.appendMessage(meta.id, { id: "msg_x", sessionId: meta.id, role: "user", blocks: [], createdAt: new Date().toISOString() })
    store.delete(meta.id)
    store.purge(meta.id)
    expect(store.meta(meta.id)).toBeUndefined()
  })

  it("purgeExpired 只清理超过 ttl 的已删会话", () => {
    const store = new SessionStore(dir)
    const old = store.delete(store.create("旧").id)
    const fresh = store.delete(store.create("新").id)
    // 把 old 的 deletedAt 改到很久以前
    store.updateMeta(old.id, { deletedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 31).toISOString() })
    const purged = store.purgeExpired(30 * 24 * 60 * 60 * 1000)
    expect(purged).toContain(old.id)
    expect(purged).not.toContain(fresh.id)
    expect(store.meta(fresh.id)).toBeDefined()
  })

  it("appends and reads compaction audit records", () => {
    const store = new SessionStore(dir)
    const meta = store.create("审计")
    const rec: CompactionRecord = {
      at: "2026-08-27T00:00:00.000Z", trigger: "auto", from: "m1", upto: "m3",
      messages: 3, segmentSummary: "段摘要", top: "总摘要",
    }
    store.appendCompaction(meta.id, rec)
    store.appendCompaction(meta.id, { ...rec, trigger: "manual" as const, focus: "登录模块" })
    expect(store.readCompactions(meta.id)).toHaveLength(2)
    expect(store.readCompactions(meta.id)[1]).toMatchObject({ trigger: "manual", focus: "登录模块" })
  })

  it("returns [] when no compactions file exists", () => {
    const store = new SessionStore(dir)
    const meta = store.create("无记录")
    expect(store.readCompactions(meta.id)).toEqual([])
  })

  it("readCompactions 在事件流中部损坏时返回 [] 而不是抛错", () => {
    const store = new SessionStore(dir)
    const meta = store.create("审计")
    store.appendCompaction(meta.id, { at: "2026-08-27T00:00:00.000Z", trigger: "auto", from: "m1", upto: "m3", messages: 3, segmentSummary: "段摘要", top: "总摘要" })
    const f = join(dir, meta.id, "events.jsonl")
    const lines = readFileSync(f, "utf8").trim().split("\n")
    writeFileSync(f, ["{broken-middle", ...lines.slice(1)].join("\n"))
    expect(store.readCompactions(meta.id)).toEqual([])
  })
})

describe("queue persistence", () => {
  it("replaceQueue/readQueue round-trips entries; empty array clears", () => {
    const store = new SessionStore(dir)
    const meta = store.create("q")
    const entry = { messageId: "msg_1", disposition: "wait" as const, text: "hi", trigger: "user" as const, enqueuedAt: new Date().toISOString() }
    store.replaceQueue(meta.id, [entry])
    expect(store.readQueue(meta.id)).toEqual([entry])
    store.replaceQueue(meta.id, [])
    expect(store.readQueue(meta.id)).toEqual([])
  })
  it("queue 不经过 updateMeta：写 dispositionOverride 不影响 queue.jsonl", () => {
    const store = new SessionStore(dir)
    const meta = store.create("q")
    const entry = { messageId: "msg_1", disposition: "wait" as const, text: "hi", trigger: "user" as const, enqueuedAt: new Date().toISOString() }
    store.replaceQueue(meta.id, [entry])
    store.updateMeta(meta.id, { dispositionOverride: "steer" })
    expect(store.meta(meta.id)!.dispositionOverride).toBe("steer")
    expect(store.readQueue(meta.id)).toEqual([entry])
    store.updateMeta(meta.id, { dispositionOverride: undefined })
    expect(store.meta(meta.id)!.dispositionOverride).toBeUndefined()
    expect(store.readQueue(meta.id)).toEqual([entry])
  })
  it("queue 独立文件：queue.jsonl 与 meta.json 分开，写入 queue 不进投影", () => {
    const store = new SessionStore(dir)
    const meta = store.create("q")
    const entry = { messageId: "msg_1", disposition: "wait" as const, text: "hi", trigger: "user" as const, enqueuedAt: new Date().toISOString() }
    store.replaceQueue(meta.id, [entry])
    expect(store.readQueue(meta.id)).toHaveLength(1)
    const metaRaw = JSON.parse(readFileSync(join(dir, meta.id, "meta.json"), "utf8"))
    expect("queue" in metaRaw).toBe(false) // 投影不再含 queue 字段
  })
  it("legacy meta without the fields loads unchanged", () => {
    const store = new SessionStore(dir)
    const meta = store.create("legacy")
    const raw = JSON.parse(readFileSync(join(dir, meta.id, "meta.json"), "utf8"))
    delete raw.queue
    delete raw.dispositionOverride
    writeFileSync(join(dir, meta.id, "meta.json"), JSON.stringify(raw))
    expect(store.meta(meta.id)!.title).toBe("legacy")
    expect(store.readQueue(meta.id)).toEqual([])
  })
  it("queue 独立文件：append 排队 + replaceQueue 出队", () => {
    const store = new SessionStore(dir)
    const meta = store.create()
    store.replaceQueue(meta.id, [{ messageId: "q1", disposition: "steer", text: "hi", trigger: "user", enqueuedAt: "2026-01-01T00:00:00.000Z" }])
    expect(store.readQueue(meta.id)).toHaveLength(1)
    store.replaceQueue(meta.id, [])
    expect(store.readQueue(meta.id)).toHaveLength(0)
    // queue 不影响 meta 投影的其它字段
    expect(store.meta(meta.id)!.title).toBe("新会话")
  })
})

describe("SessionStore event sourcing", () => {
  it("create 产生 session.created 事件与投影 meta", () => {
    const store = new SessionStore(dir)
    const meta = store.create("标题", undefined, "/w")
    const events = store.readEvents(meta.id)
    expect(events[0]).toMatchObject({ type: "session.created", title: "标题", workdir: "/w" })
    expect(store.meta(meta.id)!.title).toBe("标题")
  })

  it("create 固化初始权限模式：缺省显式写 default，config 默认档传入则写该档", () => {
    const store = new SessionStore(dir)
    const dflt = store.create("缺省档")
    // 事件恒带 mode 字段：meta.mode 永远有真实值（gate 读它判定，不各自回落）
    const [created] = store.readEvents(dflt.id)
    expect(created).toMatchObject({ type: "session.created", mode: "default" })
    expect(store.meta(dflt.id)!.mode).toBe("default")

    const ro = store.create("只读档", undefined, undefined, "readonly")
    expect(store.meta(ro.id)!.mode).toBe("readonly")
    const trusted = store.create("信任档", undefined, undefined, "trusted")
    expect(store.meta(trusted.id)!.mode).toBe("trusted")
  })

  it("appendMessage 写 message 事件，readMessages 还原", () => {
    const store = new SessionStore(dir)
    const meta = store.create()
    store.appendMessage(meta.id, { id: "m1", sessionId: meta.id, role: "user", blocks: [{ type: "text", text: "hi" }], createdAt: "2026-01-02T00:00:00.000Z" } as never)
    expect(store.readMessages(meta.id)).toHaveLength(1)
    expect(store.meta(meta.id)!.updatedAt).toBe("2026-01-02T00:00:00.000Z")
  })

  it("appendCompaction 写 compaction 事件并投影出 meta.compaction", () => {
    const store = new SessionStore(dir)
    const meta = store.create()
    store.appendCompaction(meta.id, { at: "2026-01-02T00:00:00.000Z", trigger: "auto", from: null, upto: "m1", messages: 1, segmentSummary: "s", top: "t" })
    expect(store.readCompactions(meta.id)).toHaveLength(1)
    expect(store.meta(meta.id)!.compaction).toEqual({ segments: [{ upto: "m1", summary: "s" }], top: "t", upto: "m1" })
  })

  it("appendSystem 写 system 事件：恰好一条、文本与 at 完整，其他事件类型读回不受影响", () => {
    const store = new SessionStore(dir)
    const meta = store.create("审计会话")
    store.appendMessage(meta.id, newMessage(meta.id, "user", [{ id: "blk_1", type: "text", text: "hi" }]))
    store.appendSystem(meta.id, { at: new Date().toISOString(), text: "底座人设 + 认知注入的拼装全文" })
    store.appendCompaction(meta.id, { at: "2026-01-03T00:00:00.000Z", trigger: "auto", from: null, upto: "m1", messages: 1, segmentSummary: "s", top: "t" })
    const systemEvents = store.readEvents(meta.id).filter(isSystemEvent)
    expect(systemEvents).toHaveLength(1)
    expect(systemEvents[0].text).toBe("底座人设 + 认知注入的拼装全文")
    expect(Number.isNaN(Date.parse(systemEvents[0].at))).toBe(false)
    // 其他事件类型不受影响
    expect(store.readMessages(meta.id)).toHaveLength(1)
    expect(store.readCompactions(meta.id)).toHaveLength(1)
  })

  it("appendSandboxChecked 写 sandbox.checked 事件：恰好一条、字段完整、投影穿透（updatedAt 不动）", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    store.updateMeta(meta.id, { model: "gpt-4", mode: "readonly" })
    const before = JSON.parse(readFileSync(join(dir, meta.id, "meta.json"), "utf8"))
    store.appendSandboxChecked(meta.id, {
      at: new Date().toISOString(),
      enabled: true,
      available: false,
      unavailableReason: "bwrap not found on PATH",
    })
    const sandboxEvents = store.readEvents(meta.id).filter(isSandboxCheckedEvent)
    expect(sandboxEvents).toHaveLength(1)
    expect(sandboxEvents[0]).toMatchObject({
      type: "sandbox.checked",
      enabled: true,
      available: false,
      unavailableReason: "bwrap not found on PATH",
    })
    // 审计事件不进投影：含 updatedAt 在内的所有投影字段逐字段一致
    const after = JSON.parse(readFileSync(join(dir, meta.id, "meta.json"), "utf8"))
    expect(after).toEqual(before)
  })

  it("appendRunStarted / appendRunEnded / appendPermissionDecided 写审计事件：字段完整、投影穿透（updatedAt 不动）", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    store.updateMeta(meta.id, { model: "gpt-4", mode: "readonly" })
    const before = JSON.parse(readFileSync(join(dir, meta.id, "meta.json"), "utf8"))

    store.appendRunStarted(meta.id, { at: "2026-01-02T00:00:00.000Z", trigger: "user" })
    store.appendRunEnded(meta.id, {
      at: "2026-01-02T00:01:00.000Z", stopReason: "end_turn",
      usage: { inputTokens: 120, outputTokens: 45 },
    })
    store.appendRunEnded(meta.id, {
      at: "2026-01-02T00:02:00.000Z", stopReason: "error",
      error: { code: "llm_error", message: "boom" },
    })
    store.appendPermissionDecided(meta.id, {
      at: "2026-01-02T00:00:30.000Z", confirmationId: "conf_1", decision: "once", by: "cli",
      tool: { callId: "call_1", name: "exec", argsJson: '{"command":"ls"}' },
    })

    const events = store.readEvents(meta.id)
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(1)
    const ended = events.filter((e) => e.type === "run.ended")
    expect(ended).toHaveLength(2)
    expect(ended[0]).toMatchObject({ stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 45 } })
    expect("error" in ended[0]!).toBe(false)
    expect(ended[1]).toMatchObject({ stopReason: "error", error: { code: "llm_error" } })
    expect("usage" in ended[1]!).toBe(false)
    const decided = events.filter((e) => e.type === "permission.decided")
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({
      confirmationId: "conf_1", decision: "once", by: "cli",
      tool: { callId: "call_1", name: "exec", argsJson: '{"command":"ls"}' },
    })

    // 审计事件不进投影：含 updatedAt 在内的所有投影字段逐字段一致
    const after = JSON.parse(readFileSync(join(dir, meta.id, "meta.json"), "utf8"))
    expect(after).toEqual(before)
  })

  it("appendSystem 投影效果=upsert 冻结基线：updatedAt 与其余字段不动，压缩清除，rebuild 一致", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    store.updateMeta(meta.id, { model: "gpt-4", mode: "readonly" })
    const before = JSON.parse(readFileSync(join(dir, meta.id, "meta.json"), "utf8"))
    store.appendSystem(meta.id, { at: "2026-01-02T00:00:00.000Z", text: "run-1 的系统提示词" })
    const after = JSON.parse(readFileSync(join(dir, meta.id, "meta.json"), "utf8"))
    // 基线之外的投影字段（含 updatedAt）逐字段一致；基线文本与冻结时刻就位
    expect(after.systemBaseline).toEqual({ text: "run-1 的系统提示词", frozenAt: "2026-01-02T00:00:00.000Z" })
    const { systemBaseline: _drop, ...rest } = after
    const { systemBaseline: _dropBefore, ...restBefore } = before
    expect(rest).toEqual(restBefore)
    // 后一条 system 事件覆盖前一条（最新胜出）
    store.appendSystem(meta.id, { at: "2026-01-03T00:00:00.000Z", text: "run-2 的系统提示词" })
    expect(store.meta(meta.id)!.systemBaseline).toEqual({ text: "run-2 的系统提示词", frozenAt: "2026-01-03T00:00:00.000Z" })
    // 文本未变的重复审计：frozenAt 保留原值（= 这份文本成为基线的时刻）
    store.appendSystem(meta.id, { at: "2026-01-03T06:00:00.000Z", text: "run-2 的系统提示词" })
    expect(store.meta(meta.id)!.systemBaseline).toEqual({ text: "run-2 的系统提示词", frozenAt: "2026-01-03T00:00:00.000Z" })
    // 压缩事件清除基线（重冻结边界）；压缩后下一条 system 事件重新固化
    store.appendCompaction(meta.id, { at: "2026-01-04T00:00:00.000Z", trigger: "auto", from: null, upto: "m1", messages: 1, segmentSummary: "s", top: "t" })
    expect(store.meta(meta.id)!.systemBaseline).toBeUndefined()
    store.appendSystem(meta.id, { at: "2026-01-05T00:00:00.000Z", text: "压缩后重新装配的系统提示词" })
    expect(store.meta(meta.id)!.systemBaseline?.text).toBe("压缩后重新装配的系统提示词")
    // 事件流全量重建投影，与增量推进结果一致
    store.appendCompaction(meta.id, { at: "2026-01-06T00:00:00.000Z", trigger: "manual", from: "m1", upto: "m2", messages: 1, segmentSummary: "s2", top: "t2" })
    const rebuilt = store.rebuildMeta(meta.id)!
    expect(rebuilt).toEqual(store.meta(meta.id))
    expect(rebuilt.systemBaseline).toBeUndefined()
    // 事件流仅一条 system 事件（无 session.created）：rebuildMeta 从 at 取时间，不崩
    const only = "ses_sys_only"
    store.appendSystem(only, { at: new Date().toISOString(), text: "唯一一条 system 事件" })
    const onlyMeta = store.rebuildMeta(only)!
    expect(onlyMeta.id).toBe(only)
    expect(onlyMeta.systemBaseline?.text).toBe("唯一一条 system 事件")
    expect(Number.isNaN(Date.parse(onlyMeta.createdAt))).toBe(false)
    expect(Number.isNaN(Date.parse(onlyMeta.updatedAt))).toBe(false)
  })

  it("system 事件按追加顺序穿插在 message/compaction 之间", () => {
    const store = new SessionStore(dir)
    const meta = store.create()
    store.appendSystem(meta.id, { at: new Date().toISOString(), text: "run-1 的系统提示词" })
    store.appendMessage(meta.id, newMessage(meta.id, "user", [{ id: "blk_1", type: "text", text: "hi" }]))
    store.appendSystem(meta.id, { at: new Date().toISOString(), text: "run-2 的系统提示词（内容已变化）" })
    store.appendCompaction(meta.id, { at: "2026-01-03T00:00:00.000Z", trigger: "auto", from: null, upto: "m1", messages: 1, segmentSummary: "s", top: "t" })
    expect(store.readEvents(meta.id).map((e) => e.type)).toEqual([
      "session.created", "system", "message", "system", "compaction",
    ])
  })

  it("rebuildMeta 从事件流全量重建投影", () => {
    const store = new SessionStore(dir)
    const meta = store.create("旧")
    store.updateMeta(meta.id, { title: "新" })
    rmSync(join(dir, meta.id, "meta.json")) // 模拟投影丢失
    const rebuilt = store.rebuildMeta(meta.id)!
    expect(rebuilt.title).toBe("新")
  })

  it("clearing model via updateMeta emits session.set {model:null}; rebuildMeta does NOT resurrect it", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    store.updateMeta(meta.id, { model: "gpt-4" })
    expect(store.meta(meta.id)!.model).toBe("gpt-4")
    // 清除 = 一个真实的 session.set {model:null} 事件
    store.updateMeta(meta.id, { model: undefined })
    expect(store.meta(meta.id)!.model).toBeUndefined()
    expect("model" in store.meta(meta.id)!).toBe(false)
    const setEvents = store.readEvents(meta.id).filter((e) => e.type === "session.set")
    expect(setEvents).toHaveLength(2)
    expect((setEvents[1] as { model: string | null }).model).toBeNull()
    // 回归：清空已事件化 → 重建投影不复活已清除的覆盖
    const rebuilt = store.rebuildMeta(meta.id)!
    expect(rebuilt.model).toBeUndefined()
    expect("model" in rebuilt).toBe(false)
  })

  it("clearing mode via updateMeta emits session.set {mode:null}; rebuildMeta does NOT resurrect it", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    store.updateMeta(meta.id, { mode: "readonly" })
    store.updateMeta(meta.id, { mode: undefined })
    expect(store.meta(meta.id)!.mode).toBeUndefined()
    expect("mode" in store.meta(meta.id)!).toBe(false)
    const setEvents = store.readEvents(meta.id).filter((e) => e.type === "session.set")
    expect(setEvents).toHaveLength(2)
    expect((setEvents[1] as { mode: string | null }).mode).toBeNull()
    const rebuilt = store.rebuildMeta(meta.id)!
    expect(rebuilt.mode).toBeUndefined()
    expect("mode" in rebuilt).toBe(false)
  })

  it("legacy meta.json readonly:true reads back as mode:'readonly' and writes drop the boolean", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    // 手写一个旧投影：readonly 布尔、无 mode
    const legacyPath = join(dir, meta.id, "meta.json")
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8"))
    delete legacy.mode
    legacy.readonly = true
    writeFileSync(legacyPath, JSON.stringify(legacy))
    expect(store.meta(meta.id)!.mode).toBe("readonly")
    expect("readonly" in store.meta(meta.id)!).toBe(false)
    // 之后经 updateMeta 正常切档：只写 mode 字段
    store.updateMeta(meta.id, { mode: "default" })
    const after = JSON.parse(readFileSync(legacyPath, "utf8"))
    expect(after.mode).toBe("default")
    expect("readonly" in after).toBe(false)
  })

  it("setting model works and does not touch unrelated overrides (set is per-present-key)", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    store.updateMeta(meta.id, { mode: "readonly" })
    store.updateMeta(meta.id, { model: "gpt-4" }) // 只含 model 的 patch 不应清掉 mode
    expect(store.meta(meta.id)!.model).toBe("gpt-4")
    expect(store.meta(meta.id)!.mode).toBe("readonly")
  })

  it("a session.set event with absent fields leaves the field untouched ({} semantics)", () => {
    const store = new SessionStore(dir)
    const meta = store.create("t")
    store.updateMeta(meta.id, { model: "gpt-4" })
    // 手动写入一个缺 model 字段的 session.set 事件（等价于 {} 语义）：不清除、不覆盖
    const now = new Date().toISOString()
    store.appendEvent(meta.id, { type: "session.set", at: now, model: undefined })
    expect(store.meta(meta.id)!.model).toBe("gpt-4")
  })
})

describe("SessionStore append hook", () => {
  it("appendEvent 落盘成功后触发 onAppended（携带 sessionId 与事件本体）", () => {
    const seen: Array<{ id: string; type: string }> = []
    const s = new SessionStore(dir, (id, ev) => seen.push({ id, type: ev.type }))
    const m = s.create()
    s.appendMessage(m.id, newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "hi" }]))
    // create 走 appendEvent（session.created），appendMessage 再一条：两条都通知
    expect(seen).toEqual([
      { id: m.id, type: "session.created" },
      { id: m.id, type: "message" },
    ])
  })

  it("onAppended 抛异常不破坏落盘与投影（通知失败不是写失败）", () => {
    const s = new SessionStore(dir, () => { throw new Error("bus down") })
    const m = s.create()
    s.appendMessage(m.id, newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "hi" }]))
    expect(s.readEvents(m.id)).toHaveLength(2)
    expect(s.meta(m.id)!.updatedAt).toBeTruthy()
  })

  it("未传 onAppended 时行为不变", () => {
    const s = new SessionStore(dir)
    const m = s.create()
    s.appendMessage(m.id, newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "hi" }]))
    expect(s.readEvents(m.id)).toHaveLength(2)
  })

  it("落盘失败不触发 onAppended（异常照常抛出——通知只属于写成功的追加）", () => {
    // 把会话的 events.jsonl 换成目录：追加写入必然失败（EISDIR），
    // 回调必须未被调用（"先落盘后广播"的不变式由这条用例守住）。
    const seen: Array<{ id: string; type: string }> = []
    const s = new SessionStore(dir, (id, ev) => seen.push({ id, type: ev.type }))
    const m = s.create()
    rmSync(join(dir, m.id, "events.jsonl"))
    mkdirSync(join(dir, m.id, "events.jsonl"))
    expect(() => s.appendMessage(m.id, newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "hi" }]))).toThrow()
    expect(seen).toEqual([{ id: m.id, type: "session.created" }])
  })
})

describe("SessionStore readEventsFrom (tail read)", () => {
  function seeded(): { s: SessionStore; id: string } {
    const s = new SessionStore(dir)
    const m = s.create()
    for (let i = 1; i <= 3; i++) {
      s.appendMessage(m.id, newMessage(m.id, "user", [{ id: `blk_${i}`, type: "text", text: `msg${i}` }]))
    }
    return { s, id: m.id }
  }

  it("等价于 readEvents().slice(since)：0/中间/越界三档", () => {
    const { s, id } = seeded()
    const full = s.readEvents(id)
    expect(s.readEventsFrom(id, 0)).toEqual(full)
    expect(s.readEventsFrom(id, 2)).toEqual(full.slice(2))
    expect(s.readEventsFrom(id, 99)).toEqual([])
  })

  it("只解析尾部：跳过的行损坏不抛错，尾部的损坏语义与 readJsonl 一致（丢撕裂数据）", () => {
    const { s, id } = seeded()
    // 模拟真实损坏场景比较绕，这里直接验证"跳过区不 parse"：把首行改成非法 JSON，
    // readEvents 会抛（corrupt），readEventsFrom(1, …) 不受影响。
    const file = join(dir, id, "events.jsonl")
    const lines = readFileSync(file, "utf8").split("\n")
    lines[0] = "{corrupt"
    writeFileSync(file, lines.join("\n"))
    expect(() => s.readEvents(id)).toThrow()
    expect(s.readEventsFrom(id, 1)).toHaveLength(3)
  })

  it("不存在的会话返回 []（与 readEvents 同语义）", () => {
    const s = new SessionStore(dir)
    expect(s.readEventsFrom("ses_none", 0)).toEqual([])
  })
})
