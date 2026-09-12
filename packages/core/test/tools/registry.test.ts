import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBuiltinTools, dropSensitiveTools } from "../../src/tools/index.js"
import type { MemorySystem } from "../../src/memory/system.js"
import type { ToolDefinition } from "../../src/provider/types.js"

let dir: string
let registry: ReturnType<typeof createBuiltinTools>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kclaw-registry-"))
  registry = createBuiltinTools({
    workspace: dir,
    memoryCtx: {
      system: {
        triggerImmediate: vi.fn(async () => undefined),
        searchAll: vi.fn(async () => []),
      } as unknown as MemorySystem,
      sessionId: "ses_1",
      workdir: dir,
      immediateEnabled: false,
    },
    tavilyApiKey: "tvly-test",
  })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ALL_TOOLS = [
  "exec", "fs_read", "fs_list", "fs_write", "fs_edit",
  "web_search", "web_fetch", "memory_save", "memory_search",
  "session_search", "skill_read",
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
  skill_read: ["name"],
}

describe("builtin tool registry", () => {
  it("tools keys and toolDefs names are the exact same set (both directions)", () => {
    expect([...registry.tools.keys()].sort()).toEqual([...ALL_TOOLS].sort())
    expect(registry.toolDefs.map((d) => d.name).sort()).toEqual([...registry.tools.keys()].sort())
  })
  it("a spawner adds subagent_run to the mainline surface (12 tools)", () => {
    const withSpawner = createBuiltinTools({
      workspace: dir,
      memoryCtx: {
        system: {
          triggerImmediate: vi.fn(async () => undefined),
          searchAll: vi.fn(async () => []),
        } as unknown as MemorySystem,
        sessionId: "ses_1",
        workdir: dir,
        immediateEnabled: false,
      },
      tavilyApiKey: "tvly-test",
      subagent: { spawner: vi.fn(), parentSessionId: "ses_1" },
    })
    expect(withSpawner.tools.has("subagent_run")).toBe(true)
    expect(withSpawner.tools.get("subagent_run")!.risk).toBe("safe")
    expect(withSpawner.tools.get("subagent_run")!.concurrency).toBe("parallel")
    expect([...withSpawner.tools.keys()]).toHaveLength(ALL_TOOLS.length + 1)
  })
  it("a child run drops memory_save and never carries subagent_run (no grandchildren)", () => {
    const child = createBuiltinTools({
      workspace: dir,
      memoryCtx: {
        system: {
          triggerImmediate: vi.fn(async () => undefined),
          searchAll: vi.fn(async () => []),
        } as unknown as MemorySystem,
        sessionId: "ses_child",
        workdir: dir,
        immediateEnabled: false,
      },
      tavilyApiKey: "tvly-test",
      childRun: true,
      // Even with a spawner (wrongly) handed over, a child never sees it.
      subagent: { spawner: vi.fn(), parentSessionId: "ses_child" },
    })
    expect(child.tools.has("memory_save")).toBe(false)
    expect(child.tools.has("subagent_run")).toBe(false)
    expect([...child.tools.keys()]).toHaveLength(ALL_TOOLS.length - 1)
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
    // memory_save 只收 text（多余字段忽略）
    expect(prop("memory_save", "text")).toEqual({ type: "string", description: expect.any(String) })
    expect(prop("memory_search", "limit")).toEqual({ type: "integer", minimum: 1, maximum: 20 })
    for (const tool of ["exec", "fs_read", "fs_list", "fs_write", "fs_edit", "web_fetch", "memory_save", "memory_search", "session_search", "skill_read"]) {
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

  describe("dropSensitiveTools (readonly visibility)", () => {
    it("drops exactly the sensitive tools and keeps tools/defs the same set", () => {
      const { tools, toolDefs } = createBuiltinTools({
        workspace: dir,
        memoryCtx: {
          system: {
            triggerImmediate: vi.fn(async () => undefined),
            searchAll: vi.fn(async () => []),
          } as unknown as MemorySystem,
          sessionId: "ses_1",
          workdir: dir,
          immediateEnabled: false,
        },
        tavilyApiKey: "tvly-test",
        subagent: { spawner: vi.fn(), parentSessionId: "ses_1" },
      })
      dropSensitiveTools(tools, toolDefs)
      // sensitive today: exec, fs_write, fs_edit — everything safe survives,
      // including the safe subagent pair
      expect(tools.has("exec")).toBe(false)
      expect(tools.has("fs_write")).toBe(false)
      expect(tools.has("fs_edit")).toBe(false)
      expect(tools.has("fs_read")).toBe(true)
      expect(tools.has("fs_list")).toBe(true)
      expect(tools.has("memory_save")).toBe(true)
      expect(tools.has("subagent_run")).toBe(true)
      // map keys and def names stay one set, both directions
      expect([...tools.keys()].sort()).toEqual(toolDefs.map((d) => d.name).sort())
      // every survivor is safe — the gate's readonlyDenied set and the
      // dropped set can never drift apart
      for (const [, tool] of tools) expect(tool.risk).toBe("safe")
    })

    it("is a no-op on an already narrow surface and tolerates missing defs", () => {
      const tools = new Map([["fs_read", registry.tools.get("fs_read")!]])
      const toolDefs: ToolDefinition[] = []
      dropSensitiveTools(tools, toolDefs)
      expect([...tools.keys()]).toEqual(["fs_read"])
    })
  })
})
