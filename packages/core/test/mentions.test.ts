/**
 * File mention (`@path`) tests — the composer completion helpers, the raw-text
 * mention extractor and the model-facing implicit wrap. Boundary philosophy
 * matches skill mentions: an `@` preceded by ASCII alphanumerics (email
 * addresses) does not trigger, unspaced Chinese text does.
 */
import { describe, it, expect } from "vitest"
import { extractFileMentions, fileMentionCompletions, replaceTrailingMentionToken, wrapFileMentions } from "../src/mentions.js"

describe("extractFileMentions", () => {
  it("extracts a token at line start and after whitespace", () => {
    expect(extractFileMentions("@src/a.ts 看这个")).toEqual(["src/a.ts"])
    expect(extractFileMentions("看 @src/a.ts")).toEqual(["src/a.ts"])
  })

  it("extracts from any position, deduplicating in scan order", () => {
    expect(extractFileMentions("@a.ts 和 @b.ts 与 @a.ts 再看 @b.ts")).toEqual(["a.ts", "b.ts"])
  })

  it("does not trigger inside email addresses or digit runs", () => {
    expect(extractFileMentions("发到 a@b.com 就行")).toEqual([])
    expect(extractFileMentions("1@2")).toEqual([])
  })

  it("lets unspaced Chinese text through (skill-mention posture)", () => {
    expect(extractFileMentions("看看@src/x.ts 这个文件")).toEqual(["src/x.ts"])
  })

  it("ends the token at whitespace and at end of line", () => {
    expect(extractFileMentions("@src/a b")).toEqual(["src/a"])
    expect(extractFileMentions("第一行\n@a.ts")).toEqual(["a.ts"])
  })

  it("ignores a bare @ and keeps slashes inside the token", () => {
    expect(extractFileMentions("一个 @ 就在那")).toEqual([])
    expect(extractFileMentions("@a/b/c.ts")).toEqual(["a/b/c.ts"])
  })

  it("returns empty for plain text", () => {
    expect(extractFileMentions("")).toEqual([])
    expect(extractFileMentions("没有引用的消息")).toEqual([])
  })
})

describe("wrapFileMentions", () => {
  it("returns undefined with no resolutions", () => {
    expect(wrapFileMentions("原文", [])).toBeUndefined()
  })

  it("appends one fs_read instruction for a single ok mention, keeping the text verbatim", () => {
    const wrapped = wrapFileMentions("原文", [{ token: "src/a.ts", status: "ok" }])!
    expect(wrapped.startsWith("原文")).toBe(true)
    expect(wrapped).toContain("「@src/a.ts」")
    expect(wrapped).toContain("fs_read")
  })

  it("appends a read-them-in-order instruction for multiple ok mentions", () => {
    const wrapped = wrapFileMentions("原文", [
      { token: "a.ts", status: "ok" },
      { token: "b.ts", status: "ok" },
    ])!
    expect(wrapped).toContain("「@a.ts」「@b.ts」")
    expect(wrapped).toContain("依次读取")
  })

  it("says so for missing files instead of asking for a read", () => {
    const wrapped = wrapFileMentions("原文", [{ token: "gone.ts", status: "missing" }])!
    expect(wrapped).toContain("「@gone.ts」引用的文件不存在或已删除")
    expect(wrapped).not.toContain("fs_read")
  })

  it("mixes the ok instruction and the missing note", () => {
    const wrapped = wrapFileMentions("原文", [
      { token: "a.ts", status: "ok" },
      { token: "gone.ts", status: "missing" },
    ])!
    expect(wrapped).toContain("「@a.ts」")
    expect(wrapped).toContain("fs_read")
    expect(wrapped).toContain("「@gone.ts」引用的文件不存在或已删除")
  })
})

describe("fileMentionCompletions", () => {
  const files = ["lib/test.ts", "test.ts", "src/mytest/a.ts", "src/components/Button.tsx", "README.md", "my file.txt"]

  it("suggests nothing unless the trailing chunk starts with @", () => {
    expect(fileMentionCompletions("hello", files)).toEqual([])
    expect(fileMentionCompletions("email a@b.com", files)).toEqual([])
    expect(fileMentionCompletions("@a.ts 看看", files)).toEqual([])
    expect(fileMentionCompletions("", files)).toEqual([])
  })

  it("suggests everything for a bare @, sorted shallow-first then lexicographically", () => {
    const bare = fileMentionCompletions("@", files)
    expect(bare).toHaveLength(files.length)
    // depth 0: my file.txt, README.md, test.ts — depth 1: lib/test.ts — depth 2 lexicographic.
    expect(bare).toEqual(["my file.txt", "README.md", "test.ts", "lib/test.ts", "src/components/Button.tsx", "src/mytest/a.ts"])
  })

  it("matches case-insensitively on any path part", () => {
    expect(fileMentionCompletions("@SRC", files)).toEqual(["src/components/Button.tsx", "src/mytest/a.ts"])
    expect(fileMentionCompletions("@button", files)).toEqual(["src/components/Button.tsx"])
  })

  it("ranks filename prefix over filename substring over path-only hits", () => {
    const scoped = ["lib/test.ts", "test.ts", "src/mytest/a.ts"]
    expect(fileMentionCompletions("@test", scoped)).toEqual(["test.ts", "lib/test.ts", "src/mytest/a.ts"])
  })

  it("caps the candidate list at 50", () => {
    const many = Array.from({ length: 51 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`)
    expect(fileMentionCompletions("@", many)).toHaveLength(50)
  })

  it("keeps space-containing paths among the candidates (the UI disables them)", () => {
    expect(fileMentionCompletions("@", files)).toContain("my file.txt")
  })

  it("suggests nothing for an @ mid-word boundary that does not match any file", () => {
    expect(fileMentionCompletions("@zzz", files)).toEqual([])
  })
})

describe("replaceTrailingMentionToken", () => {
  it("rewrites only the in-progress mention word and appends a space", () => {
    expect(replaceTrailingMentionToken("@src", "src/a.ts")).toBe("@src/a.ts ")
    expect(replaceTrailingMentionToken("看 @sr", "src/a.ts")).toBe("看 @src/a.ts ")
    expect(replaceTrailingMentionToken("@", "a.ts")).toBe("@a.ts ")
  })
})
