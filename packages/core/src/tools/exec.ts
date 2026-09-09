/**
 * exec tool: run a shell command inside the workspace.
 *
 * - cwd is pinned to the workspace so commands can't wander the filesystem.
 * - stdout/stderr chunks are streamed via `ctx.onOutput` until
 *   `maxOutputBytes` is reached — beyond that the head is kept, the drop is
 *   counted, and the final output carries a `...[dropped N bytes]...` marker.
 * - On timeout the whole process group gets SIGKILL (`detached: true` makes
 *   the child a group leader, so `kill(-pid)` also reaps shell descendants
 *   like `sleep`); partial output is still returned.
 * - Output larger than `maxOutputBytes` keeps the accumulated head and drops
 *   the tail, finishing with a byte-counted `...[dropped N bytes]...` marker
 *   (truncateMiddle only micro-trims the head's <=1-chunk overshoot).
 * - Exit 0 → ok; anything else → error with an `exit code N` prefix line.
 */
import { spawn, type ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"
import type { ToolExecutor } from "../agent/tools.js"
import { spillLocatorLine, spillToolOutput, SPILL_MAX_BYTES } from "./spill.js"

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024

/**
 * The minimal spawn surface the exec tool needs from a sandbox wrapper:
 * given a shell command line, produce a ChildProcess that runs it inside the
 * sandbox. The real provider (sandbox/provider.ts) supplies this; the run
 * assembly wires it only when the sandbox is available, so a "sandboxed"
 * allowance and a sandboxed spawn are always the same source.
 */
export interface ExecSandboxSpawn {
  spawn(command: string, opts: { cwd: string }): ChildProcess
}

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

export function createExecTool(opts: {
  workspace: string
  timeoutMs?: number
  maxOutputBytes?: number
  /**
   * Optional sandbox wrapper. When present, the command runs inside the
   * sandbox (the wrapper owns spawning); absent = bare spawn, exactly the
   * pre-sandbox behavior. Wired by the run assembly from the sandbox
   * provider's availability — never by the tool itself.
   */
  sandbox?: ExecSandboxSpawn
  /** Full-output spill dir (<home>/spill); undefined = truncation drops data as before. */
  spillDir?: string
}): ToolExecutor & { name: "exec" } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return {
    name: "exec",
    risk: "sensitive",
    concurrency: "serial",
    execute(args, ctx) {
      const command = (args as { command?: unknown } | null)?.command
      if (typeof command !== "string" || command.trim() === "") {
        return Promise.resolve({
          status: "error",
          output: "exec: args.command must be a non-empty string",
        })
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

        const child = opts.sandbox
          ? opts.sandbox.spawn(command, { cwd: opts.workspace })
          : spawn(command, {
              shell: true,
              cwd: opts.workspace,
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
          const spill = spillToolOutput(opts.spillDir, "exec", spillBuf)
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
          finish({
            status: "error",
            output: `command timed out after ${timeoutMs}ms\n${capped()}`,
          })
        }, timeoutMs)

        child.on("error", (err) => {
          finish({ status: "error", output: `exec failed: ${err.message}` })
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
