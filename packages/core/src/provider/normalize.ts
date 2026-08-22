import type { StopReason } from "../protocol/messages.js"

const MAP: Record<string, StopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "content_filter",
  stop_sequence: "stop_sequence",
}

export function normalizeFinishReason(raw: string | null | undefined): StopReason {
  if (raw == null) return "end_turn"
  return MAP[raw] ?? "end_turn"
}
