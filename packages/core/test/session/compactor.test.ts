import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Compactor } from "../../src/session/compactor.js"
import { SessionStore } from "../../src/session/store.js"
import { newMessage, newAssistantMessage } from "../../src/protocol/messages.js"
import type { LlmClient, LlmRequest, LlmStreamEvent } from "../../src/provider/types.js"
import type { KclawConfig } from "../../src/storage/config.js"
import type { AgentEvent } from "../../src/protocol/events.js"
import { estimateSpanTokens, estimateTokens } from "../../src/session/compaction.js"
import { SUMMARY_WRAPPER_TOKENS } from "../../src/agent/context.js"

// 压缩的结构化 spill 指针：摘要器 mock 不回显任何路径，但段摘要与总摘要必须
// 携带 locator 行——指针由代码保证，不依赖提示词纪律。

const LOCATOR_A = "[完整输出已存盘: /tmp/kclaw-spill/aaa-exec.txt；需要更多内容时用 fs_read 读取该文件]"
const LOCATOR_B = "[完整输出已存盘: /tmp/kclaw-spill/bbb-web.txt；需要更多内容时用 fs_read 读取该文件]"

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "kclaw-compactor-"))
  const sessions = new SessionStore(dir)
  const events: AgentEvent[] = []
  const compactor = new Compactor({ sessions, emit: (e) => events.push(e) })
  const config = { sessions: { contextTokens: 2000 } } as unknown as KclawConfig
  return { dir, sessions, events, compactor, config }
}

/** 固定五栏但不含任何 spill 路径的摘要器 mock：结构化追加才是被测对象。 */
function stubSummarizer(calls: LlmRequest[]): LlmClient {
  return {
    async *stream(req): AsyncIterable<LlmStreamEvent> {
      calls.push(req)
      const isMerge = (req.system ?? "").includes("归并")
      yield { type: "text_delta", delta: isMerge ? "## 关键事实\n（归并摘要）" : "## 关键事实\n（段摘要）" }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } }
    },
  }
}

function historyWithSpill(sessionId: string) {
  // 两轮结构：第一轮的两个工具输出（带 spill locator）要落在被压缩的最旧
  // 前缀里，后面跟着一条大文本 assistant 消息把估算顶过黄线。
  const u0 = newMessage(sessionId, "user", [{ id: "b-u0", type: "text", text: "先跑构建再看页面" }])
  const a1 = newAssistantMessage(sessionId, "m1", [
    { id: "b-c1", type: "tool_call", callId: "call_1", name: "exec", args: {}, argsJson: '{"command":"pnpm build"}' },
  ])
  a1.stopReason = "tool_use"
  const t1 = newMessage(sessionId, "tool", [
    { id: "b-r1", type: "tool_result", callId: "call_1", status: "ok", output: "构建日志".repeat(200) + "\n" + LOCATOR_A, durationMs: 5 },
  ])
  const a2 = newAssistantMessage(sessionId, "m2", [
    { id: "b-c2", type: "tool_call", callId: "call_2", name: "web_fetch", args: {}, argsJson: '{"url":"https://x"}' },
  ])
  a2.stopReason = "tool_use"
  const t2 = newMessage(sessionId, "tool", [
    { id: "b-r2", type: "tool_result", callId: "call_2", status: "ok", output: "网页".repeat(300) + "\n" + LOCATOR_B, durationMs: 5 },
  ])
  const u1 = newMessage(sessionId, "user", [{ id: "b-u1", type: "text", text: "总结一下刚才的结果" }])
  const a3 = newAssistantMessage(sessionId, "m3", [{ id: "b-t3", type: "text", text: "团队讨论了迁移方案。".repeat(200) }])
  a3.usage = { inputTokens: 3000, outputTokens: 10 } // 锚点
  return [u0, a1, t1, a2, t2, u1, a3]
}

describe("Compactor 结构化 spill 指针", () => {
  it("摘要器不回显路径时，段摘要与总摘要仍携带 locator 行（去重）", async () => {
    const { dir, sessions, events, compactor, config } = makeEnv()
    try {
      const session = sessions.create("指针会话")
      const history = historyWithSpill(session.id)
      for (const m of history) sessions.appendMessage(session.id, m)
      const calls: LlmRequest[] = []

      const out = await compactor.compact(session.id, history, "", config, stubSummarizer(calls), "mock-model")
      expect(out.status).toBe("applied")

      const [record] = sessions.readCompactions(session.id)
      expect(record.segmentSummary).toContain(LOCATOR_A)
      expect(record.segmentSummary).toContain(LOCATOR_B)
      expect(record.top).toContain(LOCATOR_A)
      expect(record.top).toContain(LOCATOR_B)
      // 每条 locator 恰好一份（不因段摘要+归并链路重复）
      expect(record.top.split(LOCATOR_A).length - 1).toBe(1)
      // 摘要器 mock 的输出不含任何路径（固定五栏正文）——摘要里的 locator
      // 行完全来自结构化追加，不依赖提示词纪律
      for (const c of calls) {
        expect(c.messages.length).toBeGreaterThan(0)
      }
      expect(calls).toHaveLength(2)
      expect(events.some((e) => e.type === "compaction.completed")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Compactor token 记账", () => {
  it("tokensBefore 锚定真实请求；tokensAfter = 保留尾估算 + 真值摘要 token + 注入模板", async () => {
    const { dir, sessions, compactor, config } = makeEnv()
    try {
      const session = sessions.create("token 会话")
      const history = historyWithSpill(session.id)
      for (const m of history) sessions.appendMessage(session.id, m)

      // stubSummarizer 的 message_done 带 outputTokens: 5 → 总摘要走真值分支
      const out = await compactor.compact(session.id, history, "", config, stubSummarizer([]), "mock-model")
      expect(out.status).toBe("applied")
      if (out.status !== "applied") return

      const [record] = sessions.readCompactions(session.id)
      // a3.usage.inputTokens = 3000 是唯一真锚点且其后无消息 → X 精确等于它
      expect(record.tokensBefore).toBe(3_000)
      // Y = 保留尾逐条估算 + 真值 5 + 模板常量（overheadTokens 未传不另计）
      expect(record.tokensAfter).toBe(estimateSpanTokens(out.active) + 5 + SUMMARY_WRAPPER_TOKENS)
      expect(record.tokensAfter!).toBeLessThan(record.tokensBefore!)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("provider 未报 usage 时总摘要回退文本估算", async () => {
    const { dir, sessions, compactor, config } = makeEnv()
    try {
      const session = sessions.create("回退会话")
      const history = historyWithSpill(session.id)
      for (const m of history) sessions.appendMessage(session.id, m)

      const noUsageLlm: LlmClient = {
        async *stream(req): AsyncIterable<LlmStreamEvent> {
          const isMerge = (req.system ?? "").includes("归并")
          yield { type: "text_delta", delta: isMerge ? "## 关键事实\n（归并摘要）" : "## 关键事实\n（段摘要）" }
          yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } }
        },
      }
      const out = await compactor.compact(session.id, history, "", config, noUsageLlm, "mock-model")
      expect(out.status).toBe("applied")
      if (out.status !== "applied") return

      const [record] = sessions.readCompactions(session.id)
      expect(record.tokensAfter).toBe(estimateSpanTokens(out.active) + estimateTokens(record.top) + SUMMARY_WRAPPER_TOKENS)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
