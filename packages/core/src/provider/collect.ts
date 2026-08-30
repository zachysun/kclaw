import type { LlmClient, LlmRequest } from "./types.js"

/** Consume an llm stream and concatenate every text_delta into one string.
 *  A stream that throws propagates; an aborted signal throws too — partial
 *  text must never be mistaken for a complete summary. */
export async function collectStreamText(
  llm: LlmClient,
  req: LlmRequest,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  let text = ""
  const it = llm.stream(req)[Symbol.asyncIterator]()
  try {
    for (;;) {
      if (opts?.signal?.aborted === true) throw new Error("collect aborted")
      const next = await it.next()
      if (next.done === true) break
      if (next.value.type === "text_delta") text += next.value.delta
    }
  } finally {
    void it.return?.(undefined)
  }
  return text
}
