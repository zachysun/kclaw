import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VectorIndex, type IndexEntry } from "../../src/memory/indexer.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-idx-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ep = (key: string, text: string): IndexEntry => ({ key, text, topic: key.split("#")[0], title: "T", date: "2026-08-28", updatedAt: "2026-08-28" })

describe("VectorIndex", () => {
  it("upsert/keys/remove round-trip", () => {
    const idx = new VectorIndex(join(dir, "vectors.db"))
    idx.upsert(ep("ws#2026-08-21#加退避", "重连加指数退避"))
    idx.upsert(ep("pwa#2026-08-27#修401", "PWA 静态文件 401 修复"))
    expect(idx.keys().has("ws#2026-08-21#加退避")).toBe(true)
    idx.remove("pwa#2026-08-27#修401")
    expect(idx.keys().has("pwa#2026-08-27#修401")).toBe(false)
  })
  it("searches CJK bigrams via FTS5 and returns raw rank", () => {
    const idx = new VectorIndex(join(dir, "vectors.db"))
    idx.upsert(ep("a#d#h1", "重连加指数退避守卫"))
    idx.upsert(ep("b#d#h2", "完全无关的情节"))
    const hits = idx.searchFts("退避", 5)
    expect(hits.map((h) => h.key)).toContain("a#d#h1")
    expect(hits.find((h) => h.key === "a#d#h1")!.rank).toBeLessThanOrEqual(0)
  })
  it("stores and returns vectors", () => {
    const idx = new VectorIndex(join(dir, "vectors.db"))
    const v = new Float32Array([0.1, 0.2, 0.3])
    idx.upsert(ep("k", "文本"), v)
    idx.upsert(ep("j", "另一段")) // 无向量：允许（关键词路兜底）
    expect(Array.from(idx.vectorOf("k")!)).toEqual(Array.from(v))
    expect(idx.vectorOf("j")).toBeUndefined()
    // 重开库仍在（持久化）
    idx.close()
    const again = new VectorIndex(join(dir, "vectors.db"))
    expect(Array.from(again.vectorOf("k")!)).toEqual(Array.from(v))
    expect(again.metaOf("k")!.topic).toBe("k")
  })
  it("re-upsert replaces text and vector", () => {
    const idx = new VectorIndex(join(dir, "vectors.db"))
    idx.upsert(ep("k", "旧正文"), new Float32Array([1, 0]))
    idx.upsert({ ...ep("k", "新正文完全不同"), updatedAt: "2026-08-29" }, new Float32Array([0, 1]))
    expect(idx.metaOf("k")!.text).toBe("新正文完全不同")
    expect(Array.from(idx.vectorOf("k")!)).toEqual([0, 1])
  })
})
