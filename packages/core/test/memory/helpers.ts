import type { LlmClient, LlmStreamEvent } from "../../src/provider/types.js"

/** 把一次回复编排成 LlmStreamEvent 流的脚本客户端（pipeline/system 测试共用）。 */
export function scriptedLlm(replies: string[]): LlmClient {
  let call = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      const text = replies[Math.min(call++, replies.length - 1)]!
      yield { type: "text_delta", delta: text }
      yield { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
}
