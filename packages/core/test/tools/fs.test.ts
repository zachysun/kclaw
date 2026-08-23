import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFsTools } from "../../src/tools/fs.js"
import type { ToolExecutor } from "../../src/agent/tools.js"

let ws: string
beforeEach(async () => {
  ws = mkdtempSync(join(tmpdir(), "kclaw-fs-"))
  writeFileSync(join(ws, "a.txt"), "hello world\nhello again")
  mkdirSync(join(ws, "sub"))
  writeFileSync(join(ws, "sub", "b.txt"), "inner")
})
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

const call = (t: { execute: ToolExecutor["execute"] }, args: unknown) => t.execute(args, { onOutput: () => {} })

describe("fs tools", () => {
  it("fs_read reads relative and absolute", async () => {
    const t = createFsTools({ workspace: ws })
    expect((await call(t.fs_read, { path: "a.txt" })).output).toContain("hello world")
    expect((await call(t.fs_read, { path: join(ws, "a.txt") })).output).toContain("hello again")
  })
  it("fs_read resolves out-of-workspace paths (boundary is the permission gate)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "kclaw-fs-outside-"))
    try {
      writeFileSync(join(outside, "secret.txt"), "outside secret")
      const t = createFsTools({ workspace: ws })
      const r = await call(t.fs_read, { path: join(outside, "secret.txt") })
      expect(r.status).toBe("ok")
      expect(r.output).toContain("outside secret")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it("fs_list marks dirs and sizes", async () => {
    const t = createFsTools({ workspace: ws })
    const r = await call(t.fs_list, { path: "." })
    expect(r.output).toMatch(/sub\//)
    expect(r.output).toMatch(/a.txt \(\d+\)/)
  })
  it("fs_write creates parents and reports bytes", async () => {
    const t = createFsTools({ workspace: ws })
    const r = await call(t.fs_write, { path: "x/y/c.txt", content: "abc" })
    expect(r.status).toBe("ok")
    expect(r.output).toMatch(/wrote 3 bytes/)
  })
  it("fs_edit replaces exactly-once, errors on 0 or 2 matches", async () => {
    const t = createFsTools({ workspace: ws })
    const ok = await call(t.fs_edit, { path: "a.txt", old: "world", new: "kclaw" })
    expect(ok.status).toBe("ok")
    const zero = await call(t.fs_edit, { path: "a.txt", old: "nope", new: "x" })
    expect(zero.status).toBe("error")
    const two = await call(t.fs_edit, { path: "a.txt", old: "hello", new: "x" })
    expect(two.status).toBe("error")
    expect(two.output).toMatch(/2 occurrences/)
  })
  it("fs_edit replaces literally without $-pattern expansion", async () => {
    // $$, $&, $` and $' are replacement patterns for a string replacer;
    // fs_edit must write them back byte-for-byte instead.
    writeFileSync(join(ws, "dollar.txt"), "pre [X] post")
    const t = createFsTools({ workspace: ws })
    const r = await call(t.fs_edit, { path: "dollar.txt", old: "[X]", new: "` $' $$ $&" })
    expect(r.status).toBe("ok")
    expect(readFileSync(join(ws, "dollar.txt"), "utf8")).toBe("pre ` $' $$ $& post")
  })
  it("fs_edit refuses binary content and leaves the file byte-identical", async () => {
    // 0x00 与无效 UTF-8（解码成 U+FFFD）都是二进制标记：把 mojibake 解码串
    // 写回会毁掉原始字节，所以必须拒绝而不是编辑。
    const bytes = Buffer.from([0x68, 0x00, 0x69, 0xff, 0x21]) // h \0 i <invalid> !
    writeFileSync(join(ws, "blob.bin"), bytes)
    const t = createFsTools({ workspace: ws })
    const r = await call(t.fs_edit, { path: "blob.bin", old: "h", new: "H" })
    expect(r.status).toBe("error")
    expect(r.output).toContain("fs_edit only supports text files (binary content detected)")
    expect(readFileSync(join(ws, "blob.bin"))).toEqual(bytes) // 逐字节未变
  })
  it("risk/concurrency classification", () => {
    const t = createFsTools({ workspace: ws })
    expect(t.fs_read.risk).toBe("safe")
    expect(t.fs_read.concurrency).toBe("parallel")
    expect(t.fs_write.risk).toBe("sensitive")
    expect(t.fs_edit.concurrency).toBe("serial")
  })
})
