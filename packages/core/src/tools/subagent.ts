/**
 * The `subagent_run` builtin tool executor — the model-facing dispatch seam.
 *
 * Thin by design: argument validation, then one spawner call. Session
 * creation, run submission, status streaming, confirmation forwarding and
 * abort propagation all live in the server-side spawner implementation
 * (agent/subagent.ts holds the shared contract).
 *
 * `risk: "safe"` — the spawn itself touches nothing sensitive; the child
 * run's own tool calls bear their own permission responsibility through the
 * regular gate. `concurrency: "parallel"` — several spawns in one tool batch
 * run concurrently, which is the parallelism path.
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { SubagentSpawnRequest, SubagentSpawner } from "../agent/subagent.js"

/** The tool's model-facing description (kept beside the def in the registry). */
export const SUBAGENT_RUN_DESCRIPTION = [
  "Dispatch a subagent: an independent short-lived agent session that executes ONE task autonomously and returns its final answer as this tool's result.",
  "Use it for context-heavy work (codebase sweeps, research, multi-step verification) so the process never floods this conversation; the child cannot talk back, ask questions, or spawn further subagents.",
  "Issue several subagent_run calls in one batch to run independent tasks in parallel. `task` must be self-contained: the child sees nothing of this conversation, so include every path, constraint and definition it needs. `label` is a short display name.",
].join(" ")

export function createSubagentTool(spawner: SubagentSpawner, parentSessionId: string): ToolExecutor {
  return {
    risk: "safe",
    concurrency: "parallel",
    async execute(args, ctx) {
      const { task, label } = (args ?? {}) as { task?: unknown; label?: unknown }
      if (typeof task !== "string" || task.trim() === "") {
        return { status: "error", output: "invalid args: task must be a non-empty string" }
      }
      if (label !== undefined && typeof label !== "string") {
        return { status: "error", output: "invalid args: label must be a string" }
      }
      const req: SubagentSpawnRequest = {
        parentSessionId,
        task,
        ...(label === undefined ? {} : { label }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        onStatus: (line) => ctx.onOutput(line),
      }
      const res = await spawner(req)
      // The executor contract carries structured extras under `data` — that is
      // what rides the persisted ToolResultBlock (the web audit link reads it).
      return {
        status: res.status,
        output: res.output,
        ...(res.childSessionId === undefined ? {} : { data: { childSessionId: res.childSessionId } }),
      }
    },
  }
}
