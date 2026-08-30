import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { parseCognitionFile, renderCognitionFile, writeCognitionFile, cognitionPath } from "../../src/memory/cognition.js"

const RULE = `---
title: kclaw 项目规则
scope: project:kclaw-a3f2c9
created: 2026-08-22
updated: 2026-08-28
---

## 测试驱动

kclaw 的功能改动必须先写测试再写实现。
<!-- 来源：ws-reconnect#2026-08-21 -->
`

describe("parseCognitionFile", () => {
  it("parses rule file with scope and body", () => {
    const cf = parseCognitionFile(RULE, "rule", "kclaw")!
    expect(cf.title).toBe("kclaw 项目规则")
    expect(cf.scope).toBe("project:kclaw-a3f2c9")
    expect(cf.body).toContain("测试驱动")
    expect(cf.body).toContain("<!-- 来源：ws-reconnect#2026-08-21 -->")
  })
  it("defaults scope to global and status-free body", () => {
    const cf = parseCognitionFile("---\ntitle: p\n---\n\n正文\n", "persona", "persona")!
    expect(cf.scope).toBe("global")
    expect(cf.body).toBe("正文")
  })
  it("returns undefined without closing frontmatter", () => {
    expect(parseCognitionFile("---\nx", "wiki", "misc")).toBeUndefined()
  })
})

describe("writeCognitionFile merges human edits", () => {
  it("keeps the human-edited scope while rewriting the body", () => {
    const dir = mkdtempSync(join(tmpdir(), "kclaw-cog-"))
    try {
      const path = join(dir, "rule", "general.md")
      const created = writeCognitionFile(
        path, "rule", "general",
        (cf) => cf,
        () => ({ kind: "rule", name: "general", title: "通用", scope: "global", created: "2026-08-01", updated: "2026-08-01", body: "旧认知" }),
      )
      expect(created.body).toBe("旧认知")
      const human = readFileSync(path, "utf8").replace("scope: global", "scope: project:other-123456")
      writeFileSync(path, human)
      writeCognitionFile(path, "rule", "general",
        (cf) => ({ ...cf, body: "新认知", updated: "2026-08-29" }),
        () => { throw new Error("should create only when absent") })
      const merged = parseCognitionFile(readFileSync(path, "utf8"), "rule", "general")!
      expect(merged.scope).toBe("project:other-123456")
      expect(merged.body).toBe("新认知")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it("refuses to overwrite an existing unparseable file (spec 2.5)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kclaw-cog-"))
    try {
      const path = join(dir, "rule", "general.md")
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, "人工手写，没有 frontmatter\n")
      expect(() => writeCognitionFile(
        path, "rule", "general",
        (cf) => ({ ...cf, body: "不该覆盖" }),
        () => ({ kind: "rule", name: "general", title: "t", scope: "global", created: "2026-08-01", updated: "2026-08-01", body: "不该覆盖" }),
      )).toThrow()
      expect(readFileSync(path, "utf8")).toBe("人工手写，没有 frontmatter\n")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("cognitionPath", () => {
  it("maps kind/name to the global tree layout", () => {
    expect(cognitionPath("/g", "persona", "persona")).toBe("/g/persona.md")
    expect(cognitionPath("/g", "wiki", "dev-machine")).toBe("/g/wiki/dev-machine.md")
    expect(cognitionPath("/g", "rule", "kclaw")).toBe("/g/rule/kclaw.md")
  })
})
