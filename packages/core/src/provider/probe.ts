import { DEFAULT_LLM_TIMEOUT_MS, llmHttpError, rethrowClassified } from "./http.js"
import { PROVIDER_WIRE_FORMATS, type ProviderApiFormat } from "./formats.js"

/**
 * List the model ids a provider endpoint serves: the models-list request the
 * Model tab uses both for the model picker and as its connection test (a
 * successful list is the cheapest proof the URL + key work). Auth and URL
 * policy come from the wire-format registry entry.
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
  const fmt = PROVIDER_WIRE_FORMATS[opts.format]
  const url = fmt.endpoint(opts.baseUrl, "/models")
  const headers: Record<string, string> = fmt.authHeaders(opts.apiKey)
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
 * model itself. Request path and payload come from the wire-format
 * registry's probeRequest. Never throws: a failed probe is a result, with
 * status null meaning the request never landed.
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
  const fmt = PROVIDER_WIRE_FORMATS[opts.format]
  const probe = fmt.probeRequest(opts.model)
  const url = fmt.endpoint(opts.baseUrl, probe.path)
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...fmt.authHeaders(opts.apiKey),
  }
  const payload = probe.payload
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
