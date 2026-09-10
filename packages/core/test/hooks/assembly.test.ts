/**
 * executeRun 与钩子系统的端到端：内置链照常工作、extraHooks /
 * HookRegistry 的用户条目在同一链上生效、fail-open 失败发 hook.failed 且不伤 run。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { executeRun, type RunEngine } from "../../src/agent/run-assembly.js"
import { runAgent } from "../../src/agent/loop.js"
import { EventBus } from "../../src/bus.js"
import type { AgentEvent } from "../../src/protocol/events.js"
import { SessionStore } from "../../src/session/store.js"
import { Compactor } from "../../src/session/compactor.js"
import { newMessage } from "../../src/protocol/messages.js"
import { MemorySystem } from "../../src/memory/system.js"
import { ConfirmationBroker } from "../../src/permissions/broker.js"
import { HookRegistry } from "../../src/hooks/registry.js"
import { loadConfig, resolvePaths } from "../../src/storage/index.js"
import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"
import type { HookEntry } from "../../src/hooks/types.js"
import { chainOf, hook } from "../agent/hook-utils.js"

let home: string
let workspace: string

beforeEach(() => {
  home = join(tmpdir(), `kclaw-hookrun-home-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  workspace = join(tmpdir(), `kclaw-hookrun-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

/** 记录事件的 bus（executeRun 的 busEmit 全走这里）。 */
class RecordingBus extends EventBus {
  readonly events: AgentEvent[] = []
  override emit(e: AgentEvent): void {
    this.events.push(e)
    super.emit(e)
  }
}

function scriptClient(): LlmClient {
  const events: LlmStreamEvent[] = [
    { type: "text_delta", delta: "done" },
    { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } },
  ]
  return { async *stream(req): AsyncIterable<LlmStreamEvent> { lastRequest = req; yield* events } }
}
let lastRequest: { messages: Array<{ role: string; content: unknown }> } | undefined

function makeEngine(overrides: Partial<RunEngine["deps"]> = {}, extra: Partial<RunEngine> = {}): {
  engine: RunEngine
  bus: RecordingBus
  sessions: SessionStore
  sessionId: string
} {
  const paths = resolvePaths(home)
  const config = loadConfig(paths)
  const sessions = new SessionStore(paths.sessionsDir)
  const bus = new RecordingBus()
  const memory = new MemorySystem({
    memoryDir: paths.memoryDir,
    sessions,
    config,
    resolveLlm: () => ({ llm: scriptClient(), model: "test-model" }),
  })
  const sessionId = sessions.create("钩子端到端").id
  const engine: RunEngine = {
    deps: {
      config,
      paths,
      sessions,
      memory,
      bus,
      llm: scriptClient(),
      model: "test-model",
      workspace,
      broker: new ConfirmationBroker(),
      ...overrides,
    },
    compactor: new Compactor({ sessions, emit: (e) => bus.emit(e) }),
    ...extra,
  }
  return { engine, bus, sessions, sessionId }
}

function handoff(sessionId: string, userText = "你好") {
  return {
    sessionId,
    input: { userText, trigger: "user" as const },
    controller: new AbortController(),
    drainSteer: () => [],
  }
}

describe("executeRun × hook system", () => {
  it("内置链照常工作：消息落盘、run 完成、系统提示词审计留痕", async () => {
    const { engine, bus, sessions, sessionId } = makeEngine()
    const outcome = await executeRun(engine, handoff(sessionId))
    expect(outcome.stopReason).toBe("end_turn")

    const types = bus.events.map((e) => e.type)
    expect(types[0]).toBe("run.started")
    expect(types).toContain("message.created")
    expect(types).toContain("message.completed")
    expect(types).toContain("llm.started")
    expect(types.at(-1)).toBe("run.completed")

    const persisted = sessions.readMessages(sessionId)
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant"])

    // system-audit（system-after，fatal）：一份全量系统提示词事件
    const systemEvents = sessions.readEvents(sessionId).filter((e) => e.type === "system")
    expect(systemEvents).toHaveLength(1)
    expect((systemEvents[0] as { text: string }).text.length).toBeGreaterThan(0)
  })

  it("提示词缓存纪律：基线冻结后链路跳过、前缀稳定；压缩清除后重新装配并再次固化", async () => {
    const requests: string[] = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req.system)
        yield { type: "text_delta", delta: "done" }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } }
      },
    }
    const segmentRuns: number[] = []
    const extra: HookEntry[] = [
      hook("drift-segment", "system-before", () => {
        segmentRuns.push(1)
        return ["【漂移段】"]
      }, { failure: "skip" }),
    ]
    const { engine, sessions, sessionId } = makeEngine({ llm, extraHooks: extra })
    writeFileSync(engine.deps.paths.agentsMd, "v1 人设")

    // run 1：无基线 → 全链装配；审计落盘即固化基线
    await executeRun(engine, handoff(sessionId))
    expect(requests[0]).toContain("v1 人设")
    expect(requests[0]).toContain("【漂移段】")
    expect(sessions.meta(sessionId)!.systemBaseline?.text).toBe(requests[0])
    expect(sessions.readEvents(sessionId).filter((e) => e.type === "system")).toHaveLength(1)

    // 漂移源变化（AGENTS.md 改写）；run 2 走冻结基线：请求前缀逐字节不变、组装链不跑
    writeFileSync(engine.deps.paths.agentsMd, "v2 人设")
    await executeRun(engine, handoff(sessionId, "第二条"))
    expect(requests[1]).toBe(requests[0])
    expect(segmentRuns).toHaveLength(1)
    const audits = sessions.readEvents(sessionId).filter((e) => e.type === "system")
    expect(audits).toHaveLength(2)
    expect((audits[1] as { text: string }).text).toBe(requests[0]) // 审计=模型实际视图

    // 压缩清除基线（重冻结边界）；run 3 重新装配，漂移源的新内容生效并再次固化
    sessions.appendCompaction(sessionId, { at: new Date().toISOString(), trigger: "auto", from: null, upto: "m1", messages: 1, segmentSummary: "s", top: "t" })
    expect(sessions.meta(sessionId)!.systemBaseline).toBeUndefined()
    await executeRun(engine, handoff(sessionId, "压缩后第一条"))
    expect(requests[2]).toContain("v2 人设")
    expect(requests[2]).not.toContain("v1 人设")
    expect(segmentRuns).toHaveLength(2)
    expect(sessions.meta(sessionId)!.systemBaseline?.text).toBe(requests[2])
    expect(sessions.readEvents(sessionId).filter((e) => e.type === "system")).toHaveLength(3)
  })

  it("extraHooks 在链上生效：system-before 段落进系统提示词、llm-before 改写只动模型视图", async () => {
    const extra: HookEntry[] = [
      hook("test-segment", "system-before", () => ["【测试段落】"]),
      hook("test-rewrite", "llm-before", (ctx) => {
        const last = ctx.messages[ctx.messages.length - 1]!
        return [...ctx.messages.slice(0, -1), { ...last, content: `${String(last.content)}【已包装】` }]
      }),
    ]
    const { engine, bus, sessions, sessionId } = makeEngine({ extraHooks: extra })
    const outcome = await executeRun(engine, handoff(sessionId))
    expect(outcome.stopReason).toBe("end_turn")

    const systemEvents = sessions.readEvents(sessionId).filter((e) => e.type === "system")
    expect(systemEvents).toHaveLength(1)
    expect((systemEvents[0] as { text: string }).text).toContain("【测试段落】")

    // 模型视图被改写；持久化的用户消息保持原文
    expect(String(lastRequest!.messages.at(-1)!.content)).toContain("【已包装】")
    expect(sessions.readMessages(sessionId)[0]!.blocks[0]).toMatchObject({ type: "text", text: "你好" })
    expect(bus.events.some((e) => e.type === "hook.failed")).toBe(false)
  })

  it("skip 钩子抛错：run 照常完成，hook.failed 经 bus 可见（phase run）", async () => {
    const extra: HookEntry[] = [
      hook("broken-observer", "run-before", () => { throw new Error("observer boom") }, { failure: "skip", order: 5 }),
    ]
    const { engine, bus, sessionId } = makeEngine({ extraHooks: extra })
    const outcome = await executeRun(engine, handoff(sessionId))
    expect(outcome.stopReason).toBe("end_turn")
    const failed = bus.events.find((e) => e.type === "hook.failed")
    expect(failed).toBeDefined()
    expect(failed!.payload).toMatchObject({
      hook: "broken-observer", position: "run-before", error: "observer boom", phase: "run",
    })
    expect(failed!.sessionId).toBe(sessionId)
  })

  it("HookRegistry 的用户文件钩子进入 run 链：refresh 后段落生效", async () => {
    const userHooksDir = join(home, "hooks")
    mkdirSync(userHooksDir, { recursive: true })
    writeFileSync(join(userHooksDir, "my-segment.js"), [
      'export const hook = { position: "system-before", description: "用户段落" }',
      'export default () => ["【用户文件段落】"]',
    ].join("\n"))
    const registry = new HookRegistry({ userDir: userHooksDir })
    const { engine, bus, sessions, sessionId } = makeEngine({ hooks: registry })
    const outcome = await executeRun(engine, handoff(sessionId))
    expect(outcome.stopReason).toBe("end_turn")
    const systemEvents = sessions.readEvents(sessionId).filter((e) => e.type === "system")
    expect((systemEvents[0] as { text: string }).text).toContain("【用户文件段落】")
    expect(bus.events.some((e) => e.type === "hook.failed")).toBe(false)
  })

  it("run-after 链在 runAgent 返回后串行执行（内置 + 注入共用）", async () => {
    const order: string[] = []
    const extra: HookEntry[] = [
      hook("after-watcher", "run-after", () => { order.push("watcher") }, { failure: "skip", order: 15 }),
    ]
    const { engine, sessionId } = makeEngine({ extraHooks: extra })
    const outcome = await executeRun(engine, handoff(sessionId))
    expect(outcome.stopReason).toBe("end_turn")
    // 内置 usage-ledger(10) → 注入 watcher(15) → post-run-compaction(20)
    expect(order).toEqual(["watcher"])
  })

  it("收尾压缩慢于钩子预算：压缩钩子不限时，完整落地且 run 正常完成", async () => {
    // 回归背景（2026-09-09 线上）：迁移把内联压缩放进 5s 钩子竞速，真实压缩
    // （两次 LLM 调用）必超时——mid-run 甩出后台重复压缩，post-run（fatal）
    // 把已完成 run 拖成条目级失败。这里用 50ms 钩子预算 + 80ms/次的 LLM 复现。
    const base = loadConfig(resolvePaths(home))
    const cfg = {
      ...base,
      sessions: { ...base.sessions, contextTokens: 1500 },
      hooks: { timeoutMs: 50 },
    }
    const llm: LlmClient = {
      async *stream(): AsyncIterable<LlmStreamEvent> {
        await new Promise((resolve) => setTimeout(resolve, 80))
        yield { type: "text_delta", delta: "x".repeat(2000) }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 999_000, outputTokens: 1 } }
      },
    }
    const { engine, bus, sessions, sessionId } = makeEngine({ llm, config: cfg })
    // 预置一条早先的用户消息：给 chooseBoundary 留出可压的分界（单轮切不出）
    const seed = newMessage(sessionId, "user", [{ id: "b-seed", type: "text", text: "x".repeat(2000) }])
    sessions.appendMessage(sessionId, seed)

    const outcome = await executeRun(engine, handoff(sessionId, "x".repeat(2000)))
    expect(outcome.stopReason).toBe("end_turn")
    // 压缩真的发生且成对收尾：started(post-run) → completed(ok)，持久化恰一条
    expect(bus.events.some((e) => e.type === "compaction.started" && e.payload.phase === "post-run")).toBe(true)
    const completed = bus.events.find((e) => e.type === "compaction.completed")
    expect(completed!.payload).toMatchObject({ phase: "post-run", result: "ok" })
    expect(sessions.readEvents(sessionId).filter((e) => e.type === "compaction")).toHaveLength(1)
    expect(sessions.meta(sessionId)?.compaction).toBeDefined()
    // 无任何钩子失败（修复前这里是 fatal timeout：executeRun 直接拒绝）
    expect(bus.events.some((e) => e.type === "hook.failed")).toBe(false)
  })

  it("模型条目的 contextWindow 收紧压缩线、maxOutput 随请求下发", async () => {
    // 预算取 min(会话上限, 模型窗口)：窗口 1000 → 黄线 800。回复锚点 900 在
    // 默认 128k 预算下永远不会触发压缩，但被窗口压过线——压缩必须发生，
    // 且 maxOutput 以 max_tokens 形式出现在发给供应商的请求里。
    const base = loadConfig(resolvePaths(home))
    const cfg = {
      ...base,
      providers: {
        ...base.providers,
        default: "m",
        entries: { m: { baseUrl: "http://x", apiKey: "k", model: "m1", contextWindow: 1000, maxOutput: 111 } },
      },
    }
    const requests: Array<{ maxTokens?: number }> = []
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        requests.push(req)
        yield { type: "text_delta", delta: "x".repeat(2000) }
        yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 1 } }
      },
    }
    const { engine, bus, sessions, sessionId } = makeEngine({ llm, config: cfg })
    // 预置一条早先的用户消息：给 chooseBoundary 留出可压的分界（单轮切不出）
    const seed = newMessage(sessionId, "user", [{ id: "b-seed", type: "text", text: "x".repeat(2000) }])
    sessions.appendMessage(sessionId, seed)

    const outcome = await executeRun(engine, handoff(sessionId, "x".repeat(2000)))
    expect(outcome.stopReason).toBe("end_turn")
    expect(bus.events.some((e) => e.type === "compaction.started" && e.payload.phase === "post-run")).toBe(true)
    expect(sessions.meta(sessionId)?.compaction).toBeDefined()
    // 主 run 的请求带 max_tokens；压缩摘要请求（两次 LLM 调用）不携带
    expect(requests.filter((r) => r.maxTokens === 111).length).toBeGreaterThanOrEqual(1)
    expect(requests.some((r) => r.maxTokens === undefined)).toBe(true)
  })
})

/** 防止 runAgent import 被裁掉的类型引用（loop 语义测试在 agent/ 目录）。 */
describe("executeRun × v4 水位线", () => {
  /** 预置 N 轮历史（每轮 user+assistant，文本可区分），给 chooseBoundary 留出分界。 */
  function seedTurns(sessions: InstanceType<typeof SessionStore>, sessionId: string, turns: number): void {
    for (let i = 0; i < turns; i++) {
      const u = newMessage(sessionId, "user", [{ id: `b-su${i}`, type: "text", text: `历史问题${i}，`.repeat(30) }])
      u.id = `su${i}`
      sessions.appendMessage(sessionId, u)
      const a = newMessage(sessionId, "assistant", [{ id: `b-sa${i}`, type: "text", text: `历史回答${i}，`.repeat(30) }])
      a.id = `sa${i}`
      sessions.appendMessage(sessionId, a)
    }
  }

  /**
   * 主请求按脚本走（tool_use ×mainTurns → end_turn）；摘要请求吐固定摘要并
   * 记录。`holdTurn` 在第 N 轮主请求的流末尾（message_done 之前）挂起——
   * 测试借这个停顿在"下一个迭代边界到来之前"完成外部编排（放行摘要 gate）。
   */
  function waterlineLlm(opts: {
    mainTurns: number
    anchor?: number
    summaryGate?: Promise<void>
    holdTurn?: number
    holdPromise?: Promise<void>
  }) {
    const mainRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    const summaryRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    let mainCalls = 0
    const anchor = opts.anchor ?? 780
    const llm: LlmClient = {
      async *stream(req): AsyncIterable<LlmStreamEvent> {
        if (typeof req.system === "string" && req.system.startsWith("你是对话摘要")) {
          summaryRequests.push(req as never)
          if (opts.summaryGate !== undefined) await opts.summaryGate
          yield { type: "text_delta", delta: "后台段摘要" }
          yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }
          return
        }
        mainCalls += 1
        mainRequests.push(req as never)
        if (mainCalls <= opts.mainTurns) {
          yield { type: "tool_call_started", index: 0, callId: `c${mainCalls}`, name: "noop" }
          yield { type: "tool_call_delta", index: 0, delta: "{}" }
          if (opts.holdTurn !== undefined && mainCalls === opts.holdTurn && opts.holdPromise !== undefined) {
            await opts.holdPromise
          }
          yield { type: "message_done", stopReason: "tool_use", usage: { inputTokens: anchor, outputTokens: 1 } }
        } else {
          yield { type: "text_delta", delta: "done" }
          yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: anchor, outputTokens: 1 } }
        }
      },
    }
    return { llm, mainRequests, summaryRequests }
  }

  it("预压线触发后台压缩：同一 run 的后续迭代边界应用挂起成果", async () => {
    // 锚点 780 / 预算 1000 → 水位 0.78 ∈ [0.75 预压, 0.90 红线)：边界 1 kick
    // 后台；测试放行摘要后，边界 2 应用挂起视图——第三次请求应垫总摘要。
    const base = loadConfig(resolvePaths(home))
    const cfg = { ...base, sessions: { ...base.sessions, contextTokens: 1000 } }
    const summaryGate = Promise.withResolvers<void>()
    const holdTurn = Promise.withResolvers<void>()
    const { llm, mainRequests, summaryRequests } = waterlineLlm({
      mainTurns: 2, summaryGate: summaryGate.promise, holdTurn: 2, holdPromise: holdTurn.promise,
    })
    const { engine, bus, sessions, sessionId } = makeEngine({ llm, config: cfg })
    seedTurns(sessions, sessionId, 3)

    const run = executeRun(engine, handoff(sessionId, "x".repeat(500)))
    // 边界 1 已 kick 后台（摘要卡在 gate）：放行它，等后台完成写元数据，
    // 再放行被扣住的第 2 轮流——边界 2 应用挂起成果
    await vi.waitFor(() => expect(summaryRequests.length).toBe(1))
    summaryGate.resolve()
    await vi.waitFor(() => expect(bus.events.some((e) => e.type === "compaction.completed")).toBe(true))
    holdTurn.resolve()
    const outcome = await run
    expect(outcome.stopReason).toBe("end_turn")

    // 后台压缩写入元数据（审计恰一条）
    expect(sessions.readEvents(sessionId).filter((e) => e.type === "compaction")).toHaveLength(1)
    expect(sessions.meta(sessionId)?.compaction).toBeDefined()

    // 第三次主请求（边界 2 之后）：垫上压缩摘要、upto 前原文消失
    const third = mainRequests[2]!
    expect(String(third.messages[0]!.content)).toContain("<compacted-summary>")
    expect(String(third.messages[0]!.content)).toContain("后台段摘要")
    expect(JSON.stringify(third.messages)).not.toContain("历史问题0")
  })

  it("水位达红线时不预压：红线同步压缩兜底（请求 2 即带摘要）", async () => {
    // 锚点 950 / 预算 1000 → 水位 0.95 ≥ 红线：precompact 让位，mid-run-panic 同步压
    const base = loadConfig(resolvePaths(home))
    const cfg = { ...base, sessions: { ...base.sessions, contextTokens: 1000 } }
    const { llm, mainRequests } = waterlineLlm({ mainTurns: 1, anchor: 950 })
    const { engine, bus, sessions, sessionId } = makeEngine({ llm, config: cfg })
    seedTurns(sessions, sessionId, 3)

    const outcome = await executeRun(engine, handoff(sessionId, "x".repeat(500)))
    expect(outcome.stopReason).toBe("end_turn")
    // 同步压缩发生且紧随边界：第二次主请求已带摘要（不等下一次边界）
    const second = mainRequests[1]!
    expect(String(second.messages[0]!.content)).toContain("<compacted-summary>")
    expect(bus.events.some((e) => e.type === "compaction.started" && e.payload.phase === "in-run")).toBe(true)
  })

  it("挂起的 /compact 在收尾链冲刷：自动收尾压缩之前执行", async () => {
    // 预算 400 → 手动边界切得出（尾部 126 < 目标 132）；锚点 780 过黄线但
    // flush 先执行、压完水位落回，post-run 判断自然不重复压
    const base = loadConfig(resolvePaths(home))
    const cfg = { ...base, sessions: { ...base.sessions, contextTokens: 400 } }
    const { llm, mainRequests, summaryRequests } = waterlineLlm({ mainTurns: 0 })
    const { engine, bus, sessions, sessionId } = makeEngine({ llm, config: cfg })
    seedTurns(sessions, sessionId, 3)
    engine.compactor.deferManual(sessionId, "重点保留登录模块")

    const outcome = await executeRun(engine, handoff(sessionId, "x".repeat(500)))
    expect(outcome.stopReason).toBe("end_turn")

    // 挂起压缩执行：审计 trigger "manual" 带 focus；主 run 结束后发生
    const records = sessions.readEvents(sessionId).filter((e) => e.type === "compaction")
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ trigger: "manual", focus: "重点保留登录模块" })
    // 收尾链在 run 完成事件之后（run-after 语义）
    const completedIdx = bus.events.findIndex((e) => e.type === "compaction.completed")
    expect(completedIdx).toBeGreaterThan(bus.events.findIndex((e) => e.type === "run.completed"))
    expect(summaryRequests.length).toBe(2)
    expect(mainRequests.length).toBe(1)
  })
})

describe("loop re-export sanity", () => {
  it("runAgent 与 executeRun 同源可用", () => {
    expect(typeof runAgent).toBe("function")
    expect(typeof executeRun).toBe("function")
    expect(typeof chainOf).toBe("function")
  })
})
