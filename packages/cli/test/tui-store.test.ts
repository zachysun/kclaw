/**
 * ChatStore unit tests: the frame-view → state bookkeeping both ledgers
 * (history for <Static>, transcript for the Ctrl+O view) are driven through
 * the same show()/notice() calls the orchestrator makes. No React, no ink.
 */
import { describe, expect, it } from "vitest"
import type { Message } from "@kclaw/core"
import { ChatStore, type TranscriptEntry } from "../src/tui/store.js"
import type { DisplayView } from "../src/chat-surface.js"

const view = (v: DisplayView): DisplayView => v

function makeStore(showThinking = false): ChatStore {
  return new ChatStore({ showThinking, onExit: () => {} })
}

describe("text streaming ledger", () => {
  it("accumulates deltas into one history item at text-end", () => {
    const store = makeStore()
    store.show(view({ kind: "text", delta: "你好" }))
    store.show(view({ kind: "text", delta: "，世界" }))
    expect(store.getState().dynamic.streamingText).toBe("你好，世界")
    store.show(view({ kind: "text-end" }))
    const items = store.getState().history
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "text", text: "你好，世界" })
    expect(store.getState().dynamic.streamingText).toBe("")
  })

  it("keeps the live transcript in sync while transcriptLive", () => {
    const store = makeStore()
    store.replaceTranscript([])
    store.show(view({ kind: "text", delta: "a" }))
    store.show(view({ kind: "text", delta: "b" }))
    const transcript = store.getState().transcript
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({ kind: "assistant-text", text: "ab" })
    // 第二个文本块开新条目
    store.show(view({ kind: "text-end" }))
    store.show(view({ kind: "text", delta: "c" }))
    expect(store.getState().transcript.map((e) => (e.kind === "tool" ? "" : e.text))).toEqual(["ab", "c"])
  })

  it("does not touch the transcript while not transcriptLive", () => {
    const store = makeStore()
    store.show(view({ kind: "text", delta: "x" }))
    store.show(view({ kind: "text-end" }))
    expect(store.getState().transcript).toHaveLength(0)
    expect(store.getState().history).toHaveLength(1)
  })
})

describe("thinking ledger", () => {
  it("folds into one timed history line at thinking-end and clears the live text", () => {
    const store = makeStore(true)
    store.show(view({ kind: "thinking", delta: "推理中" }))
    expect(store.getState().dynamic.thinkingText).toBe("推理中")
    store.show(view({ kind: "thinking-end" }))
    const items = store.getState().history
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe("thinking")
    expect((items[0] as { seconds: number }).seconds).toBeGreaterThanOrEqual(1)
    expect(store.getState().dynamic.thinkingText).toBeUndefined()
    expect(store.getState().dynamic.thinkingStartedAt).toBeUndefined()
  })

  it("keeps thinking live text only when showThinking is on", () => {
    const off = makeStore(false)
    off.show(view({ kind: "thinking", delta: "深层" }))
    expect(off.getState().dynamic.thinkingText).toBeUndefined()
    const on = makeStore(true)
    on.show(view({ kind: "thinking", delta: "深层" }))
    expect(on.getState().dynamic.thinkingText).toBe("深层")
  })
})

describe("tool pairing", () => {
  it("a running tool row moves to a paired history item at its result", () => {
    const store = makeStore()
    store.show(view({ kind: "tool-call", callId: "c1", name: "bash", args: { command: "ls" } }))
    expect(store.getState().dynamic.runningTools).toHaveLength(1)
    store.show(view({ kind: "tool-result", callId: "c1", status: "ok", durationMs: 12, output: "a\nb" }))
    expect(store.getState().dynamic.runningTools).toHaveLength(0)
    expect(store.getState().history[0]).toMatchObject({
      kind: "tool",
      name: "bash",
      status: "ok",
      durationMs: 12,
      outputSummary: "a b",
    })
  })

  it("an unpaired result still lands (name marked unknown)", () => {
    const store = makeStore()
    store.show(view({ kind: "tool-result", callId: "ghost", status: "error", durationMs: 1, output: "nope" }))
    expect(store.getState().history[0]).toMatchObject({ kind: "tool", name: "未知工具", status: "error" })
  })

  it("live transcript closes the open tool entry with the result's full output", () => {
    const store = makeStore()
    store.replaceTranscript([])
    store.show(view({ kind: "tool-call", callId: "c2", name: "fs_read", args: { path: "a" } }))
    store.show(view({ kind: "tool-result", callId: "c2", status: "ok", durationMs: 3, output: "全文……" }))
    const entry = store.getState().transcript[0]
    expect(entry).toMatchObject({ kind: "tool", name: "fs_read", status: "ok", durationMs: 3, output: "全文……" })
  })
})

describe("status + notices", () => {
  it("run-completed records the usage", () => {
    const store = makeStore()
    store.show(view({ kind: "run-completed", stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 45 } }))
    expect(store.getState().status.inputTokens).toBe(120)
    expect(store.getState().status.outputTokens).toBe(45)
  })

  it("notices and run failures land with their tone", () => {
    const store = makeStore()
    store.notice("[reconnected]", "dim")
    store.show(view({ kind: "run-failed", message: "boom" }))
    store.show(view({ kind: "command-error", message: "未知命令" }))
    const notices = store.getState().history.filter((i) => i.kind === "notice")
    expect(notices.map((i) => (i as { text: string; tone: string }).tone)).toEqual(["dim", "error", "error"])
  })

  it("echo goes to history; plain messages also land in the transcript, slash lines do not", () => {
    const store = makeStore()
    store.replaceTranscript([])
    store.pushEcho("帮我看看")
    store.pushEcho("/help")
    expect(store.getState().history.filter((i) => i.kind === "echo")).toHaveLength(2)
    const users = store.getState().transcript.filter((e) => e.kind === "user")
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ text: "帮我看看" })
  })
})

describe("input history (spec B3)", () => {
  const msg = (id: string, role: Message["role"], blocks: Message["blocks"]): Message =>
    ({ id, sessionId: "s", role, blocks, createdAt: "t" }) as Message

  it("keeps plain user texts, drops machine-sent messages carrying provenance notes", () => {
    const store = makeStore()
    store.setInputHistory([
      msg("m1", "user", [{ id: "b1", type: "text", text: "第一条" }]),
      msg("m2", "user", [
        { id: "b2", type: "note", kind: "team", text: "本消息为团队投递…" },
        { id: "b3", type: "text", text: "投递内容" },
      ]),
      msg("m3", "user", [
        { id: "b4", type: "note", kind: "memory", text: "记忆召回" },
        { id: "b5", type: "text", text: "用户自己的话" },
      ]),
      msg("m4", "assistant", [{ id: "b6", type: "text", text: "回复不算输入历史" }]),
    ])
    expect(store.getState().inputHistory).toEqual(["第一条", "用户自己的话"])
  })
})

describe("transcript sync", () => {
  it("beginTranscriptSync stops live appends and kills open-entry indexes", () => {
    const store = makeStore()
    store.replaceTranscript([])
    store.show(view({ kind: "text", delta: "进行中" }))
    store.beginTranscriptSync()
    expect(store.getState().transcriptLive).toBe(false)
    expect(store.getState().overlays.transcript).toBe(true)
    // fetch 回来替换；此后的 delta 开新条目，不会接在拉取到的条目后面
    store.replaceTranscript([{ id: 1, kind: "user", text: "历史消息" } as TranscriptEntry])
    store.show(view({ kind: "text", delta: "新" }))
    const transcript = store.getState().transcript
    expect(transcript[0]).toMatchObject({ kind: "user", text: "历史消息" })
    expect(transcript[1]).toMatchObject({ kind: "assistant-text", text: "新" })
  })
})

describe("pending cards queue", () => {
  const confirmPayload = {
    confirmationId: "c1",
    toolCall: { id: "b", type: "tool_call" as const, callId: "k", name: "bash", args: {}, argsJson: "ls" },
    risk: "sensitive" as const,
    expiresAt: "soon",
  }

  it("confirm resolves FIFO with the chosen verdict and leaves a verdict line", async () => {
    const store = makeStore()
    const p1 = store.confirm(confirmPayload)
    const p2 = store.confirm({ ...confirmPayload, confirmationId: "c2" })
    store.resolveConfirm("project")
    await expect(p1).resolves.toBe("project")
    store.resolveConfirm("reject")
    await expect(p2).resolves.toBe("reject")
    const verdicts = store.getState().history.filter((i) => i.kind === "notice")
    expect(verdicts.map((i) => (i as { text: string }).text)).toEqual(["已允许（本项目）", "已拒绝"])
    expect(store.getState().pending.confirms).toHaveLength(0)
  })

  it("question and choice queues resolve through the store", async () => {
    const store = makeStore()
    const q = store.ask({ questionId: "q1", questions: [{ text: "选" }], expiresAt: "t" })
    store.resolveQuestion([["A"]])
    await expect(q).resolves.toEqual([["A"]])
    const c = store.choose("选择", [{ value: "x", label: "X" }])
    store.resolveChoice(undefined)
    await expect(c).resolves.toBeUndefined()
  })
})

describe("session switch", () => {
  it("resets the dynamic area, transcript and ledger indexes but keeps the status mode", () => {
    const store = makeStore(true)
    store.modeChanged("acceptEdits")
    store.replaceTranscript([])
    store.show(view({ kind: "tool-call", callId: "c", name: "bash", args: {} }))
    store.sessionChanged("ses_next")
    expect(store.getState().status.sessionId).toBe("ses_next")
    expect(store.getState().status.mode).toBe("acceptEdits")
    expect(store.getState().dynamic.runningTools).toHaveLength(0)
    expect(store.getState().transcript).toHaveLength(0)
    expect(store.getState().transcriptLive).toBe(false)
  })
})

describe("queue row (spec B3)", () => {
  it("queued messages count in, leaves on left-queue, and a session switch clears the row", () => {
    const store = makeStore()
    store.show(view({ kind: "queued", messageId: "m1" }))
    store.show(view({ kind: "queued", messageId: "m2" }))
    store.show(view({ kind: "queued", messageId: "m1" })) // 重复入队只计一次
    expect(store.getState().dynamic.queuedIds).toEqual(["m1", "m2"])
    store.show(view({ kind: "left-queue", messageIds: ["m1", "m3"] }))
    expect(store.getState().dynamic.queuedIds).toEqual(["m2"])
    store.sessionChanged("ses_next")
    expect(store.getState().dynamic.queuedIds).toHaveLength(0)
  })
})

describe("tool output truncation (spec B7)", () => {
  it("marks summaries that were cut so the row can point at the transcript view", () => {
    const store = makeStore()
    const long = "长".repeat(100)
    store.show(view({ kind: "tool-result", callId: "x1", status: "ok", durationMs: 1, output: long }))
    expect(store.getState().history[0]).toMatchObject({ kind: "tool", outputTruncated: true })
    store.show(view({ kind: "tool-result", callId: "x2", status: "ok", durationMs: 1, output: "短" }))
    expect(store.getState().history[1]).toMatchObject({ kind: "tool", outputTruncated: false })
  })
})

describe("exit gate", () => {
  it("requestExit flips exiting once and fires onExit", () => {
    let exits = 0
    const store = new ChatStore({ showThinking: false, onExit: () => { exits += 1 } })
    expect(store.getState().exiting).toBe(false)
    store.requestExit()
    expect(store.getState().exiting).toBe(true)
    expect(exits).toBe(1)
  })
})
