/**
 * The three `kclaw run` output formats (spec A4): given the frames the
 * lifecycle attributed to this run, what lands on stdout.
 */
import { describe, it, expect, afterEach } from "vitest"
import type { WsFrame } from "../src/client.js"
import { configureColor } from "../src/color.js"
import { createRunOutput, type OutputFormat } from "../src/run-output.js"
import { UNATTENDED_ANSWER, type CardPolicy } from "../src/run-lifecycle.js"

function ev(type: string, payload: unknown, runId = "run_mine"): WsFrame {
  return { id: `evt_${type}`, ts: "2026-11-07T00:00:00.000Z", type, sessionId: "ses_1", runId, payload }
}

const ack: WsFrame = { type: "send_message_ack", sessionId: "ses_1", messageId: "msg_mine", queued: false }
const userCreated = ev("message.created", { message: { id: "msg_mine", role: "user" } })
const firstReply = ev("message.created", { message: { id: "msg_a1", role: "assistant" } })
const secondReply = ev("message.created", { message: { id: "msg_a2", role: "assistant" } })
const delta = (messageId: string, text: string): WsFrame => ev("text.delta", { messageId, blockId: "b", delta: text })
const textDone = (messageId: string): WsFrame => ev("text.completed", { messageId, block: { id: "b", type: "text", text: "" } })
const toolCall = ev("tool_call.completed", { messageId: "msg_a1", block: { id: "c", type: "tool_call", name: "bash", args: { command: "ls" } } })
const toolResult = ev("tool_result.completed", { messageId: "msg_t", block: { id: "r", type: "tool_result", status: "ok", durationMs: 12.4, output: "a\nb" } })
const done = ev("run.completed", { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } })
const card = ev("confirmation.requested", { confirmationId: "cfm", toolCall: { name: "bash", argsJson: "{\"command\":\"rm x\"}" }, risk: "sensitive", expiresAt: "2026-11-07T00:05:00.000Z" })
const ask = ev("question.requested", { questionId: "q", questions: [{ text: "哪个？" }], expiresAt: "2026-11-07T00:05:00.000Z" })
const thinking = ev("thinking.delta", { messageId: "msg_a1", blockId: "t", delta: "想一想" })

function render(format: OutputFormat, frames: WsFrame[], opts: { policy?: CardPolicy; showThinking?: boolean; failure?: { code: string; message: string } } = {}): string {
  const chunks: string[] = []
  const output = createRunOutput({ format, policy: opts.policy ?? "default", showThinking: opts.showThinking ?? false, write: (c) => chunks.push(c) })
  for (const f of frames) output.frame(f)
  output.finish({ sessionId: "ses_1", messageId: "msg_mine", durationMs: 42, ...(opts.failure !== undefined ? { failure: opts.failure } : {}) })
  return chunks.join("")
}

afterEach(() => configureColor("never", {}, { isTTY: false }))

describe("text", () => {
  it("streams the answer, tool lines on their own lines, ending on a newline", () => {
    configureColor("never", {}, { isTTY: false })
    const out = render("text", [ack, userCreated, firstReply, toolCall, toolResult, secondReply, delta("msg_a2", "完成"), delta("msg_a2", "了"), textDone("msg_a2"), done])
    expect(out).toBe('⚡ bash {"command":"ls"}\n↳ ok (12ms) a b\n完成了\n')
  })

  it("names each card's automatic verdict per policy", () => {
    configureColor("never", {}, { isTTY: false })
    expect(render("text", [card])).toContain("已自动拒绝（未指定 --yes）")
    expect(render("text", [card], { policy: "yes" })).toContain("[--yes] 已自动允许（仅本次）")
    expect(render("text", [card], { policy: "no" })).toContain("[--no] 已自动拒绝")
    expect(render("text", [ask])).toBe(`❓ 1 个问题待回答\n已自动回复：${UNATTENDED_ANSWER}\n`)
  })

  it("thinking only with --think; colour only when C1 says so", () => {
    configureColor("never", {}, { isTTY: false })
    expect(render("text", [thinking])).toBe("")
    expect(render("text", [thinking], { showThinking: true })).toBe("· 想一想\n")
    configureColor("always", {}, { isTTY: false })
    expect(render("text", [thinking], { showThinking: true })).toBe("\x1b[2m· 想一想\x1b[22m\n")
  })

  it("prints nothing for a failure: stderr carries it", () => {
    configureColor("never", {}, { isTTY: false })
    expect(render("text", [ev("run.failed", { error: { code: "llm_error", message: "x" } })], { failure: { code: "llm_error", message: "x" } })).toBe("")
  })
})

describe("json", () => {
  it("one object: the last assistant message's text, stopReason and usage from run.completed", () => {
    const out = render("json", [ack, userCreated, firstReply, delta("msg_a1", "先看看"), textDone("msg_a1"), toolCall, toolResult, secondReply, delta("msg_a2", "结论"), done])
    expect(out.endsWith("\n")).toBe(true)
    expect(JSON.parse(out)).toEqual({
      sessionId: "ses_1",
      messageId: "msg_mine",
      text: "结论",
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 3 },
      durationMs: 42,
    })
  })

  it("a failure without run.completed: error added, stopReason and usage omitted", () => {
    const out = render("json", [ack, userCreated, ev("run.failed", { error: { code: "llm_error", message: "provider 返回 500" } })], { failure: { code: "llm_error", message: "provider 返回 500" } })
    expect(JSON.parse(out)).toEqual({ sessionId: "ses_1", messageId: "msg_mine", text: "", durationMs: 42, error: { code: "llm_error", message: "provider 返回 500" } })
  })

  it("never coloured, even under --color always", () => {
    configureColor("always", {}, { isTTY: false })
    expect(render("json", [firstReply, delta("msg_a1", "hi"), done])).not.toContain("\x1b")
  })
})

describe("stream-json", () => {
  it("every frame verbatim, one compact line each; nothing extra at the end", () => {
    const frames = [ack, userCreated, delta("msg_a1", "hi"), done]
    const out = render("stream-json", frames, { failure: { code: "x", message: "y" } })
    expect(out.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l))).toEqual(frames)
  })
})
