// packages/core/test/text/fts.test.ts
import { describe, expect, it } from "vitest"
import { ftsQuery, similarity, tokenize } from "../../src/text/fts.js"

describe("shared fts helpers", () => {
  it("bigram-splits CJK runs and lowercases ASCII words", () => {
    expect(tokenize("用户在上海工作 oolong")).toEqual([
      "用户", "户在", "在上", "上海", "海工", "工作", "oolong",
    ])
  })

  it("returns [] for punctuation-only input", () => {
    expect(tokenize("!!! ...")).toEqual([])
  })

  it("quotes and joins tokens for FTS MATCH", () => {
    expect(ftsQuery(["上海", "oolong"], " ")).toBe('"上海" "oolong"')
    expect(ftsQuery(["用户"], " OR ")).toBe('"用户"')
  })

  it("computes Jaccard similarity of token sets", () => {
    expect(similarity(["a", "b"], ["a", "b"])).toBe(1)
    expect(similarity(["a"], ["b"])).toBe(0)
    expect(similarity([], [])).toBe(1)
  })
})
