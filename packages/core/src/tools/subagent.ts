/**
 * The `subagent_run` + `subagent_collect` builtin tool executors — the
 * model-facing dispatch seam.
 *
 * Thin by design: argument validation, then one spawner/collector call.
 * Session creation, run submission, status streaming, confirmation
 * forwarding and abort propagation all live in the server-side spawner
 * implementation (agent/subagent.ts holds the shared contract).
 *
 * `risk: "safe"` — the spawn itself touches nothing sensitive; the child
 * run's own tool calls bear their own permission responsibility through the
 * regular gate. `concurrency: "parallel"` — several spawns in one tool batch
 * run concurrently, which is the parallelism path.
 *
 * `run_in_background` (issue #22) flips the wait: the dispatch returns the
 * child session id immediately, a completion notification lands on the
 * parent session when the child settles, and `subagent_collect` fetches the
 * full answer on demand.
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { SubagentCollector, SubagentSpawnRequest, SubagentSpawner } from "../agent/subagent.js"

/** The tool's model-facing description (kept beside the def in the registry). */
export const SUBAGENT_RUN_DESCRIPTION = [
  "Dispatch a subagent: an independent short-lived agent session that executes ONE task autonomously and returns its final answer as this tool's result.",
  "Use it for context-heavy work (codebase sweeps, research, multi-step verification) so the process never floods this conversation; the child cannot talk back, ask questions, or spawn further subagents.",
  "Issue several subagent_run calls in one batch to run independent tasks in parallel. `task` must be self-contained: the child sees nothing of this conversation, so include every path, constraint and definition it needs. `label` is a short display name.",
  "For long-running tasks set run_in_background: true — the call returns the child session id immediately and keeps this conversation free; a completion notice arrives as a message here, and subagent_collect fetches the full answer afterwards.",
].join(" ")

export const SUBAGENT_COLLECT_DESCRIPTION = [
  "Fetch a background subagent's final answer by its child session id (from the subagent_run background result or the completion notice).",
  "Only children of THIS session can be collected; the answer is head+tail truncated like a blocking result.",
].join(" ")

export function createSubagentTool(spawner: SubagentSpawner, parentSessionId: string): ToolExecutor {
  return {
    risk: "safe",
    concurrency: "parallel",
    async execute(args, ctx) {
      const { task, label, run_in_background } = (args ?? {}) as {
        task?: unknown
        label?: unknown
        run_in_background?: unknown
      }
      if (typeof task !== "string" || task.trim() === "") {
        return { status: "error", output: "invalid args: task must be a non-empty string" }
      }
      if (label !== undefined && typeof label !== "string") {
        return { status: "error", output: "invalid args: label must be a string" }
      }
      if (run_in_background !== undefined && typeof run_in_background !== "boolean") {
        return { status: "error", output: "invalid args: run_in_background must be a boolean" }
      }
      const req: SubagentSpawnRequest = {
        parentSessionId,
        task,
        ...(label === undefined ? {} : { label }),
        ...(run_in_background === true ? { background: true } : {}),
        // The abort signal only rides blocking dispatches: a background
        // child's lifecycle attaches to the parent SESSION, so ending or
        // aborting the parent run must not cancel it.
        ...(ctx.signal === undefined || run_in_background === true ? {} : { signal: ctx.signal }),
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

export function createSubagentCollectTool(collector: SubagentCollector, parentSessionId: string): ToolExecutor {
  return {
    risk: "safe",
    concurrency: "parallel",
    async execute(args) {
      const { childSessionId } = (args ?? {}) as { childSessionId?: unknown }
      if (typeof childSessionId !== "string" || childSessionId.trim() === "") {
        return { status: "error", output: "invalid args: childSessionId must be a non-empty string" }
      }
      const res = await collector({ parentSessionId, childSessionId })
      return {
        status: res.status,
        output: res.output,
        ...(res.childSessionId === undefined ? {} : { data: { childSessionId: res.childSessionId } }),
      }
    },
  }
}
