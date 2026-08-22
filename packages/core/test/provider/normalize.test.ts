import { describe, it, expect } from "vitest"
import { normalizeFinishReason } from "../../src/provider/normalize.js"

describe("normalizeFinishReason", () => {
  it.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["function_call", "tool_use"],
    ["content_filter", "content_filter"],
    ["stop_sequence", "stop_sequence"],
    [null, "end_turn"],
    [undefined, "end_turn"],
    ["unknown_future_value", "end_turn"],
  ])("maps %s -> %s", (raw, expected) => {
    expect(normalizeFinishReason(raw)).toBe(expected)
  })
})
