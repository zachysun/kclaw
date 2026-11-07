/**
 * stdin's four states for `kclaw run` (spec A2) and the session list table
 * (A9): prompt source, the piped attachment, limits and display-width
 * alignment.
 */
import { describe, it, expect } from "vitest"
import { MAX_ATTACHMENT_BYTES } from "@kclaw/core"
import { MAX_STDIN_PROMPT_BYTES, readRunPrompt } from "../src/run-input.js"
import { renderSessionTable } from "../src/session-list.js"
import { alignColumns, displayWidth } from "../src/text-width.js"
import { UsageError } from "../src/usage-error.js"

/** A stdin stand-in: the chunks as an async iterable; `touched` records whether anyone read it. */
function pipe(...chunks: Array<string | Buffer>): { read: () => AsyncIterable<Buffer | string>; touched: () => boolean } {
  let touched = false
  return {
    read: () => {
      touched = true
      return (async function* () {
        yield* chunks
      })()
    },
    touched: () => touched,
  }
}

describe("readRunPrompt", () => {
  it("TTY: arguments are the prompt and stdin is never read", async () => {
    const stdin = pipe("ignored")
    expect(await readRunPrompt(["看看", "日志"], true, stdin.read)).toEqual({ text: "看看 日志" })
    expect(stdin.touched()).toBe(false)
  })

  it("TTY without a prompt is a usage error that shows usage", async () => {
    const error = await readRunPrompt([], true, pipe().read).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UsageError)
    expect((error as UsageError).showHelp).toBe(true)
  })

  it("TTY with `-` is a usage error: there is no pipe to read", async () => {
    await expect(readRunPrompt(["-"], true, pipe().read)).rejects.toBeInstanceOf(UsageError)
  })

  it("pipe + prompt: the pipe rides as stdin.txt, the message keeps only the argument", async () => {
    const r = await readRunPrompt(["总结"], false, pipe("@Component\n", "/deploy now\n").read)
    expect(r.text).toBe("总结")
    expect(r.pipe).toEqual({ filename: "stdin.txt", mimeType: "text/plain", body: Buffer.from("@Component\n/deploy now\n") })
  })

  it("pipe + prompt with a NUL byte: binary stdin.bin", async () => {
    const r = await readRunPrompt(["看"], false, pipe(Buffer.from([0x50, 0x00, 0x4b])).read)
    expect(r.pipe?.filename).toBe("stdin.bin")
    expect(r.pipe?.mimeType).toBe("application/octet-stream")
  })

  it("pipe + prompt with an empty pipe: no attachment", async () => {
    expect(await readRunPrompt(["你好"], false, pipe().read)).toEqual({ text: "你好" })
  })

  it("pipe without arguments, or with `-` alone: the whole pipe is the prompt", async () => {
    expect(await readRunPrompt([], false, pipe("修一下 ", "@src/a.ts").read)).toEqual({ text: "修一下 @src/a.ts" })
    expect(await readRunPrompt(["-"], false, pipe("hi").read)).toEqual({ text: "hi" })
  })

  it("`-` followed by more arguments, a blank prompt, or a blank pipe-as-prompt are usage errors", async () => {
    await expect(readRunPrompt(["-", "more"], false, pipe("x").read)).rejects.toBeInstanceOf(UsageError)
    await expect(readRunPrompt(["  "], false, pipe("x").read)).rejects.toBeInstanceOf(UsageError)
    await expect(readRunPrompt([], false, pipe(" \n\t").read)).rejects.toBeInstanceOf(UsageError)
  })

  it("limits: 10 MiB as a prompt, the upload cap as an attachment", async () => {
    const big = Buffer.alloc(MAX_STDIN_PROMPT_BYTES + 1, 0x61)
    await expect(readRunPrompt([], false, pipe(big).read)).rejects.toThrow(/10 MiB/)
    const ok = await readRunPrompt(["看"], false, pipe(big).read)
    expect(ok.pipe?.body.length).toBe(big.length)
    await expect(readRunPrompt(["看"], false, pipe(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61)).read)).rejects.toThrow(/20MB/)
  })
})

describe("display width", () => {
  it("a CJK character takes two columns", () => {
    expect(displayWidth("会话")).toBe(4)
    expect(displayWidth("ab")).toBe(2)
  })

  it("aligns mixed CJK and ASCII columns by display width", () => {
    const lines = alignColumns([["id", "title", "x"], ["s1", "中文标题", "y"], ["s2", "abc", "z"]])
    const xCol = lines.map((l) => displayWidth(l.slice(0, l.lastIndexOf(" ") + 1)))
    expect(new Set(xCol).size).toBe(1)
  })
})

describe("renderSessionTable", () => {
  it("one aligned row per session with local short time; control characters neutralized", () => {
    const at = new Date(2026, 10, 7, 9, 5).toISOString()
    const out = renderSessionTable([
      { id: "ses_A", title: "排查\x1b[31m日志", updatedAt: at, workdir: "/w/项目" },
      { id: "ses_B", title: "x", updatedAt: at },
    ])
    const lines = out.split("\n")
    expect(lines[0]).toMatch(/^id\s+title\s+workdir\s+updatedAt$/)
    expect(lines[1]).toContain("2026-11-07 09:05")
    expect(out).not.toContain("\x1b")
    expect(lines[2]).toContain(" - ")
    const updatedCol = lines.map((l) => displayWidth(l.slice(0, l.indexOf(l.includes("2026") ? "2026" : "updatedAt"))))
    expect(new Set(updatedCol).size).toBe(1)
  })

  it("an empty list prints one hint line", () => {
    expect(renderSessionTable([]).split("\n")).toHaveLength(1)
  })
})
