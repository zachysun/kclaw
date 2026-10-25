import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../../src/session/store.js"
import { chainGenesis, lineDigest, verifyEventChain } from "../../src/session/integrity.js"
import { newMessage } from "../../src/protocol/messages.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-integrity-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 造一个有 N 条消息事件的会话，返回 { store, id }。 */
function seeded(n: number) {
  const store = new SessionStore(dir)
  const m = store.create("链测试")
  for (let i = 0; i < n; i++) store.appendMessage(m.id, newMessage(m.id, "user", [{ type: "text", text: `m${i}` }]))
  return { store, id: m.id }
}

const eventsPath = (id: string) => join(dir, id, "events.jsonl")
const metaPath = (id: string) => join(dir, id, "meta.json")
const lines = (id: string) => readFileSync(eventsPath(id), "utf8").split("\n").filter((l) => l !== "")
const writeLines = (id: string, ls: string[]) => writeFileSync(eventsPath(id), ls.join("\n") + "\n")

describe("哈希链写入与读取", () => {
  it("appendEvent 写入 $prev 且 readEvents 剥离", () => {
    const { store, id } = seeded(3)
    const raw = lines(id)
    expect(raw).toHaveLength(4) // session.created + 3 messages
    expect((JSON.parse(raw[0]!) as Record<string, unknown>).$prev).toBe(chainGenesis(id))
    for (let i = 1; i < raw.length; i++) {
      expect((JSON.parse(raw[i]!) as Record<string, unknown>).$prev).toBe(lineDigest(raw[i - 1]!))
    }
    // 读取边界剥离：上层事件不含 $prev
    for (const e of store.readEvents(id)) expect("$prev" in (e as object)).toBe(false)
    const tail = store.readEventsFrom(id, 3)
    expect(tail).toHaveLength(1)
    expect("$prev" in (tail[0] as object)).toBe(false)
  })

  it("meta 记录链头与总行数", () => {
    const { store, id } = seeded(3)
    const meta = store.meta(id)!
    expect(meta.chainLength).toBe(4)
    expect(meta.chainHead).toBe(lineDigest(lines(id).at(-1)!))
  })

  it("updateMeta（软删/恢复路径）不丢链锚字段", () => {
    const { store, id } = seeded(2)
    store.delete(id)
    store.restore(id)
    const meta = store.meta(id)!
    expect(meta.chainLength).toBe(5) // created + 2 msg + deleted + restored
    expect(meta.chainHead).toBe(lineDigest(lines(id).at(-1)!))
    expect(store.verifyChain(id).status).toBe("ok")
  })

  it("rebuildMeta 重算链锚字段", () => {
    const { store, id } = seeded(3)
    rmSync(metaPath(id), { force: true } as never) // meta.json 缺失触发重建
    const meta = store.rebuildMeta(id)!
    expect(meta.chainLength).toBe(4)
    expect(meta.chainHead).toBe(lineDigest(lines(id).at(-1)!))
    expect(store.verifyChain(id).status).toBe("ok")
  })

  it("writeEventsRaw 建新链（fork 复制段重链化）", () => {
    const { store, id } = seeded(3)
    const forkId = "ses_forktest"
    const events = store.readEvents(id)
    ;(store as unknown as { writeEventsRaw: (i: string, e: unknown[]) => void }).writeEventsRaw(forkId, events)
    const raw = lines(forkId)
    expect((JSON.parse(raw[0]!) as Record<string, unknown>).$prev).toBe(chainGenesis(forkId))
    expect((JSON.parse(raw[1]!) as Record<string, unknown>).$prev).toBe(lineDigest(raw[0]!))
  })

  it("fork 会话整链自洽：复制段 + forked 事件 + 后续新事件", () => {
    const { store, id } = seeded(3)
    const forkId = "ses_forkchain"
    store.appendEvent = store.appendEvent // keep type
    const events = store.readEvents(id)
    const w = (store as unknown as { writeEventsRaw: (i: string, e: unknown[]) => void })
    w.writeEventsRaw(forkId, events)
    store.appendEvent(forkId, { type: "session.forked", at: new Date().toISOString(), sourceSessionId: id, title: "fork" })
    store.appendMessage(forkId, newMessage(forkId, "user", [{ type: "text", text: "after fork" }]))
    store.rebuildMeta(forkId)
    const r = store.verifyChain(forkId)
    expect(r.status).toBe("ok")
    expect(r.checked).toBe(6)
    // 复制段被改 → 链断（复制段已重链化为本会话链一部分）
    const raw = lines(forkId)
    const t = JSON.parse(raw[1]!) as Record<string, unknown>; t.$prev = "0".repeat(64)
    raw[1] = JSON.stringify(t)
    writeLines(forkId, raw)
    expect(store.verifyChain(forkId).status).toBe("broken")
  })
})

describe("verifyEventChain 篡改检出（原型场景对齐）", () => {
  it("正常链 ok", () => {
    const { store, id } = seeded(3)
    const r = store.verifyChain(id)
    expect(r.status).toBe("ok")
    expect(r.checked).toBe(4)
  })

  it("改中间一行 → broken，suspect 指向被改行", () => {
    const { store, id } = seeded(5)
    const raw = lines(id)
    const t = JSON.parse(raw[2]!) as Record<string, unknown>; (t as { blocks?: unknown[] }).blocks = [{ type: "text", text: "HACKED" }]
    raw[2] = JSON.stringify(t)
    writeLines(id, raw)
    const r = store.verifyChain(id)
    expect(r.status).toBe("broken")
    expect(r.brokenAt).toBe(4)
    expect(r.suspect).toBe(3)
  })

  it("删中间一行 → broken", () => {
    const { store, id } = seeded(5)
    const raw = lines(id)
    raw.splice(2, 1)
    writeLines(id, raw)
    expect(store.verifyChain(id).status).toBe("broken")
  })

  it("删末尾两行 → chainLength 检出（截尾攻击）", () => {
    const { store, id } = seeded(5)
    const raw = lines(id)
    raw.splice(-2, 2) // 掐掉最后两行：剩余链自洽，靠 meta.chainLength 抓截尾
    writeLines(id, raw)
    const r = store.verifyChain(id)
    expect(r.status).toBe("broken")
    expect(r.reason).toContain("比记录短")
  })

  it("调换相邻两行 → broken", () => {
    const { store, id } = seeded(5)
    const raw = lines(id)
    ;[raw[1], raw[2]] = [raw[2], raw[1]]
    writeLines(id, raw)
    expect(store.verifyChain(id).status).toBe("broken")
  })

  it("换入别的会话的文件 → meta.id 核对检出", () => {
    const a = seeded(3)
    const b = seeded(3)
    writeFileSync(eventsPath(b.id), readFileSync(eventsPath(a.id), "utf8"))
    writeFileSync(metaPath(b.id), readFileSync(metaPath(a.id), "utf8"))
    const r = b.store.verifyChain(b.id)
    expect(r.status).toBe("broken")
    expect(r.reason).toContain("置换")
  })

  it("只换文件不换 meta → 创世不符检出", () => {
    const a = seeded(3)
    const b = seeded(3)
    writeFileSync(eventsPath(b.id), readFileSync(eventsPath(a.id), "utf8"))
    const r = b.store.verifyChain(b.id)
    expect(r.status).toBe("broken")
  })

  it("meta.chainHead 被改 → 检出", () => {
    const { store, id } = seeded(3)
    const meta = JSON.parse(readFileSync(metaPath(id), "utf8")) as Record<string, unknown>
    meta.chainHead = lineDigest("fake")
    writeFileSync(metaPath(id), JSON.stringify(meta))
    const r = store.verifyChain(id)
    expect(r.status).toBe("broken")
    expect(r.reason).toContain("chainHead")
  })

  it("末行撕裂 → torn-tail（崩溃痕迹，非篡改）", () => {
    const { store, id } = seeded(4)
    const raw = readFileSync(eventsPath(id), "utf8")
    writeFileSync(eventsPath(id), raw.slice(0, raw.length - 10))
    expect(store.verifyChain(id).status).toBe("torn-tail")
  })

  it("撕裂后追加 → 修复并续链，verify ok（自愈）", () => {
    const { store, id } = seeded(4)
    const raw = readFileSync(eventsPath(id), "utf8")
    writeFileSync(eventsPath(id), raw.slice(0, raw.length - 10))
    store.appendMessage(id, newMessage(id, "user", [{ type: "text", text: "after crash" }]))
    const r = store.verifyChain(id)
    expect(r.status).toBe("ok")
  })

  it("崩溃窗口（事件已写、meta 未写）→ 容忍并自愈", () => {
    const { store, id } = seeded(3)
    // 模拟：手动追加一条链正确的行（走 store 内部逻辑等价于事件写成功），
    // 但把 meta 回滚到追加前
    const metaBefore = readFileSync(metaPath(id), "utf8")
    store.appendMessage(id, newMessage(id, "user", [{ type: "text", text: "crash window" }]))
    writeFileSync(metaPath(id), metaBefore) // meta 回滚（事件在、meta 旧）
    const stale = store.verifyChain(id)
    expect(stale.status === "ok" || stale.status === "partial").toBe(true) // 崩溃窗口容忍
    // 下一次追加后 meta 对齐 → 彻底 ok
    store.appendMessage(id, newMessage(id, "user", [{ type: "text", text: "heal" }]))
    expect(store.verifyChain(id).status).toBe("ok")
  })
})

describe("旧会话兼容", () => {
  it("纯旧会话（无链）→ not-chained；旧前缀 + 新事件 → partial", () => {
    const store = new SessionStore(dir)
    const id = "ses_legacy"
    // 手工造旧格式会话（无 $prev）
    const now = new Date().toISOString()
    const msg = { ...newMessage(id, "user", [{ type: "text", text: "old" }]), createdAt: now }
    mkdirSync(join(dir, id), { recursive: true })
    writeFileSync(join(dir, id, "events.jsonl"), JSON.stringify({ type: "session.created", at: now, title: "旧会话" }) + "\n" + JSON.stringify({ type: "message", ...msg }) + "\n")
    // 首次校验：未起链
    expect(store.verifyChain(id).status).toBe("not-chained")
    // 追加新事件（meta 不存在 → 读末行 → 末行无 $prev → 新链从创世起）
    store.appendMessage(id, newMessage(id, "user", [{ type: "text", text: "new" }]))
    const r = store.verifyChain(id)
    expect(r.status).toBe("partial")
    expect(r.verifiedFrom).toBe(3)
    expect(r.checked).toBe(1)
    // 再追加仍续链
    store.appendMessage(id, newMessage(id, "user", [{ type: "text", text: "newer" }]))
    expect(store.verifyChain(id).status).toBe("partial")
    expect(store.verifyChain(id).checked).toBe(2)
  })

  it("旧会话数据经 readEvents 不受影响（无 $prev 可剥也照常读）", () => {
    const store = new SessionStore(dir)
    const id = "ses_legacy2"
    mkdirSync(join(dir, id), { recursive: true })
    const now = new Date().toISOString()
    const msg = { ...newMessage(id, "user", [{ type: "text", text: "old" }]), createdAt: now }
    writeFileSync(join(dir, id, "events.jsonl"), JSON.stringify({ type: "session.created", at: now, title: "旧会话" }) + "\n" + JSON.stringify({ type: "message", ...msg }) + "\n")
    expect(store.readEvents(id)).toHaveLength(2)
  })
})

describe("verifyEventChain 纯函数（无 IO）", () => {
  it("空输入 → not-chained", () => {
    expect(verifyEventChain("", null, "s").status).toBe("not-chained")
  })
})
