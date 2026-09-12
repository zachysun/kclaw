/**
 * ConfirmationBroker 直测：确认与问答两种登记共用一套语义（create/wait/
 * resolve/expire 对称、过期即陈旧、迟到 resolve 返回 false），
 * racePending 的三路竞速边界（值先到 / 超时 / 中止 / signal 已中止）。
 * 网关侧端到端行为另有 server/confirm-gateway.test.ts 覆盖。
 */
import { describe, it, expect } from "vitest"
import { ConfirmationBroker, racePending, type QuestionResolution } from "../../src/permissions/broker.js"
import { newBlockId, type ToolCallBlock } from "../../src/protocol/blocks.js"

function toolCall(name = "exec"): ToolCallBlock {
  return { id: newBlockId(), type: "tool_call", callId: "call_1", name, args: {}, argsJson: "{}" }
}

describe("ConfirmationBroker 确认/问答登记对称", () => {
  it("resolve 如实回答：在册结一次 true，重复/未知 false", async () => {
    const broker = new ConfirmationBroker()
    const p = broker.create("conf_1", toolCall(), "sensitive", 60_000, "ses_1")
    expect(broker.resolve("conf_1", "once", "web")).toBe(true)
    await expect(p).resolves.toEqual({ decision: "once", by: "web" })
    expect(broker.resolve("conf_1", "reject")).toBe(false)
    expect(broker.resolve("conf_missing", "once")).toBe(false)
  })

  it("wait 未知 id 永不结：竞速里表现为 timeout", async () => {
    const broker = new ConfirmationBroker()
    const raced = await racePending(broker.wait("conf_none"), 15, undefined)
    expect(raced).toBe("timeout")
  })

  it("expire 后条目陈旧：迟到 resolve false，pending 不再列出", async () => {
    const broker = new ConfirmationBroker()
    const p = broker.create("conf_2", toolCall(), "safe", 60_000)
    broker.expire("conf_2")
    expect(broker.resolve("conf_2", "once")).toBe(false)
    expect(broker.pending()).toEqual([])
    // 原承诺永远悬置——外面的竞速负责拒绝，这里只确认它不被 settle
    const raced = await racePending(p, 15, undefined)
    expect(raced).toBe("timeout")
  })

  it("过期条目被惰性清理：pending/resolve 都视为未知", () => {
    const broker = new ConfirmationBroker()
    broker.create("conf_old", toolCall(), "safe", -1) // expiresAt 已过去
    expect(broker.pending()).toEqual([])
    expect(broker.resolve("conf_old", "once")).toBe(false)
  })

  it("pending() 携带网关载荷字段（toolCall/risk/expiresAt/sessionId）", () => {
    const broker = new ConfirmationBroker()
    broker.create("conf_3", toolCall("fs_write"), "sensitive", 60_000, "ses_9")
    expect(broker.pending()).toEqual([
      expect.objectContaining({
        confirmationId: "conf_3",
        risk: "sensitive",
        toolCall: expect.objectContaining({ name: "fs_write" }),
      }),
    ])
  })

  it("问答同构：resolveQuestion 结一次，expireQuestion 后迟到应答 false", async () => {
    const broker = new ConfirmationBroker()
    const p = broker.createQuestion("q_1", 60_000)
    expect(broker.resolveQuestion("q_1", [["甲"]], "web")).toBe(true)
    await expect(p).resolves.toEqual({ answers: [["甲"]], by: "web" } satisfies QuestionResolution)
    expect(broker.resolveQuestion("q_1", [])).toBe(false)

    const q2 = broker.createQuestion("q_2", 60_000)
    broker.expireQuestion("q_2")
    expect(broker.resolveQuestion("q_2", [])).toBe(false)
    const raced = await racePending(q2, 15, undefined)
    expect(raced).toBe("timeout")
  })
})

describe("racePending 三路竞速", () => {
  it("值先到：原样返回，不掺哨兵", async () => {
    const raced = await racePending(Promise.resolve({ decision: "once" as const, by: "cli" as const }), 5_000, undefined)
    expect(raced).toEqual({ decision: "once", by: "cli" })
  })

  it("timer 先到：timeout 哨兵", async () => {
    const raced = await racePending(new Promise<{ decision: "once" }>(() => {}), 10, undefined)
    expect(raced).toBe("timeout")
  })

  it("等待中 signal 中止：aborted 哨兵（不是 timeout，也不是拒绝）", async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 5)
    const raced = await racePending(new Promise<{ decision: "once" }>(() => {}), 60_000, ctrl.signal)
    expect(raced).toBe("aborted")
  })

  it("signal 已是 aborted：立即 aborted", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const raced = await racePending(new Promise<{ decision: "once" }>(() => {}), 60_000, ctrl.signal)
    expect(raced).toBe("aborted")
  })

  it("无 signal：只有值与 timeout 两路", async () => {
    const raced = await racePending(new Promise<{ decision: "once" }>(() => {}), 10, undefined)
    expect(raced).toBe("timeout")
  })
})
