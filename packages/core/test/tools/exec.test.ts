import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
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
  it("caps oversized output: head kept, dropped tail counted in bytes", async () => {
    const tool = createExecTool({ workspace: ws, maxOutputBytes: 10 * 1024 })
    const r = await run(tool, "seq 1 100000") // ~588KB
    expect(r.status).toBe("ok")
    expect(r.output.length).toBeLessThan(15 * 1024)
    expect(r.output.startsWith("1\n2\n")).toBe(true) // head kept
    expect(r.output).toMatch(/\[dropped \d+ bytes\]/) // tail dropped, not buffered
  }, 10_000)
  it("caps streaming output: an endless producer cannot grow memory or deltas", async () => {
    const tool = createExecTool({ workspace: ws, timeoutMs: 300, maxOutputBytes: 2048 })
    const deltas: string[] = []
    const r = await run(tool, "while true; do echo 0123456789; done", (d) => deltas.push(d))
    expect(r.status).toBe("error") // timeout
    expect(r.output).toMatch(/dropped \d+ bytes/)
    expect(r.output.length).toBeLessThan(2048 + 200) // head + marker only
    const totalDelta = deltas.join("").length
    expect(totalDelta).toBeLessThan(2048 + 200)
  }, 10_000)
})

describe("exec tool with an injected sandbox", () => {
  /** A fake sandbox that records calls and runs the command itself. */
  const fakeSandbox = (inner: (command: string, opts: { cwd: string }) => ReturnType<typeof spawn>) => {
    const calls: string[] = []
    return {
      calls,
      spawn(command: string, opts: { cwd: string }) {
        calls.push(command)
        return inner(command, opts)
      },
    }
  }

  it("spawns through the sandbox wrapper instead of a bare shell", async () => {
    writeFileSync(join(ws, "flag.txt"), "x")
    const sb = fakeSandbox((command, opts) => spawn(command, { shell: true, cwd: opts.cwd }))
    const tool = createExecTool({ workspace: ws, sandbox: sb })
    const r = await run(tool, "ls flag.txt && echo done")
    expect(r.status).toBe("ok")
    expect(r.output).toContain("done")
    expect(sb.calls).toEqual(["ls flag.txt && echo done"])
  })

  it("sandbox spawn failure surfaces as an error result (fail-closed, no bare run)", async () => {
    const sb = fakeSandbox(() => spawn("kclaw-no-such-binary-" + Date.now(), { shell: false }))
    const tool = createExecTool({ workspace: ws, sandbox: sb })
    const r = await run(tool, "echo should-not-run")
    expect(r.status).toBe("error")
    expect(r.output).toContain("exec failed")
    // the command never reached a shell: nothing was executed
    expect(r.output).not.toContain("should-not-run")
  })

  it("sandbox denial surfaces as the command's own error result", async () => {
    // A real sandbox "denies" a command by making it fail (Operation not
    // permitted → non-zero exit); the tool must surface that unchanged.
    const sb = fakeSandbox((_command, opts) => spawn("sh", ["-c", "echo denied >&2; exit 1"], { cwd: opts.cwd }))
    const tool = createExecTool({ workspace: ws, sandbox: sb })
    const r = await run(tool, "should-be-denied")
    expect(r.status).toBe("error")
    expect(r.output).toContain("exit code 1")
    expect(r.output).toContain("denied")
  })

  it("sandboxed timeout still kills the whole tree", async () => {
    const sb = fakeSandbox((command, opts) => spawn(command, { shell: true, cwd: opts.cwd }))
    const tool = createExecTool({ workspace: ws, timeoutMs: 150, sandbox: sb })
    const r = await run(tool, "echo started && sleep 5")
    expect(r.status).toBe("error")
    expect(r.output).toContain("timed out")
    expect(r.output).toContain("started")
  }, 10_000)
})
