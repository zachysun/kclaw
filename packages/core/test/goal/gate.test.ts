/**
 * 验收门接缝测试（issue #47）：runAcceptanceGates 用假 ExecSandbox（真
 * /bin/sh 子进程，不经 OS 沙箱）验证 串行执行/退出码判定/超时杀组/
 * 不可用 fail-closed。不依赖平台沙箱。
 */
import { describe, it, expect } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { runAcceptanceGates } from "../../src/goal/gate.js"
import type { ExecSandbox } from "../../src/sandbox/provider.js"

/** 直通沙箱：命令原样交给 /bin/sh（detached 同产品路径，可杀进程组）。 */
const passthrough: ExecSandbox = {
  available: true,
  spawn(command: string, opts: { cwd: string }): ChildProcess {
    return spawn("/bin/sh", ["-c", command], { ...opts, detached: true })
  },
}

describe("runAcceptanceGates", () => {
  it("runs commands in order and marks exit code 0 as ok", async () => {
    const outcomes = await runAcceptanceGates(passthrough, ["echo first", "echo second"], process.cwd())
    expect(outcomes.map((o) => o.command)).toEqual(["echo first", "echo second"])
    expect(outcomes.every((o) => o.ok && o.exitCode === 0)).toBe(true)
    expect(outcomes[0]!.outputTail).toContain("first")
  })

  it("a failing command keeps its stderr tail and exit code", async () => {
    const outcomes = await runAcceptanceGates(passthrough, ["echo boom >&2; exit 3"], process.cwd())
    expect(outcomes[0]).toMatchObject({ ok: false, exitCode: 3 })
    expect(outcomes[0]!.outputTail).toContain("boom")
  })

  it("kills a hung command at the gate timeout (fail, null exit code)", async () => {
    const outcomes = await runAcceptanceGates(passthrough, ["sleep 30"], process.cwd(), 500)
    expect(outcomes[0]!.ok).toBe(false)
    expect(outcomes[0]!.exitCode).toBeNull()
    expect(outcomes[0]!.outputTail).toContain("超时")
  }, 20_000)

  it("an unavailable sandbox never runs the command (fail-closed with reason)", async () => {
    const sandbox: ExecSandbox = { available: false, unavailableReason: "sandbox disabled in config", spawn: () => { throw new Error("unreachable") } }
    const outcomes = await runAcceptanceGates(sandbox, ["echo never"], process.cwd())
    expect(outcomes[0]!.ok).toBe(false)
    expect(outcomes[0]!.outputTail).toContain("沙箱不可用")
  })

  it("an empty acceptance list yields no outcomes", async () => {
    expect(await runAcceptanceGates(passthrough, [], process.cwd())).toEqual([])
  })
})
