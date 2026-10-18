import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSearchTools } from "../../src/tools/search.js"
import type { ToolExecutor } from "../../src/agent/tools.js"

let ws: string
let tools: ReturnType<typeof createSearchTools>
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "kclaw-search-"))
  writeFileSync(join(ws, "a.ts"), "const alpha = 1\nconst beta = alpha + 1\n")
  writeFileSync(join(ws, "b.md"), "# doc\nalpha mention\n")
  writeFileSync(join(ws, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x61, 0x62])) // NUL → binary
  mkdirSync(join(ws, "ignored"))
  writeFileSync(join(ws, "ignored", "c.ts"), "const alpha = 3\n")
  mkdirSync(join(ws, "sub"))
  writeFileSync(join(ws, "sub", "d.ts"), "alpha here\n")
  tools = createSearchTools({ workspace: ws })
})
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

const call = (t: { execute: ToolExecutor["execute"] }, args: unknown) => t.execute(args, { onOutput: () => {} })

/** Real git repo (gitignore honored) vs plain tmp dir (walk fallback) per test. */
const gitInit = (dir: string): void => {
  const { execSync } = require("node:child_process") as typeof import("node:child_process")
  writeFileSync(join(dir, ".gitignore"), "ignored/\n")
  execSync("git init -q", { cwd: dir })
}

describe("search tools", () => {
  it("grep matches content with path:lineNo output", async () => {
    const r = await call(tools.grep, { pattern: "alpha" })
    expect(r.status).toBe("ok")
    // tmp dir has no .git → walk skips hidden dirs but "ignored" is not hidden:
    // without git, only node_modules/hidden are skipped.
    expect(r.output).toContain("a.ts:1:")
    expect(r.output).toContain("sub/d.ts:1:")
  })

  it("grep respects .gitignore inside a git repo", async () => {
    gitInit(ws)
    const g = createSearchTools({ workspace: ws })
    const r = await call(g.grep, { pattern: "alpha" })
    expect(r.output).toContain("a.ts:1:")
    expect(r.output).not.toContain("ignored/c.ts")
  })

  it("grep skips binary files", async () => {
    const r = await call(tools.grep, { pattern: "ab" })
    expect(r.output).not.toContain("blob.bin")
  })

  it("grep reports no matches distinctly", async () => {
    const r = await call(tools.grep, { pattern: "zzz-nowhere" })
    expect(r.status).toBe("ok")
    expect(r.output).toBe("(no matches)")
  })

  it("grep rejects an invalid regex with the error text", async () => {
    const r = await call(tools.grep, { pattern: "(unclosed" })
    expect(r.status).toBe("error")
    expect(r.output).toContain("invalid regex")
  })

  it("grep caps results with a truncation marker", async () => {
    for (let i = 0; i < 10; i++) writeFileSync(join(ws, `many-${i}.ts`), "alpha\nalpha\nalpha\n")
    const r = await call(tools.grep, { pattern: "alpha", maxResults: 5 })
    expect(r.output.split("\n").filter((l) => l.includes(":")).length).toBeLessThanOrEqual(5)
    expect(r.output).toContain("truncated")
  })

  it("grep scopes by path", async () => {
    const r = await call(tools.grep, { pattern: "alpha", path: "sub" })
    expect(r.output).toContain("sub/d.ts:1:")
    expect(r.output).not.toContain("a.ts:1:")
  })

  it("grep applies the glob filter", async () => {
    const r = await call(tools.grep, { pattern: "alpha", glob: "*.md" })
    expect(r.output).toContain("b.md:2:")
    expect(r.output).not.toContain("a.ts:1:")
  })

  it("glob finds files by pattern", async () => {
    const r = await call(tools.glob, { pattern: "**/*.ts" })
    expect(r.output).toContain("a.ts")
    expect(r.output).toContain("sub/d.ts")
    expect(r.output).not.toContain("b.md")
  })

  it("glob respects .gitignore inside a git repo", async () => {
    gitInit(ws)
    const g = createSearchTools({ workspace: ws })
    const r = await call(g.glob, { pattern: "**/*.ts" })
    expect(r.output).not.toContain("ignored/c.ts")
  })

  it("glob reports no matches distinctly", async () => {
    const r = await call(tools.glob, { pattern: "**/*.zig" })
    expect(r.output).toBe("(no matches)")
  })

  it("risk/concurrency classification", () => {
    expect(tools.grep.risk).toBe("safe")
    expect(tools.grep.concurrency).toBe("parallel")
    expect(tools.glob.risk).toBe("safe")
    expect(tools.glob.concurrency).toBe("parallel")
  })
})
