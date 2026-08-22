import type { Message } from "../protocol/messages.js"
import { isBlockType } from "../protocol/blocks.js"
import type { ProviderMessage, ProviderToolCall } from "../provider/types.js"

export function toProviderMessages(history: Message[], window: number): ProviderMessage[] {
  const recent = history.slice(-window)
  // A tool message whose paired assistant message fell outside the window is
  // unusable for OpenAI-compatible APIs — drop leading orphans.
  while (recent.length > 0 && recent[0].role === "tool") recent.shift()
  const out: ProviderMessage[] = []
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i]!
    if (m.role === "user" || m.role === "assistant") {
      const parts: string[] = []
      const toolCalls: ProviderToolCall[] = []
      // Defense in depth: an assistant tool_call whose tool message is NOT in
      // the window (e.g. dangling from an aborted stream) must not reach the
      // provider — unpaired tool_calls make OpenAI-compat APIs 400.
      const answered = new Set<string>()
      for (let j = i + 1; j < recent.length && recent[j]!.role === "tool"; j++) {
        for (const b of recent[j]!.blocks) {
          if (isBlockType("tool_result", b)) answered.add(b.callId)
        }
      }
      for (const b of m.blocks) {
        if (isBlockType("text", b)) parts.push(b.text)
        else if (isBlockType("note", b)) parts.push(`[system note] ${b.text}`)
        else if (isBlockType("tool_call", b) && m.role === "assistant" && answered.has(b.callId)) {
          toolCalls.push({ callId: b.callId, name: b.name, argsJson: b.argsJson })
        }
      }
      if (m.role === "user") out.push({ role: "user", content: parts.join("\n") })
      else {
        const content = parts.length ? parts.join("\n") : null
        // an assistant with neither content nor toolCalls has nothing usable
        if (content !== null || toolCalls.length > 0) {
          out.push({ role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) })
        }
      }
    } else {
      for (const b of m.blocks) {
        if (isBlockType("tool_result", b)) {
          out.push({ role: "tool", toolCallId: b.callId, content: b.status === "error" ? `[error] ${b.output}` : b.output })
        }
      }
    }
  }
  return out
}
