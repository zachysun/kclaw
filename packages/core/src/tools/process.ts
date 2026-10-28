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
import { def, int, makeTool, optInt, requireString, str, type ToolEntry } from "./shared.js"

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

/**
 * The registry-facing bundle: executors + schemas owned beside each other.
 * 归属按会话隔离：registry 只暴露本 sessionId 的条目（组装层按注册表在位
 * 与否决定是否展开本组）。
 */
export function createProcessToolEntries(opts: Parameters<typeof createProcessTools>[0]): ToolEntry[] {
  const tools = createProcessTools(opts)
  return [
    {
      name: "process_list",
      tool: tools.process_list,
      def: def(
        "process_list",
        "List this session's background processes (id, command, status, exit code, output file). Completion is announced automatically; use process_output to read output incrementally.",
        {},
        [],
      ),
    },
    {
      name: "process_output",
      tool: tools.process_output,
      def: def(
        "process_output",
        "Read a background process's output since a byte offset (incremental cursor; the completion notice arrives automatically — do not poll). Optional wait blocks for new output or exit, bounded by timeoutMs (default 30s, max 600s).",
        {
          processId: str("Background process id (from the run_in_background result or the completion notice)"),
          offset: int(0, Number.MAX_SAFE_INTEGER),
          wait: { type: "boolean", description: "True = block until new output or termination (bounded by timeoutMs)" },
          timeoutMs: int(1_000, 600_000),
        },
        ["processId"],
      ),
    },
    {
      name: "process_kill",
      tool: tools.process_kill,
      def: def(
        "process_kill",
        "Terminate a background process (SIGKILL to its whole process group). Killing an already-finished process is not an error.",
        { processId: str("Background process id") },
        ["processId"],
      ),
    },
  ]
}
