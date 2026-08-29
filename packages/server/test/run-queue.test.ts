/**
 * RunManager 显式队列语义测试（spec §3.2/§3.4/§4.1/§5.2-§5.5）：空闲直发、
 * wait FIFO 与预分配消息 id、meta.queue 镜像、上限拒绝、enqueue 兼容、
 * cancel 语义收窄（仅中止活动 run）与 interrupt 插队不吞消息。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore, defaultConfig, resolvePaths } from "@kclaw/core"
import type { LlmStreamEvent, RunOutcome } from "@kclaw/core"
import { RunManager } from "../src/run.js"
import { EventBus } from "../src/bus.js"
import { endTurnLlm } from "./helpers/scripted-llm.js"

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
})
