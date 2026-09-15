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
