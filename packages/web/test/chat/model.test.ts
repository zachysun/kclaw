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
  adoptQueuedId,
  type AgentEvent,
  type Block,
  type ChatState,
  type Message,
  appendOptimisticUser,
} from "../../src/chat/model.js"

function msg(id: string, role: "user" | "assistant" | "tool", blocks: Block[]): Message {
  return { id, sessionId: "s1", role, blocks, createdAt: "2026-08-15T00:00:00.000Z" }
}

function ev(type: AgentEvent["type"], payload: unknown, sessionId = "s1"): AgentEvent {
  return { id: `evt-${type}`, ts: "2026-08-15T00:00:00.000Z", type, payload, sessionId } as AgentEvent
}

const text = (id: string, text: string) => ({ id, type: "text" as const, text })
const thinking = (id: string, text: string) => ({ id, type: "thinking" as const, text })
const note = (id: string, kind: string, text: string) => ({ id, type: "note" as const, kind, text })
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

  it("carries the compact meta on compact notes (persisted and via note.emitted)", () => {
    const compact = { ...note("b2", "compact", "早期对话已压缩为 2 段"), compact: { segments: 2, kept: 4 } }
    const view = initChat([msg("m1", "user", [text("b1", "hi"), compact as Block])])
    expect(view.messages[0]!.blocks[1]).toEqual({
      kind: "note", blockId: "b2", noteKind: "compact", text: "早期对话已压缩为 2 段", compact: { segments: 2, kept: 4 },
    })
    const live = applyEvent(initChat([msg("m9", "user", [text("b1", "hi")])]), ev("note.emitted", { messageId: "m9", block: compact }))
    expect((live.messages[0]!.blocks[1] as { compact?: unknown }).compact).toEqual({ segments: 2, kept: 4 })
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
    state = applyEvent(state, ev("confirmation.resolved", { confirmationId: "conf_1", approved: true, by: "web" }))
    expect(state.pendingConfirmations).toEqual([])
    // Resolving an unknown id is a no-op.
    expect(applyEvent(state, ev("confirmation.resolved", { confirmationId: "conf_nope", approved: true, by: "web" })))
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
    state = applyEvent(state, ev("confirmation.resolved", { confirmationId: "conf_1", approved: false, by: "web" }))
    expect(state.pendingConfirmations.map((c) => c.confirmationId)).toEqual(["conf_2"])
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
    // attempt carried in the payload → recorded
    const next = applyEvent(state, ev("llm.failed", {
      error: { code: "llm_retry", message: "llm http 503: storm" }, willRetry: true, attempt: 2,
    }))
    expect(next.retryHint).toEqual({ attempt: 2 })
    expect(next.runState).toBe("running")
    // no attempt in the payload → "unknown" (attempt undefined) but still set
    const bare = applyEvent(state, ev("llm.failed", {
      error: { code: "llm_retry", message: "llm http 503: storm" }, willRetry: true,
    }))
    expect(bare.retryHint).toEqual({ attempt: undefined })
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
    const started = applyEvent(state, ev("compaction.started", {}))
    expect(started.compacting).toBe(true)
    const done = applyEvent(started, ev("compaction.completed", { segments: 1, kept: 4 }))
    expect(done.compacting).toBe(false)
  })

  it("run lifecycle events clear a stuck compacting state (failed compaction emits no completed)", () => {
    const started = applyEvent(initChat([]), ev("compaction.started", {}))
    expect(applyEvent(started, ev("run.started", { trigger: "user" })).compacting).toBe(false)
    const again = applyEvent(initChat([]), ev("compaction.started", {}))
    expect(applyEvent(again, ev("run.completed", { stopReason: "end_turn" })).compacting).toBe(false)
    expect(applyEvent(again, ev("run.failed", { error: { code: "x", message: "y" } })).compacting).toBe(false)
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

  it("message.queued adopts the optimistic bubble id and tracks the entry", () => {
    let s = appendOptimisticUser(base(), "排队消息")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_9", disposition: "wait", position: 0 }))
    expect(s.queue).toEqual([{ messageId: "msg_9", disposition: "wait", state: "queued", text: "排队消息" }])
    expect(s.messages.some((m) => m.id === "msg_9")).toBe(true)
    expect(s.messages.some((m) => m.id.startsWith("local-"))).toBe(false)
  })

  it("message.steered flips state to injected", () => {
    let s = appendOptimisticUser(base(), "引导")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_1", disposition: "steer" }))
    s = applyEvent(s, ev("message.steered", { messageId: "msg_1" }))
    expect(s.queue[0]!.state).toBe("injected")
  })

  it("message.queue_cancelled removes the bubble and the entry", () => {
    let s = appendOptimisticUser(base(), "取消我")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_2", disposition: "wait" }))
    s = applyEvent(s, ev("message.queue_cancelled", { messageId: "msg_2" }))
    expect(s.queue).toHaveLength(0)
    expect(s.messages.some((m) => m.id === "msg_2")).toBe(false)
  })

  it("dequeue execution: message.created with a queued id removes the queue entry", () => {
    let s = appendOptimisticUser(base(), "执行我")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_3", disposition: "wait", position: 0 }))
    s = applyEvent(s, ev("message.created", { message: wireMsg("msg_3", "执行我") }))
    expect(s.queue).toHaveLength(0)
    expect(s.messages.some((m) => m.id === "msg_3")).toBe(true)
  })

  it("mergeQueue rebuilds bubbles after reconnect", () => {
    let s = base()
    s = mergeQueue(s, [{ messageId: "msg_5", disposition: "wait", text: "断线期间的排队" }])
    expect(s.queue[0]!.messageId).toBe("msg_5")
    expect(s.messages.some((m) => m.id === "msg_5" && m.blocks[0]!.kind === "text")).toBe(true)
  })

  it("adoptQueuedId swaps the oldest local- pending bubble (ack path)", () => {
    let s = appendOptimisticUser(base(), "via ack")
    s = adoptQueuedId(s, "msg_7")
    expect(s.messages.some((m) => m.id === "msg_7")).toBe(true)
    expect(s.messages.some((m) => m.id.startsWith("local-"))).toBe(false)
  })

  it("message.queued swaps ids IN PLACE so bubbles keep their send order (FIFO adoption)", () => {
    let s = appendOptimisticUser(base(), "第一条")
    s = appendOptimisticUser(s, "第二条")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_a", disposition: "wait" }))
    s = applyEvent(s, ev("message.queued", { messageId: "msg_b", disposition: "wait" }))
    expect(s.messages.map((m) => m.id)).toEqual(["msg_a", "msg_b"])
    expect(s.queue.map((e) => e.messageId)).toEqual(["msg_a", "msg_b"])
    expect(s.queue.map((e) => e.text)).toEqual(["第一条", "第二条"])
  })

  it("message.queue_cancelled {all:true} clears queued entries+bubbles but keeps injected ones", () => {
    let s = appendOptimisticUser(base(), "已注入的引导")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_i", disposition: "steer" }))
    s = applyEvent(s, ev("message.steered", { messageId: "msg_i" }))
    s = appendOptimisticUser(s, "还在排队")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_q", disposition: "wait" }))
    s = applyEvent(s, ev("message.queue_cancelled", { all: true }))
    // injected entry and its bubble stay (the message is already in history)
    expect(s.queue.map((e) => e.messageId)).toEqual(["msg_i"])
    expect(s.queue[0]!.state).toBe("injected")
    expect(s.messages.some((m) => m.id === "msg_i")).toBe(true)
    // queued entry and its never-persisted bubble are gone
    expect(s.messages.some((m) => m.id === "msg_q")).toBe(false)
  })

  it("run lifecycle events leave the queue untouched", () => {
    let s = appendOptimisticUser(base(), "排队中")
    s = applyEvent(s, ev("message.queued", { messageId: "msg_q", disposition: "wait" }))
    s = applyEvent(s, ev("run.completed", { stopReason: "end_turn" }))
    expect(s.queue).toHaveLength(1)
    s = applyEvent(s, ev("run.failed", { error: { code: "x", message: "boom" } }))
    expect(s.queue).toHaveLength(1)
  })
})
