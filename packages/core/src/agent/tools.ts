/**
 * Tool executor contract implemented by built-in tools and MCP adapters.
 *
 * - `risk` marks whether a call needs human confirmation before executing
 *   (handled by the permission gate; the loop only carries it through).
 * - `concurrency` drives scheduling within one turn's batch of tool_calls:
 *   "parallel" tools run concurrently, "serial" tools run strictly
 *   one-by-one and never overlap any other tool.
 * - `onOutput(delta)` streams partial output while the tool runs.
 * - `promote(defs)` (optional, tiered disclosure): merges deferred/directory
 *   defs into the run's active tool set — the next request's tools array
 *   carries them, so the model calls the promoted names directly.
 */
export interface ToolExecutor {
  risk: "safe" | "sensitive"
  concurrency: "parallel" | "serial"
  execute(args: unknown, ctx: {
    signal?: AbortSignal
    onOutput(delta: string): void
    promote?: (defs: import("../provider/types.js").ToolDefinition[]) => void
  }): Promise<{ status: "ok" | "error"; output: string; data?: unknown }>
}
