/**
 * The providers' shared HTTP transport primitives: timeout default, abort
 * classification, the one error shape, and SSE line parsing. Both streaming
 * clients and the probes are pure consumers, so a transport-semantics
 * change lands exactly once, and neither adapter imports from the other.
 * Per-format request policy (auth headers, endpoint URLs) lives in the
 * wire-format registry (formats.ts).
 */

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

/** SSE `data:` line reader shared by both streaming clients and the probes. */
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
