import type { LlmClient, LlmRequest } from "./types.js"

/** Consume an llm stream and concatenate every text_delta into one string.
 *  A stream that throws propagates — callers decide fallback vs log. */
export async function collectStreamText(llm: LlmClient, req: LlmRequest): Promise<string> {
  let text = ""
  for await (const ev of llm.stream(req)) {
    if (ev.type === "text_delta") text += ev.delta
  }
  return text
}
