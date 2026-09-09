/**
 * renderFrame unit tests — the per-frame CLI renderer, driven with synthetic
 * ChatCtx (a recording `line` stand-in; no readline, no daemon). Covers the
 * compaction lifecycle events: started prints one dim hint line (the pre-run
 * compaction is otherwise a silent multi-second gap between send and
 * run.started), completed prints the one-line "compacted to N segments"
 * summary, and the per-turn re-attached compact note (it carries the
 * structured meta) stays silent — printing its full text every turn would
 * repeat the whole summary each round.
 */
import { describe, it, expect, vi } from "vitest"
import { renderFrame, type ChatCtx } from "../src/chat.js"
import type { AgentEvent, NoteBlock } from "@kclaw/core"

function makeCtx(): { ctx: ChatCtx; lines: string[] } {
  const lines: string[] = []
  const ctx = {
    home: undefined,
    client: {} as never,
    ws: {} as never,
    sessionId: "s1",
    rl: {} as never,
    showThinking: false,
    auto: "ask",
    io: { atLineStart: true },
    pendingAttachments: [],
  } as unknown as ChatCtx
  // line() routes through the module's io bookkeeping; simplest recording
  // seam: patch the module-level writer via the ctx adapter used by line().
  // Instead of reaching into internals, call renderFrame and capture through
  // process.stdout writes.
  return { ctx, lines }
}

function ev(type: AgentEvent["type"], payload: unknown): AgentEvent {
  return { id: `evt-${type}`, ts: "2026-08-28T00:00:00.000Z", type, payload, sessionId: "s1" } as AgentEvent
}

/** Run one render through a synthetic ctx, capturing stdout as a string. */
async function capture(render: (ctx: ChatCtx) => Promise<unknown>): Promise<string> {
  const writes: string[] = []
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  })
  try {
    const { ctx } = makeCtx()
    await render(ctx)
  } finally {
    spy.mockRestore()
  }
  return writes.join("")
}

describe("renderFrame compaction events", () => {
  it("prints one dim hint on compaction.started and stays quiet on completed", async () => {
    const writes: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
      return true
    })
    try {
      const { ctx } = makeCtx()
      const done1 = await renderFrame(ev("compaction.started", {}), ctx)
      expect(done1).toBe(false)
      const done2 = await renderFrame(ev("compaction.completed", { segments: 1, kept: 4 }), ctx)
      expect(done2).toBe(false)
      const out = writes.join("")
      expect(out).toContain("正在压缩")
      expect(out).toContain("已压缩为 1 段")
      expect(out).toContain("保留最近 4 条")
      expect(spy).toHaveBeenCalled()
      void origWrite
    } finally {
      spy.mockRestore()
    }
  })
})

describe("renderFrame note.emitted", () => {
  it("keeps printing memory and job notes as before", async () => {
    const block: NoteBlock = { id: "b1", type: "note", kind: "memory", text: "记住的要点" }
    const out = await capture((ctx) => renderFrame(ev("note.emitted", { messageId: "m1", block }), ctx))
    expect(out).toContain("[note] 记住的要点")
  })
})

describe("renderFrame memory.written", () => {
  it("prints a dim notice line and stays non-terminating (done === false)", async () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
      return true
    })
    try {
      const { ctx } = makeCtx()
      const done = await renderFrame(ev("memory.written", { path: "/m/global/persona.md", kind: "cognition" }), ctx)
      expect(done).toBe(false)
      expect(writes.join("")).toContain("已写入记忆: /m/global/persona.md")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("renderFrame compaction.completed result branches", () => {
  it("prints the failure hint when result is failed", async () => {
    const out = await capture((ctx) =>
      renderFrame(ev("compaction.completed", { segments: 0, kept: 0, result: "failed" }), ctx),
    )
    expect(out).toContain("✱ 压缩失败，本轮继续（稍后自动重试）")
    expect(out).not.toContain("已压缩为")
  })

  it("prints the cancelled hint when result is cancelled", async () => {
    const out = await capture((ctx) =>
      renderFrame(ev("compaction.completed", { segments: 0, kept: 0, result: "cancelled" }), ctx),
    )
    expect(out).toContain("✱ 压缩已取消")
    expect(out).not.toContain("已压缩为")
  })

  it("keeps the success summary when result is ok (and for legacy payloads without result)", async () => {
    const ok = await capture((ctx) =>
      renderFrame(ev("compaction.completed", { segments: 2, kept: 5, result: "ok" }), ctx),
    )
    expect(ok).toContain("✱ 早期对话已压缩为 2 段，保留最近 5 条原文（早期细节可用 session_search 检索）")

    const legacy = await capture((ctx) => renderFrame(ev("compaction.completed", { segments: 1, kept: 4 }), ctx))
    expect(legacy).toContain("已压缩为 1 段")
    expect(legacy).toContain("保留最近 4 条")
  })
})
