import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore } from "../../src/memory/store.js"
import { createBuiltinTools } from "../../src/tools/index.js"
import type { ToolDefinition } from "../../src/provider/types.js"

let dir: string
let registry: ReturnType<typeof createBuiltinTools>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kclaw-registry-"))
  registry = createBuiltinTools({
    workspace: dir,
    memory: new MemoryStore({ notesDir: join(dir, "notes"), indexDb: join(dir, "index.db") }),
    tavilyApiKey: "tvly-test",
  })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ALL_TOOLS = [
  "exec", "fs_read", "fs_list", "fs_write", "fs_edit",
  "web_search", "web_fetch", "memory_save", "memory_search",
  "session_search",
]

/** required arrays per tool (task brief); checked as sets. */
const REQUIRED: Record<string, string[]> = {
  exec: ["command"],
  fs_read: ["path"],
  fs_list: ["path"],
  fs_write: ["path", "content"],
  fs_edit: ["path", "old", "new"],
  web_search: ["query"],
  web_fetch: ["url"],
  memory_save: ["text"],
  memory_search: ["query"],
  session_search: ["query"],
}

describe("builtin tool registry", () => {
  it("tools keys and toolDefs names are the exact same set (both directions)", () => {
    expect([...registry.tools.keys()].sort()).toEqual([...ALL_TOOLS].sort())
    expect(registry.toolDefs.map((d) => d.name).sort()).toEqual([...registry.tools.keys()].sort())
  })
  it("every def has description and complete JSON Schema with required arrays", () => {
    for (const def of registry.toolDefs) {
      expect(typeof def.description).toBe("string")
      expect(def.description.length).toBeGreaterThan(10)
      const p = def.parameters as Record<string, unknown>
      expect(p.type).toBe("object")
      expect(typeof p.properties).toBe("object")
      expect(Array.isArray(p.required)).toBe(true)
      // every required prop must exist in properties
      for (const key of p.required as string[]) {
        expect(p.properties).toHaveProperty(key)
      }
      // exactly the brief's required set
      expect(new Set(p.required as string[])).toEqual(new Set(REQUIRED[def.name]))
    }
  })
  it("optional args are declared with the right types", () => {
    const byName = new Map(registry.toolDefs.map((d) => [d.name, d]) as [string, ToolDefinition][])
    const prop = (tool: string, key: string) =>
      ((byName.get(tool)!.parameters as Record<string, { properties: Record<string, unknown> }>).properties)[key]
    expect(prop("web_search", "maxResults")).toEqual({ type: "integer", minimum: 1, maximum: 10 })
    expect(prop("memory_save", "tags")).toEqual({
      type: "array", items: { type: "string" }, description: expect.any(String),
    })
    expect(prop("memory_search", "limit")).toEqual({ type: "integer", minimum: 1, maximum: 20 })
    for (const tool of ["exec", "fs_read", "fs_list", "fs_write", "fs_edit", "web_fetch", "memory_save", "memory_search", "session_search"]) {
      expect(prop(tool, REQUIRED[tool][0])).toEqual({ type: "string", description: expect.any(String) })
    }
  })
  it("defs survive a JSON roundtrip (providers serialize them)", () => {
    expect(JSON.parse(JSON.stringify(registry.toolDefs))).toHaveLength(ALL_TOOLS.length)
  })
  it("risk/concurrency classification carried into the map", () => {
    expect(registry.tools.get("exec")!.risk).toBe("sensitive")
    expect(registry.tools.get("exec")!.concurrency).toBe("serial")
    expect(registry.tools.get("fs_write")!.risk).toBe("sensitive")
    expect(registry.tools.get("fs_read")!.concurrency).toBe("parallel")
    expect(registry.tools.get("memory_save")!.risk).toBe("safe")
    expect(registry.tools.get("web_search")!.concurrency).toBe("parallel")
  })
})
