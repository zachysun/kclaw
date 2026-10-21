/**
 * bash tool: run a shell command inside the workspace.
 *
 * - cwd is pinned to the workspace so commands can't wander the filesystem.
 * - stdout/stderr chunks are streamed via `ctx.onOutput` until
 *   `maxOutputBytes` is reached — beyond that the head is kept, the drop is
 *   counted, and the final output carries a `...[dropped N bytes]...` marker.
 * - On timeout the whole process group gets SIGKILL (`detached: true` makes
 *   the child a group leader, so `kill(-pid)` also reaps shell descendants
 *   like `sleep`); a short grace window still collects the exit and the
 *   output buffered before the kill, and partial output is returned either
 *   way.
 * - Output larger than `maxOutputBytes` keeps the accumulated head and drops
 *   the tail, finishing with a byte-counted `...[dropped N bytes]...` marker
 *   (truncateMiddle only micro-trims the head's <=1-chunk overshoot).
 * - Exit 0 → ok; anything else → error with an `exit code N` prefix line.
 * - `timeoutMs` lets the model set a per-call timeout (clamped 1s–600s,
 *   default = the configured tool timeout) — some commands legitimately run
 *   for minutes and the model knows which.
 * - `run_in_background` spawns detached with output streaming into a spill
 *   file and returns immediately with a process id; completion is announced
 *   into the conversation via the process registry (polling is unnecessary).
 *   Background commands have no timeout: their lifetime is managed through
 *   process_output / process_kill.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, closeSync, mkdirSync, openSync, unlinkSync } from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import type { ToolExecutor } from "../agent/tools.js"
import { spillLocatorLine, spillToolOutput, SPILL_MAX_BYTES } from "./spill.js"
import type { ToolResult } from "./shared.js"
import type { BashSandboxSpawn } from "../sandbox/provider.js"
import { newId } from "../protocol/ids.js"
import type { ProcessRegistry } from "../process/registry.js"

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 600_000
/** After a timeout kill, how long "close" may take to deliver the exit + tail output. */
const TIMEOUT_GRACE_MS = 2_000

/**
 * Clamp a string to `maxBytes` by keeping the first and last maxBytes/2
 * around a `\n...[truncated N bytes]...\n` marker. Measured in UTF-8 bytes;
 * a multibyte char torn at a cut boundary decodes to U+FFFD replacement
 * chars, which is acceptable for tool output.
 */
export function truncateMiddle(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return s
  const half = Math.floor(maxBytes / 2)
  const head = buf.subarray(0, half)
  const tail = buf.subarray(buf.length - half)
  const dropped = buf.length - head.length - tail.length
  return `${head.toString("utf8")}\n...[truncated ${dropped} bytes]...\n${tail.toString("utf8")}`
}

export function createBashTool(opts: {
  workspace: string
  timeoutMs?: number
  maxOutputBytes?: number
  /**
   * Optional sandbox wrapper. When present, the command runs inside the
   * sandbox (the wrapper owns spawning); absent = bare spawn, exactly the
   * pre-sandbox behavior. Wired by the run assembly from the sandbox
   * provider's availability — never by the tool itself.
   */
  sandbox?: BashSandboxSpawn
  /** Full-output spill dir (<home>/spill); undefined = truncation drops data as before. */
  spillDir?: string
  /**
   * Extra environment variables layered over the inherited process env
   * (session identity: KCLAW_SESSION_ID etc.). Absent = inherit unchanged.
   */
  env?: Record<string, string>
  /**
   * Background-process registry. Required for `run_in_background`: the tool
   * records the spawned group here (ownership, cap, notices). Absent =
   * background calls return an assembly error (the daemon always wires it).
   */
  processes?: ProcessRegistry
  /** Owning session id for background entries (registry ownership + notices). */
  sessionId?: string
}): ToolExecutor & { name: "bash" } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  /**
   * Background branch: spawn detached, stream merged output into the spill
   * file (the file offset is the read cursor), register the group, and
   * return immediately. No timeout — lifetime is managed via process_kill,
   * and completion is announced by the registry.
   */
  const runBackground = (command: string): Promise<ToolResult> =>
    (async () => {
      if (opts.processes === undefined) {
        return { status: "error" as const, output: "bash: 后台执行未装配进程注册表" }
      }
      const id = newId("proc")
      let spillPath =
        opts.spillDir !== undefined
          ? path.join(opts.spillDir, `proc-${id}.txt`)
          : path.join(opts.workspace, `.${id}.out`)
      let fd: number | undefined
      let spillClosed = false
      const pump = (stream: Readable | null): void => {
        if (stream === null) return
        stream.setEncoding("utf8")
        stream.on("data", (chunk: string) => {
          if (fd !== undefined) {
            try {
              appendFileSync(fd, chunk, "utf8")
            } catch {
              // spill write failure must not kill the process pump
            }
          }
        })
      }
      const childEnv = opts.env === undefined ? undefined : { ...process.env, ...opts.env } as Record<string, string>
      if (opts.spillDir !== undefined) {
        try {
          mkdirSync(opts.spillDir, { recursive: true })
          fd = openSync(spillPath, "a")
        } catch {
          fd = undefined // spill dir unwritable: fall back below
        }
      }
      if (fd === undefined) {
        // Spill dir unavailable → the workspace-local file (still on disk,
        // still a cursor); if even that fails, surface the error.
        spillPath = path.join(opts.workspace, `.${id}.out`)
        try {
          fd = openSync(spillPath, "a")
        } catch (e) {
          return { status: "error" as const, output: `bash: 后台输出文件无法创建：${e instanceof Error ? e.message : String(e)}` }
        }
      }
      let child: ChildProcess
      try {
        child = opts.sandbox
          ? opts.sandbox.spawn(command, { cwd: opts.workspace, ...(childEnv === undefined ? {} : { env: childEnv }) })
          : spawn(command, {
              shell: true,
              cwd: opts.workspace,
              ...(childEnv === undefined ? {} : { env: childEnv }),
              detached: process.platform !== "win32",
            })
      } catch (e) {
        closeSync(fd)
        spillClosed = true
        unlinkSync(spillPath)
        return { status: "error" as const, output: `bash failed: ${e instanceof Error ? e.message : String(e)}` }
      }
      pump(child.stdout)
      pump(child.stderr)
      child.stdin?.destroy()
      const settle = (exitCode: number | null, killed: boolean): void => {
        if (!spillClosed) {
          spillClosed = true
          try {
            closeSync(fd!)
          } catch {
            // already closed
          }
        }
      }
      try {
        opts.processes!.register({
          id,
          sessionId: opts.sessionId ?? "unknown",
          command,
          pid: child.pid ?? 0,
          spillPath,
          onExit: (done) => {
            child.once("exit", (code, signal) => {
              settle(code, signal !== null && signal !== undefined)
              done(code, signal !== null && signal !== undefined)
            })
            child.once("error", () => {
              settle(null, false)
              done(null, false)
            })
          },
        })
      } catch (e) {
        // Cap rejection etc.: kill the just-spawned group and report.
        try {
          if (child.pid != null && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
          child.kill("SIGKILL")
        } catch {
          // already gone
        }
        closeSync(fd)
        unlinkSync(spillPath)
        return { status: "error" as const, output: `bash: ${e instanceof Error ? e.message : String(e)}` }
      }
      const hint =
        opts.processes !== undefined
          ? "完成后会自动通知，不要轮询或 sleep 等待；用 process_output 增量读输出，process_list 看清单，process_kill 终止。"
          : ""
      return {
        status: "ok" as const,
        output: `已在后台启动：${id}\n命令：${command}\n输出流式写入：${spillPath}${hint !== "" ? `\n${hint}` : ""}`,
        data: { processId: id, spillPath },
      }
    })()

  return {
    name: "bash",
    risk: "sensitive",
    concurrency: "serial",
    execute(args, ctx) {
      const command = (args as { command?: unknown } | null)?.command
      if (typeof command !== "string" || command.trim() === "") {
        return Promise.resolve({
          status: "error",
          output: "bash: args.command must be a non-empty string",
        })
      }
      const raw = args as { timeoutMs?: unknown; run_in_background?: unknown }
      if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== "number" || !Number.isInteger(raw.timeoutMs))) {
        return Promise.resolve({ status: "error", output: "bash: args.timeoutMs must be an integer" })
      }
      // Model-set timeout, clamped; absent = the configured tool timeout.
      const effectiveTimeout = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(MIN_TIMEOUT_MS, raw.timeoutMs ?? timeoutMs),
      )
      if (raw.run_in_background === true) {
        return runBackground(command)
      }

      return new Promise((resolve) => {
        let output = ""
        let outputBytes = 0
        let droppedBytes = 0
        let truncationNoted = false
        let settled = false
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined
        // Everything the process emitted, up to the spill ceiling: the model
        // view truncates at maxOutputBytes, the spill copy keeps the span
        // readable (fs_read locator) instead of dropping it. Accumulation is
        // gated on a wired spill dir — without one the capture would be pure
        // memory waste (up to 10MB per truncated call) for a spill that can
        // never happen.
        let spillBuf = ""
        let spillBytes = 0
        const spillWired = opts.spillDir !== undefined

        // Merged once for both spawn paths: the sandbox wrapper forwards the
        // environment verbatim, so `env` here is the child's COMPLETE
        // environment (undefined = inherit process.env unchanged). The cast
        // narrows process.env's `string | undefined` index type — spawn
        // itself accepts undefined-valued entries, but the sandbox seam is
        // declared with plain string values.
        const childEnv = opts.env === undefined ? undefined : { ...process.env, ...opts.env } as Record<string, string>
        const child = opts.sandbox
          ? opts.sandbox.spawn(command, { cwd: opts.workspace, ...(childEnv === undefined ? {} : { env: childEnv }) })
          : spawn(command, {
              shell: true,
              cwd: opts.workspace,
              ...(childEnv === undefined ? {} : { env: childEnv }),
              // Own process group on POSIX so a timeout kill reaches shell
              // descendants, not just the immediate child.
              detached: process.platform !== "win32",
            })

        const finish = (result: { status: "ok" | "error"; output: string }) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          resolve(result)
        }

        const killAll = () => {
          // POSIX: kill(-pid) SIGKILLs the whole process group.
          // Windows has no process groups (negative pid is a hard error):
          // fall back to killing just the direct child.
          if (child.pid != null && process.platform !== "win32") {
            try {
              process.kill(-child.pid, "SIGKILL")
            } catch {
              // group already gone; try the child below
            }
          }
          try {
            child.kill("SIGKILL")
          } catch {
            // already exited
          }
        }

        // Final output for both finish paths: always byte-truncated, plus a
        // drop marker when streaming hit the cap, plus an fs_read locator
        // when the captured span was spilled to disk.
        const capped = (): string => {
          const base = truncateMiddle(output, maxOutputBytes)
          if (droppedBytes === 0) return base
          const spill = spillToolOutput(opts.spillDir, "bash", spillBuf)
          return `${base}\n...[dropped ${droppedBytes} bytes]...${spillLocatorLine(spill)}`
        }

        for (const stream of [child.stdout, child.stderr]) {
          if (!stream) continue
          stream.setEncoding("utf8")
          stream.on("data", (chunk: string) => {
            if (spillWired && spillBytes <= SPILL_MAX_BYTES) {
              spillBuf += chunk
              spillBytes += Buffer.byteLength(chunk)
            }
            if (droppedBytes > 0) {
              // already capped: keep counting, forward nothing
              droppedBytes += Buffer.byteLength(chunk)
              return
            }
            output += chunk
            outputBytes += Buffer.byteLength(chunk)
            if (outputBytes > maxOutputBytes) {
              droppedBytes = outputBytes - maxOutputBytes
              // keep the head as accumulated
              if (!truncationNoted) {
                truncationNoted = true
                ctx.onOutput(`\n...[output truncated, further output dropped]...`)
              }
              return
            }
            ctx.onOutput(chunk)
          })
        }

        timer = setTimeout(() => {
          timedOut = true
          killAll()
          // Timeout is not a silent discard: after the SIGKILL, give the
          // process a short grace window so "close" can deliver the exit and
          // everything still buffered in the pipes (waiter gives up, the
          // child's final words are still collected).
          const grace = setTimeout(() => {
            finish({ status: "error", output: `command timed out after ${effectiveTimeout}ms\n${capped()}` })
          }, TIMEOUT_GRACE_MS)
          child.once("close", () => {
            clearTimeout(grace)
            finish({ status: "error", output: `command timed out after ${effectiveTimeout}ms\n${capped()}` })
          })
        }, effectiveTimeout)

        child.on("error", (err) => {
          finish({ status: "error", output: `bash failed: ${err.message}` })
        })

        child.on("close", (code) => {
          if (timedOut) return // timeout path already resolved with partial output
          const merged = capped()
          if (code === 0) finish({ status: "ok", output: merged })
          else finish({ status: "error", output: `exit code ${code}\n${merged}` })
        })
      })
    },
  }
}
