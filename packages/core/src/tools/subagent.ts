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
import { def, str, type ToolEntry } from "./shared.js"

/** The tool's model-facing description (the schema below shapes it). */
export const SUBAGENT_RUN_DESCRIPTION = [
  "Dispatch a subagent: an independent short-lived agent session that executes ONE task autonomously and returns its final answer as this tool's result.",
  "Use it for context-heavy work (codebase sweeps, research, multi-step verification) so the process never floods this conversation; the child cannot talk back, ask questions, or spawn further subagents.",
  "Issue several subagent_run calls in one batch to run independent tasks in parallel. `task` must be self-contained: the child sees nothing of this conversation, so include every path, constraint and definition it needs. `label` is a short display name.",
  "Optionally specialize the child: `role` appends a per-task identity to its system prompt, and `tools` restricts its toolset (read-only exploration: ['fs_read','fs_list','fs_edit'] without fs_write/bash — a narrower toolset never widens permissions).",
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
      const { task, label, run_in_background, role, tools } = (args ?? {}) as {
        task?: unknown
        label?: unknown
        run_in_background?: unknown
        role?: unknown
        tools?: unknown
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
      if (role !== undefined && (typeof role !== "string" || role.trim() === "")) {
        return { status: "error", output: "invalid args: role must be a non-empty string" }
      }
      if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || t.trim() === ""))) {
        return { status: "error", output: "invalid args: tools must be an array of non-empty tool names" }
      }
      const allowList = Array.isArray(tools) ? tools.map((t) => (t as string).trim()).slice(0, 40) : undefined
      const req: SubagentSpawnRequest = {
        parentSessionId,
        task,
        ...(label === undefined ? {} : { label }),
        ...(role === undefined ? {} : { role: (role as string).trim().slice(0, 2000) }),
        ...(allowList === undefined || allowList.length === 0 ? {} : { toolAllow: allowList }),
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

/**
 * The registry-facing bundle: executors + schemas owned beside each other.
 * `collector` 在位时一并挂 subagent_collect（后台 subagent 按需取回答案）。
 */
export function createSubagentToolEntries(opts: {
  spawner: SubagentSpawner
  parentSessionId: string
  collector?: SubagentCollector
}): ToolEntry[] {
  const entries: ToolEntry[] = [
    {
      name: "subagent_run",
      tool: createSubagentTool(opts.spawner, opts.parentSessionId),
      def: def(
        "subagent_run",
        SUBAGENT_RUN_DESCRIPTION,
        {
          task: str("Self-contained task description — the child sees nothing of this conversation"),
          label: str("Short display name shown in status lines and confirmation cards"),
          run_in_background: { type: "boolean", description: "True = return the child session id immediately; the completion notice arrives later and subagent_collect fetches the answer (default false = wait for the result here)" },
          role: str("Optional role supplement for the child's system prompt: who it is for THIS task (e.g. '只读代码侦探，定位调用链'). Plain text, a few sentences at most"),
          tools: { type: "array", items: { type: "string" }, description: "Optional tool allowlist for the child (exact tool names, e.g. ['fs_read','fs_list']). Narrowing only — omitted tools vanish from the child. Empty/absent = the child gets the full default surface" },
        },
        ["task"],
      ),
    },
  ]
  if (opts.collector !== undefined) {
    entries.push({
      name: "subagent_collect",
      tool: createSubagentCollectTool(opts.collector, opts.parentSessionId),
      def: def(
        "subagent_collect",
        SUBAGENT_COLLECT_DESCRIPTION,
        { childSessionId: str("The child session id to collect (from the background dispatch result or the completion notice)") },
        ["childSessionId"],
      ),
    })
  }
  return entries
}
