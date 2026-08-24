import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../../src/session/store.js"
import { newMessage } from "../../src/protocol/messages.js"

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
    const raw = readFileSync(join(dir, m.id, "messages.jsonl"), "utf8").trim().split("\n")
    expect(raw).toHaveLength(2)
    expect(JSON.parse(raw[0]).blocks[0].text).toBe("hi")
    expect(s.meta(m.id)!.updatedAt > before).toBe(true)
    expect(s.readMessages(m.id)).toHaveLength(2)
  })

  it("truncates corrupt trailing line, throws on corrupt middle line", () => {
    const s = new SessionStore(dir)
    const m = s.create()
    s.appendMessage(m.id, newMessage(m.id, "user", [{ id: "blk_1", type: "text", text: "ok" }]))
    const f = join(dir, m.id, "messages.jsonl")
    writeFileSync(f, readFileSync(f, "utf8") + '{"id":"msg_x","role":"user","blocks":[{broken')
    expect(s.readMessages(m.id)).toHaveLength(1) // 尾行损坏被丢弃
    const lines = readFileSync(f, "utf8").trim().split("\n")
    writeFileSync(f, ["{broken-middle", ...lines.slice(1)].join("\n"))
    expect(() => s.readMessages(m.id)).toThrow()
  })

  it("newline-separates appends after a torn crash line so only the torn message is lost", () => {
    const s = new SessionStore(dir)
    const m = s.create()
    const f = join(dir, m.id, "messages.jsonl")
    writeFileSync(f, '{"id":"msg_torn","role":"user","blocks":[{broken') // 崩溃残留：无结尾换行
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
    const f = join(dir, m.id, "messages.jsonl")
    const chinese = newMessage(m.id, "user", [{ id: "blk_0", type: "text", text: "你好世界" }])
    writeFileSync(f, JSON.stringify(chinese) + "\n" + '{"id":"msg_torn","role":"user","blocks":[{broken') // 有效中文行 + 撕裂尾行
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
})
