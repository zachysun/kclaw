import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecTool } from "../../src/tools/exec.js"

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "kclaw-exec-")) })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

const run = async (tool: ReturnType<typeof createExecTool>, command: string, onOutput?: (d: string) => void) =>
  tool.execute({ command }, { onOutput: onOutput ?? (() => {}) })

describe("exec tool", () => {
  it("runs in workspace cwd and merges output", async () => {
    writeFileSync(join(ws, "flag.txt"), "x")
    const tool = createExecTool({ workspace: ws })
    const r = await run(tool, "ls flag.txt && echo done")
    expect(r.status).toBe("ok")
    expect(r.output).toContain("flag.txt")
    expect(r.output).toContain("done")
  })
  it("streams stdout chunks via onOutput", async () => {
    const tool = createExecTool({ workspace: ws })
    const chunks: string[] = []
    const r = await run(tool, "echo hello", (d) => chunks.push(d))
    expect(r.status).toBe("ok")
    expect(chunks.join("")).toContain("hello")
  })
  it("nonzero exit is error with exit code", async () => {
    const tool = createExecTool({ workspace: ws })
    const r = await run(tool, "exit 3")
    expect(r.status).toBe("error")
    expect(r.output).toMatch(/exit code 3/)
  })
  it("times out and reports partial output", async () => {
    const tool = createExecTool({ workspace: ws, timeoutMs: 150 })
    const r = await run(tool, "echo started && sleep 5")
    expect(r.status).toBe("error")
    expect(r.output).toContain("timed out")
    expect(r.output).toContain("started")
  }, 10_000)
  it("truncates oversized output head+tail", async () => {
    const tool = createExecTool({ workspace: ws, maxOutputBytes: 10 * 1024 })
    const r = await run(tool, "seq 1 100000") // ~588KB
    expect(r.output.length).toBeLessThan(15 * 1024)
    expect(r.output).toContain("[truncated")
    expect(r.output.trim().endsWith("100000")).toBe(true)
  }, 10_000)
})
