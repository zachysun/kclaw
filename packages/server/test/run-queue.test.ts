/**
 * RunManager 显式队列语义测试（spec §3.2/§3.4/§4.1/§5.2-§5.5）：空闲直发、
 * wait FIFO 与预分配消息 id、queue.jsonl 镜像、上限拒绝、enqueue 兼容、
 * cancel 语义收窄（仅中止活动 run）、interrupt 插队不吞消息、出队失败自愈
 * （条目退回重试不无声消失）与条目级失败可见性（queue_entry_failed）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore, defaultConfig, resolvePaths } from "@kclaw/core"
import type { LlmClient, LlmStreamEvent, QueueEntry, RunOutcome, ToolExecutor } from "@kclaw/core"
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
    const lines = sessions.readMessages(meta.id)
    const users = lines
      .filter((m: { role: string }) => m.role === "user")
      .map((m: { id: string; blocks: Array<{ type: string; text?: string }> }) => ({ id: m.id, text: m.blocks.find((x) => x.type === "text")!.text }))
    expect(users.map((u: { text: string }) => u.text)).toEqual(["first", "second", "third"])
    expect(users[1]!.id).toBe(a.messageId)
    expect(users[2]!.id).toBe(b.messageId)
  })

  it("queue.jsonl mirrors the in-memory queue (persist on enqueue & dequeue)", async () => {
    const meta = sessions.create("t", undefined, "/w")
    const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
    manager.submit(meta.id, { userText: "q1", trigger: "user", disposition: "wait" })
    expect(sessions.readQueue(meta.id)).toHaveLength(1)
    await first.outcome
    // first 结束后 q1 立即被驱动器接管执行；再排两条验证持久化镜像与排空
    manager.submit(meta.id, { userText: "q2", trigger: "user", disposition: "wait" })
    manager.submit(meta.id, { userText: "q3", trigger: "user", disposition: "wait" })
    expect(sessions.readQueue(meta.id).map((e) => e.text)).toEqual(["q2", "q3"])
    const settle = async (): Promise<void> => {
      for (;;) {
        if (sessions.readQueue(meta.id).length === 0) return
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    await settle()
    expect(sessions.readQueue(meta.id)).toHaveLength(0)
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
    const lines = sessions.readMessages(meta.id)
    const texts = lines.filter((m: { role: string }) => m.role === "user").map((m: { blocks: Array<{ text?: string }> }) => m.blocks[0]!.text)
    expect(texts).toEqual(["first", "cutter", "waiter"]) // 不吞已排队消息，只插队
  })

  it("driver survives a dequeue-phase persist crash: node rejects, entry returns to the queue (no silent drop), no zombie", async () => {
    // #drive 的出队阶段（#demoteSteer / 出队后的 #persistQueue）在 try 之外：
    // meta.json 写盘炸掉（会话被删、盘满）时，不允许会话永久停转（僵尸驱动器）
    // 也不允许循环 promise 裸拒绝。手头 node 以错误落定并塞回队首——persist 抛错
    // 意味着 queue.jsonl 也没写成，塞回后内存与盘上重新一致；此后任何一次成功的
    // 持久化都不得把崩溃条目从 queue.jsonl 无声抹掉，条目由重启的驱动器重试执行。
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {}) // 崩溃日志静音
    const rejections: unknown[] = []
    const onRejection = (err: unknown): void => { rejections.push(err) }
    process.on("unhandledRejection", onRejection)
    const meta = sessions.create("t", undefined, "/w")
    const events: Array<{ type: string; payload: { error?: { code?: string; message?: string } } }> = []
    bus.subscribe(meta.id, { send: (d: string) => { const e = JSON.parse(d); if (e.sessionId === meta.id) events.push(e) } })
    // 只在 w1 的出队持久化（shift 后 queue 恰为 [w2]）这一次炸掉 replaceQueue
    const originalReplace = sessions.replaceQueue.bind(sessions)
    sessions.replaceQueue = (id: string, entries: QueueEntry[]): void => {
      if (id === meta.id && entries.length === 1 && entries[0]!.text === "w2") {
        throw new Error("queue 写盘失败")
      }
      return originalReplace(id, entries)
    }

    try {
      const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
      const w1 = manager.submit(meta.id, { userText: "w1", trigger: "user", disposition: "wait" })
      const w2 = manager.submit(meta.id, { userText: "w2", trigger: "user", disposition: "wait" })

      // first 落定触发驱动器出队 w1 → 出队持久化炸掉：w1 的 outcome 以该错误拒绝
      await expect(w1.outcome).rejects.toThrow("queue 写盘失败")
      expect((await first.outcome).stopReason).toBe("end_turn")

      // 失败可见性（fix A）：bus 上出现条目级失败事件，message 带 messageId
      const failed = events.find((e) => e.type === "run.failed" && e.payload.error?.code === "queue_entry_failed")
      expect(failed).toBeDefined()
      expect(failed!.payload.error?.message).toContain(w1.messageId)

      // 崩溃后 queue.jsonl 仍含崩溃条目（persist 没写成，盘上未动）
      expect(sessions.readQueue(meta.id).map((e) => e.text)).toEqual(["w1", "w2"])

      // 恢复 replaceQueue，下一次 submit 重新起转：驱动器同步首拍立即重新出队 w1
      // 重试（这次 persist 成功）——崩溃条目被"重试处理"而不是被无声抹掉
      sessions.replaceQueue = originalReplace
      const w3 = manager.submit(meta.id, { userText: "w3", trigger: "user", disposition: "wait" })
      expect(sessions.readQueue(meta.id).map((e) => e.text)).toEqual(["w2", "w3"]) // w1 已重新出队重试

      // 塞回队首的 w1 由重启的驱动器重试执行（等待方已见过拒绝，事件流照常）
      expect((await w2.outcome).stopReason).toBe("end_turn")
      expect((await w3.outcome).stopReason).toBe("end_turn")
      const lines = sessions.readMessages(meta.id)
      const texts = lines.filter((m: { role: string }) => m.role === "user").map((m: { blocks: Array<{ text?: string }> }) => m.blocks[0]!.text)
      expect(texts).toEqual(["first", "w1", "w2", "w3"])
      expect(sessions.readQueue(meta.id)).toHaveLength(0)

      await new Promise((r) => setTimeout(r, 50)) // 让任何未处理拒绝浮出
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
      errorSpy.mockRestore()
    }
  })

  it("execution failure of a dequeued entry (bad attachment) emits queue_entry_failed visibility", async () => {
    // 同族统一（fix A ③）：降级/排队的坏附件条目在 #execute 装配段同步抛出，
    // 走 node.reject——循环自己的 run.failed 兜不住，补发条目级失败事件；
    // 驱动器不停转，后续队列照常消化。
    const meta = sessions.create("t", undefined, "/w")
    const events: Array<{ type: string; payload: { error?: { code?: string; message?: string } } }> = []
    bus.subscribe(meta.id, { send: (d: string) => { const e = JSON.parse(d); if (e.sessionId === meta.id) events.push(e) } })
    const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
    const bad = manager.submit(meta.id, {
      userText: "坏附件", trigger: "user", disposition: "wait",
      attachments: [{ path: "/etc/hosts", name: "hosts", size: 1, mimeType: "text/plain" }],
    })
    await first.outcome
    await expect(bad.outcome).rejects.toThrow(/attachment outside/)
    const failed = events.find((e) => e.type === "run.failed" && e.payload.error?.code === "queue_entry_failed")
    expect(failed).toBeDefined()
    expect(failed!.payload.error?.message).toContain(bad.messageId)
    // 驱动器没有停转：坏条目失败后队列清空、字段删除
    expect(sessions.readQueue(meta.id)).toHaveLength(0)
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
    const lines = sessions.readMessages(meta.id)
    const injected = lines.find((m: { id: string }) => m.id === s.messageId)
    expect(injected.blocks[0].text).toBe("转向：改用方案 B")
    // steer 注入复用同一份系统提示词：整轮（两次模型调用 + 边界注入）恰好一条审计
    expect(sessions.readEvents(meta.id).filter((e) => e.type === "system")).toHaveLength(1)
  })

  it("a failing steer mount fails the run (steering_failed) and keeps the rest of the buffer for demotion", async () => {
    const gate = makeGate()
    const mgr = managerWith({ llm: gateLlm(gate, true), tools: new Map([["gate", gateTool(gate)]]) })
    const meta = sessions.create("t", undefined, "/w")
    const events: Array<{ type: string; payload: { error?: { code?: string } } }> = []
    bus.subscribe(meta.id, { send: (d: string) => { const e = JSON.parse(d); if (e.sessionId === meta.id) events.push(e) } })
    const run = mgr.submit(meta.id, { userText: "start", trigger: "user" })
    await gate.toolEntered
    // 附件在会话附件目录之外 → drain 构建 Message 时 mountAttachments 抛
    const bad = mgr.submit(meta.id, {
      userText: "坏附件", trigger: "user", disposition: "steer",
      attachments: [{ path: "/etc/hosts", name: "hosts", size: 1, mimeType: "text/plain" }],
    })
    const good = mgr.submit(meta.id, { userText: "后到的 steer", trigger: "user", disposition: "steer" })
    gate.releaseTool()
    expect((await run.outcome).stopReason).toBe("error")
    gate.releaseLlm() // good 降级执行的 final stream 等这扇门
    // 先构建后变更（spec §5.6）：bad 构建失败 → 整批不动、不登记 injected；
    // good 不被连带丢掉，随 #demoteSteer 降级仍被执行并进 JSONL
    const settleGood = async (): Promise<void> => {
      for (;;) {
        if (sessions.readMessages(meta.id).some((m) => m.id === good.messageId)) return
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    await settleGood()
    await new Promise((r) => setTimeout(r, 20)) // 等 good 的 run 收尾，避免 afterEach 竞争
    expect(events.some((e) => e.type === "run.failed" && e.payload.error?.code === "steering_failed")).toBe(true)
    expect(events.some((e) => e.type === "message.steered")).toBe(false)
    // 未被登记 injected（旧实现会谎报 injected）
    expect(mgr.queueCancel(meta.id, bad.messageId)).toEqual({ ok: false, reason: "not_found" })
    expect(sessions.readMessages(meta.id).some((m) => m.id === bad.messageId)).toBe(false) // bad 从未注入
  })

  it("steer buffered across an abort demotes via #demoteSteer (original order, executes after, no steered events)", async () => {
    const gate = makeGate()
    const mgr = managerWith({ llm: gateLlm(gate, true), tools: new Map([["gate", gateTool(gate)]]) })
    const meta = sessions.create("t", undefined, "/w")
    const events: Array<{ type: string; payload: { messageId?: string } }> = []
    let llmStarts = 0
    let secondStart!: () => void
    const secondStarted = new Promise<void>((r) => { secondStart = r })
    bus.subscribe(meta.id, { send: (d: string) => {
      const e = JSON.parse(d)
      if (e.sessionId !== meta.id) return
      events.push(e)
      if (e.type === "llm.started" && ++llmStarts === 2) secondStart()
    } })
    const run = mgr.submit(meta.id, { userText: "start", trigger: "user" })
    await gate.toolEntered
    gate.releaseTool() // 边界 drain 空跑（此刻缓冲为空），final stream 停在 releaseLlm 门上
    await secondStarted // llm.started #2 与 stream 挂门之间无 await：此后提交必落在门后
    const s1 = mgr.submit(meta.id, { userText: "s1", trigger: "user", disposition: "steer" })
    const s2 = mgr.submit(meta.id, { userText: "s2", trigger: "user", disposition: "steer" })
    // run 在 abort 处结束、从未取走缓冲：结算后 #demoteSteer 是 s1/s2 的唯一执行
    // 通道——按原顺序降级并入队尾执行（spec §3.4），而非边界注入（无 steered 事件）
    mgr.cancel(meta.id)
    gate.releaseLlm() // 丢弃的 call-2 生成器与降级 run 的流都等这扇门
    expect((await run.outcome).stopReason).toBe("aborted")
    await s1.outcome
    await s2.outcome
    const settle = async (): Promise<void> => {
      for (;;) {
        if (sessions.readQueue(meta.id).length === 0) return
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    await settle()
    expect(events.some((e) => e.type === "message.steered" && (e.payload.messageId === s1.messageId || e.payload.messageId === s2.messageId))).toBe(false)
    const lines = sessions.readMessages(meta.id)
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
    expect(sessions.readQueue(meta.id)).toHaveLength(0)
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
    expect(sessions.readMessages(meta.id).some((m) => m.id === s.messageId)).toBe(false) // 注入前撤回：不进 JSONL
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
    expect(sessions.readQueue(meta.id)).toHaveLength(0)
  })

  it("unknown id answers not_found", () => {
    const meta = sessions.create("t", undefined, "/w")
    expect(manager.queueCancel(meta.id, "msg_nope")).toEqual({ ok: false, reason: "not_found" })
  })
})

describe("compactSession refusal", () => {
  it("refuses while running with the running message", async () => {
    const gate = makeGate()
    const mgr = managerWith({ llm: gateLlm(gate, false), tools: new Map([["gate", gateTool(gate)]]) })
    const meta = sessions.create("t", undefined, "/w")
    const run = mgr.submit(meta.id, { userText: "x", trigger: "user" })
    await gate.toolEntered
    await expect(mgr.compactSession(meta.id)).rejects.toThrow("会话正在运行，等它结束")
    mgr.cancel(meta.id)
    gate.releaseTool()
    await run.outcome // 不留仍在跑的 run（afterEach rmSync 竞争）
  })

  it("refuses with the queued-count message when only the queue is non-empty", async () => {
    const meta = sessions.create("t", undefined, "/w")
    const first = manager.submit(meta.id, { userText: "first", trigger: "user" })
    const q = manager.submit(meta.id, { userText: "q", trigger: "user", disposition: "wait" })
    await first.outcome
    // 同步连续再排两条占住队列（此刻 q 可能已被驱动器执行掉），保证非空
    const q2 = manager.submit(meta.id, { userText: "q2", trigger: "user", disposition: "wait" })
    const q3 = manager.submit(meta.id, { userText: "q3", trigger: "user", disposition: "wait" })
    await expect(manager.compactSession(meta.id)).rejects.toThrow(/还有 \d+ 条排队消息，先处理或取消/)
    // 断言后排空：测试结束时不得有仍在写的 run（Ruling B）
    await Promise.all([first.outcome, q.outcome, q2.outcome, q3.outcome])
    for (let i = 0; i < 50; i++) {
      if (sessions.readQueue(meta.id).length === 0) return
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(sessions.readQueue(meta.id)).toHaveLength(0)
  })
})

describe("recoverQueues", () => {
  it("re-enqueues persisted entries as wait (steer/interrupt demoted) and drives them in order", async () => {
    const meta = sessions.create("t", undefined, "/w")
    sessions.replaceQueue(meta.id, [
      { messageId: "msg_s", disposition: "steer", text: "s", trigger: "user", enqueuedAt: new Date().toISOString() },
      { messageId: "msg_w", disposition: "wait", text: "w", trigger: "user", enqueuedAt: new Date().toISOString() },
      { messageId: "msg_i", disposition: "interrupt", text: "i", trigger: "user", enqueuedAt: new Date().toISOString() },
    ])
    manager.recoverQueues()
    // 轮询到全部 3 条 user 消息 + 各自 assistant 回复落盘（3 run × 2 条 = 6 条）：
    // 只数 user 消息会在 run 仍在写盘时放行，与 afterEach 的 rmSync 竞争。
    // 上限 50×20ms：回归时以明确断言失败，而非静默超时。
    for (let i = 0; i < 50; i++) {
      const messages = sessions.readMessages(meta.id)
      if (messages.filter((m) => m.role === "user").length >= 3 && messages.length >= 6) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(sessions.readQueue(meta.id)).toHaveLength(0)
    const texts = sessions.readMessages(meta.id).filter((m) => m.role === "user").map((m: { blocks: Array<{ text?: string }> }) => m.blocks[0]!.text)
    expect(texts).toEqual(["s", "w", "i"])
  })

  it("is a no-op for sessions without a queue", () => {
    sessions.create("t2", undefined, "/w")
    expect(() => manager.recoverQueues()).not.toThrow()
  })
})
