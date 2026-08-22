import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore } from "../../src/memory/store.js"
import { createMemoryTools } from "../../src/tools/memory.js"
import type { ToolExecutor } from "../../src/agent/tools.js"

let dir: string
let memory: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kclaw-memtools-"))
  memory = new MemoryStore({ notesDir: join(dir, "notes"), indexDb: join(dir, "index.db") })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const call = (t: { execute: ToolExecutor["execute"] }, args: unknown) =>
  t.execute(args, { onOutput: () => {} })

describe("memory tools", () => {
  it("memory_save persists through the real store and reports the id", async () => {
    const t = createMemoryTools(memory)
    const r = await call(t.memory_save, { text: "user prefers dark mode over light", tags: ["preference"] })
    expect(r.status).toBe("ok")
    const hits = await memory.search("dark mode")
    expect(hits).toHaveLength(1)
    expect(r.output).toBe(`saved memory ${hits[0].id}`)
    expect(hits[0].tags).toEqual(["preference"])
  })
  it("memory_save rejects missing/blank text and non-string-array tags", async () => {
    const t = createMemoryTools(memory)
    for (const args of [{ tags: ["x"] }, { text: "   " }, { text: "ok", tags: "preference" }, { text: "ok", tags: [1] }]) {
      const r = await call(t.memory_save, args)
      expect(r.status).toBe("error")
      expect(r.output).toMatch(/^memory_save: /)
    }
  })
  it("memory_search formats one `- <text>` line per hit", async () => {
    await memory.save({ text: "likes oolong tea" })
    await memory.save({ text: "golang backend service notes" })
    const t = createMemoryTools(memory)
    const r = await call(t.memory_search, { query: "oolong tea" })
    expect(r.status).toBe("ok")
    expect(r.output).toBe("- likes oolong tea")
  })
  it("memory_search honors limit", async () => {
    await memory.save({ text: "golang backend service notes" })
    await memory.save({ text: "golang concurrency patterns" })
    await memory.save({ text: "golang error handling guide" })
    const t = createMemoryTools(memory)
    const r = await call(t.memory_search, { query: "golang", limit: 2 })
    expect(r.status).toBe("ok")
    expect(r.output.split("\n")).toHaveLength(2)
    for (const line of r.output.split("\n")) expect(line).toMatch(/^- golang /)
  })
  it("memory_search on no hit and on missing query", async () => {
    await memory.save({ text: "likes oolong tea" })
    const t = createMemoryTools(memory)
    expect((await call(t.memory_search, { query: "rust borrow checker" })).output).toBe("(no memories)")
    const r = await call(t.memory_search, {})
    expect(r.status).toBe("error")
    expect(r.output).toMatch(/query/)
  })
  it("risk/concurrency classification: both safe + parallel", () => {
    const t = createMemoryTools(memory)
    expect(t.memory_save.risk).toBe("safe")
    expect(t.memory_save.concurrency).toBe("parallel")
    expect(t.memory_search.risk).toBe("safe")
    expect(t.memory_search.concurrency).toBe("parallel")
  })
})
