import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseThreadFile, renderThreadFile, writeThreadFile, appendSection, updateSection, renderMemoryMd, parseMemoryMd, capHeading, sectionHeading, HEADING_CAP, type ThreadFile } from "../../src/memory/threads.js"

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
  it("refuses to overwrite an existing unparseable file ", () => {
    const dir = mkdtempSync(join(tmpdir(), "kclaw-thr-"))
    try {
      const path = join(dir, "ws-reconnect.md")
      writeFileSync(path, "人工手写，没有 frontmatter\n")
      expect(() => writeThreadFile(
        path,
        (tf) => appendSection(tf, { date: "2026-08-29", heading: "不该覆盖", body: "- x\n" }),
        () => parseThreadFile(SAMPLE)!,
      )).toThrow()
      expect(readFileSync(path, "utf8")).toBe("人工手写，没有 frontmatter\n")
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

describe("sectionHeading", () => {
  it("caps a single-paragraph body to a readable prefix instead of echoing the full text", () => {
    const body = "用户把工作目录改名成了新路径，旧路径的记忆库因此成了孤儿。".repeat(4)
    const h = sectionHeading([body], [])
    expect(h.length).toBeLessThanOrEqual(HEADING_CAP)
    expect(body.startsWith(h)).toBe(true)
  })

  it("takes the first non-empty candidate and falls back to a generic heading", () => {
    expect(capHeading("\n \n第二行标题\n正文")).toBe("第二行标题")
    expect(sectionHeading(["模型给的标题", "正文首行"], [])).toBe("模型给的标题")
    expect(sectionHeading(["", "正文首行"], [])).toBe("正文首行")
    expect(sectionHeading(["", "  "], [])).toBe("记录")
  })

  it("suffixes a numeric disambiguator on collision so index keys stay unique", () => {
    const existing = [
      { date: "2026-09-16", heading: "同题", body: "a" },
      { date: "2026-09-16", heading: "同题（2）", body: "b" },
    ]
    expect(sectionHeading(["同题"], existing)).toBe("同题（3）")
  })
})

describe("updateSection fallback heading", () => {
  it("never appends an empty heading when the target section is missing", () => {
    const tf: ThreadFile = {
      topic: "t", title: "T", status: "active", created: "2026-09-16", updated: "2026-09-16",
      sections: [{ date: "2026-09-16", heading: "旧节", body: "旧" }],
    }
    const next = updateSection(tf, "", "模型没报对要修正的小节，正文整段落进来当标题来源。")
    expect(next.sections).toHaveLength(2)
    expect(next.sections[1]!.heading).not.toBe("")
  })
})
