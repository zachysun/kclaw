/**
 * 判定器接缝测试（issue #47）：证据窗口构建 + judgeGoal 的解析/重试/
 * 传输分类。全部用假 LlmClient（脚本流），不碰网络。
 */
import { describe, it, expect } from "vitest"
import { buildEvidenceWindow, judgeGoal } from "../../src/goal/judge.js"
import type { GoalSnapshot, GoalGateOutcome } from "../../src/goal/types.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import type { Message } from "../../src/protocol/messages.js"

/** 一次性脚本客户端：按调用序吐预设响应（同 daemon.test 的 scriptClient）。 */
function scriptClient(script: string[][]): LlmClient & { calls: LlmRequestView[] } {
  let i = 0
  const calls: LlmRequestView[] = []
  return {
    calls,
    async *stream(req): AsyncIterable<LlmStreamEvent> {
      calls.push({ model: req.model, temperature: req.temperature, tools: req.tools.length })
      const text = script[Math.min(i++, script.length - 1)]![0] ?? ""
      yield { type: "text_delta", delta: text }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 5 } }
    },
  }
}

type LlmRequestView = { model: string; temperature?: number; tools: number }

function goalSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return { text: "测试全过", acceptance: ["pnpm test"], state: "active", setAt: "2026-01-01T00:00:00.000Z", rounds: 0, totalRounds: 0, tokensUsed: 0, ...overrides }
}

function msg(role: "user" | "assistant", text: string): Message {
  return { id: `m_${text.length}_${text.charCodeAt(0)}`, sessionId: "s", role, blocks: [{ id: "b", type: "text", text }], createdAt: "2026-01-01T00:00:00.000Z" }
}

const GATES: GoalGateOutcome[] = [{ command: "pnpm test", ok: true, exitCode: 0, outputTail: "all green" }]

describe("buildEvidenceWindow", () => {
  it("keeps recent messages and marks the omitted head count", () => {
    const messages = Array.from({ length: 40 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `消息 ${i}：${"内容".repeat(50)}`))
    const window = buildEvidenceWindow(messages)
    expect(window).toMatch(/^（更早的 \d+ 条消息已省略）/)
    expect(window).toContain("消息 39")
    expect(window).not.toContain("消息 5：")
  })

  it("empty stream yields an empty window without the omission header", () => {
    expect(buildEvidenceWindow([])).toBe("")
  })
})

describe("judgeGoal", () => {
  it("parses a clean verdict JSON and reports usage", async () => {
    const llm = scriptClient([[JSON.stringify({ verdict: "met", reason: "验收命令全过", progress: "完成" })]])
    const out = await judgeGoal({ llm, model: "judge-model", goal: goalSnapshot(), gates: GATES, messages: [msg("assistant", "done")] })
    expect(out).toEqual({
      ok: true,
      result: { verdict: "met", reason: "验收命令全过", progress: "完成", tokens: { inputTokens: 3, outputTokens: 5 } },
    })
    // 判定请求带温度 0、无工具、宽松输出上限。
    expect(llm.calls[0]).toMatchObject({ temperature: 0, tools: 0 })
  })

  it("strips code fences and extracts the first JSON object", async () => {
    const llm = scriptClient([["```json\n{\"verdict\":\"not_met\",\"reason\":\"还在改\",\"progress\":\"过半\"}\n```"]])
    const out = await judgeGoal({ llm, model: "m", goal: goalSnapshot(), gates: [], messages: [] })
    expect(out.ok && out.result.verdict).toBe("not_met")
  })

  it("retries once on garbage output and merges both attempts' usage", async () => {
    const llm = scriptClient([["抱歉我说人话"], [JSON.stringify({ verdict: "impossible", reason: "前提缺失" })]])
    const out = await judgeGoal({ llm, model: "m", goal: goalSnapshot(), gates: [], messages: [] })
    expect(out.ok && out.result.verdict).toBe("impossible")
    expect(llm.calls).toHaveLength(2)
    expect(out.ok && out.result.tokens).toEqual({ inputTokens: 6, outputTokens: 10 })
  })

  it("classifies a persistent parse failure as parse error", async () => {
    const llm = scriptClient([["不是 json"], ["还是不是"]])
    const out = await judgeGoal({ llm, model: "m", goal: goalSnapshot(), gates: [], messages: [] })
    expect(out).toMatchObject({ ok: false, error: { kind: "parse" } })
  })

  it("rejects an out-of-contract verdict as a parse failure", async () => {
    const llm = scriptClient([[JSON.stringify({ verdict: "maybe", reason: "拿不准" })], [JSON.stringify({ verdict: "perhaps", reason: "还是" })]])
    const out = await judgeGoal({ llm, model: "m", goal: goalSnapshot(), gates: [], messages: [] })
    expect(out).toMatchObject({ ok: false, error: { kind: "parse" } })
  })

  it("classifies a thrown stream as a transport error", async () => {
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        throw new Error("connection reset")
      },
    }
    const out = await judgeGoal({ llm, model: "m", goal: goalSnapshot(), gates: [], messages: [] })
    expect(out).toMatchObject({ ok: false, error: { kind: "transport", message: "connection reset" } })
  })

  it("requires a non-empty reason", async () => {
    const llm = scriptClient([[JSON.stringify({ verdict: "met", reason: "" })], [JSON.stringify({ verdict: "met", reason: "  " })]])
    const out = await judgeGoal({ llm, model: "m", goal: goalSnapshot(), gates: [], messages: [] })
    expect(out).toMatchObject({ ok: false, error: { kind: "parse" } })
  })
})
