import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spillLocatorLine, spillToolOutput, SPILL_MAX_BYTES } from "../../src/tools/spill.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-spill-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("spillToolOutput", () => {
  it("writes the captured span and returns a readable path", () => {
    const r = spillToolOutput(dir, "exec", "hello\nworld")
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
    const r = spillToolOutput(dir, "exec", big)
    expect(r.partial).toBe(true)
    expect(readFileSync(r.path!, "utf8")).toHaveLength(SPILL_MAX_BYTES)
  })

  it("degrades silently: missing dir flag and unwritable root both return empty results", () => {
    expect(spillToolOutput(undefined, "exec", "data")).toEqual({})
    // dir points at a FILE — mkdir/write must fail, not throw
    const asFile = join(dir, "occupied")
    writeFileSync(asFile, "not a dir")
    expect(spillToolOutput(asFile, "exec", "data")).toEqual({})
  })

  it("skips empty captures without creating anything", () => {
    expect(spillToolOutput(dir, "exec", "")).toEqual({})
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
