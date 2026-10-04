/**
 * The providers' shared HTTP layer: timeout default, abort classification,
 * the one error shape, SSE line parsing, and the per-format request policy
 * (auth headers, endpoint URLs). Both streaming clients and the probes are
 * pure consumers, so an auth-semantics change lands exactly once (the
 * dual-header fix had to touch three hand-kept copies before this existed)
 * and neither adapter imports from the other.
 */
import type { ProviderApiFormat } from "../storage/config.js"

/** Value of the mandatory anthropic-version header on every Messages API call. */
export const ANTHROPIC_VERSION = "2023-06-01"

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

/**
 * Auth headers for one format: Bearer for OpenAI-compatible bases;
 * anthropic-version plus x-api-key + Bearer for Anthropic bases — the
 * official API prefers x-api-key when both are present, while some
 * Anthropic-compatible gateways only read Bearer on their models route. An
 * empty apiKey sends no auth header (local runtimes). content-type is NOT
 * included; callers add it per request shape.
 */
export function formatAuthHeaders(format: ProviderApiFormat, apiKey: string): Record<string, string> {
  if (format === "anthropic") {
    return {
      "anthropic-version": ANTHROPIC_VERSION,
      ...(apiKey === "" ? {} : { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` }),
    }
  }
  return apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` }
}

/**
 * Anthropic base URLs conventionally exclude the version segment (the
 * official base is https://api.anthropic.com), but users pasting a proxy
 * base often already include /v1 — accept both: a trailing /v1 is kept and
 * the path appended, otherwise /v1 is inserted. The anthropic arm of
 * {@link formatEndpoint}.
 */
export function anthropicEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, "")
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`
}

/**
 * Endpoint URL for one format: Anthropic bases get the /v1 tolerance
 * (anthropicEndpoint), OpenAI-compatible bases concatenate the path.
 */
export function formatEndpoint(format: ProviderApiFormat, baseUrl: string, path: string): string {
  return format === "anthropic" ? anthropicEndpoint(baseUrl, path) : `${baseUrl.replace(/\/$/, "")}${path}`
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
