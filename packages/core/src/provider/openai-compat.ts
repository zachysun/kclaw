import type { LlmClient, LlmRequest, LlmStreamEvent } from "./types.js"
import { normalizeFinishReason } from "./normalize.js"
import type { Usage } from "../protocol/messages.js"

interface ChatDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>
}

interface ChatChunk {
  choices?: Array<{ delta?: ChatDelta; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function toApiMessages(req: LlmRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: req.system }]
  for (const m of req.messages) {
    if (m.role === "system") { out.push({ role: "system", content: m.content }); continue }
    if (m.role === "user") out.push({ role: "user", content: m.content })
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        ...(m.content === null ? {} : { content: m.content }),
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((t) => ({ id: t.callId, type: "function", function: { name: t.name, arguments: t.argsJson } })) }
          : {}),
      })
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content })
    }
  }
  return out
}

/**
 * Whole-request llm timeout: covers the fetch (headers) AND the body stream —
 * undici errors pending body reads when the request signal aborts. Also the
 * default for `KclawConfig.providers.timeoutMs` (storage/config.ts).
 */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000

/**
 * Abort classification for the stream's guarded awaits: any failure after the
 * timeout signal fired is reported as the `llm http timeout` message (the
 * retry contract in retry.ts matches on it); everything else rethrows as-is.
 */
export function rethrowClassified(err: unknown, signal: AbortSignal, timeoutMs: number): never {
  if (signal.aborted) throw new Error(`llm http timeout after ${timeoutMs}ms`)
  throw err
}

/** The one error shape for non-ok provider responses, shared by both formats and the probe. */
export function llmHttpError(status: number, text: string): Error {
  return new Error(`llm http ${status}: ${text}`)
}

export function createOpenAiCompatClient(opts: {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  /** Per-request timeout via AbortSignal.timeout; default {@link DEFAULT_LLM_TIMEOUT_MS}. */
  timeoutMs?: number
}): LlmClient {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  return {
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      // A hung provider stream (no headers, or a stalled SSE body) must never
      // park a run forever: the abort fires at `timeoutMs` and the error is
      // re-classified below so withRetry sees it as transient. The signal is
      // checked (not the error shape) so any abort → timeout classification.
      const signal = AbortSignal.timeout(timeoutMs)
      let res: Response
      try {
        res = await doFetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(opts.apiKey === "" ? {} : { authorization: `Bearer ${opts.apiKey}` }),
          },
          body: JSON.stringify({
            model: req.model,
            messages: toApiMessages(req),
            tools: req.tools.map((t) => ({ type: "function", function: t })),
            stream: true,
            stream_options: { include_usage: true },
            ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          }),
          signal,
        })
      } catch (err) {
        rethrowClassified(err, signal, timeoutMs)
      }
      if (!res.ok || res.body === null) {
        let text = ""
        try {
          text = await res.text()
        } catch (err) {
          // even the error body is bounded: a stalled non-ok response must
          // not trade one hang for another. A PRE-timeout read failure keeps
          // the historical swallow-to-empty so the status line still
          // classifies the failure (`llm http <status>`).
          if (signal.aborted) throw new Error(`llm http timeout after ${timeoutMs}ms`)
          void err
        }
        throw llmHttpError(res.status, text)
      }
      const startedTools = new Map<number, string | null>() // index -> callId
      let finish: string | null = null
      let usage: Usage = { inputTokens: 0, outputTokens: 0 }
      try {
        for await (const line of sseDataLines(res.body)) {
          if (line === "[DONE]") break
          const chunk: ChatChunk = JSON.parse(line)
          const delta = chunk.choices?.[0]?.delta
          if (chunk.usage) {
            usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 }
          }
          if (chunk.choices?.[0]?.finish_reason != null) finish = chunk.choices[0].finish_reason
          // Explicit emptiness checks: undefined, null and "" all carry no
          // payload — skipped uniformly. (An arguments fragment of "" was
          // previously skipped by falsiness too, but the loop must survive a
          // tool_call with NO arguments at all — see the `|| "{}"` parse.)
          const reasoning = delta?.reasoning_content
          if (reasoning != null && reasoning !== "") yield { type: "thinking_delta", delta: reasoning }
          const content = delta?.content
          if (content != null && content !== "") yield { type: "text_delta", delta: content }
          for (const tc of delta?.tool_calls ?? []) {
            if (!startedTools.has(tc.index) && (tc.id !== undefined || tc.function?.name !== undefined)) {
              startedTools.set(tc.index, tc.id ?? null)
              yield { type: "tool_call_started", index: tc.index, callId: tc.id ?? `call_idx_${tc.index}`, name: tc.function?.name ?? "" }
            }
            const args = tc.function?.arguments
            if (args != null && args !== "") yield { type: "tool_call_delta", index: tc.index, delta: args }
          }
        }
      } catch (err) {
        // stalled SSE body: undici (and the tests) surface the abort as a
        // body-read rejection — same classified message as the fetch phase
        rethrowClassified(err, signal, timeoutMs)
      }
      yield { type: "message_done", stopReason: normalizeFinishReason(finish), usage }
    },
  }
}

export async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "")
      buf = buf.slice(idx + 1)
      if (line.startsWith("data:")) yield line.slice(5).trim()
    }
  }
}
