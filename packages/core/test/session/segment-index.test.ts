// packages/core/test/session/segment-index.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { SegmentIndex } from "../../src/session/segment-index.js"

const dir = mkdtempSync(join(tmpdir(), "kclaw-segidx-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("SegmentIndex", () => {
  it("indexes segments and searches CJK queries with an excerpt", () => {
    const idx = SegmentIndex.open(join(dir, "a.db"))
    idx.addSegment("m3", "user: 我们把分界改到用户消息上\nassistant: 好的", "分界相关段摘要")
    const hits = idx.search("分界", 5)
    expect(hits.length).toBe(1)
    expect(hits[0]!.summary).toBe("分界相关段摘要")
    expect(hits[0]!.excerpt).toContain("用户消息")
  })

  it("upserts on the same upto and returns [] for token-less queries", () => {
    const idx = SegmentIndex.open(join(dir, "b.db"))
    idx.addSegment("m1", "第一版正文", "摘要1")
    idx.addSegment("m1", "第二版正文完全不同", "摘要2")
    expect(idx.search("第一版", 5)).toEqual([])
    expect(idx.search("第二版", 5)[0]!.summary).toBe("摘要2")
    expect(idx.search("!!!", 5)).toEqual([])
  })

  it("ensure() rebuilds a missing db from entries, skips empty bodies, reuses an existing db", () => {
    const path = join(dir, "c.db")
    const rebuilt = SegmentIndex.ensure(path, [
      { upto: "m2", body: "用户在上海工作", summary: "上海段" },
      { upto: "gone", body: "", summary: "失效段" },
    ])
    expect(rebuilt.search("上海", 5).length).toBe(1)
    // empty-body entries are invalidated segments: skipped, never searchable
    expect(rebuilt.search("失效段", 5)).toEqual([])
    // existing file: ensure must NOT re-add (the upsert would otherwise
    // overwrite the summary with "被忽略的新摘要")
    const again = SegmentIndex.ensure(path, [{ upto: "m2", body: "用户在上海工作", summary: "被忽略的新摘要" }])
    expect(again.search("上海", 5)[0]!.summary).toBe("上海段")
  })

  it("ensure() recovers from a corrupt db file by deleting and rebuilding it", () => {
    const path = join(dir, "d.db")
    writeFileSync(path, "not a sqlite database at all ".repeat(40))
    const idx = SegmentIndex.ensure(path, [{ upto: "m9", body: "损坏后重建的正文", summary: "重建段" }])
    expect(idx.search("重建", 5).length).toBe(1)
  })
})
