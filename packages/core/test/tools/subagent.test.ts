/**
 * The `subagent_run` tool contract at the core seam: argument validation,
 * spawner passthrough, and — through the loop — the abort-signal handoff that
 * parent-stop-child-stop relies on. The spawner is a mock here; the real one
 * lives in the server and gets its own integration suite.
 */
import { describe, it, expect, vi } from "vitest"
import { createSubagentTool, createSubagentCollectTool, SUBAGENT_RUN_DESCRIPTION } from "../../src/tools/subagent.js"
import { subagentSystemPrompt, truncateAnswer, subagentTitle, SUBAGENT_ANSWER_MAX_CHARS } from "../../src/agent/subagent.js"
import type { SubagentSpawnRequest, SubagentSpawnResult } from "../../src/agent/subagent.js"

function ok(output: string, childSessionId?: string): SubagentSpawnResult {
  return { status: "ok", output, ...(childSessionId === undefined ? {} : { childSessionId }) }
}

describe("subagent_run executor", () => {
  it("classifies as safe + parallel (the spawn itself bears no risk; batches parallelize)", () => {
    const tool = createSubagentTool(vi.fn(async () => ok("done")), "ses_p")
    expect(tool.risk).toBe("safe")
    expect(tool.concurrency).toBe("parallel")
    expect(SUBAGENT_RUN_DESCRIPTION).toContain("subagent")
  })

  it("validates args: empty/missing task and non-string label are immediate error results", async () => {
    const spawner = vi.fn(async () => ok("never"))
    const tool = createSubagentTool(spawner, "ses_p")
    const r1 = await tool.execute({}, { onOutput: () => undefined })
    expect(r1.status).toBe("error")
    const r2 = await tool.execute({ task: "  " }, { onOutput: () => undefined })
    expect(r2.status).toBe("error")
    const r3 = await tool.execute({ task: "t", label: 5 }, { onOutput: () => undefined })
    expect(r3.status).toBe("error")
    expect(spawner).not.toHaveBeenCalled()
  })

  it("passes task/label/parent through and settles with the spawner's result", async () => {
    const spawner = vi.fn(async (req: SubagentSpawnRequest) => {
      expect(req.parentSessionId).toBe("ses_p")
      expect(req.task).toBe("找出所有 TODO")
      expect(req.label).toBe("todo-sweep")
      return ok("共 3 处", "ses_child")
    })
    const tool = createSubagentTool(spawner, "ses_p")
    const result = await tool.execute({ task: "找出所有 TODO", label: "todo-sweep" }, { onOutput: () => undefined })
    // childSessionId rides the executor contract's `data` (→ ToolResultBlock.data).
    expect(result).toEqual({ status: "ok", output: "共 3 处", data: { childSessionId: "ses_child" } })
  })

  it("forwards the run's abort signal to the spawner (parent stop → child stop)", async () => {
    let sawSignal: AbortSignal | undefined
    const spawner = vi.fn(async (req: SubagentSpawnRequest) => {
      sawSignal = req.signal
      return { status: "error", output: "aborted" }
    })
    const tool = createSubagentTool(spawner, "ses_p")
    const controller = new AbortController()
    controller.abort()
    await tool.execute({ task: "t" }, { signal: controller.signal, onOutput: () => undefined })
    expect(sawSignal?.aborted).toBe(true)
  })

  it("streams spawner status lines through onOutput (the live one-liner channel)", async () => {
    const spawner = vi.fn(async (req: SubagentSpawnRequest) => {
      req.onStatus("▸ 调用工具 exec\n")
      return ok("done")
    })
    const tool = createSubagentTool(spawner, "ses_p")
    const seen: string[] = []
    await tool.execute({ task: "t" }, { onOutput: (d) => seen.push(d) })
    expect(seen).toEqual(["▸ 调用工具 exec\n"])
  })

  it("run_in_background: background flag rides the request and the abort signal does NOT (lifecycle belongs to the session)", async () => {
    let seen: SubagentSpawnRequest | undefined
    const spawner = vi.fn(async (req: SubagentSpawnRequest) => {
      seen = req
      return ok("已在后台派出", "ses_bg")
    })
    const tool = createSubagentTool(spawner, "ses_p")
    const controller = new AbortController()
    controller.abort()
    const result = await tool.execute(
      { task: "t", run_in_background: true },
      { signal: controller.signal, onOutput: () => undefined },
    )
    expect(seen?.background).toBe(true)
    expect(seen?.signal).toBeUndefined()
    expect(result.data).toEqual({ childSessionId: "ses_bg" })
    // A non-boolean flag is rejected before the spawner runs.
    const bad = await tool.execute({ task: "t", run_in_background: "yes" }, { onOutput: () => undefined })
    expect(bad.status).toBe("error")
    expect(spawner).toHaveBeenCalledTimes(1)
  })
})

describe("subagent_collect executor", () => {
  it("validates childSessionId and passes parent+child through, carrying the child id in data", async () => {
    const collector = vi.fn(async (req: { parentSessionId: string; childSessionId: string }) => ({
      status: "ok" as const,
      output: "完整答复",
      childSessionId: req.childSessionId,
    }))
    const tool = createSubagentCollectTool(collector, "ses_p")
    expect(tool.risk).toBe("safe")
    const bad = await tool.execute({}, { onOutput: () => undefined })
    expect(bad.status).toBe("error")
    const result = await tool.execute({ childSessionId: "ses_c" }, { onOutput: () => undefined })
    expect(collector).toHaveBeenCalledWith({ parentSessionId: "ses_p", childSessionId: "ses_c" })
    expect(result).toEqual({ status: "ok", output: "完整答复", data: { childSessionId: "ses_c" } })
  })
})

describe("subagent helpers", () => {
  it("the lean prompt carries identity + workspace + discipline, not the persona", () => {
    const prompt = subagentSystemPrompt("/tmp/proj")
    expect(prompt).toContain("子代理")
    expect(prompt).toContain("/tmp/proj")
    expect(prompt).toContain("结题答复")
    expect(prompt).not.toContain("AGENTS")
  })

  it("truncateAnswer keeps head+tail with an elision marker", () => {
    const long = `A${"x".repeat(SUBAGENT_ANSWER_MAX_CHARS)}Z`
    const out = truncateAnswer(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out.startsWith("A")).toBe(true)
    expect(out.endsWith("Z")).toBe(true)
    expect(out).toContain("已截断")
    expect(truncateAnswer("short")).toBe("short")
  })

  it("subagentTitle prefers the label, else the task's head, always prefixed", () => {
    expect(subagentTitle("扫 TODO", "whatever")).toBe("子代理 · 扫 TODO")
    const fromTask = subagentTitle(undefined, `${"很长的任务".repeat(20)}结尾`)
    expect(fromTask.startsWith("子代理 · ")).toBe(true)
    expect(fromTask.length).toBeLessThanOrEqual(50)
  })
})
