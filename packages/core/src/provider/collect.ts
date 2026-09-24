import type { Usage } from "../protocol/messages.js"
import type { LlmClient, LlmRequest } from "./types.js"

export interface StreamResult {
  text: string
  /** message_done 携带的真实 usage；流异常中断时缺失。 */
  usage?: Usage
}

/** Consume an llm stream and concatenate every text_delta into one string,
 *  keeping the message_done usage alongside. A stream that throws propagates;
 *  an aborted signal throws too — partial text must never be mistaken for a
 *  complete summary. */
export async function collectStreamResult(
  llm: LlmClient,
  req: LlmRequest,
  opts?: { signal?: AbortSignal },
): Promise<StreamResult> {
  let text = ""
  let usage: Usage | undefined
  const it = llm.stream(req)[Symbol.asyncIterator]()
  try {
    for (;;) {
      if (opts?.signal?.aborted === true) throw new Error("collect aborted")
      const next = await it.next()
      if (next.done === true) break
      if (next.value.type === "text_delta") text += next.value.delta
      else if (next.value.type === "message_done") usage = next.value.usage
    }
  } finally {
    void it.return?.(undefined)
  }
  return { text, usage }
}

/** Text-only facade over collectStreamResult for callers that don't need usage. */
export async function collectStreamText(
  llm: LlmClient,
  req: LlmRequest,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  return (await collectStreamResult(llm, req, opts)).text
}
