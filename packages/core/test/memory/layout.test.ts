import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectIdFor, MemoryLayout } from "../../src/memory/layout.js"

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "kclaw-layout-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe("projectIdFor", () => {
  it("is deterministic and mixes basename with path hash", () => {
    const a = projectIdFor("/Users/x/coding/kclaw")
    expect(a).toBe(projectIdFor("/Users/x/coding/kclaw"))
    expect(a).toMatch(/^kclaw-[0-9a-f]{6}$/)
  })
  it("differs for same basename under different parents", () => {
    expect(projectIdFor("/a/kclaw")).not.toBe(projectIdFor("/b/kclaw"))
  })
})

describe("MemoryLayout.ensureProject", () => {
  it("lazily creates the project dir with workdir.txt", () => {
    const layout = new MemoryLayout(join(root, "memory"))
    const { id, dir } = layout.ensureProject("/Users/x/coding/kclaw")
    expect(existsSync(dir)).toBe(true)
    expect(readFileSync(join(dir, "workdir.txt"), "utf8")).toBe("/Users/x/coding/kclaw")
    expect(layout.workdirOf(id)).toBe("/Users/x/coding/kclaw")
    // 幂等：第二次同一路径返回同一目录
    expect(layout.ensureProject("/Users/x/coding/kclaw").dir).toBe(dir)
  })
  it("path change = new project id; old dir untouched", () => {
    const layout = new MemoryLayout(join(root, "memory"))
    const first = layout.ensureProject("/w/old-name")
    const second = layout.ensureProject("/w/new-name")
    expect(second.id).not.toBe(first.id)
    expect(existsSync(first.dir)).toBe(true)
  })
})
