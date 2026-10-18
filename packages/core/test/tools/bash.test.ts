import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { createBashTool } from "../../src/tools/bash.js"
import { ProcessRegistry } from "../../src/process/registry.js"

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "kclaw-bash-")) })
afterEach(() => { rmSync(ws, { recursive: true, force: true }) })

const run = async (
  tool: ReturnType<typeof createBashTool>,
  command: string,
  opts?: { onOutput?: (d: string) => void; run_in_background?: boolean; timeoutMs?: number },
) =>
  tool.execute(
    {
      command,
      ...(opts?.run_in_background !== undefined ? { run_in_background: opts.run_in_background } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
    { onOutput: opts?.onOutput ?? (() => {}) },
  )

describe("bash tool", () => {
  it("runs in workspace cwd and merges output", async () => {
    writeFileSync(join(ws, "flag.txt"), "x")
    const tool = createBashTool({ workspace: ws })
    const r = await run(tool, "ls flag.txt && echo done")
    expect(r.status).toBe("ok")
    expect(r.output).toContain("flag.txt")
    expect(r.output).toContain("done")
  })
  it("streams stdout chunks via onOutput", async () => {
    const tool = createBashTool({ workspace: ws })
    const chunks: string[] = []
    const r = await run(tool, "echo hello", { onOutput: (d) => chunks.push(d) })
    expect(r.status).toBe("ok")
    expect(chunks.join("")).toContain("hello")
  })
  it("nonzero exit is error with exit code", async () => {
    const tool = createBashTool({ workspace: ws })
    const r = await run(tool, "exit 3")
    expect(r.status).toBe("error")
    expect(r.output).toMatch(/exit code 3/)
  })
  it("injects session env vars over the inherited environment", async () => {
    const tool = createBashTool({ workspace: ws, env: { KCLAW_SESSION_ID: "ses_test123", KCLAW_WORKSPACE: ws } })
    const r = await run(tool, "echo $KCLAW_SESSION_ID $KCLAW_WORKSPACE")
    expect(r.status).toBe("ok")
    expect(r.output).toContain("ses_test123")
    expect(r.output).toContain(ws)
    // PATH survives: inherited vars are still present
    const r2 = await run(tool, "echo $PATH")
    expect(r2.status).toBe("ok")
    expect(r2.output).not.toContain("undefined")
  })
  it("times out and reports partial output", async () => {
    const tool = createBashTool({ workspace: ws, timeoutMs: 150 })
    const r = await run(tool, "echo started && sleep 5")
    expect(r.status).toBe("error")
    expect(r.output).toContain("timed out")
    expect(r.output).toContain("started")
  }, 10_000)
  it("caps oversized output: head kept, dropped tail counted in bytes", async () => {
    const tool = createBashTool({ workspace: ws, maxOutputBytes: 10 * 1024 })
    const r = await run(tool, "seq 1 100000") // ~588KB
    expect(r.status).toBe("ok")
    expect(r.output.length).toBeLessThan(15 * 1024)
    expect(r.output.startsWith("1\n2\n")).toBe(true) // head kept
    expect(r.output).toMatch(/\[dropped \d+ bytes\]/) // tail dropped, not buffered
  }, 10_000)
  it("caps streaming output: an endless producer cannot grow memory or deltas", async () => {
    const tool = createBashTool({ workspace: ws, timeoutMs: 300, maxOutputBytes: 2048 })
    const deltas: string[] = []
    const r = await run(tool, "while true; do echo 0123456789; done", { onOutput: (d) => deltas.push(d) })
    expect(r.status).toBe("error") // timeout
    expect(r.output).toMatch(/dropped \d+ bytes/)
    expect(r.output.length).toBeLessThan(2048 + 200) // head + marker only
    const totalDelta = deltas.join("").length
    expect(totalDelta).toBeLessThan(2048 + 200)
  }, 10_000)
  it("spills the captured span when a spill dir is wired: locator in output, full text on disk", async () => {
    const spillDir = join(ws, "spill")
    const tool = createBashTool({ workspace: ws, maxOutputBytes: 10 * 1024, spillDir })
    const r = await run(tool, "seq 1 100000") // ~588KB view-truncated, spill keeps up to 10MB
    expect(r.status).toBe("ok")
    expect(r.output).toMatch(/\[dropped \d+ bytes\]/)
    expect(r.output).toMatch(/完整输出已存盘: .+\.txt/)
    // The locator names a real file holding the full sequence.
    const m = /完整输出已存盘: (\S+\.txt)/.exec(r.output)!
    const spilled = readFileSync(m[1]!, "utf8")
    expect(spilled.trimEnd().split("\n").at(-1)).toBe("100000") // tail survived in the spill
    expect(spilled.length).toBeGreaterThan(r.output.length)
  }, 10_000)
  it("no spill dir wired: dropped data stays dropped (legacy behavior)", async () => {
    const tool = createBashTool({ workspace: ws, maxOutputBytes: 10 * 1024 })
    const r = await run(tool, "seq 1 100000")
    expect(r.output).toMatch(/\[dropped \d+ bytes\]/)
    expect(r.output).not.toMatch(/完整输出已存盘/)
  }, 10_000)
})

describe("bash tool with an injected sandbox", () => {
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
    const tool = createBashTool({ workspace: ws, sandbox: sb })
    const r = await run(tool, "ls flag.txt && echo done")
    expect(r.status).toBe("ok")
    expect(r.output).toContain("done")
    expect(sb.calls).toEqual(["ls flag.txt && echo done"])
  })

  it("forwards the merged session env through the sandbox wrapper", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined
    const sb = {
      spawn(command: string, opts: { cwd: string; env?: Record<string, string> }) {
        seenEnv = opts.env
        return spawn(command, { shell: true, cwd: opts.cwd, ...(opts.env === undefined ? {} : { env: opts.env }) })
      },
    }
    const tool = createBashTool({ workspace: ws, sandbox: sb, env: { KCLAW_SESSION_ID: "ses_sb" } })
    const r = await run(tool, "echo $KCLAW_SESSION_ID")
    expect(r.status).toBe("ok")
    expect(r.output).toContain("ses_sb")
    expect(seenEnv?.PATH).toBeDefined()
    expect(seenEnv?.KCLAW_SESSION_ID).toBe("ses_sb")
  })

  it("sandbox spawn failure surfaces as an error result (fail-closed, no bare run)", async () => {
    const sb = fakeSandbox(() => spawn("kclaw-no-such-binary-" + Date.now(), { shell: false }))
    const tool = createBashTool({ workspace: ws, sandbox: sb })
    const r = await run(tool, "echo should-not-run")
    expect(r.status).toBe("error")
    expect(r.output).toContain("bash failed")
    // the command never reached a shell: nothing was executed
    expect(r.output).not.toContain("should-not-run")
  })

  it("sandbox denial surfaces as the command's own error result", async () => {
    // A real sandbox "denies" a command by making it fail (Operation not
    // permitted → non-zero exit); the tool must surface that unchanged.
    const sb = fakeSandbox((_command, opts) => spawn("sh", ["-c", "echo denied >&2; exit 1"], { cwd: opts.cwd }))
    const tool = createBashTool({ workspace: ws, sandbox: sb })
    const r = await run(tool, "should-be-denied")
    expect(r.status).toBe("error")
    expect(r.output).toContain("exit code 1")
    expect(r.output).toContain("denied")
  })

  it("sandboxed timeout still kills the whole tree", async () => {
    const sb = fakeSandbox((command, opts) => spawn(command, { shell: true, cwd: opts.cwd }))
    const tool = createBashTool({ workspace: ws, timeoutMs: 150, sandbox: sb })
    const r = await run(tool, "echo started && sleep 5")
    expect(r.status).toBe("error")
    expect(r.output).toContain("timed out")
    expect(r.output).toContain("started")
  }, 10_000)
})

describe("bash tool background mode", () => {
  const mk = (spillDir?: string) => {
    const notices: string[] = []
    const reg = new ProcessRegistry({ noticesPath: spillDir === undefined ? undefined : join(ws, "notices.jsonl") })
    reg.onNotice((n) => { notices.push(n.processId) })
    const tool = createBashTool({ workspace: ws, processes: reg, sessionId: "ses_bg", spillDir })
    return { tool, reg, notices }
  }

  it("run_in_background returns immediately with a process id and streams output to the spill file", async () => {
    const spillDir = join(ws, "spill")
    const { tool, reg, notices } = mk(spillDir)
    const r = await run(tool, "echo bg-hello && sleep 5", { run_in_background: true })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("proc_")
    expect(r.output).toContain("不要轮询")
    const processId = (r.data as { processId: string }).processId
    expect(processId).toMatch(/^proc_/)
    // output lands in the spill file (cursor for process_output)
    await new Promise((r2) => setTimeout(r2, 300))
    const entry = reg.get(processId, "ses_bg")!
    expect(readFileSync(entry.spillPath, "utf8")).toContain("bg-hello")
    expect(entry.status).toBe("running")
    // kill via the registry → exit event → killed notice
    reg.kill(processId, "ses_bg")
    await vi.waitFor(() => expect(notices).toContain(processId))
    expect(reg.get(processId, "ses_bg")!.status).toBe("killed")
  }, 15_000)

  it("a fast background command settles and delivers its notice", async () => {
    const { tool, reg, notices } = mk(undefined)
    const r = await run(tool, "echo quick", { run_in_background: true })
    expect(r.status).toBe("ok")
    const processId = (r.data as { processId: string }).processId
    await vi.waitFor(() => expect(notices).toContain(processId), { timeout: 5_000 })
    expect(reg.get(processId, "ses_bg")!.exitCode).toBe(0)
  }, 10_000)

  it("timeoutMs is honored per call (clamped) without changing the default", async () => {
    const tool = createBashTool({ workspace: ws, timeoutMs: 30_000 })
    const r = await run(tool, "sleep 5", { timeoutMs: 300 })
    expect(r.status).toBe("error")
    expect(r.output).toContain("timed out after 1000ms")
  }, 10_000)

  it("without a registry, background calls report an assembly error", async () => {
    const tool = createBashTool({ workspace: ws })
    const r = await run(tool, "echo x", { run_in_background: true })
    expect(r.status).toBe("error")
    expect(r.output).toContain("未装配进程注册表")
  })
})
