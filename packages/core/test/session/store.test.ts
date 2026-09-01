import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../../src/session/store.js"
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

  it("rebuildMeta 从事件流全量重建投影", () => {
    const store = new SessionStore(dir)
    const meta = store.create("旧")
    store.updateMeta(meta.id, { title: "新" })
    rmSync(join(dir, meta.id, "meta.json")) // 模拟投影丢失
    const rebuilt = store.rebuildMeta(meta.id)!
    expect(rebuilt.title).toBe("新")
  })
})
