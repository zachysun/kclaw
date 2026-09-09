import { describe, expect, it } from "vitest"
import { newAssistantMessage, newMessage } from "../../src/protocol/messages.js"
import { estimateContextTokens, estimateTokens } from "../../src/session/compaction.js"
import { chooseBoundary, emergencyBoundary, renderSegment, segmentRanges } from "../../src/session/compaction.js"

function hist(...roles: Array<"user" | "assistant">): Array<ReturnType<typeof newMessage>> {
  return roles.map((r, i) =>
    newMessage("s", r, [{ id: `b${i}`, type: "text", text: r === "user" ? "问题".repeat(100) : "回答".repeat(100) }]),
  )
}

describe("estimateTokens", () => {
  it("charges CJK 0.75/char and ASCII 0.25/char, ceil", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("ab")).toBe(1)          // 2 * 0.25 = 0.5 → 1
    expect(estimateTokens("你好")).toBe(2)         // 2 * 0.75 = 1.5 → 2
    expect(estimateTokens("a你好")).toBe(2)        // 0.25 + 1.5 = 1.75 → 2
  })
})

describe("estimateContextTokens", () => {
  it("anchors on the last assistant usage and estimates only newer messages", () => {
    const u1 = newMessage("s", "user", [{ id: "b1", type: "text", text: "问".repeat(400) }])
    const a1 = newAssistantMessage("s", "m", [{ id: "b2", type: "text", text: "答" }])
    a1.usage = { inputTokens: 10_000, outputTokens: 5 }
    const u2 = newMessage("s", "user", [{ id: "b3", type: "text", text: "你好".repeat(100) }])
    const est = estimateContextTokens([u1, a1, u2], "新问题")
    // 10_000 anchor + 200 CJK chars (150) + "新问题" (3 chars → ceil(2.25) = 3)
    expect(est).toBeGreaterThanOrEqual(10_000 + 150 + 3)
    expect(est).toBeLessThan(10_000 + 200)
  })

  it("estimates everything when no assistant message exists", () => {
    const u = newMessage("s", "user", [{ id: "b1", type: "text", text: "你好" }])
    expect(estimateContextTokens([u])).toBeGreaterThanOrEqual(2)
  })

  it("adds overhead only in the anchor-less view (fresh session / post-compaction first request)", () => {
    const u = newMessage("s", "user", [{ id: "b1", type: "text", text: "你好" }])
    // 无锚点：固定开销计入
    expect(estimateContextTokens([u], undefined, 7_000)).toBeGreaterThanOrEqual(7_000 + 2)
    // 有锚点：inputTokens 已含固定开销，再传也不重复计
    const a = newAssistantMessage("s", "m", [{ id: "b2", type: "text", text: "答" }])
    a.usage = { inputTokens: 10_000, outputTokens: 5 }
    const withAnchor = estimateContextTokens([u, a], undefined, 7_000)
    expect(withAnchor).toBeGreaterThanOrEqual(10_000)
    expect(withAnchor).toBeLessThan(10_000 + 100)
  })
})

describe("chooseBoundary", () => {
  it("returns undefined when the whole history is under target (nothing to compact)", () => {
    const active = hist("user", "assistant")
    expect(chooseBoundary(active, { budget: 100_000, targetRatio: 0.33 })).toBeUndefined()
  })

  it("keeps the newest tail up to target, aligned back to a user message", () => {
    // u1 a1 u2 a2 u3 a3: make target cover only the last pair
    const active = hist("user", "assistant", "user", "assistant", "user", "assistant")
    const perMsg = estimateTokens("问题".repeat(100)) // ≈ 150
    const budget = perMsg * 6 / 0.9 // total ≈ 6*150; target = 0.33*budget ≈ 2 messages → aligns to u3? no: keeps newest ≥ target
    // simpler: directly assert the invariant instead of exact arithmetic
    const b = chooseBoundary(active, { budget: perMsg * 3 / 0.33, targetRatio: 0.33 })
    if (b !== undefined) {
      expect(active[b.keepFrom]!.role).toBe("user")
      expect(b.keepFrom).toBeGreaterThan(0) // something was compacted
    } else {
      // Unreachable for this fixture (target ≈ 450 < total 900): if this fires,
      // the budget arithmetic above failed to cross the target — fail loudly.
      throw new Error("fallback hit: chooseBoundary returned undefined for the 6-message fixture")
    }
  })

  it("never returns keepFrom 0 (would compact nothing)", () => {
    const active = hist("user", "assistant")
    // tiny budget forces the accumulator past target at the first message
    const b = chooseBoundary(active, { budget: 10, targetRatio: 0.5 })
    expect(b).toBeUndefined()
  })

  it("returns undefined for history without user messages", () => {
    const a = newMessage("s", "assistant", [{ id: "b0", type: "text", text: "x".repeat(5000) }])
    expect(chooseBoundary([a], { budget: 10, targetRatio: 0.5 })).toBeUndefined()
  })
})

describe("emergencyBoundary", () => {
  it("keeps only the last user turn: keepFrom = the last user message index", () => {
    const active = hist("user", "assistant", "user", "assistant")
    // last user is at index 2 → keep active[2..], compact everything before it
    expect(emergencyBoundary(active)).toBe(2)
  })

  it("returns undefined when the whole active is a single turn (nothing to compress)", () => {
    expect(emergencyBoundary(hist("user", "assistant"))).toBeUndefined()
  })

  it("returns undefined for history without user messages", () => {
    const a = newMessage("s", "assistant", [{ id: "b0", type: "text", text: "x".repeat(500) }])
    expect(emergencyBoundary([a])).toBeUndefined()
  })
})

describe("segmentRanges", () => {
  it("slices each segment between adjacent upto markers", () => {
    const msgs = hist("user", "assistant", "user", "assistant", "user")
    const upto = (i: number) => msgs[i]!.id
    const ranges = segmentRanges(msgs, [{ upto: upto(1) }, { upto: upto(3) }])
    expect(ranges[0]!.messages.map((m) => m.id)).toEqual([upto(0), upto(1)])
    expect(ranges[1]!.messages.map((m) => m.id)).toEqual([upto(2), upto(3)])
  })

  it("yields an empty range for a segment whose upto id is missing (stale marker)", () => {
    const msgs = hist("user", "assistant")
    const ranges = segmentRanges(msgs, [{ upto: "gone" }])
    expect(ranges[0]!.messages).toEqual([])
  })

  it("honors firstFromExclusive for legacy-upgrade sessions", () => {
    const msgs = hist("user", "assistant", "user", "assistant")
    const legacyUpto = msgs[1]!.id
    const ranges = segmentRanges(msgs, [{ upto: msgs[3]!.id }], legacyUpto)
    expect(ranges[0]!.messages.map((m) => m.id)).toEqual([msgs[2]!.id, msgs[3]!.id])
  })
})

describe("renderSegment", () => {
  it("renders one line per message with tool call/result condensed", () => {
    const u = newMessage("s", "user", [{ id: "b1", type: "text", text: "看一下配置" }])
    const a = newAssistantMessage("s", "m", [
      { id: "b2", type: "text", text: "我来读" },
      { id: "b3", type: "tool_call", callId: "c1", name: "fs_read", args: { path: "cfg.yaml" }, argsJson: '{"path":"cfg.yaml"}' },
    ])
    a.stopReason = "tool_use"
    const t = newMessage("s", "tool", [
      { id: "b4", type: "tool_result", callId: "c1", status: "ok", output: "port: 8080", durationMs: 3 },
    ])
    const lines = renderSegment([u, a, t]).split("\n")
    expect(lines[0]).toBe("user: 看一下配置")
    expect(lines[1]).toContain("assistant: 我来读")
    expect(lines[1]).toContain('→ fs_read({"path":"cfg.yaml"})')
    expect(lines[2]).toContain("⇐ port: 8080")
  })

  it("marks errored tool results and truncates long outputs to 300 chars", () => {
    const t = newMessage("s", "tool", [
      { id: "b1", type: "tool_result", callId: "c1", status: "error", output: "炸".repeat(1000), durationMs: 1 },
    ])
    const line = renderSegment([t])
    expect(line).toContain("[错误]")
    expect(line.length).toBeLessThan(2000)
    expect(line).not.toContain("炸".repeat(301))
  })

  it("includes note blocks by their text", () => {
    const u = newMessage("s", "user", [
      { id: "b1", type: "text", text: "问题" },
      { id: "b2", type: "note", kind: "memory", text: "相关记忆: 用户在上海" },
    ])
    const line = renderSegment([u])
    expect(line).toContain("问题")
    expect(line).toContain("相关记忆: 用户在上海")
  })

  it("renders tool-only messages without text as <tool use>", () => {
    const a = newAssistantMessage("s", "m", [
      { id: "b1", type: "tool_call", callId: "c1", name: "exec", args: { command: "ls" }, argsJson: '{"command":"ls"}' },
    ])
    expect(renderSegment([a])).toContain("→ exec(")
  })
})
