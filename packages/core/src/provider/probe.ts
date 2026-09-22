import type { ProviderApiFormat } from "../storage/config.js"
import { formatAuthHeaders, formatEndpoint } from "./anthropic.js"
import { DEFAULT_LLM_TIMEOUT_MS, llmHttpError, rethrowClassified } from "./openai-compat.js"

/**
 * List the model ids a provider endpoint serves: the models-list request the
 * Model tab uses both for the model picker and as its connection test (a
 * successful list is the cheapest proof the URL + key work). Auth and URL
 * policy come from formatAuthHeaders/formatEndpoint (the shared per-format
 * source).
 */
export async function fetchProviderModels(opts: {
  format: ProviderApiFormat
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  const url = formatEndpoint(opts.format, opts.baseUrl, "/models")
  const headers: Record<string, string> = formatAuthHeaders(opts.format, opts.apiKey)
  const signal = AbortSignal.timeout(timeoutMs)
  let res: Response
  try {
    res = await doFetch(url, { headers, signal })
  } catch (err) {
    rethrowClassified(err, signal, timeoutMs)
  }
  if (!res.ok) {
    let text = ""
    try {
      text = await res.text()
    } catch {
      void 0
    }
    throw llmHttpError(res.status, text)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error("llm models: response is not json")
  }
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new Error("llm models: response has no data array")
  const ids = data
    .map((m) => (typeof m === "object" && m !== null ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id !== "")
  return [...new Set(ids)]
}

/** Probes are user-facing checks (the first-run wizard): a short timeout, not the client default. */
const PROBE_TIMEOUT_MS = 20_000

/**
 * One-shot minimal chat completion (1 token) that proves a model name works
 * on top of a working URL + key — the models-list probe cannot check the
 * model itself. Format-aware like {@link fetchProviderModels} (auth and URL
 * policy from the shared helpers). Never throws: a failed probe is a
 * result, with status null meaning the request never landed.
 */
export async function probeProviderChat(opts: {
  format: ProviderApiFormat
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<{ status: number | null; body: string }> {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  const isAnthropic = opts.format === "anthropic"
  const url = formatEndpoint(
    opts.format,
    opts.baseUrl,
    isAnthropic ? "/messages" : "/chat/completions",
  )
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...formatAuthHeaders(opts.format, opts.apiKey),
  }
  const payload = isAnthropic
    ? { model: opts.model, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], max_tokens: 1 }
    : { model: opts.model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let text = ""
    try {
      text = await res.text()
    } catch {
      void 0
    }
    return { status: res.status, body: text.slice(0, 200) }
  } catch {
    return { status: null, body: "" }
  }
}
