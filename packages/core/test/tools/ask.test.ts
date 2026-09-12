// ask_user_questions tool + question registry: the three-way race
// (answered / timed out / aborted) and the arg validation contract.
import { describe, expect, it } from "vitest"
import { ConfirmationBroker } from "../../src/permissions/broker.js"
import { createAskUserQuestionsTool } from "../../src/tools/ask.js"
import type { AgentEvent } from "../../src/protocol/index.js"

function makeTool(overrides: { timeoutMs?: number } = {}) {
  const broker = new ConfirmationBroker()
  const emitted: AgentEvent[] = []
  const tool = createAskUserQuestionsTool({
    broker,
    timeoutMs: overrides.timeoutMs ?? 60_000,
    emit: (type, payload) => emitted.push({ id: "evt_test", ts: new Date().toISOString(), type, payload } as AgentEvent),
  })
  return { broker, emitted, tool }
}

describe("ask_user_questions executor", () => {
  it("非法参数：空 questions、缺 text、坏 options 都返回 error 结果且不发事件", async () => {
    const { tool, emitted } = makeTool()
    for (const args of [undefined, {}, { questions: [] }, { questions: "q" }, { questions: [{ options: ["a"] }] }, { questions: [{ text: "q", options: ["only"] }] }]) {
      const r = await tool.execute(args, { onOutput: () => {} })
      expect(r.status).toBe("error")
      expect(r.output).toContain("ask_user_questions:")
    }
    expect(emitted).toHaveLength(0)
  })

  it("回答路径：requested → 网关 resolveQuestion → 工具结果带逐题答案，resolved 事件带 by", async () => {
    const { broker, emitted, tool } = makeTool()
    const args = {
      questions: [
        { text: "用哪个方案?", options: ["方案A", "方案B"] },
        { text: "补充说明?" },
        { text: "改哪些?", options: ["db", "api"], multiSelect: true },
      ],
    }
    const pending = tool.execute(args, { onOutput: () => {} })
    // The requested event carries the id the gateway answers with.
    const requested = emitted.find((e) => e.type === "question.requested")
    expect(requested).toBeDefined()
    const questionId = (requested!.payload as { questionId: string }).questionId
    expect(broker.resolveQuestion(questionId, [["方案A"], [] as string[], ["db", "api"]], "web")).toBe(true)
    const r = await pending
    expect(r.status).toBe("ok")
    expect(r.output).toContain("1. 用哪个方案?\n   → 方案A")
    expect(r.output).toContain("2. 补充说明?\n   → （未回答）")
    expect(r.output).toContain("3. 改哪些?\n   → db、api")
    const resolved = emitted.find((e) => e.type === "question.resolved")
    expect(resolved!.payload).toMatchObject({ questionId, by: "web" })
  })

  it("错位应答按问题序规整：缺位补空、非数组槽位按未回答、越位丢弃", async () => {
    const { broker, emitted, tool } = makeTool()
    const args = { questions: [{ text: "一?" }, { text: "二?" }, { text: "三?" }] }
    const pending = tool.execute(args, { onOutput: () => {} })
    const requested = emitted.find((e) => e.type === "question.requested")!
    const questionId = (requested.payload as { questionId: string }).questionId
    // 网关应答错位：第 2 题的槽位不是数组（按未回答处理），第 4 组越位
    // （丢弃）——结果与 data 都按问题数对齐
    expect(broker.resolveQuestion(questionId, [["甲"], "bad", ["丙"], ["越位"]] as unknown as string[][], "cli")).toBe(true)
    const r = await pending
    expect(r.status).toBe("ok")
    expect(r.output).toContain("1. 一?\n   → 甲")
    expect(r.output).toContain("2. 二?\n   → （未回答）")
    expect(r.output).toContain("3. 三?\n   → 丙")
    expect(r.output).not.toContain("越位")
    expect(r.data).toEqual({ questionId, answers: [["甲"], [], ["丙"]] })
    const resolved = emitted.find((e) => e.type === "question.resolved")
    expect(resolved!.payload).toMatchObject({ questionId, answers: [["甲"], [], ["丙"]], by: "cli" })
  })

  it("超时路径：竞速定时器先到 → ok 结果含『未在限时内回答』，resolved 带 by:timeout，条目过期", async () => {
    const { broker, emitted, tool } = makeTool({ timeoutMs: 20 })
    const pending = tool.execute({ questions: [{ text: "在吗?" }] }, { onOutput: () => {} })
    const r = await pending
    expect(r.status).toBe("ok")
    expect(r.output).toContain("未在限时")
    const resolved = emitted.find((e) => e.type === "question.resolved")
    expect(resolved!.payload).toMatchObject({ by: "timeout" })
    // A late answer settles nothing.
    const requested = emitted.find((e) => e.type === "question.requested")!
    const questionId = (requested.payload as { questionId: string }).questionId
    expect(broker.resolveQuestion(questionId, [["晚了的回答"]], "cli")).toBe(false)
  })

  it("中止路径：signal 已中止 → error 结果、无 resolved 事件（中止不是答案）", async () => {
    const { emitted, tool } = makeTool()
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await tool.execute({ questions: [{ text: "在吗?" }] }, { onOutput: () => {}, signal: ctrl.signal })
    expect(r.status).toBe("error")
    expect(r.output).toContain("中止")
    expect(emitted.some((e) => e.type === "question.resolved")).toBe(false)
  })

  it("运行中中止：等待期间 abort → 同样错误结果且无 resolved", async () => {
    const { emitted, tool } = makeTool({ timeoutMs: 10_000 })
    const ctrl = new AbortController()
    const pending = tool.execute({ questions: [{ text: "在吗?" }] }, { onOutput: () => {}, signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 5)
    const r = await pending
    expect(r.status).toBe("error")
    expect(emitted.some((e) => e.type === "question.resolved")).toBe(false)
  })
})

describe("ConfirmationBroker question registry", () => {
  it("确认与问题两类条目共存：各自的 resolve 互不串扰", async () => {
    const broker = new ConfirmationBroker()
    const q = broker.createQuestion("q_1", 60_000)
    const confP = broker.create("conf_1", { id: "blk_1", type: "tool_call", callId: "call_1", name: "exec", argsJson: "{}" }, "safe", 60_000, "ses_a")
    expect(broker.resolveQuestion("conf_1", [["x"]])).toBe(false)
    expect(broker.resolve("q_1", "once")).toBe(false)
    expect(broker.resolveQuestion("q_1", [["在"]], "cli")).toBe(true)
    expect(broker.resolve("conf_1", "once", "web")).toBe(true)
    await expect(q).resolves.toMatchObject({ answers: [["在"]], by: "cli" })
    await expect(confP).resolves.toMatchObject({ decision: "once", by: "web" })
  })

  it("重复结算返回 false；过期条目上的迟到回答也返回 false", async () => {
    const broker = new ConfirmationBroker()
    broker.createQuestion("q_2", 60_000)
    expect(broker.resolveQuestion("q_2", [["1"]])).toBe(true)
    expect(broker.resolveQuestion("q_2", [["2"]])).toBe(false)
    broker.createQuestion("q_3", 5)
    await new Promise((r) => setTimeout(r, 15))
    expect(broker.resolveQuestion("q_3", [["迟到"]])).toBe(false)
  })
})
