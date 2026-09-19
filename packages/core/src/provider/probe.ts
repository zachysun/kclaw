import type { ProviderApiFormat } from "../storage/config.js"
import { ANTHROPIC_VERSION, anthropicEndpoint } from "./anthropic.js"
import { DEFAULT_LLM_TIMEOUT_MS, llmHttpError, rethrowClassified } from "./openai-compat.js"

/**
 * List the model ids a provider endpoint serves: the models-list request the
 * Model tab uses both for the model picker and as its connection test (a
 * successful list is the cheapest proof the URL + key work). OpenAI-format
 * bases authenticate with Bearer; Anthropic-format bases with x-api-key +
 * anthropic-version. An empty apiKey sends no auth header (local runtimes).
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
  const url = opts.format === "anthropic"
    ? anthropicEndpoint(opts.baseUrl, "/models")
    : `${opts.baseUrl.replace(/\/$/, "")}/models`
  const headers: Record<string, string> = {}
  if (opts.format === "anthropic") {
    headers["x-api-key"] = opts.apiKey
    headers["anthropic-version"] = ANTHROPIC_VERSION
  } else if (opts.apiKey !== "") {
    headers.authorization = `Bearer ${opts.apiKey}`
  }
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
 * model itself. Format-aware like {@link fetchProviderModels}: Bearer for
 * OpenAI-compatible bases, x-api-key + anthropic-version for Anthropic
 * bases (an empty apiKey sends no auth header). Never throws: a failed probe
 * is a result, with status null meaning the request never landed.
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
  const url = isAnthropic
    ? anthropicEndpoint(opts.baseUrl, "/messages")
    : `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (isAnthropic) {
    headers["anthropic-version"] = ANTHROPIC_VERSION
    if (opts.apiKey !== "") headers["x-api-key"] = opts.apiKey
  } else if (opts.apiKey !== "") {
    headers.authorization = `Bearer ${opts.apiKey}`
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
