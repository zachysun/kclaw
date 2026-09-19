import type { KclawConfig } from "../storage/config.js"
import type { LlmClient } from "./types.js"
import { createEmbeddingClient, type EmbeddingClient } from "../memory/embeddings.js"
import { createOpenAiCompatClient } from "./openai-compat.js"
import { createProviderClient } from "./factory.js"
import { resolveProviderFormat } from "../storage/config.js"

/** `value` when non-empty, else the env var, else "" (config wins, env falls back). */
function valueOrEnv(value: string | undefined, envName: string): string {
  if (value !== undefined && value !== "") return value
  const fromEnv = process.env[envName]
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : ""
}

/**
 * The default provider endpoint: the config's default provider entry, with
 * KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY filling in what the entry leaves
 * empty. A still-missing baseUrl is a launch error, not a silent
 * half-configured daemon; an empty apiKey is legal (keyless local runtimes
 * get no auth header).
 */
export function resolveProviderEndpoint(cfg: KclawConfig): { baseUrl: string; apiKey: string } {
  const entry = cfg.providers.entries[cfg.providers.default]
  const baseUrl = valueOrEnv(entry?.baseUrl, "KCLAW_LLM_BASE_URL")
  const apiKey = valueOrEnv(entry?.apiKey, "KCLAW_LLM_API_KEY")
  if (baseUrl === "") {
    throw new Error("no llm provider configured: set providers in config.json or KCLAW_LLM_BASE_URL env")
  }
  return { baseUrl, apiKey }
}

/**
 * The model string for runs: the provider entry's model, falling back to
 * KCLAW_LLM_MODEL. Separate from {@link resolveProviderEndpoint} so a test
 * llmFactory still needs a model (RunManager sends one on every request)
 * without needing a reachable endpoint.
 */
export function resolveModel(cfg: KclawConfig): string {
  const entry = cfg.providers.entries[cfg.providers.default]
  const model = valueOrEnv(entry?.model, "KCLAW_LLM_MODEL")
  if (model === "") {
    throw new Error("no llm model configured: set providers.<name>.model in config.json or KCLAW_LLM_MODEL env")
  }
  return model
}

/**
 * Shared provider client resolution for one config object: every provider
 * entry owns its endpoint, and one resolver instance per daemon holds the
 * client caches so entry edits hot-apply to the next call instead of
 * spawning a fresh client per request.
 *
 * - {@link ProviderResolver.llm} picks the client by entry key (raw,
 *   un-retried — callers wrap in withRetry per run to carry their own retry
 *   sink). The cache holds one slot per entry key; a changed entry (format,
 *   baseUrl, apiKey, or the global timeout) changes the signature and
 *   rebuilds. No configured entry (empty key, nothing set) falls back to the
 *   KCLAW_LLM_* env endpoint.
 * - {@link ProviderResolver.embed} re-resolves the configured embedding
 *   entry per call (signature-checked, so unchanged entries reuse the
 *   client). Whether the vector path exists at all is decided once at launch
 *   (an anthropic-format entry has no embeddings API and stays disabled).
 * - {@link ProviderResolver.invalidate} drops every cache wholesale; config
 *   mutations publish through a ConfigNotifier and the daemon wires the
 *   notification here. The signature check remains as an optimization —
 *   with notification in place its completeness is no longer a correctness
 *   requirement (an entry deleted between publishes is caught by the
 *   invalidate, not by a signature).
 */
export interface ProviderResolver {
  llm(entryKey?: string): LlmClient
  embed(providerName: string, model: string): EmbeddingClient
  invalidate(): void
}

/**
 * Build a resolver over one config object. `fetchImpl` is optional and only
 * for tests (injected into every client the resolver creates); production
 * callers omit it.
 */
export function createProviderResolver(cfg: KclawConfig, fetchImpl?: typeof fetch): ProviderResolver {
  const llmCache = new Map<string, { sig: string; client: LlmClient }>()
  const embedCache = new Map<string, { sig: string; client: EmbeddingClient }>()
  const llmOf = (entryKey?: string): LlmClient => {
    const entry = (entryKey !== undefined ? cfg.providers.entries[entryKey] : undefined)
      ?? cfg.providers.entries[cfg.providers.default]
    if (entry === undefined) {
      const { baseUrl, apiKey } = resolveProviderEndpoint(cfg)
      return createOpenAiCompatClient({ baseUrl, apiKey, timeoutMs: cfg.providers.timeoutMs, fetchImpl })
    }
    const sig = `${resolveProviderFormat(entry)}|${entry.baseUrl}|${entry.apiKey}|${cfg.providers.timeoutMs}`
    const key = entryKey ?? ""
    const hit = llmCache.get(key)
    if (hit !== undefined && hit.sig === sig) return hit.client
    const client = createProviderClient({ entry, timeoutMs: cfg.providers.timeoutMs, fetchImpl })
    llmCache.set(key, { sig, client })
    return client
  }
  return {
    llm: llmOf,
    embed(providerName: string, model: string): EmbeddingClient {
      return {
        async embed(texts: string[]): Promise<Float32Array[]> {
          const entry = (providerName !== "" ? cfg.providers.entries[providerName] : undefined)
            ?? cfg.providers.entries[cfg.providers.default]
          if (entry === undefined) throw new Error("embedding provider entry not found")
          const key = `${providerName}|${model}`
          const sig = `${entry.baseUrl}|${entry.apiKey}|${cfg.providers.timeoutMs}`
          const slot = embedCache.get(key)
          if (slot === undefined || slot.sig !== sig) {
            const client = createEmbeddingClient({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model, timeoutMs: cfg.providers.timeoutMs, fetchImpl })
            embedCache.set(key, { sig, client })
            return client.embed(texts)
          }
          return slot.client.embed(texts)
        },
      }
    },
    invalidate(): void {
      llmCache.clear()
      embedCache.clear()
    },
  }
}
