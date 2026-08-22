import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore } from "../../src/memory/store.js"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kclaw-mem-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const store = () => new MemoryStore({ notesDir: join(dir, "notes"), indexDb: join(dir, "index.db") })

describe("MemoryStore", () => {
  it("save creates markdown with frontmatter and indexes it", async () => {
    const m = store()
    const n = await m.save({ text: "用户在上海工作", tags: ["profile"], source: "model" })
    const raw = readFileSync(n.path, "utf8")
    expect(raw.startsWith("---\n")).toBe(true)
    expect(raw).toContain("id: " + n.id)
    expect(raw).toContain("用户在上海工作")
    expect((await m.search("上海")).map((x) => x.id)).toContain(n.id)
  })
  it("reconcile picks up hand-edited and deleted files (file is truth)", async () => {
    const m = store()
    const n = await m.save({ text: "likes oolong tea" })
    const m2 = store() // 新实例=重启
    writeFileSync(n.path, readFileSync(n.path, "utf8").replace("oolong", "green"))
    rmSync(join(dir, "notes", "gone.md"), { force: true }) // noop-safe
    const r = m2.reconcile()
    expect((await m2.search("green tea")).map((x) => x.id)).toContain(n.id)
    expect(r).toBeDefined()
    // 删除文件后索引清除
    rmSync(n.path)
    const m3 = store()
    m3.reconcile()
    expect(await m3.search("tea")).toEqual([])
  })
  it("save is merge-aware: similar note updates instead of duplicating", async () => {
    const m = store()
    await m.save({ text: "user lives in Shanghai", source: "model" })
    const second = await m.save({ text: "user lives in Shanghai now works remote", source: "auto" })
    const all = await m.search("Shanghai", 10)
    expect(all).toHaveLength(1)
    expect(second.text).toContain("works remote")
  })
  it("search ranks and limits", async () => {
    const m = store()
    await m.save({ text: "golang backend service notes" })
    await m.save({ text: "golang concurrency patterns" })
    await m.save({ text: "rust memory safety" })
    const r = await m.search("golang", 1)
    expect(r).toHaveLength(1)
    expect(r[0].text).toMatch(/golang/)
  })
})
