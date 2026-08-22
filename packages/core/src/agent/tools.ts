/**
 * Tool executor contract implemented by built-in tools (Task 10+) and MCP adapters.
 *
 * - `risk` marks whether a call needs human confirmation before executing
 *   (handled in a later task; the loop only carries it through).
 * - `concurrency` drives scheduling within one turn's batch of tool_calls
 *   (spec §7): "parallel" tools run concurrently, "serial" tools run strictly
 *   one-by-one and never overlap any other tool.
 * - `onOutput(delta)` streams partial output while the tool runs.
 */
export interface ToolExecutor {
  risk: "safe" | "sensitive"
  concurrency: "parallel" | "serial"
  execute(args: unknown, ctx: {
    signal?: AbortSignal
    onOutput(delta: string): void
  }): Promise<{ status: "ok" | "error"; output: string; data?: unknown }>
}
