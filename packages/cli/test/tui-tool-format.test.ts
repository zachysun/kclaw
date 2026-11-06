/**
 * Per-tool one-line formatter tests (spec B7): registered tools render their
 * most-readable argument term; unregistered tools fall back to the compact
 * JSON summary.
 */
import { describe, expect, it } from "vitest"
import { toolArgLine } from "../src/tui/tool-format.js"

describe("toolArgLine", () => {
  it("bash renders the command text", () => {
    expect(toolArgLine("bash", { command: "git status --short", description: "x" })).toBe("git status --short")
  })

  it("fs tools render the target path", () => {
    expect(toolArgLine("fs_read", { path: "src/a.ts" })).toBe("src/a.ts")
    expect(toolArgLine("fs_write", { path: "out.txt", content: "..." })).toBe("out.txt")
    expect(toolArgLine("fs_edit", { path: "src/b.ts" })).toBe("src/b.ts")
    expect(toolArgLine("fs_list", { path: "src" })).toBe("src")
  })

  it("grep and glob render the pattern", () => {
    expect(toolArgLine("grep", { pattern: "TODO", path: "src" })).toBe("TODO")
    expect(toolArgLine("glob", { pattern: "**/*.ts" })).toBe("**/*.ts")
  })

  it("search family renders the query", () => {
    expect(toolArgLine("web_search", { query: "ink 8 useInput" })).toBe("ink 8 useInput")
    expect(toolArgLine("session_search", { query: "缓存" })).toBe("缓存")
    expect(toolArgLine("skill_read", { name: "k-writing-style" })).toBe("k-writing-style")
  })

  it("unregistered tools fall back to the compact JSON summary", () => {
    const line = toolArgLine("mcp_unknown", { city: "杭州", unit: "c" })
    expect(line).toContain("杭州")
  })

  it("non-string args (missing/objects) fall back to the JSON summary", () => {
    expect(toolArgLine("bash", {})).toBe("{}")
    expect(toolArgLine("grep", { pattern: 42 })).toContain("42")
  })
})
