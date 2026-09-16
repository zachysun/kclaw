/**
 * Reducer unit tests — the event→view-model core of the streaming chat view
 * (the UI-relevant event subset, the wire order, out-of-order tolerance).
 * The reducer is a pure function: every applyEvent returns a NEW state and
 * never mutates its inputs.
 */
import { describe, expect, it } from "vitest"
import {
  applyEvent,
  initChat,
  mergeMessages,
  mergeQueue,
  appendPendingQueueRow,
  adoptQueuedId,
  collectPendingSends,
  dropLocalPending,
  undeliveredPendingSends,
  type AgentEvent,
  type Block,
  type ChatState,
  type Message,
  appendOptimisticUser,
} from "../../src/chat/model.js"
import type { CompactionPhase, NoteKind } from "@kclaw/core/protocol"
import { parseTeamMail } from "../../src/chat/model.js"

function msg(id: string, role: "user" | "assistant" | "tool", blocks: Block[]): Message {
  return { id, sessionId: "s1", role, blocks, createdAt: "2026-08-15T00:00:00.000Z" }
}

function ev(type: AgentEvent["type"], payload: unknown, sessionId = "s1"): AgentEvent {
  return { id: `evt-${type}`, ts: "2026-08-15T00:00:00.000Z", type, payload, sessionId } as AgentEvent
}

const text = (id: string, text: string) => ({ id, type: "text" as const, text })
const thinking = (id: string, text: string) => ({ id, type: "thinking" as const, text })
const note = (id: string, kind: NoteKind, text: string) => ({ id, type: "note" as const, kind, text })
const toolCall = (id: string, callId: string, name: string, argsJson: string) =>
  ({ id, type: "tool_call" as const, callId, name, args: {}, argsJson })
const toolResult = (id: string, callId: string, output: string, durationMs = 0, status: "ok" | "error" = "ok") =>
  ({ id, type: "tool_result" as const, callId, status, output, durationMs })
const firstTextOf = (m: { blocks: Array<{ kind: string; text?: string }> }): string =>
  m.blocks.find((b) => b.kind === "text")?.text ?? ""

describe("initChat", () => {
  it("maps persisted messages by role/block structure without replaying events", () => {
    const view = initChat([
      msg("m1", "user", [text("b1", "hi"), note("b2", "memory", "remembered")]),
      msg("m2", "assistant", [thinking("b3", "reasoning"), text("b4", "hello"), toolCall("b5", "c1", "fs_read", "{\"path\":\"/x\"}")]),
      msg("m3", "tool", [toolResult("b6", "c1", "content", 12)]),
    ])
    expect(view.runState).toBe("idle")
    expect(view.pendingConfirmations).toEqual([])
    expect(view.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"])
    expect(view.messages.every((m) => m.pending === false)).toBe(true)

    const [u, a, t] = view.messages
    expect(u!.blocks).toEqual([
      { kind: "text", blockId: "b1", text: "hi" },
      { kind: "note", blockId: "b2", noteKind: "memory", text: "remembered" },
    ])
    expect(a!.blocks).toEqual([
      { kind: "thinking", blockId: "b3", text: "reasoning" },
      { kind: "text", blockId: "b4", text: "hello" },
      { kind: "tool_call", blockId: "b5", callId: "c1", name: "fs_read", argsJson: "{\"path\":\"/x\"}" },
    ])
    expect(t!.blocks).toEqual([
      { kind: "tool_result", blockId: "b6", callId: "c1", status: "ok", output: "content", durationMs: 12 },
    ])
  })

  it("renders empty messages without crashing", () => {
    const view = initChat([msg("m1", "assistant", [])])
    expect(view.messages).toEqual([{ id: "m1", role: "assistant", pending: false, blocks: [] }])
  })
})

describe("incremental deltas", () => {
  it("appends text.delta to the matching text block by blockId", () => {
    const state = initChat([msg("m2", "assistant", [text("b4", "hello")])])
    const next = applyEvent(state, ev("text.delta", { messageId: "m2", blockId: "b4", delta: " world" }))
    expect(next.messages[0]!.blocks[0]).toEqual({ kind: "text", blockId: "b4", text: "hello world" })
    // Purity: the input state is untouched.
    expect(state.messages[0]!.blocks[0]).toEqual({ kind: "text", blockId: "b4", text: "hello" })
  })

  it("appends thinking.delta to the matching thinking block", () => {
    const state = initChat([msg("m2", "assistant", [thinking("b3", "reason")])])
    const next = applyEvent(state, ev("thinking.delta", { messageId: "m2", blockId: "b3", delta: "ing" }))
    expect(next.messages[0]!.blocks[0]).toEqual({ kind: "thinking", blockId: "b3", text: "reasoning" })
  })

  it("appends tool_call.delta to the argsJson of the matching tool_call block", () => {
    const state = initChat([msg("m2", "assistant", [toolCall("b5", "c1", "fs_read", "{\"path\":")])])
    const next = applyEvent(state, ev("tool_call.delta", { messageId: "m2", blockId: "b5", delta: "\"/x\"}" }))
    expect(next.messages[0]!.blocks[0]).toEqual(
      { kind: "tool_call", blockId: "b5", callId: "c1", name: "fs_read", argsJson: "{\"path\":\"/x\"}" },
    )
  })

  it("appends tool_result.delta to the matching result by callId", () => {
    const state = initChat([msg("m3", "tool", [toolResult("b6", "c1", "con")])])
    const next = applyEvent(state, ev("tool_result.delta", { messageId: "m3", callId: "c1", delta: "tent" }))
    expect(next.messages[0]!.blocks[0]).toEqual(
      { kind: "tool_result", blockId: "b6", callId: "c1", status: "ok", output: "content", durationMs: 0 },
    )
  })

  it("appends deltas to the right block when a message has several of the same kind", () => {
    const state = initChat([msg("m2", "assistant", [text("b4", "first"), text("b9", "second")])])
    const next = applyEvent(state, ev("text.delta", { messageId: "m2", blockId: "b9", delta: "!" }))
    expect(next.messages[0]!.blocks).toEqual([
      { kind: "text", blockId: "b4", text: "first" },
      { kind: "text", blockId: "b9", text: "second!" },
    ])
  })

  it("drops deltas for an unknown blockId (completed full-calibrates later)", () => {
    const state = initChat([msg("m2", "assistant", [text("b4", "hello")])])
    const next = applyEvent(state, ev("text.delta", { messageId: "m2", blockId: "ghost", delta: "x" }))
    expect(next).toBe(state)
  })

  it("drops deltas for an unknown messageId", () => {
    const state = initChat([])
    const next = applyEvent(state, ev("text.delta", { messageId: "ghost", blockId: "b4", delta: "x" }))
    expect(next).toBe(state)
  })
})

describe("block created/completed calibration", () => {
  it("streams a full assistant message: created skeleton → block.created → delta → completed", () => {
    let state = initChat([])
    state = applyEvent(state, ev("message.created", { message: msg("m2", "assistant", []) }))
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]!.pending).toBe(true)
    expect(state.messages[0]!.blocks).toEqual([])

    state = applyEvent(state, ev("text.created", { messageId: "m2", block: text("b4", "") }))
    state = applyEvent(state, ev("text.delta", { messageId: "m2", blockId: "b4", delta: "Hel" }))
    expect(state.messages[0]!.blocks[0]).toEqual({ kind: "text", blockId: "b4", text: "Hel" })

    state = applyEvent(state, ev("text.completed", { messageId: "m2", block: text("b4", "Hello") }))
    expect(state.messages[0]!.blocks[0]).toEqual({ kind: "text", blockId: "b4", text: "Hello" })

    state = applyEvent(state, ev("tool_call.created", { messageId: "m2", block: toolCall("b5", "c1", "exec", "") }))
    state = applyEvent(state, ev("tool_call.delta", { messageId: "m2", blockId: "b5", delta: "{\"cmd\":\"ls\"}" }))
    expect(state.messages[0]!.blocks[1]).toEqual(
      { kind: "tool_call", blockId: "b5", callId: "c1", name: "exec", argsJson: "{\"cmd\":\"ls\"}" },
    )

    const full = msg("m2", "assistant", [
      thinking("b3", "reasoning"),
      text("b4", "Hello"),
      toolCall("b5", "c1", "exec", "{\"cmd\":\"ls\"}"),
    ])
    state = applyEvent(state, ev("message.completed", { message: full }))
    expect(state.messages[0]!.pending).toBe(false)
    expect(state.messages[0]!.blocks).toEqual([
      { kind: "thinking", blockId: "b3", text: "reasoning" },
      { kind: "text", blockId: "b4", text: "Hello" },
      { kind: "tool_call", blockId: "b5", callId: "c1", name: "exec", argsJson: "{\"cmd\":\"ls\"}" },
    ])
  })

  it("streams a tool message: created skeleton → tool_result.created → delta → completed", () => {
    let state = initChat([])
    state = applyEvent(state, ev("message.created", { message: msg("m3", "tool", []) }))
    state = applyEvent(state, ev("tool_result.created", { messageId: "m3", block: toolResult("b6", "c1", "") }))
    state = applyEvent(state, ev("tool_result.delta", { messageId: "m3", callId: "c1", delta: "stdout" }))
    state = applyEvent(state, ev("tool_result.completed", { messageId: "m3", block: toolResult("b6", "c1", "stdout", 42) }))
    expect(state.messages[0]!.blocks).toEqual([
      { kind: "tool_result", blockId: "b6", callId: "c1", status: "ok", output: "stdout", durationMs: 42 },
    ])
  })

  it("adds a block even when its created event was missed (completed calibrates)", () => {
    let state = initChat([msg("m2", "assistant", [])])
    state = applyEvent(state, ev("text.completed", { messageId: "m2", block: text("b4", "full") }))
    expect(state.messages[0]!.blocks).toEqual([{ kind: "text", blockId: "b4", text: "full" }])
  })

  it("note.emitted upserts a note block onto the message (live memory/job notes)", () => {
    let state = initChat([msg("m1", "user", [text("b1", "hi")])])
    state = applyEvent(state, ev("note.emitted", { messageId: "m1", block: note("b2", "memory", "remembered") }))
    expect(state.messages[0]!.blocks).toEqual([
      { kind: "text", blockId: "b1", text: "hi" },
      { kind: "note", blockId: "b2", noteKind: "memory", text: "remembered" },
    ])
    // Same blockId re-emitted replaces rather than duplicating.
    state = applyEvent(state, ev("note.emitted", { messageId: "m1", block: note("b2", "job", "job note") }))
    expect(state.messages[0]!.blocks).toEqual([
      { kind: "text", blockId: "b1", text: "hi" },
      { kind: "note", blockId: "b2", noteKind: "job", text: "job note" },
    ])
  })

  it("drops block events for an unknown message", () => {
    const state = initChat([])
    expect(applyEvent(state, ev("text.created", { messageId: "ghost", block: text("b4", "") }))).toBe(state)
  })
})

describe("run lifecycle", () => {
  it("run.started marks the view running and clears a previous error", () => {
    const base = { ...initChat([]), error: "old" }
    const next = applyEvent(base, ev("run.started", { trigger: "user" }))
    expect(next.runState).toBe("running")
    expect(next.error).toBeUndefined()
  })

  it("run.completed returns to idle", () => {
    const base = { ...initChat([]), runState: "running" as const }
    const next = applyEvent(base, ev("run.completed", { stopReason: "end_turn" }))
    expect(next.runState).toBe("idle")
  })

  it("run.failed returns to idle and surfaces the error message", () => {
    const base = { ...initChat([]), runState: "running" as const }
    const next = applyEvent(base, ev("run.failed", { error: { code: "llm_error", message: "boom" } }))
    expect(next.runState).toBe("idle")
    expect(next.error).toBe("boom")
  })

  it("run.failed with a malformed payload falls back instead of throwing", () => {
    const base = { ...initChat([]), runState: "running" as const }
    const next = applyEvent(base, ev("run.failed", {}))
    expect(next.runState).toBe("idle")
    expect(next.error).toBe("run failed")
  })
})

describe("confirmations", () => {
  it("confirmation.requested pushes a card with the tool name and args summary", () => {
    const state = initChat([])
    const next = applyEvent(state, ev("confirmation.requested", {
      confirmationId: "conf_1",
      toolCall: toolCall("b5", "c1", "exec", "{\"cmd\":\"rm -rf /\"}"),
      risk: "sensitive",
      expiresAt: "2026-08-15T00:02:00.000Z",
    }))
    expect(next.pendingConfirmations).toEqual([
      {
        confirmationId: "conf_1",
        toolName: "exec",
        argsJson: "{\"cmd\":\"rm -rf /\"}",
        risk: "sensitive",
        expiresAt: "2026-08-15T00:02:00.000Z",
      },
    ])
  })

  it("does not duplicate a still-pending confirmation", () => {
    let state = initChat([])
    const payload = {
      confirmationId: "conf_1",
      toolCall: toolCall("b5", "c1", "exec", "{}"),
      risk: "sensitive" as const,
      expiresAt: "2026-08-15T00:02:00.000Z",
    }
    state = applyEvent(state, ev("confirmation.requested", payload))
    const next = applyEvent(state, ev("confirmation.requested", payload))
    expect(next.pendingConfirmations).toHaveLength(1)
  })

  it("confirmation.resolved removes the card by confirmationId", () => {
    let state = initChat([])
    state = applyEvent(state, ev("confirmation.requested", {
      confirmationId: "conf_1",
      toolCall: toolCall("b5", "c1", "exec", "{}"),
      risk: "sensitive",
      expiresAt: "2026-08-15T00:02:00.000Z",
    }))
    state = applyEvent(state, ev("confirmation.resolved", { confirmationId: "conf_1", decision: "once", by: "web" }))
    expect(state.pendingConfirmations).toEqual([])
    // Resolving an unknown id is a no-op.
    expect(applyEvent(state, ev("confirmation.resolved", { confirmationId: "conf_nope", decision: "reject", by: "web" })))
      .toBe(state)
  })

  it("keeps other cards when one resolves", () => {
    let state = initChat([])
    const push = (id: string) =>
      applyEvent(state, ev("confirmation.requested", {
        confirmationId: id, toolCall: toolCall("b", id, "exec", "{}"), risk: "safe", expiresAt: "t",
      }))
    state = push("conf_1")
    state = push("conf_2")
    state = applyEvent(state, ev("confirmation.resolved", { confirmationId: "conf_1", decision: "reject", by: "web" }))
    expect(state.pendingConfirmations.map((c) => c.confirmationId)).toEqual(["conf_2"])
  })
})

describe("questions (ask_user_questions)", () => {
  const QUESTIONS = [
    { text: "用哪个方案?", options: ["方案A", "方案B"] },
    { text: "补充说明?" },
  ]

  it("question.requested pushes a card with the questions intact", () => {
    const state = initChat([])
    const next = applyEvent(state, ev("question.requested", {
      questionId: "q_1",
      questions: QUESTIONS,
      expiresAt: "2026-09-11T00:10:00.000Z",
      noteText: "来自子代理 小李",
    }))
    expect(next.pendingQuestions).toEqual([
      {
        questionId: "q_1",
        questions: QUESTIONS,
        expiresAt: "2026-09-11T00:10:00.000Z",
        noteText: "来自子代理 小李",
      },
    ])
  })

  it("does not duplicate a still-pending question", () => {
    const payload = { questionId: "q_1", questions: QUESTIONS, expiresAt: "t" }
    let state = initChat([])
    state = applyEvent(state, ev("question.requested", payload))
    const next = applyEvent(state, ev("question.requested", payload))
    expect(next.pendingQuestions).toHaveLength(1)
  })

  it("question.resolved removes the card by questionId; unknown id is a no-op", () => {
    let state = initChat([])
    state = applyEvent(state, ev("question.requested", { questionId: "q_1", questions: QUESTIONS, expiresAt: "t" }))
    state = applyEvent(state, ev("question.resolved", { questionId: "q_1", answers: [["方案A"], []], by: "web" }))
    expect(state.pendingQuestions).toEqual([])
    expect(applyEvent(state, ev("question.resolved", { questionId: "q_nope", by: "timeout" }))).toBe(state)
  })
})

describe("mergeMessages (reconnect)", () => {
  it("replaces messages the fresh pull knows and keeps live-only messages", () => {
    const existing = initChat([msg("m1", "user", [text("b1", "old")])]).messages
    const fresh = [
      msg("m1", "user", [text("b1", "new")]),
      msg("m2", "assistant", [text("b2", "persisted")]),
    ]
    const merged = mergeMessages(existing, fresh)
    expect(merged.map((m) => m.id)).toEqual(["m1", "m2"])
    expect(merged[0]!.blocks[0]).toEqual({ kind: "text", blockId: "b1", text: "new" })
    expect(merged[1]!.blocks[0]).toEqual({ kind: "text", blockId: "b2", text: "persisted" })
  })

  it("keeps a live in-flight message not yet persisted", () => {
    const live = applyEvent(initChat([]), ev("message.created", { message: msg("m9", "assistant", []) })).messages
    const merged = mergeMessages(live, [msg("m1", "user", [text("b1", "hi")])])
    expect(merged.map((m) => m.id)).toEqual(["m9", "m1"])
    expect(merged[0]!.pending).toBe(true)
  })
})

describe("unrelated events", () => {
  it("ignores events outside the UI-relevant subset (llm.started/job/attachment)", () => {
    const state = initChat([msg("m1", "user", [text("b1", "hi")])])
    const payloads = new Map<string, unknown>([
      ["attachment.created", { messageId: "m1", block: { id: "b9", type: "attachment", mimeType: "text/plain", source: { type: "file", path: "/x" } } }],
      ["attachment.completed", { messageId: "m1", block: { id: "b9", type: "attachment", mimeType: "text/plain", source: { type: "file", path: "/x" } } }],
      ["llm.started", { model: "m", attempt: 1 }],
      ["llm.failed", { error: { code: "x", message: "m" }, willRetry: false }],
      ["job.started", { jobId: "j1" }],
      ["job.completed", { jobId: "j1", summary: "s" }],
      ["job.failed", { jobId: "j1", error: { code: "x", message: "m" } }],
    ])
    for (const [type, payload] of payloads) {
      const next = applyEvent(state, ev(type as AgentEvent["type"], payload))
      expect(next).toBe(state)
    }
  })
})

describe("llm retry hint", () => {
  it("sets a retry hint on llm.failed {willRetry:true} while the run keeps streaming", () => {
    const state = { ...initChat([]), runState: "running" as const }
    // The wire never carries `attempt` (the daemon's retry wrapper emits
    // error + willRetry only — see LlmFailedPayload), so the hint is set
    // with no attempt number; unknown synthetic fields are ignored.
    const next = applyEvent(state, ev("llm.failed", {
      error: { code: "llm_retry", message: "llm http 503: storm" }, willRetry: true, attempt: 2,
    }))
    expect(next.retryHint).toEqual({})
    expect(next.runState).toBe("running")
    // no attempt in the payload → the same set-but-unknown hint
    const bare = applyEvent(state, ev("llm.failed", {
      error: { code: "llm_retry", message: "llm http 503: storm" }, willRetry: true,
    }))
    expect(bare.retryHint).toEqual({})
  })

  it("clears the retry hint on llm.completed and run terminal events", () => {
    const base = { ...initChat([]), runState: "running" as const }
    const withHint = (): ChatState =>
      applyEvent(base, ev("llm.failed", { error: { code: "llm_retry", message: "503" }, willRetry: true }))

    const completed = applyEvent(withHint(), ev("llm.completed", { usage: {}, stopReason: "end_turn" }))
    expect(completed.retryHint).toBeNull()
    expect(completed.runState).toBe("running") // the run itself is still going

    expect(applyEvent(withHint(), ev("run.completed", { stopReason: "end_turn" })).retryHint).toBeNull()
    expect(applyEvent(withHint(), ev("run.failed", { error: { code: "llm_error", message: "boom" } })).retryHint)
      .toBeNull()
  })
})

describe("compaction state", () => {
  it("compaction.started marks compacting; completed clears it", () => {
    const state = initChat([])
    const started = applyEvent(state, ev("compaction.started", { phase: "post-run" }))
    expect(started.compacting).toBe(true)
    const done = applyEvent(started, ev("compaction.completed", { segments: 1, kept: 4, phase: "post-run", result: "ok" }))
    expect(done.compacting).toBe(false)
  })

  it("v3 wire shape: started carries phase, completed carries phase/result (typed, not cast)", () => {
    // 直接以 AgentEvent 类型内联构造（不经 ev 的 cast）：payload 形状错了就编
    // 译不过——这是协议适配的编译期守护。
    const started = (phase: CompactionPhase): AgentEvent => ({
      id: "e0", ts: "t", sessionId: "s1", type: "compaction.started", payload: { phase },
    })
    const finished = (result: "ok" | "failed" | "cancelled"): AgentEvent => ({
      id: "e1", ts: "t", sessionId: "s1", type: "compaction.completed",
      payload: { segments: 2, kept: 3, phase: "in-run", result },
    })
    expect(applyEvent(initChat([]), started("in-run")).compacting).toBe(true)
    expect(applyEvent(initChat([]), finished("failed")).compacting).toBe(false)
  })

  it("completed is always delivered: ANY result (ok/failed/cancelled) clears compacting", () => {
    // v3 协议：started 后 completed 必达——失败/被取消的压缩同样有配对的
    // completed，所以任意 result 都清 compacting，不能只认 ok。
    const finish = (result: "ok" | "failed" | "cancelled") =>
      ev("compaction.completed", { segments: 2, kept: 3, phase: "in-run", result })
    for (const result of ["ok", "failed", "cancelled"] as const) {
      const started = applyEvent(initChat([]), ev("compaction.started", { phase: "in-run" }))
      expect(applyEvent(started, finish(result)).compacting).toBe(false)
    }
    // ok 收尾不重复报条目：没有 error 横幅、没有落入消息流的条目。
    const started = applyEvent(initChat([]), ev("compaction.started", { phase: "in-run" }))
    const ok = applyEvent(started, finish("ok"))
    expect(ok.error).toBeUndefined()
    expect(ok.messages).toHaveLength(0)
  })

  it("run lifecycle events clear a stuck compacting state (dropped-frame backstop)", () => {
    const started = applyEvent(initChat([]), ev("compaction.started", { phase: "post-run" }))
    expect(applyEvent(started, ev("run.started", { trigger: "user" })).compacting).toBe(false)
    const again = applyEvent(initChat([]), ev("compaction.started", { phase: "post-run" }))
    expect(applyEvent(again, ev("run.completed", { stopReason: "end_turn" })).compacting).toBe(false)
    expect(applyEvent(again, ev("run.failed", { error: { code: "x", message: "y" } })).compacting).toBe(false)
  })

  it("compactingPhase mirrors the started phase and clears together with compacting", () => {
    // Important-2: the phase decides whether the cancel button renders — manual
    // must be distinguishable from in-run/post-run until the compaction ends.
    const started = applyEvent(initChat([]), ev("compaction.started", { phase: "manual" }))
    expect(started.compactingPhase).toBe("manual")
    const done = applyEvent(started, ev("compaction.completed", { segments: 1, kept: 2, phase: "manual", result: "ok" }))
    expect(done.compactingPhase).toBeUndefined()
    // run lifecycle also clears the phase (dropped-frame backstop)
    const again = applyEvent(initChat([]), ev("compaction.started", { phase: "post-run" }))
    expect(again.compactingPhase).toBe("post-run")
    expect(applyEvent(again, ev("run.started", { trigger: "user" })).compactingPhase).toBeUndefined()
  })
})

describe("optimistic user echo", () => {
  it("appendOptimisticUser adds a pending user bubble with a local- id", () => {
    const next = appendOptimisticUser(initChat([]), "在吗")
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]!.role).toBe("user")
    expect(next.messages[0]!.pending).toBe(true)
    expect(next.messages[0]!.id.startsWith("local-")).toBe(true)
    expect(next.messages[0]!.blocks).toEqual([{ kind: "text", blockId: "local", text: "在吗" }])
  })

  it("message.created replaces the optimistic twin (same text) instead of duplicating", () => {
    const optimistic = appendOptimisticUser(initChat([]), "在吗")
    const created = applyEvent(optimistic, ev("message.created", { message: msg("m9", "user", [text("b9", "在吗")]) }))
    expect(created.messages).toHaveLength(1)
    expect(created.messages[0]!.id).toBe("m9")
    expect(created.messages[0]!.pending).toBe(true) // server skeleton is still pending until message.completed
  })

  it("message.created for a different message keeps the optimistic twin", () => {
    const optimistic = appendOptimisticUser(initChat([]), "在吗")
    const created = applyEvent(optimistic, ev("message.created", { message: msg("m1", "assistant", [text("b1", "hi")]) }))
    expect(created.messages.map((m) => m.id)).toEqual([optimistic.messages[0]!.id, "m1"])
  })

  it("replaces the twin IN PLACE so later queued optimistic messages keep their order", () => {
    // Master's report: send "a" (compaction starts), then "b" (queued). The
    // server echo for "a" must take the twin's position — appending it would
    // hoard "b" above "a" until b's own echo lands.
    let state = appendOptimisticUser(initChat([]), "a")
    state = appendOptimisticUser(state, "b")
    const localB = state.messages[1]!.id
    state = applyEvent(state, ev("message.created", { message: msg("m1", "user", [text("b1", "a")]) }))
    expect(state.messages.map((m) => m.id)).toEqual(["m1", localB])
    expect(firstTextOf(state.messages[0]!)).toBe("a")
    expect(firstTextOf(state.messages[1]!)).toBe("b")
    // b's own echo completes the swap in place: [m1, m2] in send order.
    state = applyEvent(state, ev("message.created", { message: msg("m2", "user", [text("b2", "b")]) }))
    expect(state.messages.map((m) => m.id)).toEqual(["m1", "m2"])
  })

  it("mergeMessages drops an optimistic twin once the server pull knows the text", () => {
    const optimistic = appendOptimisticUser(initChat([]), "在吗")
    const merged = mergeMessages(optimistic.messages, [msg("m9", "user", [text("b9", "在吗")])])
    expect(merged.map((m) => m.id)).toEqual(["m9"])
    // still-unpersisted optimistic bubbles survive the merge
    const other = appendOptimisticUser(initChat([]), "还没落盘")
    const merged2 = mergeMessages(other.messages, [msg("m9", "user", [text("b9", "在吗")])])
    expect(merged2.map((m) => m.id)).toEqual([other.messages[0]!.id, "m9"])
  })
})

describe("queue reducer", () => {
  const base = (): ChatState => initChat([])
  const wireMsg = (id: string, text: string): Message => ({
    id, sessionId: "s", role: "user",
    blocks: [{ id: "b", type: "text", text }], createdAt: "t",
  })

  it("appendPendingQueueRow: a busy-session send starts as a local row, never a bubble", () => {
    // Master 2026-08-30 第二轮：忙会话（running/compacting）发送的消息从第一
    // 帧起就不进消息流——乐观回显搬到列表行（local- 前缀待确认 id）。
    let s = appendPendingQueueRow(base(), "排队消息", "wait")
    expect(s.messages).toHaveLength(0)
    expect(s.queue).toHaveLength(1)
    expect(s.queue[0]!.messageId.startsWith("local-")).toBe(true)
    expect(s.queue[0]!.text).toBe("排队消息")
    // FIFO：后发的排下面
    s = appendPendingQueueRow(s, "第二条", "steer")
    expect(s.queue.map((e) => e.text)).toEqual(["排队消息", "第二条"])
  })

  it("busy-send full chain: local row → ack rename → message.queued refresh → created lands the bubble", () => {
    let s = appendPendingQueueRow(base(), "排队消息", "wait")
    const localId = s.queue[0]!.messageId
    // ack 先到：改名本地行（收养）
    s = adoptQueuedId(s, "msg_9")
    expect(s.queue[0]!.messageId).toBe("msg_9")
    expect(s.queue[0]!.text).toBe("排队消息")
    expect(s.messages).toHaveLength(0)
    // message.queued 后到：id 已跟踪 → 只刷新处置，文本不丢
    s = applyEvent(s, ev("message.queued", { messageId: "msg_9", disposition: "wait", position: 0 }))
    expect(s.queue).toEqual([{ messageId: "msg_9", disposition: "wait", text: "排队消息" }])
    // 轮到它执行：created 删行、气泡落进消息流
    s = applyEvent(s, ev("message.created", { message: wireMsg("msg_9", "排队消息") }))
    expect(s.queue).toHaveLength(0)
    expect(s.messages.map((m) => m.id)).toEqual(["msg_9"])
    expect(localId.startsWith("local-")).toBe(true) // (id was never a bubble id)
  })

  it("message.queued first (before ack): adopts the local ROW (rename), not just bubbles", () => {
    let s = appendPendingQueueRow(base(), "排队消息", "wait")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_8", disposition: "wait" }))
    // 本地行被收养改名——不是落地一条空文本的新行（双行）
    expect(s.queue).toEqual([{ messageId: "msg_8", disposition: "wait", text: "排队消息" }])
    // 随后真 ack 到达：id 已跟踪 → no-op（不得偷走下一条的 local- 行）
    s = appendPendingQueueRow(s, "第二条", "wait")
    s = adoptQueuedId(s, "msg_8")
    expect(s.queue.map((e) => e.messageId)).toEqual(["msg_8", s.queue[1]!.messageId])
    expect(s.queue[0]!.text).toBe("排队消息")
    expect(s.queue[1]!.text).toBe("第二条")
  })

  it("cancel removes a still-local row (message never confirmed by the server)", () => {
    let s = appendPendingQueueRow(base(), "还没确认", "wait")
    s = applyEvent(s, ev("message.queue_cancelled", { all: true }))
    expect(s.queue).toHaveLength(0)
  })

  it("mergeQueue drops an unconfirmed local row (resync is authoritative)", () => {
    // 重连快照整体替换：本地未确认行被服务端真相取代——消息送达则服务端行
    // 重现（服务器 id），没送达则行消失（用户需重发），无幽灵行。
    let s = appendPendingQueueRow(base(), "断线前发送", "wait")
    s = mergeQueue(s, [{ messageId: "srv_1", disposition: "wait", text: "断线前发送" }])
    expect(s.queue).toEqual([{ messageId: "srv_1", disposition: "wait", text: "断线前发送" }])
  })

  it("message.queued moves the optimistic bubble into a queue row (idle→busy race bubble)", () => {
    // 空闲瞬间直发渲染了乐观气泡、run 随即开始：入队确认时气泡收走（文本带
    // 走），列表行是排队的唯一视图。
    let s = appendOptimisticUser(base(), "排队消息")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_9", disposition: "wait", position: 0 }))
    expect(s.queue).toEqual([{ messageId: "msg_9", disposition: "wait", text: "排队消息" }])
    expect(s.messages).toHaveLength(0)
  })

  it("message.steered removes the entry (injection → the bubble lands via message.created)", () => {
    let s = appendOptimisticUser(base(), "引导")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_1", disposition: "steer" }))
    s = applyEvent(s, ev("message.steered", { messageId: "msg_1" }))
    expect(s.queue).toHaveLength(0)
    // 注入的消息本体随后经 created 进消息流（历史消息，正常气泡）。
    s = applyEvent(s, ev("message.created", { message: wireMsg("msg_1", "引导") }))
    expect(s.messages.map((m) => m.id)).toEqual(["msg_1"])
  })

  it("message.queue_cancelled removes the entry (its bubble was never kept)", () => {
    let s = appendOptimisticUser(base(), "取消我")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_2", disposition: "wait" }))
    s = applyEvent(s, ev("message.queue_cancelled", { messageId: "msg_2" }))
    expect(s.queue).toHaveLength(0)
    expect(s.messages).toHaveLength(0)
  })

  it("dequeue execution: message.created with a queued id removes the entry, the bubble lands at the end", () => {
    let s = appendOptimisticUser(base(), "执行我")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_3", disposition: "wait", position: 0 }))
    s = applyEvent(s, ev("message.created", { message: wireMsg("msg_3", "执行我") }))
    expect(s.queue).toHaveLength(0)
    expect(s.messages.map((m) => m.id)).toEqual(["msg_3"])
  })

  it("mergeQueue rebuilds the rows after reconnect (server order, no bubble materialization)", () => {
    const s = mergeQueue(base(), [
      { messageId: "msg_5", disposition: "wait", text: "断线期间的排队" },
      { messageId: "msg_6", disposition: "steer", text: "第二条" },
    ])
    expect(s.queue.map((e) => e.messageId)).toEqual(["msg_5", "msg_6"])
    expect(s.messages).toHaveLength(0)
  })

  it("adoptQueuedId swaps the oldest local- pending bubble (ack-first path)", () => {
    let s = appendOptimisticUser(base(), "via ack")
    s = adoptQueuedId(s, "msg_7")
    expect(s.messages.some((m) => m.id === "msg_7")).toBe(true)
    // ack 先到改名后，message.queued 仍能按 id 找到气泡收走并建行。
    s = applyEvent(s, ev("message.queued", { messageId: "msg_7", disposition: "wait" }))
    expect(s.queue).toEqual([{ messageId: "msg_7", disposition: "wait", text: "via ack" }])
    expect(s.messages).toHaveLength(0)
  })

  it("adoptQueuedId is a no-op for an already-tracked id (must not steal the NEXT bubble)", () => {
    // 常见序是 message.queued 先于 ack：气泡已被收走、行已存在。此时 ack 若
    // 盲目把"最早的 local- 气泡"改名，会偷走用户随后新发的那条。
    let s = appendOptimisticUser(base(), "已入队的那条")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_a", disposition: "wait" }))
    s = appendOptimisticUser(s, "新来的")
    s = adoptQueuedId(s, "msg_a")
    expect(s.queue).toHaveLength(1)
    expect(s.messages.map((m) => m.id).every((id) => id.startsWith("local-"))).toBe(true)
  })

  it("queued rows keep their send order (FIFO)", () => {
    let s = appendOptimisticUser(base(), "第一条")
    s = appendOptimisticUser(s, "第二条")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_a", disposition: "wait" }))
    s = applyEvent(s, ev("message.queued", { messageId: "msg_b", disposition: "wait" }))
    expect(s.messages).toHaveLength(0)
    expect(s.queue.map((e) => e.messageId)).toEqual(["msg_a", "msg_b"])
    expect(s.queue.map((e) => e.text)).toEqual(["第一条", "第二条"])
  })

  it("message.queued for an already-tracked id skips adoption (no row-text steal, no double)", () => {
    // 恢复重播恰逢在途乐观气泡：queue 已含 msg_x（行文本"旧排队"），再收一条
    // message.queued{msg_x}。必须先查重——否则最早的 pending local- 气泡（"新来
    // 的"）会被收走、行文本被张冠李戴。
    let s = appendOptimisticUser(base(), "旧排队")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_x", disposition: "steer" }))
    s = appendOptimisticUser(s, "新来的")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_x", disposition: "wait" }))
    // 行保留并按事件刷新处置（恢复重播把 steer/interrupt 降级报为 wait），文本不换
    expect(s.queue).toEqual([{ messageId: "msg_x", disposition: "wait", text: "旧排队" }])
    // "新来的"气泡原样保留（它属于尚未确认的下一条消息）
    expect(s.messages).toHaveLength(1)
    expect(firstTextOf(s.messages[0]!)).toBe("新来的")
  })

  it("message.queue_cancelled {all:true} clears every entry", () => {
    let s = appendOptimisticUser(base(), "还在排队")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_q", disposition: "wait" }))
    s = applyEvent(s, ev("message.queue_cancelled", { all: true }))
    expect(s.queue).toHaveLength(0)
    expect(s.messages).toHaveLength(0)
  })

  it("run lifecycle events leave the queue untouched", () => {
    let s = appendOptimisticUser(base(), "排队中")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_q", disposition: "wait" }))
    s = applyEvent(s, ev("run.completed", { stopReason: "end_turn" }))
    expect(s.queue).toHaveLength(1)
    s = applyEvent(s, ev("run.failed", { error: { code: "x", message: "boom" } }))
    expect(s.queue).toHaveLength(1)
  })

  it("message.queued with no pending local- bubble still records the row (empty text)", () => {
    // Replay/refresh edge: the event arrives with no optimistic bubble to adopt.
    const s = applyEvent(base(), ev("message.queued", { messageId: "msg_r", disposition: "wait" }))
    expect(s.queue).toEqual([{ messageId: "msg_r", disposition: "wait", text: "" }])
  })
})

describe("reconnect resend (issue #8)", () => {
  const bubble = (text: string): ChatState => appendOptimisticUser(initChat([]), text)
  const queued = (text: string, disposition: "steer" | "wait" | "interrupt" = "wait"): ChatState => ({
    ...initChat([]),
    queue: [{ messageId: "local-abc", disposition, text }],
  })

  it("collectPendingSends snapshots local- queue rows and pending bubbles, not confirmed state", () => {
    // 手工构造（不走 message.queued reducer——它会把最早的 local- 行转正）。
    let s: ChatState = {
      ...initChat([]),
      queue: [
        { messageId: "msg_ok", disposition: "wait", text: "已确认排队" },
        { messageId: "local-abc", disposition: "interrupt", text: "排队一条" },
      ],
    }
    s = appendOptimisticUser(s, "直发一条")
    s = { ...s, messages: [...s.messages, { id: "m1", role: "user" as const, pending: false, blocks: [{ kind: "text" as const, blockId: "b", text: "已确认气泡" }] }] }

    const before = collectPendingSends(s)
    expect(before.map((p) => p.text).sort()).toEqual(["排队一条", "直发一条"])
    expect(before.find((p) => p.text === "排队一条")!.disposition).toBe("interrupt")
  })

  it("undeliveredPendingSends keeps only sends absent from both the resynced queue and messages", () => {
    const before = [
      { text: "只在队列", disposition: "steer" as const },
      { "text": "只在消息流", disposition: "wait" as const },
      { text: "哪儿都没有", disposition: "steer" as const },
    ]
    let after = mergeQueue(initChat([]), [{ messageId: "msg_a", disposition: "steer", text: "只在队列" }])
    after = { ...after, messages: [{ id: "m1", role: "user" as const, pending: false, blocks: [{ kind: "text" as const, blockId: "b", text: "只在消息流" }] }] }

    expect(undeliveredPendingSends(before, after).map((p) => p.text)).toEqual(["哪儿都没有"])
  })

  it("undeliveredPendingSends: a duplicate that arrived marks its twin delivered too (no double-send)", () => {
    const before = [
      { text: "同样的话", disposition: "steer" as const },
      { text: "同样的话", disposition: "wait" as const },
    ]
    const after = mergeQueue(initChat([]), [{ messageId: "msg_a", disposition: "steer", text: "同样的话" }])
    expect(undeliveredPendingSends(before, after)).toEqual([])
  })

  it("undeliveredPendingSends skips empty texts (attachment-only sends cannot be matched)", () => {
    const before = [{ text: "", disposition: "steer" as const }]
    expect(undeliveredPendingSends(before, initChat([]))).toEqual([])
  })

  it("dropLocalPending removes the stale optimistic rows for the resent texts and nothing else", () => {
    const s: ChatState = {
      ...initChat([]),
      queue: [
        { messageId: "local-abc", disposition: "wait", text: "没到" },
        { messageId: "msg_keep", disposition: "wait", text: "确认过的排队" },
      ],
      messages: appendOptimisticUser(initChat([]), "也没到").messages,
    }

    const dropped = dropLocalPending(s, ["没到", "也没到"])
    expect(dropped.queue).toEqual([{ messageId: "msg_keep", disposition: "wait", text: "确认过的排队" }])
    expect(dropped.messages).toHaveLength(0)
  })
})

describe("message.truncated（编辑重试/重新生成）", () => {
  it("截断事件把起点起的服务端消息退出视图；本地乐观气泡不受影响", () => {
    let s = initChat([
      msg("msg_a", "user", [text("t1", "问一")]),
      msg("msg_b", "assistant", [text("t2", "答一")]),
      msg("msg_c", "user", [text("t3", "问二")]),
      msg("msg_d", "assistant", [text("t4", "答二")]),
    ])
    // 重试的乐观回显（本地气泡）先进视图，截断事件随后到达
    s = appendOptimisticUser(s, "问二改")
    s = applyEvent(s, ev("message.truncated", { fromMessageId: "msg_c" }))
    expect(s.messages.map((m) => m.id)).toEqual(["msg_a", "msg_b", expect.stringMatching(/^local-/) ])
    expect(firstTextOf(s.messages[2]!)).toBe("问二改")
    // 幂等：事件重放/重复到达不二次改变视图
    const again = applyEvent(s, ev("message.truncated", { fromMessageId: "msg_c" }))
    expect(again.messages.map((m) => m.id)).toEqual(s.messages.map((m) => m.id))
  })

  it("run 上下文里的新消息（id 晚于截断起点）照常进入视图", () => {
    let s = initChat([
      msg("msg_a", "user", [text("t1", "问一")]),
      msg("msg_b", "assistant", [text("t2", "答一")]),
    ])
    s = applyEvent(s, ev("message.truncated", { fromMessageId: "msg_a" }))
    expect(s.messages).toHaveLength(0)
    // 重试产生的新一轮照常落位
    s = applyEvent(s, ev("message.created", { message: msg("msg_new", "user", [text("t9", "问一改")]) }))
    expect(s.messages.map((m) => m.id)).toEqual(["msg_new"])
  })

  it("被中断的助手消息（stopReason aborted）在视图里带 aborted 标记", () => {
    const half = { ...msg("msg_half", "assistant", [text("t", "半截")]), stopReason: "aborted" }
    let s = initChat([msg("msg_q", "user", [text("t0", "问")]), half as Message])
    expect(s.messages[1]!.aborted).toBe(true)
    expect(s.messages[0]!.aborted).toBeUndefined()
    // 流式路径同样带标记：message.completed 全量校准
    s = initChat([])
    s = applyEvent(s, ev("message.created", { message: half }))
    s = applyEvent(s, ev("message.completed", { message: half }))
    expect(s.messages[0]!.aborted).toBe(true)
  })
})

describe("parseTeamMail（组员来信识别）", () => {
  it("普通用户消息不命中", () => {
    expect(parseTeamMail("帮我看看这个报错")).toBeNull()
    expect(parseTeamMail("【说明】这不是来信")).toBeNull()
  })

  it("单条来信：剥掉身份前缀，拆出发件人与正文", () => {
    const raw = '<system-reminder kind="team-identity">你是 agent team「crew」的组员 builder；以下消息来自你的收信箱。</system-reminder>\n\n【来自 组长】\n请开始解析 if 语句'
    const mail = parseTeamMail(raw)
    expect(mail).not.toBeNull()
    expect(mail!.entries).toEqual([{ from: "组长", text: "请开始解析 if 语句" }])
  })

  it("多条拼接来信（组长收信箱）：逐条拆解", () => {
    const raw = "【来自 组员 builder】\n任务 #1 已完成\n\n【来自 组员 tester】\n测试全部通过"
    const mail = parseTeamMail(raw)
    expect(mail!.entries).toEqual([
      { from: "组员 builder", text: "任务 #1 已完成" },
      { from: "组员 tester", text: "测试全部通过" },
    ])
  })

  it("正文里再出现【来自 字样不会把后面的内容吞进上一位发件人", () => {
    const raw = "【来自 组员 builder】\n完成。引用了【来自 组长】的指示字样但没有新分段头"
    const mail = parseTeamMail(raw)
    // 只认段首标头：第一个标头之后没有第二个段首（引用在正文中段）
    expect(mail!.entries).toHaveLength(1)
    expect(mail!.entries[0]!.text).toContain("引用了【来自 组长】的指示")
  })
})
