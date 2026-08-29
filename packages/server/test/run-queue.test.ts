/**
 * RunManager 显式队列语义测试（spec §3.2/§3.4/§4.1/§5.2-§5.5）：空闲直发、
 * wait FIFO 与预分配消息 id、meta.queue 镜像、上限拒绝、enqueue 兼容、
 * cancel 语义收窄（仅中止活动 run）与 interrupt 插队不吞消息。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore, defaultConfig, resolvePaths } from "@kclaw/core"
import type { LlmClient, LlmStreamEvent, RunOutcome, SessionMeta, ToolExecutor } from "@kclaw/core"
import { RunManager } from "../src/run.js"
import { EventBus } from "../src/bus.js"
import { endTurnLlm } from "./helpers/scripted-llm.js"
import { gateLlm, gateTool, makeGate } from "./helpers/gate.js"

let home: string
let sessions: SessionStore
let bus: EventBus
let manager: RunManager

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kclaw-runq-"))
  sessions = new SessionStore(join(home, "sessions"))
  bus = new EventBus()
  manager = new RunManager({
    config: structuredClone(defaultConfig), paths: resolvePaths(home), sessions,
    memory: { search: async () => [] } as never, bus, llm: endTurnLlm("ok"), workspace: "/w",
  })
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const eventsOf = (bus: EventBus, sessionId: string): string[] => {
  const out: string[] = []
  bus.subscribe(sessionId, { send: (d: string) => { const e = JSON.parse(d); if (e.sessionId === sessionId) out.push(e.type) } })
  return out
}

/** 基于 beforeEach 的装配重建 RunManager，仅覆盖 llm/tools（steer 相关用例统一用它）。 */
const managerWith = (over: { llm?: LlmClient; tools?: Map<string, ToolExecutor> }): RunManager =>
  new RunManager({
    config: structuredClone(defaultConfig), paths: resolvePaths(home), sessions,
    memory: { search: async () => [] } as never, bus,
    llm: over.llm ?? endTurnLlm("ok"),
    ...(over.tools !== undefined ? { tools: over.tools } : {}),
    workspace: "/w",
  })

describe("submit / driver", () => {
  it("idle session runs immediately: queued=false, no message.queued, standard wire order", async () => {
    const meta = sessions.create("t", undefined, "/w")
    const events = eventsOf(bus, meta.id)
    const r = manager.submit(meta.id, { userText: "hello", trigger: "user" })
    expect(r.queued).toBe(false)
    expect((await r.outcome).stopReason).toBe("end_turn")
    expect(events).not.toContain("message.queued")
    expect(events[0]).toBe("run.started")
  })

  it("wait enqueues FIFO while busy; each dequeued run uses the pre-allocated messageId", async () => {
    const meta = sessions.create("t", undefined, "/w")
    const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
    const a = manager.submit(meta.id, { userText: "second", trigger: "user", disposition: "wait" })
    const b = manager.submit(meta.id, { userText: "third", trigger: "user", disposition: "wait" })
    expect(a.queued).toBe(true)
    expect(a.disposition).toBe("wait")
    await first.outcome
    await a.outcome
    await b.outcome
    const lines = readFileSync(join(home, "sessions", meta.id, "messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    const users = lines
      .filter((m: { role: string }) => m.role === "user")
      .map((m: { id: string; blocks: Array<{ type: string; text?: string }> }) => ({ id: m.id, text: m.blocks.find((x) => x.type === "text")!.text }))
    expect(users.map((u: { text: string }) => u.text)).toEqual(["first", "second", "third"])
    expect(users[1]!.id).toBe(a.messageId)
    expect(users[2]!.id).toBe(b.messageId)
  })

  it("meta.queue mirrors the in-memory queue (persist on enqueue & dequeue)", async () => {
    const meta = sessions.create("t", undefined, "/w")
    const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
    manager.submit(meta.id, { userText: "q1", trigger: "user", disposition: "wait" })
    expect(sessions.meta(meta.id)!.queue).toHaveLength(1)
    await first.outcome
    // first 结束后 q1 立即被驱动器接管执行；再排两条验证持久化镜像与排空
    manager.submit(meta.id, { userText: "q2", trigger: "user", disposition: "wait" })
    manager.submit(meta.id, { userText: "q3", trigger: "user", disposition: "wait" })
    expect(sessions.meta(meta.id)!.queue!.map((e) => e.text)).toEqual(["q2", "q3"])
    const settle = async (): Promise<void> => {
      for (;;) {
        if ((sessions.meta(meta.id)!.queue ?? []).length === 0) return
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    await settle()
    expect(sessions.meta(meta.id)!.queue ?? []).toHaveLength(0)
  })

  it("queue cap 10 rejects with the spec message", async () => {
    const meta = sessions.create("t", undefined, "/w")
    // 收集全部 outcome 并在断言后排空：测试结束时不得有仍在写的 run，
    // 否则与 afterEach 的 rmSync 竞争（updateMeta 抛错 → 驱动循环未处理拒绝）。
    const outcomes: Promise<RunOutcome>[] = []
    outcomes.push(manager.submit(meta.id, { userText: "first", trigger: "user" }).outcome)
    for (let i = 0; i < 10; i++) {
      outcomes.push(manager.submit(meta.id, { userText: `q${i}`, trigger: "user", disposition: "wait" }).outcome)
    }
    expect(() => manager.submit(meta.id, { userText: "over", trigger: "user", disposition: "wait" }))
      .toThrow("队列已满（10 条）")
    await Promise.all(outcomes)
  })

  it("enqueue() compat resolves each outcome; sessions still serialize", async () => {
    const meta = sessions.create("t", undefined, "/w")
    const out = await Promise.all([
      manager.enqueue(meta.id, { userText: "a", trigger: "user" }),
      manager.enqueue(meta.id, { userText: "b", trigger: "user", disposition: "wait" }),
    ])
    expect(out.map((o) => o.stopReason)).toEqual(["end_turn", "end_turn"])
  })

  it("cancel() only aborts the ACTIVE run; queued entries survive (narrowed semantics)", async () => {
    const meta = sessions.create("t", undefined, "/w")
    const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
    const queued = manager.submit(meta.id, { userText: "q", trigger: "user", disposition: "wait" })
    expect(manager.cancel(meta.id)).toBe(true)
    expect((await first.outcome).stopReason).toBe("aborted")
    expect((await queued.outcome).stopReason).toBe("end_turn")
    expect(manager.cancel(meta.id)).toBe(false)
  })

  it("interrupt aborts the active run and jumps the queue head", async () => {
    const meta = sessions.create("t", undefined, "/w")
    // endTurnLlm 在微任务级跑完，10ms 内 first 早已结束——按用例前提
    // "first 已在跑"，这里换用门控客户端把 first 挂在第一次调用上。
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let calls = 0
    manager = new RunManager({
      config: structuredClone(defaultConfig), paths: resolvePaths(home), sessions,
      memory: { search: async () => [] } as never, bus,
      llm: {
        async *stream(): AsyncIterable<LlmStreamEvent> {
          if (++calls === 1) await gate // first 挂在门上，直到被中断
          yield { type: "text_delta", delta: "ok" }
          yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
        },
      },
      workspace: "/w",
    })
    const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
    await new Promise((r) => setTimeout(r, 10)) // first 已在跑
    const w = manager.submit(meta.id, { userText: "waiter", trigger: "user", disposition: "wait" })
    const it = manager.submit(meta.id, { userText: "cutter", trigger: "user", disposition: "interrupt" })
    expect(it.disposition).toBe("interrupt")
    expect((await first.outcome).stopReason).toBe("aborted")
    await it.outcome
    await w.outcome
    release() // 中断已解除流等待；放行门上的挂起生成器，避免悬挂
    const lines = readFileSync(join(home, "sessions", meta.id, "messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    const texts = lines.filter((m: { role: string }) => m.role === "user").map((m: { blocks: Array<{ text?: string }> }) => m.blocks[0]!.text)
    expect(texts).toEqual(["first", "cutter", "waiter"]) // 不吞已排队消息，只插队
  })

  it("driver survives a dequeue-phase persist crash: node rejects, no zombie, no unhandled rejection", async () => {
    // #drive 的出队阶段（#demoteSteer / 出队后的 #persistQueue）在 try 之外：
    // meta.json 写盘炸掉（会话被删、盘满）时，不允许会话永久停转（僵尸驱动器）
    // 也不允许循环 promise 裸拒绝——手头 node 以错误落定、残余条目原地保留、
    // 下一次 submit 重新起转（自愈）。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // 崩溃日志静音
    const rejections: unknown[] = []
    const onRejection = (err: unknown): void => { rejections.push(err) }
    process.on("unhandledRejection", onRejection)
    const meta = sessions.create("t", undefined, "/w")
    // 只在 w1 的出队持久化（shift 后 meta.queue 恰为 [w2]）这一次炸掉 updateMeta
    const originalUpdate = sessions.updateMeta.bind(sessions)
    sessions.updateMeta = (id: string, patch: Partial<SessionMeta>): SessionMeta => {
      if (id === meta.id && patch.queue?.length === 1 && patch.queue[0]!.text === "w2") {
        throw new Error("meta 写盘失败")
      }
      return originalUpdate(id, patch)
    }

    try {
      const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
      const w1 = manager.submit(meta.id, { userText: "w1", trigger: "user", disposition: "wait" })
      const w2 = manager.submit(meta.id, { userText: "w2", trigger: "user", disposition: "wait" })

      // first 落定触发驱动器出队 w1 → 出队持久化炸掉：w1 的 outcome 以该错误拒绝
      await expect(w1.outcome).rejects.toThrow("meta 写盘失败")
      expect((await first.outcome).stopReason).toBe("end_turn")

      // 崩溃后无僵尸：恢复 updateMeta，下一次 submit 重新起转并消费残余队列
      sessions.updateMeta = originalUpdate
      const w3 = manager.submit(meta.id, { userText: "w3", trigger: "user", disposition: "wait" })
      expect((await w2.outcome).stopReason).toBe("end_turn") // 残余条目仍被执行
      expect((await w3.outcome).stopReason).toBe("end_turn")
      const lines = readFileSync(join(home, "sessions", meta.id, "messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      const texts = lines.filter((m: { role: string }) => m.role === "user").map((m: { blocks: Array<{ text?: string }> }) => m.blocks[0]!.text)
      expect(texts).toEqual(["first", "w2", "w3"]) // w1 出队即失败，从未执行

      await new Promise((r) => setTimeout(r, 50)) // 让任何未处理拒绝浮出
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
      errorSpy.mockRestore()
    }
  })
})

describe("steer", () => {
  it("injects at the iteration boundary with created+steered and the same id", async () => {
    const gate = makeGate()
    const mgr = managerWith({ llm: gateLlm(gate, true), tools: new Map([["gate", gateTool(gate)]]) })
    const meta = sessions.create("t", undefined, "/w")
    const run = mgr.submit(meta.id, { userText: "start", trigger: "user" })
    await gate.toolEntered
    const s = mgr.submit(meta.id, { userText: "转向：改用方案 B", trigger: "user", disposition: "steer" })
    expect(s.queued).toBe(true)
    expect(s.disposition).toBe("steer")
    gate.releaseTool()
    gate.releaseLlm()
    expect((await run.outcome).stopReason).toBe("end_turn")
    const lines = readFileSync(join(home, "sessions", meta.id, "messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    const injected = lines.find((m: { id: string }) => m.id === s.messageId)
    expect(injected.blocks[0].text).toBe("转向：改用方案 B")
  })

  it("residual steer demotes to wait at run end (original order, executes after)", async () => {
    const gate = makeGate()
    const mgr = managerWith({ llm: gateLlm(gate, false), tools: new Map([["gate", gateTool(gate)]]) })
    const meta = sessions.create("t", undefined, "/w")
    const run = mgr.submit(meta.id, { userText: "start", trigger: "user" })
    await gate.toolEntered
    const s1 = mgr.submit(meta.id, { userText: "s1", trigger: "user", disposition: "steer" })
    const s2 = mgr.submit(meta.id, { userText: "s2", trigger: "user", disposition: "steer" })
    // run 在取走缓冲区之前结束：abort → 残余降级 wait、按原顺序并入队尾（spec §3.4）
    mgr.cancel(meta.id)
    gate.releaseTool()
    await run.outcome
    await s1.outcome
    await s2.outcome
    const lines = readFileSync(join(home, "sessions", meta.id, "messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    const texts = lines.filter((m: { role: string }) => m.role === "user").flatMap((m: { blocks: Array<{ type: string; text?: string }> }) => m.blocks.filter((b) => b.type === "text").map((b) => b.text!))
    expect(texts).toEqual(["start", "s1", "s2"])
  })
})

describe("queueCancel", () => {
  it("cancels a wait entry before dequeue (no JSONL residue, event broadcast)", async () => {
    const meta = sessions.create("t", undefined, "/w")
    const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
    const q = manager.submit(meta.id, { userText: "q", trigger: "user", disposition: "wait" })
    const seen: unknown[] = []
    bus.subscribe(meta.id, { send: (d: string) => seen.push(JSON.parse(d)) })
    expect(manager.queueCancel(meta.id, q.messageId)).toEqual({ ok: true, cancelled: [q.messageId] })
    await first.outcome
    expect(sessions.meta(meta.id)!.queue ?? []).toHaveLength(0)
    expect(seen.some((e) => (e as { type: string }).type === "message.queue_cancelled")).toBe(true)
  })

  it("cancels a steer entry before injection; after injection answers injected", async () => {
    const gate = makeGate()
    let mgr = managerWith({ llm: gateLlm(gate, true), tools: new Map([["gate", gateTool(gate)]]) })
    const meta = sessions.create("t", undefined, "/w")
    const run = mgr.submit(meta.id, { userText: "start", trigger: "user" })
    await gate.toolEntered
    const s = mgr.submit(meta.id, { userText: "s", trigger: "user", disposition: "steer" })
    expect(mgr.queueCancel(meta.id, s.messageId)).toEqual({ ok: true, cancelled: [s.messageId] })
    gate.releaseTool()
    gate.releaseLlm()
    await run.outcome
    const all = readFileSync(join(home, "sessions", meta.id, "messages.jsonl"), "utf8")
    expect(all.includes(`"id":"${s.messageId}"`)).toBe(false) // 注入前撤回：不进 JSONL
    // 已注入场景：前半段已耗尽脚本客户端的调用计数（第 3 次调用直接 end_turn、
    // 不再有工具批次，边界 drain 无从发生），换一套新门闩让 run2 真正走一轮
    // 工具批次，drain 才会取走 s2 并登记 #injectedIds（登记随实例，须同一 mgr 应答）。
    const gate2 = makeGate()
    mgr = managerWith({ llm: gateLlm(gate2, true), tools: new Map([["gate", gateTool(gate2)]]) })
    const run2 = mgr.submit(meta.id, { userText: "start2", trigger: "user" })
    await gate2.toolEntered
    const s2 = mgr.submit(meta.id, { userText: "s2", trigger: "user", disposition: "steer" })
    gate2.releaseTool()
    gate2.releaseLlm()
    await run2.outcome
    expect(mgr.queueCancel(meta.id, s2.messageId)).toEqual({ ok: false, reason: "injected" })
  })

  it("cancel-all clears wait + pending steer, broadcasts all:true", async () => {
    const gate = makeGate()
    const mgr = managerWith({ llm: gateLlm(gate, false), tools: new Map([["gate", gateTool(gate)]]) })
    const meta = sessions.create("t", undefined, "/w")
    const run = mgr.submit(meta.id, { userText: "start", trigger: "user" })
    await gate.toolEntered
    const s = mgr.submit(meta.id, { userText: "s", trigger: "user", disposition: "steer" })
    const w = mgr.submit(meta.id, { userText: "w", trigger: "user", disposition: "wait" })
    const res = mgr.queueCancel(meta.id)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.cancelled).toEqual(expect.arrayContaining([s.messageId, w.messageId]))
    mgr.cancel(meta.id)
    gate.releaseTool()
    await run.outcome
    expect(sessions.meta(meta.id)!.queue ?? []).toHaveLength(0)
  })

  it("unknown id answers not_found", () => {
    const meta = sessions.create("t", undefined, "/w")
    expect(manager.queueCancel(meta.id, "msg_nope")).toEqual({ ok: false, reason: "not_found" })
  })
})
