import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sweepSpillDir, utimesSync } from "../src/session-retention.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-spillret-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const DAY = 24 * 60 * 60 * 1000
const plant = (name: string, ageDays: number): void => {
  const p = join(dir, name)
  writeFileSync(p, "x", { mode: 0o600 })
  const at = Date.now() - ageDays * DAY
  utimesSync(p, new Date(at), new Date(at))
}

describe("sweepSpillDir", () => {
  it("删超期、留未到期；ttl<=0 一律不动", () => {
    plant("old.txt", 40)
    plant("new.txt", 3)
    const removed = sweepSpillDir(dir, 30 * DAY)
    expect(removed).toEqual(["old.txt"])
    expect(existsSync(join(dir, "new.txt"))).toBe(true)
    expect(sweepSpillDir(dir, 0)).toEqual([])
  })

  it("目录不存在视为无事发生；非普通文件跳过", () => {
    expect(sweepSpillDir(join(dir, "nope"), DAY)).toEqual([])
    mkdirSync(join(dir, "subdir"))
    expect(sweepSpillDir(dir, DAY)).toEqual([])
  })

  it("边界：恰好到期（>= ttl）算超期", () => {
    plant("edge.txt", 30)
    expect(sweepSpillDir(dir, 30 * DAY)).toEqual(["edge.txt"])
  })
})
