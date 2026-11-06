/**
 * The `kclaw run` lifecycle (spec A4–A6, A10) driven with frame sequences:
 * which frames belong to this run, when it ends, the exit code and the
 * commands it sends to stop only its own message or answer cards.
 */
import { describe, it, expect } from "vitest"
import type { WsFrame } from "../src/client.js"
import { startRun, stepRun, UNATTENDED_ANSWER, type CardPolicy, type RunEffect, type RunInput, type RunState } from "../src/run-lifecycle.js"

const SID = "ses_demo"
const MINE = "msg_mine"

function ev(type: string, payload: unknown, runId?: string): WsFrame {
  return { id: `evt_${type}`, ts: "2026-11-07T00:00:00.000Z", type, sessionId: SID, ...(runId !== undefined ? { runId } : {}), payload }
}

const ackRun: WsFrame = { type: "send_message_ack", sessionId: SID, messageId: MINE, queued: false }
const ackQueued: WsFrame = { type: "send_message_ack", sessionId: SID, messageId: MINE, queued: true }
const otherStart = ev("run.started", { trigger: "user" }, "run_other")
const otherText = ev("text.delta", { messageId: "msg_other_reply", blockId: "b1", delta: "别人的输出" }, "run_other")
const otherCard = ev("confirmation.requested", { confirmationId: "cfm_other", toolCall: { name: "bash" } }, "run_other")
const otherDone = ev("run.completed", { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }, "run_other")
const mineStarted = ev("run.started", { trigger: "user" }, "run_mine")
const mineCreated = ev("message.created", { message: { id: MINE, role: "user" } }, "run_mine")
const mineText = ev("text.delta", { messageId: "msg_reply", blockId: "b2", delta: "自己的输出" }, "run_mine")
const mineCard = ev("confirmation.requested", { confirmationId: "cfm_mine", toolCall: { name: "bash" } }, "run_mine")
const childCard = ev("confirmation.requested", { confirmationId: "cfm_child", toolCall: { name: "bash" }, noteText: "来自subagent 检索" }, "run_child")
const mineAsk = ev("question.requested", { questionId: "q_1", questions: [{ text: "用哪个分支？", options: ["main", "dev"] }, { text: "补充？" }] }, "run_mine")
const completed = (stopReason: string): WsFrame => ev("run.completed", { stopReason, usage: { inputTokens: 3, outputTokens: 2 } }, "run_mine")
const mineFailed = ev("run.failed", { error: { code: "llm_error", message: "provider 返回 500" } }, "run_mine")
const entryFailed = ev("run.failed", { error: { code: "queue_entry_failed", message: "排队消息执行失败" }, messageId: MINE })
const notFound: WsFrame = { type: "error", message: "not found" }

const frame = (f: WsFrame): RunInput => ({ type: "frame", frame: f })
const signal = (name: "SIGINT" | "SIGTERM" | "SIGHUP" | "EPIPE"): RunInput => ({ type: "signal", name })

/** Feed inputs from the opening move; collect every effect after startRun's send. */
function drive(inputs: RunInput[], policy: CardPolicy = "default"): { state: RunState; effects: RunEffect[] } {
  let { state } = startRun({ sessionId: SID, text: "你好", attachments: [], policy })
  const effects: RunEffect[] = []
  for (const input of inputs) {
    const step = stepRun(state, input)
    state = step.state
    effects.push(...step.effects)
  }
  return { state, effects }
}

const outputs = (effects: RunEffect[]): WsFrame[] =>
  effects.flatMap((e) => (e.type === "output" ? [e.frame] : []))
const sends = (effects: RunEffect[]) => effects.flatMap((e) => (e.type === "send" ? [e.frame] : []))
const warns = (effects: RunEffect[]) => effects.flatMap((e) => (e.type === "warn" ? [e.text] : []))
const exits = (effects: RunEffect[]) => effects.flatMap((e) => (e.type === "exit" ? [e] : []))

describe("startRun", () => {
  it("sends my message with disposition wait; attachments only when there are some", () => {
    const bare = startRun({ sessionId: SID, text: "你好", attachments: [], policy: "default" })
    expect(bare.effects).toEqual([{ type: "send", frame: { type: "send_message", sessionId: SID, text: "你好", disposition: "wait" } }])
    const att = { path: "/a/stdin.txt", name: "stdin.txt", size: 3, mimeType: "text/plain" }
    const withFile = startRun({ sessionId: SID, text: "看看", attachments: [att], policy: "default" })
    expect(withFile.effects[0]).toMatchObject({ frame: { attachments: [att] } })
  })
})

describe("stepRun: which run is mine", () => {
  it("an idle session: my run's frames are output and its end exits 0", () => {
    const { state, effects } = drive([frame(ackRun), frame(mineStarted), frame(mineCreated), frame(mineText), frame(completed("end_turn"))])
    expect(outputs(effects)).toEqual([ackRun, mineStarted, mineCreated, mineText, completed("end_turn")])
    expect(exits(effects)).toEqual([{ type: "exit", code: 0 }])
    expect(state.phase).toBe("done")
  })

  it("queued behind another run: its frames and its end are not mine", () => {
    const { effects } = drive([
      frame(ackQueued), frame(otherText), frame(otherDone),
      frame(mineStarted), frame(mineCreated), frame(mineText), frame(completed("end_turn")),
    ])
    expect(outputs(effects)).toEqual([ackQueued, mineStarted, mineCreated, mineText, completed("end_turn")])
    expect(exits(effects)).toEqual([{ type: "exit", code: 0 }])
  })

  it("a run.started that turns out to be someone else's is never output", () => {
    const { effects } = drive([frame(ackQueued), frame(otherStart), frame(mineCreated), frame(completed("end_turn"))])
    expect(outputs(effects)).toEqual([ackQueued, mineCreated, completed("end_turn")])
  })

  it("an entry-level failure has no runId and is claimed through payload.messageId", () => {
    const { effects } = drive([frame(ackQueued), frame(otherDone), frame(entryFailed)])
    expect(outputs(effects)).toEqual([ackQueued, entryFailed])
    expect(exits(effects)).toEqual([{ type: "exit", code: 1, failure: { code: "queue_entry_failed", message: "排队消息执行失败" } }])
  })

  it("a run.failed of my run exits 1 with its error", () => {
    const { effects } = drive([frame(ackRun), frame(mineCreated), frame(mineFailed)])
    expect(exits(effects)).toEqual([{ type: "exit", code: 1, failure: { code: "llm_error", message: "provider 返回 500" } }])
    expect(warns(effects)).toEqual(["provider 返回 500"])
  })

  it("my message starting without a runId cannot be followed and fails loudly", () => {
    expect(() => drive([frame(ackRun), frame(ev("message.created", { message: { id: MINE, role: "user" } }))])).toThrow(/runId/)
  })
})

describe("stepRun: exit codes by stop reason", () => {
  it.each(["end_turn", "stop_sequence", "tool_use"])("%s exits 0", (reason) => {
    const { effects } = drive([frame(ackRun), frame(mineCreated), frame(completed(reason))])
    expect(exits(effects)).toEqual([{ type: "exit", code: 0 }])
  })

  it.each([
    ["aborted", "被其他客户端停止"],
    ["max_tokens", "最后一条回复被输出上限截断"],
    ["content_filter", "被模型服务商拦截"],
  ])("%s exits 1 and says why", (reason, why) => {
    const { effects } = drive([frame(ackRun), frame(mineCreated), frame(completed(reason))])
    expect(exits(effects)).toEqual([{ type: "exit", code: 1, failure: { code: reason, message: `运行未正常结束：${why}` } }])
    expect(warns(effects)).toEqual([`运行未正常结束：${why}`])
  })
})

describe("stepRun: failures without a run", () => {
  it("send_message rejected: the error frame is output, exit 1 rejected", () => {
    const rejected: WsFrame = { type: "error", message: "队列已满（11 条）" }
    const { effects } = drive([frame(rejected)])
    expect(outputs(effects)).toEqual([rejected])
    expect(exits(effects)).toEqual([{ type: "exit", code: 1, failure: { code: "rejected", message: "daemon 拒绝了这条消息：队列已满（11 条）" } }])
  })

  it("withdrawn by another client while queued (single cancel)", () => {
    const cancelled = ev("message.queue_cancelled", { messageId: MINE })
    const { effects } = drive([frame(ackQueued), frame(cancelled)])
    expect(outputs(effects)).toEqual([ackQueued, cancelled])
    expect(exits(effects)[0]).toMatchObject({ code: 1, failure: { code: "withdrawn" } })
  })

  it("withdrawn by a clear-all that lists my message; one that does not is someone else's", () => {
    const others = ev("message.queue_cancelled", { all: true, messageIds: ["msg_other"] })
    const mine = ev("message.queue_cancelled", { all: true, messageIds: ["msg_other", MINE] })
    const { effects } = drive([frame(ackQueued), frame(others), frame(mine)])
    expect(outputs(effects)).toEqual([ackQueued, mine])
    expect(exits(effects)).toHaveLength(1)
    expect(exits(effects)[0]).toMatchObject({ code: 1, failure: { code: "withdrawn" } })
  })

  it("the connection dropping mid-run exits 1 disconnected", () => {
    const { effects } = drive([frame(ackRun), frame(mineCreated), { type: "closed" }])
    expect(exits(effects)).toEqual([{ type: "exit", code: 1, failure: { code: "disconnected", message: "与 daemon 的连接断开了" } }])
  })

  it("after the end nothing happens, including the socket closing", () => {
    const { effects } = drive([frame(ackRun), frame(mineCreated), frame(completed("end_turn")), { type: "closed" }, frame(mineText)])
    expect(exits(effects)).toHaveLength(1)
  })
})

describe("stepRun: signals stop only my own run", () => {
  it("Ctrl+C while queued withdraws my message; the exit code is the signal's", () => {
    const { effects } = drive([frame(ackQueued), frame(otherText), signal("SIGINT"), frame({ type: "queue.cancel_ack", sessionId: SID, cancelled: [MINE] })])
    expect(sends(effects)).toEqual([{ type: "queue.cancel", sessionId: SID, messageId: MINE }])
    expect(exits(effects)).toEqual([{ type: "exit", code: 130, failure: { code: "interrupted", message: "已停止本次运行：收到 SIGINT" } }])
  })

  it("the withdrawal loses the race against dequeue: not found → run.cancel for my message, exit by the signal", () => {
    const { effects } = drive([
      frame(ackQueued), signal("SIGTERM"), frame(otherDone), frame(mineCreated),
      frame(notFound), frame({ type: "run_cancel_ack", sessionId: SID }), frame(completed("aborted")),
    ])
    expect(sends(effects)).toEqual([
      { type: "queue.cancel", sessionId: SID, messageId: MINE },
      { type: "run.cancel", sessionId: SID, messageId: MINE },
    ])
    expect(exits(effects)).toEqual([{ type: "exit", code: 143, failure: { code: "interrupted", message: "已停止本次运行：收到 SIGTERM" } }])
  })

  it("a running message is stopped with run.cancel naming it", () => {
    const { effects } = drive([frame(ackRun), frame(mineCreated), signal("SIGHUP"), frame(completed("aborted"))])
    expect(sends(effects)).toEqual([{ type: "run.cancel", sessionId: SID, messageId: MINE }])
    expect(exits(effects)[0]).toMatchObject({ code: 129 })
  })

  it("a signal before the ack waits for the ack to name my message", () => {
    const sigOnly = drive([signal("SIGINT")])
    expect(sends(sigOnly.effects)).toEqual([])
    const { effects } = drive([signal("SIGINT"), frame(ackQueued)])
    expect(sends(effects)).toEqual([{ type: "queue.cancel", sessionId: SID, messageId: MINE }])
  })

  it("the second signal exits at once", () => {
    const { state, effects } = drive([frame(ackRun), frame(mineCreated), signal("SIGINT"), frame({ type: "run_cancel_ack", sessionId: SID }), signal("SIGINT")])
    expect(exits(effects)).toEqual([{ type: "exit", code: 130, forced: true }])
    expect(state.phase).toBe("done")
  })

  it("EPIPE stops my run, writes nothing more, exits 141; later EPIPEs are the same pipe", () => {
    const { effects } = drive([frame(ackRun), frame(mineCreated), frame(mineText), signal("EPIPE"), frame(mineText), signal("EPIPE"), frame(completed("aborted"))])
    expect(outputs(effects)).toEqual([ackRun, mineCreated, mineText])
    expect(sends(effects)).toEqual([{ type: "run.cancel", sessionId: SID, messageId: MINE }])
    expect(exits(effects)).toEqual([{ type: "exit", code: 141, failure: { code: "interrupted", message: "已停止本次运行：stdout 的下游管道已关闭" } }])
  })
})

describe("stepRun: cards", () => {
  it("cards before my run are someone else's; mine and my subagents' are rejected by default, warned once", () => {
    const { effects } = drive([
      frame(ackQueued), frame(otherCard), frame(otherDone), frame(mineCreated),
      frame(mineCard), frame({ type: "confirmation.resolved_ack", confirmationId: "cfm_mine", ok: true }),
      frame(childCard), frame({ type: "confirmation.resolved_ack", confirmationId: "cfm_child", ok: true }),
      frame(completed("end_turn")),
    ])
    expect(sends(effects)).toEqual([
      { type: "confirmation.resolve", confirmationId: "cfm_mine", decision: "reject" },
      { type: "confirmation.resolve", confirmationId: "cfm_child", decision: "reject" },
    ])
    expect(outputs(effects)).not.toContainEqual(otherCard)
    expect(warns(effects)).toEqual(["未指定 --yes：本次运行确认一律拒绝"])
    expect(exits(effects)).toEqual([{ type: "exit", code: 0 }])
  })

  it("--yes approves once, --no rejects, neither warns", () => {
    const yes = drive([frame(ackRun), frame(mineCreated), frame(mineCard)], "yes")
    expect(sends(yes.effects)).toEqual([{ type: "confirmation.resolve", confirmationId: "cfm_mine", decision: "once" }])
    expect(warns(yes.effects)).toEqual([])
    const no = drive([frame(ackRun), frame(mineCreated), frame(mineCard)], "no")
    expect(sends(no.effects)).toEqual([{ type: "confirmation.resolve", confirmationId: "cfm_mine", decision: "reject" }])
    expect(warns(no.effects)).toEqual([])
  })

  it("a question gets the unattended answer for every question, warned once", () => {
    const { effects } = drive([frame(ackRun), frame(mineCreated), frame(mineAsk), frame(mineAsk)])
    expect(sends(effects)[0]).toEqual({ type: "question.resolve", questionId: "q_1", answers: [[UNATTENDED_ANSWER], [UNATTENDED_ANSWER]] })
    expect(warns(effects)).toEqual(["无人值守运行：问题卡已自动回复「没有人可以回答」"])
  })

  it("a card reply error (settled elsewhere) keeps waiting", () => {
    const { effects } = drive([frame(ackRun), frame(mineCreated), frame(mineCard), frame({ type: "error", message: "unknown confirmation" }), frame(completed("end_turn"))])
    expect(exits(effects)).toEqual([{ type: "exit", code: 0 }])
  })
})
