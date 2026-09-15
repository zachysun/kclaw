import type { ProviderEntry } from "../storage/config.js"
import { resolveProviderFormat } from "../storage/config.js"
import type { LlmClient } from "./types.js"
import { createOpenAiCompatClient } from "./openai-compat.js"
import { createAnthropicClient } from "./anthropic.js"
import { DEFAULT_LLM_TIMEOUT_MS } from "./openai-compat.js"

/**
 * Build the client for one provider entry: the entry's wire format picks the
 * protocol implementation (OpenAI-compatible chat completions vs Anthropic
 * Messages). This is the single construction point every per-entry client
 * path — run clients, memory extraction, the launch default — resolves
 * through, so a new format can only be wired in one place.
 */
export function createProviderClient(opts: {
  entry: ProviderEntry
  /** Per-request timeout via AbortSignal.timeout; default {@link DEFAULT_LLM_TIMEOUT_MS}. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): LlmClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  const base = { baseUrl: opts.entry.baseUrl, apiKey: opts.entry.apiKey, timeoutMs, ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}) }
  if (resolveProviderFormat(opts.entry) === "anthropic") return createAnthropicClient(base)
  return createOpenAiCompatClient(base)
}
