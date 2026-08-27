// packages/core/test/session/segment-index.test.ts
import { mkdtempSync, rmSync } from "node:fs"
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
    // existing file: ensure must NOT re-add (no duplicates)
    const again = SegmentIndex.ensure(path, [{ upto: "m2", body: "用户在上海工作", summary: "上海段" }])
    expect(again.search("上海", 5).length).toBe(1)
  })
})
