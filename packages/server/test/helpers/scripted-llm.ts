import type { LlmClient, LlmStreamEvent } from "@kclaw/core"

/** 每次调用都直接 end_turn 输出 text 的脚本客户端。 */
export function endTurnLlm(text: string): LlmClient {
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "text_delta", delta: text }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
}
