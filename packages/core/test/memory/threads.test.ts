import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseThreadFile, renderThreadFile, writeThreadFile, appendSection, updateSection, renderMemoryMd, parseMemoryMd, type ThreadFile } from "../../src/memory/threads.js"

const SAMPLE = `---
topic: ws-reconnect
title: WebSocket 重连风暴排查
status: active
created: 2026-08-20
updated: 2026-08-28
---

## 2026-08-21 · 加指数退避守卫

- 做了什么：重连逻辑加指数退避与抖动
- 结果：重连风暴消失，测试通过
`

describe("parseThreadFile", () => {
  it("parses frontmatter and date sections", () => {
    const tf = parseThreadFile(SAMPLE)!
    expect(tf.topic).toBe("ws-reconnect")
    expect(tf.status).toBe("active")
    expect(tf.sections).toHaveLength(1)
    expect(tf.sections[0]!.date).toBe("2026-08-21")
    expect(tf.sections[0]!.heading).toBe("加指数退避守卫")
    expect(tf.sections[0]!.body).toContain("指数退避")
  })
  it("tolerates missing status/dates and skips non-section body lines", () => {
    const tf = parseThreadFile("---\ntopic: t\n---\n\n开场白一行\n\n## 2026-08-01 · A\n\n正文\n")!
    expect(tf.status).toBe("active")
    expect(tf.sections).toHaveLength(1)
  })
  it("returns undefined for non-thread files", () => {
    expect(parseThreadFile("no frontmatter")).toBeUndefined()
    expect(parseThreadFile("---\nunclosed")).toBeUndefined()
  })
})

describe("renderThreadFile round-trip", () => {
  it("render→parse preserves structure", () => {
    const tf = parseThreadFile(SAMPLE)!
    expect(parseThreadFile(renderThreadFile(tf))!.sections[0]!.body).toBe(tf.sections[0]!.body)
  })
})

describe("writeThreadFile guards human edits", () => {
  it("mutates the LATEST disk content, never a stale in-memory copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "kclaw-thr-"))
    try {
      const path = join(dir, "ws-reconnect.md")
      writeThreadFile(path, (tf) => tf, () => parseThreadFile(SAMPLE)!)
      // 人工把 status 改成 inactive（daemon 内存里不知道）
      const human = readFileSync(path, "utf8").replace("status: active", "status: inactive")
      writeFileSync(path, human)
      // daemon 追加情节：必须基于人工版合并，status 不丢
      writeThreadFile(path, (tf) => appendSection(tf, { date: "2026-08-29", heading: "跟进", body: "- 做了什么：复查\n" }), () => parseThreadFile(SAMPLE)!)
      const merged = parseThreadFile(readFileSync(path, "utf8"))!
      expect(merged.status).toBe("inactive")
      expect(merged.sections).toHaveLength(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("MEMORY.md", () => {
  it("renders a table from thread frontmatter and parses back", () => {
    const tf = parseThreadFile(SAMPLE)!
    const md = renderMemoryMd("kclaw-a3f2c9", [tf])
    expect(md).toContain("| ws-reconnect | WebSocket 重连风暴排查 | active | 2026-08-28 |")
    const rows = parseMemoryMd(md)
    expect(rows[0]).toEqual({ topic: "ws-reconnect", title: "WebSocket 重连风暴排查", status: "active", updated: "2026-08-28" })
  })
})
