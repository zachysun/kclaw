import { describe, it, expect } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandFileRefs } from "../src/file-refs.js"

describe("expandFileRefs", () => {
  it("inlines a small text file and drops the @token", () => {
    const ws = mkdtempSync(join(tmpdir(), "kclaw-ref-ws-"))
    writeFileSync(join(ws, "todo.md"), "- 买菜")
    const r = expandFileRefs("帮我看看 @todo.md 的优先级", ws, ws)
    expect(r).toEqual({ text: "帮我看看 的优先级\n[来自 @todo.md]\n- 买菜" })
    rmSync(ws, { recursive: true, force: true })
  })

  it("notes large or non-text files for on-demand fs_read", () => {
    const ws = mkdtempSync(join(tmpdir(), "kclaw-ref-ws2-"))
    writeFileSync(join(ws, "big.pdf"), "x".repeat(1000))
    const r = expandFileRefs("总结 @big.pdf", ws, ws)
    if ("error" in r) throw new Error("unexpected error")
    expect(r.text).toContain("[文件 @big.pdf（1000 字节）已引用，可用 fs_read 读取")
    rmSync(ws, { recursive: true, force: true })
  })

  it("rejects out-of-workdir paths", () => {
    const ws = mkdtempSync(join(tmpdir(), "kclaw-ref-ws3-"))
    const outside = mkdtempSync(join(tmpdir(), "kclaw-ref-out-"))
    writeFileSync(join(outside, "secret.txt"), "x")
    const r = expandFileRefs("读 @../kclaw-ref-out-whatever", ws, ws)
    expect("error" in r).toBe(true)
    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
})
