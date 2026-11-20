import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendJsonlLine, readCompleteLines, readJsonl, splitLinesCanonical,
} from "../../src/storage/jsonl.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-jsonl-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("splitLinesCanonical：撕裂判定的唯一定义", () => {
  it("空文本 = 没有行、没有撕裂", () => {
    expect(splitLinesCanonical("")).toEqual({ lines: [], tornTail: false })
  })

  it("只有一行且无换行 = 一行撕裂残迹", () => {
    expect(splitLinesCanonical("abc")).toEqual({ lines: ["abc"], tornTail: true })
  })

  it("完整追加的末尾换行产生空尾串并被去掉", () => {
    expect(splitLinesCanonical("a\nb\n")).toEqual({ lines: ["a", "b"], tornTail: false })
  })

  it("末行缺换行 = 该行保留在 lines 里并置 tornTail", () => {
    expect(splitLinesCanonical("a\nb")).toEqual({ lines: ["a", "b"], tornTail: true })
  })

  it("行内的空行原样保留（只动末尾）", () => {
    expect(splitLinesCanonical("a\n\n")).toEqual({ lines: ["a", ""], tornTail: false })
  })
})

describe("appendJsonlLine：返回实际写盘的行原文", () => {
  it("返回值与文件末行逐字节相同（链摘要的可信来源）", () => {
    const file = join(dir, "log.jsonl")
    const line = appendJsonlLine(file, { b: 2, a: 1 })
    expect(line).toBe(JSON.stringify({ b: 2, a: 1 }))
    expect(readFileSync(file, "utf8")).toBe(line + "\n")
    expect(readJsonl(file)).toEqual([{ b: 2, a: 1 }])
  })

  it("追加前照常修复撕裂尾，返回值只属于新行", () => {
    const file = join(dir, "log.jsonl")
    writeFileSync(file, '{"ok":1}\n{"torn', "utf8")
    const line = appendJsonlLine(file, { n: 1 })
    expect(readJsonl(file)).toEqual([{ ok: 1 }, { n: 1 }])
    expect(line).toBe('{"n":1}')
  })
})

describe("readCompleteLines：修复语义的读取孪生", () => {
  it("文件不存在 → []", () => {
    expect(readCompleteLines(join(dir, "absent.jsonl"))).toEqual([])
  })

  it("空文件 → []", () => {
    const file = join(dir, "log.jsonl")
    writeFileSync(file, "", "utf8")
    expect(readCompleteLines(file)).toEqual([])
  })

  it("完整行原样返回（不解析）", () => {
    const file = join(dir, "log.jsonl")
    writeFileSync(file, "l1\nl2\n", "utf8")
    expect(readCompleteLines(file)).toEqual(["l1", "l2"])
  })

  it("撕裂残迹被丢弃：可解析与否都一样（与 repairTornTail 的截断一致）", () => {
    const file = join(dir, "log.jsonl")
    writeFileSync(file, "l1\n{l2-torn", "utf8")
    expect(readCompleteLines(file)).toEqual(["l1"])
    writeFileSync(file, "l1\n{\"parseable\":1}", "utf8")
    expect(readCompleteLines(file)).toEqual(["l1"])
  })
})
