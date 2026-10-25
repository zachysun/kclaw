import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { spillLocatorLine, spillToolOutput, SPILL_MAX_BYTES, SPILL_LOCATOR_PREFIX } from "../../src/tools/spill.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-spill-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("spillToolOutput", () => {
  it("writes the captured span and returns a readable path", () => {
    const r = spillToolOutput(dir, "bash", "hello\nworld")
    expect(r.path).toBeDefined()
    expect(existsSync(r.path!)).toBe(true)
    expect(readFileSync(r.path!, "utf8")).toBe("hello\nworld")
    expect(r.partial).toBeUndefined()
  })

  it("sanitizes the tool name into the filename and isolates concurrent spills", () => {
    const a = spillToolOutput(dir, "weird/name here", "a")
    const b = spillToolOutput(dir, "weird/name here", "b")
    expect(a.path).not.toBe(b.path)
    expect(a.path!.startsWith(dir)).toBe(true)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it("marks and truncates a capture beyond the ceiling", () => {
    const big = "x".repeat(SPILL_MAX_BYTES + 1)
    const r = spillToolOutput(dir, "bash", big)
    expect(r.partial).toBe(true)
    expect(readFileSync(r.path!, "utf8")).toHaveLength(SPILL_MAX_BYTES)
  })

  it("degrades silently: missing dir flag and unwritable root both return empty results", () => {
    expect(spillToolOutput(undefined, "bash", "data")).toEqual({})
    // dir points at a FILE — mkdir/write must fail, not throw
    const asFile = join(dir, "occupied")
    writeFileSync(asFile, "not a dir")
    expect(spillToolOutput(asFile, "bash", "data")).toEqual({})
  })

  it("skips empty captures without creating anything", () => {
    expect(spillToolOutput(dir, "bash", "")).toEqual({})
    expect(readdirSync(dir)).toHaveLength(0)
  })
})

describe("spillLocatorLine", () => {
  it("empty when nothing spilled", () => {
    expect(spillLocatorLine({})).toBe("")
  })
  it("carries the path and the partial note when truncated", () => {
    const line = spillLocatorLine({ path: "/tmp/x.txt", partial: true })
    expect(line).toContain("/tmp/x.txt")
    expect(line).toContain("fs_read")
    expect(line).toContain("前 10MB")
  })
})

describe("spill sha256", () => {
  it("spillToolOutput 返回写入字节的摘要，locator line 带指纹段", () => {
    const r = spillToolOutput(dir, "bash", "hello\nworld")
    expect(r.sha256).toBe(createHash("sha256").update("hello\nworld").digest("hex"))
    expect(r.path).toBeDefined()
    const line = spillLocatorLine(r)
    expect(line).toContain(`sha256=${r.sha256}`)
    expect(line.startsWith("\n" + SPILL_LOCATOR_PREFIX)).toBe(true)
    expect(line.endsWith("]")).toBe(true)
  })

  it("partial 拷贝的指纹对保留部分", () => {
    const big = "x".repeat(SPILL_MAX_BYTES + 100)
    const r = spillToolOutput(dir, "bash", big)
    expect(r.partial).toBe(true)
    expect(r.sha256).toBe(createHash("sha256").update("x".repeat(SPILL_MAX_BYTES)).digest("hex"))
  })
})
