import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProcessRegistry } from "../../src/process/registry.js"
import { createProcessTools } from "../../src/tools/process.js"
import type { ToolExecutor } from "../../src/agent/tools.js"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kclaw-procreg-"))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const call = (t: { execute: ToolExecutor["execute"] }, args: unknown) => t.execute(args, { onOutput: () => {} })

/** Spawn a detached sleep whose group lives until killed; returns pid. */
const spawnSleeper = (seconds: number): number => {
  const child = spawn("sleep", [String(seconds)], { detached: true, stdio: "ignore" })
  child.unref()
  return child.pid!
}

describe("ProcessRegistry", () => {
  it("register + exit hook settles the entry and fires the notice", async () => {
    const notices: unknown[] = []
    const reg = new ProcessRegistry()
    reg.onNotice((n) => { notices.push(n) })
    const child = spawn("echo", ["done"])
    const entry = reg.register({
      id: "proc_test1",
      sessionId: "ses_1",
      command: "echo done",
      pid: child.pid!,
      spillPath: join(dir, "out.txt"),
      onExit: (done) => {
        child.once("exit", (code) => done(code, false))
      },
    })
    expect(entry.status).toBe("running")
    await new Promise<void>((resolve) => child.once("exit", () => setTimeout(resolve, 20)))
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(reg.get("proc_test1", "ses_1")!.status).toBe("exited")
    expect(reg.get("proc_test1", "ses_1")!.exitCode).toBe(0)
  })

  it("journal persists a settled notice and is rewritten clean after delivery", async () => {
    const noticesPath = join(dir, "notices.jsonl")
    const reg = new ProcessRegistry({ noticesPath })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    reg.onNotice(() => gate)
    const child = spawn("true")
    reg.register({
      id: "proc_j1",
      sessionId: "ses_1",
      command: "true",
      pid: child.pid!,
      spillPath: join(dir, "o.txt"),
      onExit: (done) => child.once("exit", (code) => done(code, false)),
    })
    await new Promise<void>((r) => child.once("exit", r))
    await vi.waitFor(() => expect(existsSync(noticesPath)).toBe(true))
    expect(readFileSync(noticesPath, "utf8")).toContain("proc_j1")
    release()
    await vi.waitFor(() => expect(existsSync(noticesPath)).toBe(false))
  })

  it("adopt delivers notices for dead pids and re-adopts live ones", async () => {
    const noticesPath = join(dir, "notices.jsonl")
    const deadPid = 999_999_999
    const livePid = spawnSleeper(30)
    try {
      writeFileSync(noticesPath, [
        JSON.stringify({ processId: "proc_dead", sessionId: "ses_1", pid: deadPid, command: "x", exitCode: 0, killed: false, spillPath: join(dir, "a"), startedAt: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ processId: "proc_live", sessionId: "ses_1", pid: livePid, command: "sleep 30", exitCode: null, killed: false, spillPath: join(dir, "b"), startedAt: "2026-01-01T00:00:00Z" }),
      ].join("\n") + "\n")
      const reg = new ProcessRegistry({ noticesPath })
      const notices: string[] = []
      reg.onNotice((n) => { notices.push(n.processId) })
      await reg.adopt()
      expect(notices).toEqual(["proc_dead"])
      // live group re-adopted as running, journal consumed
      expect(reg.get("proc_live", "ses_1")!.status).toBe("running")
      expect(existsSync(noticesPath)).toBe(false)
    } finally {
      try { process.kill(-livePid, "SIGKILL") } catch { /* gone */ }
    }
  })

  it("output reads incrementally by offset and wait resolves on new bytes", async () => {
    const outPath = join(dir, "o.txt")
    writeFileSync(outPath, "first line\n")
    const reg = new ProcessRegistry()
    const child = spawn("sleep", ["0.2"])
    reg.register({
      id: "proc_o1",
      sessionId: "ses_1",
      command: "writer",
      pid: child.pid!,
      spillPath: outPath,
      onExit: (done) => child.once("exit", (code) => done(code, false)),
    })
    const first = await reg.output("proc_o1", "ses_1")
    expect(first.output).toContain("first line")
    // append more after the read offset
    writeFileSync(outPath, "first line\nsecond line\n")
    const waited = await reg.output("proc_o1", "ses_1", { offset: first.nextOffset, wait: true, timeoutMs: 2_000 })
    expect(waited.output).toContain("second line")
  })

  it("ownership: another session's process is invisible", async () => {
    const reg = new ProcessRegistry()
    const child = spawn("sleep", ["0.05"])
    reg.register({
      id: "proc_x1", sessionId: "ses_owner", command: "x", pid: child.pid!,
      spillPath: join(dir, "o.txt"), onExit: (done) => child.once("exit", (c) => done(c, false)),
    })
    expect(reg.get("proc_x1", "ses_owner")).toBeDefined()
    expect(reg.get("proc_x1", "ses_other")).toBeUndefined()
    await expect(reg.output("proc_x1", "ses_other")).rejects.toThrow("不属于本会话")
  })

  it("per-session running cap rejects the ninth background process", () => {
    const reg = new ProcessRegistry({ maxRunningPerSession: 2 })
    const pids: number[] = []
    for (let i = 0; i < 2; i++) {
      const c = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
      c.unref()
      pids.push(c.pid!)
      reg.register({ id: `proc_c${i}`, sessionId: "ses_1", command: "sleep", pid: c.pid!, spillPath: join(dir, `o${i}.txt`), onExit: () => {} })
    }
    expect(() => reg.register({ id: "proc_c2", sessionId: "ses_1", command: "sleep", pid: pids[0], spillPath: join(dir, "o2.txt"), onExit: () => {} })).toThrow("上限")
    expect(() => reg.register({ id: "proc_c2", sessionId: "ses_2", command: "sleep", pid: pids[0], spillPath: join(dir, "o2.txt"), onExit: () => {} })).not.toThrow()
    for (const pid of pids) { try { process.kill(-pid, "SIGKILL") } catch { /* gone */ } }
  })
})

describe("process tools", () => {
  it("list/output/kill flow over a real background process", async () => {
    const reg = new ProcessRegistry()
    const tools = createProcessTools({ registry: reg, sessionId: "ses_1" })
    // feed the registry the way the bash tool does
    const outPath = join(dir, "flow.txt")
    writeFileSync(outPath, "hello from bg\n")
    const child = spawn("sleep", ["0.3"])
    reg.register({
      id: "proc_f1", sessionId: "ses_1", command: "sleeper", pid: child.pid!, spillPath: outPath,
      onExit: (done) => child.once("exit", (code) => done(code, false)),
    })
    const listed = await call(tools.process_list, {})
    expect(listed.output).toContain("proc_f1")
    const out = await call(tools.process_output, { processId: "proc_f1" })
    expect(out.output).toContain("hello from bg")
    expect(out.output).toContain("nextOffset=")
    const killed = await call(tools.process_kill, { processId: "proc_f1" })
    expect(killed.output).toContain("SIGKILL")
    await vi.waitFor(() => expect(reg.get("proc_f1", "ses_1")!.status).not.toBe("running"))
    // killing an already-finished process is not an error
    const again = await call(tools.process_kill, { processId: "proc_f1" })
    expect(again.status).toBe("ok")
  })

  it("tools never see another session's processes", async () => {
    const reg = new ProcessRegistry()
    const tools = createProcessTools({ registry: reg, sessionId: "ses_mine" })
    const child = spawn("sleep", ["0.05"])
    reg.register({
      id: "proc_theirs", sessionId: "ses_theirs", command: "x", pid: child.pid!,
      spillPath: join(dir, "o.txt"), onExit: (done) => child.once("exit", (c) => done(c, false)),
    })
    const listed = await call(tools.process_list, {})
    expect(listed.output).toBe("(没有后台进程)")
    const out = await call(tools.process_output, { processId: "proc_theirs" })
    expect(out.status).toBe("error")
    const killed = await call(tools.process_kill, { processId: "proc_theirs" })
    expect(killed.status).toBe("error")
  })

  it("risk classification: list/output parallel, kill serial, all safe", () => {
    const tools = createProcessTools({ registry: new ProcessRegistry(), sessionId: "s" })
    expect(tools.process_list.risk).toBe("safe")
    expect(tools.process_list.concurrency).toBe("parallel")
    expect(tools.process_output.concurrency).toBe("parallel")
    expect(tools.process_kill.risk).toBe("safe")
    expect(tools.process_kill.concurrency).toBe("serial")
  })
})
