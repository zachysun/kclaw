/**
 * process_list / process_output / process_kill: manage background commands
 * the bash tool started with `run_in_background`, scoped to the owning
 * session. All three are safe: listing/reading output/terminating a process
 * this session itself started is not a new capability frontier — the same
 * rationale as subagent_run being safe. The registry enforces ownership and
 * the running cap; these tools are its model-facing surface.
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { ProcessRegistry, ProcessEntry } from "../process/registry.js"
import { makeTool, optInt, requireString } from "./shared.js"

export function createProcessTools(opts: {
  registry: ProcessRegistry
  /** Owning session id — entries of other sessions are invisible here. */
  sessionId: string
}): {
  "process_list": ToolExecutor & { name: "process_list" }
  "process_output": ToolExecutor & { name: "process_output" }
  "process_kill": ToolExecutor & { name: "process_kill" }
} {
  const { registry, sessionId } = opts

  const render = (e: ProcessEntry): string =>
    [
      `${e.id}  ${e.status}${e.exitCode !== null ? ` (exit ${e.exitCode})` : ""}`,
      `  命令: ${e.command}`,
      `  启动: ${e.startedAt}${e.endedAt !== undefined ? `  结束: ${e.endedAt}` : ""}`,
      `  输出: ${e.spillPath}`,
    ].join("\n")

  const process_list = makeTool("process_list", "safe", "parallel", () => {
    const entries = registry.list(sessionId)
    if (entries.length === 0) return { status: "ok", output: "(没有后台进程)" }
    const running = entries.filter((e) => e.status === "running").length
    const lines = entries.slice(0, 50).map(render)
    return {
      status: "ok",
      output: `共 ${entries.length} 个（运行中 ${running}）：\n\n${lines.join("\n\n")}`,
    }
  })

  const process_output = makeTool("process_output", "safe", "parallel", async (args) => {
    const id = requireString(args, "processId")
    const offset = optInt(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER)
    const timeoutMs = optInt(args, "timeoutMs", 30_000, 1_000, 600_000)
    const wait = (args as { wait?: unknown }).wait === true
    const { entry, output, nextOffset } = await registry.output(id, sessionId, {
      offset,
      wait,
      timeoutMs,
    })
    let text = output
    if (text === "" && entry.status === "running") {
      text = wait ? `(等待期内无新输出)` : `(暂无新输出)`
    }
    const statusLine =
      entry.status === "running"
        ? "运行中"
        : `${entry.status}${entry.exitCode !== null ? `（exit ${entry.exitCode}）` : ""}`
    return {
      status: "ok",
      output: `[${statusLine}] nextOffset=${nextOffset}\n${text}`,
      data: { processId: entry.id, status: entry.status, exitCode: entry.exitCode, nextOffset },
    }
  })

  const process_kill = makeTool("process_kill", "safe", "serial", (args) => {
    const id = requireString(args, "processId")
    const entry = registry.kill(id, sessionId)
    if (entry.status !== "running") {
      return { status: "ok", output: `${id} 已结束（${entry.status}${entry.exitCode !== null ? `，exit ${entry.exitCode}` : ""}）` }
    }
    return { status: "ok", output: `已向 ${id} 的进程组发送 SIGKILL，退出后自动通知。` }
  })

  return { "process_list": process_list, "process_output": process_output, "process_kill": process_kill }
}
