/**
 * exec tool (spec §7): run a shell command inside the workspace.
 *
 * - cwd is pinned to the workspace so commands can't wander the filesystem.
 * - stdout/stderr chunks are streamed via `ctx.onOutput` as they arrive and
 *   accumulated for the final result.
 * - On timeout the whole process group gets SIGKILL (`detached: true` makes
 *   the child a group leader, so `kill(-pid)` also reaps shell descendants
 *   like `sleep`); partial output is still returned.
 * - Output larger than `maxOutputBytes` keeps head + tail with a truncation
 *   marker (see truncateMiddle).
 * - Exit 0 → ok; anything else → error with an `exit code N` prefix line.
 */
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"
import type { ToolExecutor } from "../agent/tools.js"

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024

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
        let settled = false
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const child = spawn(command, {
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

        for (const stream of [child.stdout, child.stderr]) {
          if (!stream) continue
          stream.setEncoding("utf8")
          stream.on("data", (chunk: string) => {
            output += chunk
            ctx.onOutput(chunk)
          })
        }

        timer = setTimeout(() => {
          timedOut = true
          killAll()
          finish({
            status: "error",
            output: `command timed out after ${timeoutMs}ms\n${truncateMiddle(output, maxOutputBytes)}`,
          })
        }, timeoutMs)

        child.on("error", (err) => {
          finish({ status: "error", output: `exec failed: ${err.message}` })
        })

        child.on("close", (code) => {
          if (timedOut) return // timeout path already resolved with partial output
          const merged = truncateMiddle(output, maxOutputBytes)
          if (code === 0) finish({ status: "ok", output: merged })
          else finish({ status: "error", output: `exit code ${code}\n${merged}` })
        })
      })
    },
  }
}
