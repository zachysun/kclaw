/**
 * renderFrame unit tests — the orchestrator's per-frame router, driven with
 * a synthetic ChatCtx (a recording ChatSurface; no daemon, no terminal).
 * Covers the compaction lifecycle events: started prints one dim hint line
 * (the pre-run compaction is otherwise a silent multi-second gap between
 * send and run.started), completed prints the one-line "compacted to N
 * segments" summary, the per-turn re-attached compact note stays silent,
 * notes and memory hints route through the surface, and the question flow
 * collects answers through the surface and sends exactly one resolve frame.
 */
import { describe, it, expect } from "vitest"
import { renderFrame, type ChatCtx } from "../src/chat.js"
import type { DisplayView } from "../src/chat-surface.js"
import type { AgentEvent, NoteBlock } from "@kclaw/core"

/** A recording ChatSurface: every view and notice lands in arrays for assertions. */
function makeSurface() {
  const notices: Array<{ text: string; tone: string }> = []
  const shows: DisplayView[] = []
  return {
    notices,
    shows,
    askedPayloads: [] as unknown[],
    show(view: DisplayView): void {
      shows.push(view)
    },
    notice(text: string, tone: "plain" | "dim" | "error"): void {
      notices.push({ text, tone })
    },
    async confirm() {
      return "once" as const
    },
    async ask(p: unknown) {
      this.askedPayloads.push(p)
      return [["方案A"], ["没有补充"], ["db", "api"]]
    },
    async choose() {
      return undefined
    },
    modeChanged() {},
    busyChanged() {},
    sessionChanged() {},
  }
}

function makeCtx(surface = makeSurface()): { ctx: ChatCtx; surface: ReturnType<typeof makeSurface>; sent: unknown[] } {
  const sent: unknown[] = []
  const ctx = {
    home: undefined,
    client: {} as never,
    ws: { send: (frame: unknown) => sent.push(frame) },
    sessionId: "s1",
    surface,
    auto: "ask",
    pendingAttachments: [],
  } as unknown as ChatCtx
  return { ctx, surface, sent }
}

function ev(type: AgentEvent["type"], payload: unknown): AgentEvent {
  return { id: `evt-${type}`, ts: "2026-08-28T00:00:00.000Z", type, payload, sessionId: "s1" } as AgentEvent
}

/** Run one render, returning what the surface received. */
async function capture(render: (ctx: ChatCtx) => Promise<unknown>): Promise<{ surface: ReturnType<typeof makeSurface>; sent: unknown[] }> {
  const { ctx, surface, sent } = makeCtx()
  await render(ctx)
  return { surface, sent }
}

describe("renderFrame compaction events", () => {
  it("prints one dim hint on compaction.started and stays quiet on completed", async () => {
    const { ctx, surface } = makeCtx()
    const done1 = await renderFrame(ev("compaction.started", {}), ctx)
    expect(done1).toBe(false)
    const done2 = await renderFrame(ev("compaction.completed", { segments: 1, kept: 4 }), ctx)
    expect(done2).toBe(false)
    const texts = surface.shows.map((v) => (v.kind === "system" ? v.text : ""))
    expect(texts.join("\n")).toContain("正在压缩")
    expect(texts.join("\n")).toContain("已压缩为 1 段")
    expect(texts.join("\n")).toContain("保留最近 4 条")
    expect(surface.shows.every((v) => v.kind === "system")).toBe(true)
  })
})

describe("renderFrame note.emitted", () => {
  it("keeps printing memory and cron notes as before", async () => {
    const block: NoteBlock = { id: "b1", type: "note", kind: "memory", text: "记住的要点" }
    const { surface } = await capture((ctx) => renderFrame(ev("note.emitted", { messageId: "m1", block }), ctx))
    expect(surface.shows.map((v) => (v.kind === "system" ? v.text : "")).join("")).toContain("[note] 记住的要点")
  })
})

describe("renderFrame question cards (issue #21)", () => {
  it("collects per-question answers via the surface and sends one question.resolve frame", async () => {
    const { ctx, surface, sent } = makeCtx()
    const done = await renderFrame(ev("question.requested", {
      questionId: "q_1",
      questions: [
        { text: "用哪个方案?", options: ["方案A", "方案B"] },
        { text: "补充说明?" },
        { text: "改哪些?", options: ["db", "api"], multiSelect: true },
      ],
      expiresAt: "t",
    }), ctx)
    expect(done).toBe(false)
    // The surface got the full payload once; the prompt UI is its own business.
    expect(surface.askedPayloads).toHaveLength(1)
    expect(surface.askedPayloads[0]).toMatchObject({ questionId: "q_1" })
    // One answer array per question, in ask order; one resolve frame.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: "question.resolve",
      questionId: "q_1",
      answers: [["方案A"], ["没有补充"], ["db", "api"]],
    })
  })

  it("stays silent and non-terminating on question.resolved (the answers were already collected)", async () => {
    const { surface } = await capture((ctx) => renderFrame(ev("question.resolved", { questionId: "q_1", answers: [["a"]], by: "cli" }), ctx))
    expect(surface.shows).toHaveLength(0)
    expect(surface.notices).toHaveLength(0)
  })
})

describe("renderFrame memory.written", () => {
  it("prints a dim notice line and stays non-terminating (done === false)", async () => {
    const { surface } = await capture((ctx) => renderFrame(ev("memory.written", { path: "/m/global/persona.md", kind: "cognition" }), ctx))
    expect(surface.shows.map((v) => (v.kind === "system" ? v.text : "")).join("")).toContain("已写入记忆: /m/global/persona.md")
  })
})

describe("renderFrame compaction.completed result branches", () => {
  it("prints the failure hint when result is failed", async () => {
    const { surface } = await capture((ctx) =>
      renderFrame(ev("compaction.completed", { segments: 0, kept: 0, result: "failed" }), ctx),
    )
    const texts = surface.shows.map((v) => (v.kind === "system" ? v.text : "")).join("")
    expect(texts).toContain("✱ 压缩失败，本轮继续（稍后自动重试）")
    expect(texts).not.toContain("已压缩为")
  })

  it("prints the cancelled hint when result is cancelled", async () => {
    const { surface } = await capture((ctx) =>
      renderFrame(ev("compaction.completed", { segments: 0, kept: 0, result: "cancelled" }), ctx),
    )
    const texts = surface.shows.map((v) => (v.kind === "system" ? v.text : "")).join("")
    expect(texts).toContain("✱ 压缩已取消")
    expect(texts).not.toContain("已压缩为")
  })

  it("keeps the success summary when result is ok (and for legacy payloads without result)", async () => {
    const { surface: okSurface } = await capture((ctx) =>
      renderFrame(ev("compaction.completed", { segments: 2, kept: 5, result: "ok" }), ctx),
    )
    expect(okSurface.shows.map((v) => (v.kind === "system" ? v.text : "")).join("")).toContain("✱ 早期对话已压缩为 2 段，保留最近 5 条原文（早期细节可用 session_search 检索）")

    const { surface: legacySurface } = await capture((ctx) => renderFrame(ev("compaction.completed", { segments: 1, kept: 4 }), ctx))
    const legacy = legacySurface.shows.map((v) => (v.kind === "system" ? v.text : "")).join("")
    expect(legacy).toContain("已压缩为 1 段")
    expect(legacy).toContain("保留最近 4 条")
  })
})
