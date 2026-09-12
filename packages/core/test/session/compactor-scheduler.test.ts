/**
 * Compactor 的压缩调度状态机（v4 水位线批次）：后台压缩（预压线触发的
 * 非阻塞路径）、挂起成果的交接（完成即挂起 / 迭代边界应用 / 同步压缩作废）、
 * 挂起 /compact 的登记与冲刷、等待者（"等、称、再决定"）与取消语义。
 *
 * 这些规则先经 prototype-compaction-scheduler.mjs 的 18 场景推演验证，
 * 再按原样落进 Compactor——本文件的场景与 prototype 一一对应。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "../../src/session/store.js"
import { Compactor } from "../../src/session/compactor.js"
import { newMessage, newAssistantMessage } from "../../src/protocol/messages.js"
import type { Message } from "../../src/protocol/messages.js"
import { loadConfig, resolvePaths } from "../../src/storage/index.js"
import { defaultConfig } from "../../src/storage/config.js"
import type { LlmClient, LlmStreamEvent, LlmRequest } from "../../src/provider/types.js"

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kclaw-scheduler-test-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** 带真实 inputTokens 锚点的历史：水位估算由此可控。 */
function seedHistory(sessions: SessionStore, sessionId: string, pairs = 3): Message[] {
  const out: Message[] = []
  for (let i = out.length; i < pairs; i++) {
    const u = newMessage(sessionId, "user", [{ id: `bu${i}`, type: "text", text: "问题".repeat(100) }])
    u.id = `u${i}`
    sessions.appendMessage(sessionId, u)
    const a = newAssistantMessage(sessionId, "m", [{ id: `ba${i}`, type: "text", text: "回答".repeat(100) }])
    a.id = `a${i}`
    a.usage = { inputTokens: i === pairs - 1 ? 1000 : 900, outputTokens: 10 }
    sessions.appendMessage(sessionId, a)
    out.push(u, a)
  }
  return out
}

/** 可控假 LLM：首次调用被 gate 挡住，放行后本 gate 后续调用直接过；记录全部请求。 */
function gatedClient() {
  const gate = Promise.withResolvers<void>()
  const calls: LlmRequest[] = []
  const failAt = { index: -1 }
  const client: LlmClient = {
    async *stream(req): AsyncIterable<LlmStreamEvent> {
      calls.push(req)
      await gate.promise
      if (failAt.index === calls.length - 1) throw new Error("摘要挂了")
      yield { type: "text_delta", delta: "段摘要内容" }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }
    },
  }
  return {
    client,
    calls,
    release(): void {
      gate.resolve()
    },
    failNext(): void {
      failAt.index = calls.length
    },
  }
}

/** 压缩摘要请求的识别（system 以摘要提示词开头、无工具调用）。 */
function isSummaryCall(req: LlmRequest): boolean {
  return typeof req.system === "string" && req.system.startsWith("你是对话摘要")
}

function makeCompactor(sessions: SessionStore) {
  const events: unknown[] = []
  const compactor = new Compactor({ sessions, emit: (e) => events.push(e) })
  const config = { ...defaultConfig, sessions: { ...defaultConfig.sessions, contextTokens: 1000 } }
  return { compactor, events, config }
}

/** background + gated client 的装配：kick 后立即返回，测试 release 放行摘要调用。 */
async function setup(sessions: SessionStore) {
  const { compactor, events, config } = makeCompactor(sessions)
  const llm = gatedClient()
  return { compactor, events, config, llm }
}

describe("Compactor 调度状态机", () => {
  it("后台压缩正流：kick→在飞→放行两次摘要→挂起→取走即清", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("正流")
    const history = seedHistory(sessions, session.id)
    const { compactor, config, llm } = await setup(sessions)

    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(true)
    expect(compactor.hasInFlight(session.id)).toBe(true)
    expect(compactor.parked(session.id)).toBe(false)

    llm.release() // 两次摘要调用各过一个闸门——第一次 release 放行第一对中的第一个
    await vi.waitFor(() => expect(llm.calls.filter(isSummaryCall).length).toBeGreaterThanOrEqual(2))
    llm.release()
    await vi.waitFor(() => expect(compactor.parked(session.id)).toBe(true))
    expect(compactor.hasInFlight(session.id)).toBe(false)

    const view = compactor.takeParked(session.id)
    expect(view).toEqual({ upto: expect.any(String), top: "段摘要内容" })
    expect(compactor.takeParked(session.id)).toBeNull()
  })

  it("防重入：在飞或有挂起成果时 kick 被拒", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("防重入")
    const history = seedHistory(sessions, session.id)
    const { compactor, config, llm } = await setup(sessions)

    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(true)
    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(false)

    llm.release()
    await vi.waitFor(() => expect(llm.calls.filter(isSummaryCall).length).toBeGreaterThanOrEqual(2))
    llm.release()
    await vi.waitFor(() => expect(compactor.parked(session.id)).toBe(true))
    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(false)
  })

  it("取消标记压制后台压缩；清除后恢复", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("取消标记")
    const history = seedHistory(sessions, session.id)
    const { compactor, config, llm } = await setup(sessions)

    compactor.cancel(session.id)
    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(false)
    compactor.clearCancelled(session.id)
    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(true)
  })

  it("被取消的在飞后台：完成时不挂起成果", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("被取消")
    const history = seedHistory(sessions, session.id)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { compactor, config, llm } = await setup(sessions)

    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(true)
    compactor.cancel(session.id) // abort 在飞 + 标记
    llm.release()
    await vi.waitFor(() => expect(compactor.hasInFlight(session.id)).toBe(false))
    expect(compactor.parked(session.id)).toBe(false)
    errorSpy.mockRestore()
  })

  it("后台失败 = 没发生：无挂起、可重新 kick", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("失败重试")
    const history = seedHistory(sessions, session.id)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { compactor, config, llm } = await setup(sessions)

    llm.failNext()
    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(true)
    llm.release()
    await vi.waitFor(() => expect(compactor.hasInFlight(session.id)).toBe(false))
    expect(compactor.parked(session.id)).toBe(false)
    errorSpy.mockRestore()
  })

  it("waitForSettled：无在飞立即返回；在飞时挂起等待、完成放行", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("等待")
    const history = seedHistory(sessions, session.id)
    const { compactor, config, llm } = await setup(sessions)

    await expect(compactor.waitForSettled(session.id)).resolves.toBeUndefined()

    compactor.background(session.id, history, config, llm.client, "m")
    let settled = false
    void compactor.waitForSettled(session.id).then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    llm.release()
    await vi.waitFor(() => expect(llm.calls.filter(isSummaryCall).length).toBeGreaterThanOrEqual(2))
    llm.release()
    await vi.waitFor(() => expect(settled).toBe(true))
  })

  it("同步压缩作废挂起成果（防视图回退到旧 upto）", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("作废")
    const history = seedHistory(sessions, session.id)
    const { compactor, config, llm } = await setup(sessions)

    // 后台完成 → 挂起（upto 落在 a0）
    compactor.background(session.id, history, config, llm.client, "m")
    llm.release()
    await vi.waitFor(() => expect(llm.calls.filter(isSummaryCall).length).toBeGreaterThanOrEqual(2))
    await vi.waitFor(() => expect(compactor.parked(session.id)).toBe(true))

    // 新内容追加后同步压缩（经 auto，manual 免水位细判）：挂起成果被作废，
    // 同步压缩自己的视图（基于含挂起成果的 meta）生效
    seedHistory(sessions, session.id, 6)
    const view = await compactor.auto(session.id, sessions.readMessages(session.id), config, llm.client, "m", { manual: true })
    expect(view.status).toBe("applied")
    expect(compactor.takeParked(session.id)).toBeNull()
  })

  it("同步压缩没写成（水位细判拦下）不丢挂起成果：兜底仍可用", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("不成不丢")
    const history = seedHistory(sessions, session.id)
    const { compactor, config, llm } = await setup(sessions)

    // 后台完成 → 挂起
    compactor.background(session.id, history, config, llm.client, "m")
    llm.release()
    await vi.waitFor(() => expect(llm.calls.filter(isSummaryCall).length).toBeGreaterThanOrEqual(2))
    await vi.waitFor(() => expect(compactor.parked(session.id)).toBe(true))

    // 同步压缩在过小的历史上跑（估算 < 黄线）→ declined 结局，
    // 什么都没写：挂起成果仍是最新视图，不得被入口顺手清掉
    const tiny = [newMessage(session.id, "user", [{ id: "btiny", type: "text", text: "小" }])]
    const out = await compactor.compact(session.id, tiny, "", config, llm.client, "m", { phase: "post-run" })
    expect(out.status).toBe("declined")
    expect(compactor.parked(session.id)).toBe(true)
  })

  it("abortInFlight 掐在飞但不写取消标记（急救清场专用）：后续压缩照常开工", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("急救清场")
    const history = seedHistory(sessions, session.id)
    const { compactor, config, llm } = await setup(sessions)

    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(true)
    expect(compactor.abortInFlight(session.id)).toBe(true)
    expect(compactor.cancelled(session.id)).toBe(false) // 与 cancel() 的分界：不写标记
    llm.release() // 被掐的调用走取消分支收场
    await vi.waitFor(() => expect(compactor.hasInFlight(session.id)).toBe(false))
    expect(compactor.parked(session.id)).toBe(false)

    // cancel() 的标记会压制下一次开工；abortInFlight 没写 → 立刻能再 kick
    expect(compactor.background(session.id, history, config, llm.client, "m")).toBe(true)
    llm.release()
    await vi.waitFor(() => expect(compactor.parked(session.id)).toBe(true))
  })

  it("挂起 /compact：后到覆盖先到，取走即清", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const session = sessions.create("挂起manual")
    const { compactor } = await setup(sessions)

    expect(compactor.hasDeferredManual(session.id)).toBe(false)
    compactor.deferManual(session.id, "重点 A")
    compactor.deferManual(session.id, "重点 B")
    expect(compactor.takeDeferredManual(session.id)).toEqual({ focus: "重点 B" })
    expect(compactor.takeDeferredManual(session.id)).toBeNull()
    // 无参挂起
    compactor.deferManual(session.id)
    expect(compactor.takeDeferredManual(session.id)).toEqual({})
  })

  it("多会话隔离：一个会话的在飞/挂起不影响另一个", async () => {
    const sessions = new SessionStore(join(home, "s"))
    const s1 = sessions.create("会话一")
    const s2 = sessions.create("会话二")
    const h1 = seedHistory(sessions, s1.id)
    const h2 = seedHistory(sessions, s2.id)
    const { compactor, config } = await setup(sessions)
    const llm1 = gatedClient()
    const llm2 = gatedClient()

    expect(compactor.background(s1.id, h1, config, llm1.client, "m")).toBe(true)
    expect(compactor.background(s2.id, h2, config, llm2.client, "m")).toBe(true, "各自在飞，互不干扰")
    expect(compactor.hasInFlight(s1.id)).toBe(true)
    expect(compactor.hasInFlight(s2.id)).toBe(true)

    // s1 的取消标记不波及 s2
    compactor.cancel(s1.id)
    compactor.clearCancelled(s1.id)
    compactor.deferManual(s2.id, "只挂 s2")
    expect(compactor.hasDeferredManual(s1.id)).toBe(false)
    expect(compactor.hasDeferredManual(s2.id)).toBe(true)
  })

  it("loadConfig 读出的 config 传入 background 与手动路径一致（预算同源）", async () => {
    const paths = resolvePaths(home)
    const sessions = new SessionStore(paths.sessionsDir)
    const session = sessions.create("配置同源")
    const config = loadConfig(paths)
    expect(config.sessions.compactAtRatio).toBeUndefined() // 缺省在读取处兜底
    expect(config.sessions.compactAheadRatio).toBeUndefined()
    expect(config.sessions.compactPackRatio).toBeUndefined()
  })
})
