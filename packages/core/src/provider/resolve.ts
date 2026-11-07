import type { KclawConfig, ProviderEntry } from "../storage/config.js"
import type { LlmClient, LlmRequest, LlmStreamEvent } from "./types.js"
import { createEmbeddingClient, type EmbeddingClient } from "../memory/embeddings.js"
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
 * empty. A still-missing baseUrl throws — this runs on a model call, so the
 * failure lands on the run that needed the endpoint; an empty apiKey is legal
 * (keyless local runtimes get no auth header).
 */
export function resolveProviderEndpoint(cfg: KclawConfig): { baseUrl: string; apiKey: string } {
  const entry = cfg.providers.entries[cfg.providers.default]
  const baseUrl = valueOrEnv(entry?.baseUrl, "KCLAW_LLM_BASE_URL")
  const apiKey = valueOrEnv(entry?.apiKey, "KCLAW_LLM_API_KEY")
  if (baseUrl === "") {
    throw new Error("provider 未配置：在 WebUI 的 Model 页添加，或运行 kclaw chat 按向导配置，或设置环境变量 KCLAW_LLM_BASE_URL")
  }
  return { baseUrl, apiKey }
}

/**
 * The model string for runs: the default entry's model, falling back to
 * KCLAW_LLM_MODEL, "" when neither is set. Empty is legal here: the daemon
 * starts unconfigured (the Model tab and the first-run wizard configure it
 * through the live daemon), and the resolver's clients report a missing model
 * on the model call.
 */
export function resolveModel(cfg: KclawConfig): string {
  return valueOrEnv(cfg.providers.entries[cfg.providers.default]?.model, "KCLAW_LLM_MODEL")
}

/**
 * Whether a run can resolve both halves of the default provider, by the same
 * rule runs use (env fills what the entry leaves empty). The env is the
 * daemon process's, which is why clients ask the daemon instead of judging
 * from their own config read.
 */
export function isProviderConfigured(cfg: KclawConfig): boolean {
  const entry = cfg.providers.entries[cfg.providers.default]
  return valueOrEnv(entry?.baseUrl, "KCLAW_LLM_BASE_URL") !== "" && resolveModel(cfg) !== ""
}

/** An empty wire model fails the call with the fix spelled out, before any request leaves. */
function requireModel(client: LlmClient): LlmClient {
  return {
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      if (req.model === "") {
        throw new Error("模型未配置：在 WebUI 的 Model 页为默认 provider 填写模型，或设置环境变量 KCLAW_LLM_MODEL")
      }
      yield* client.stream(req)
    },
  }
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
 *   rebuilds. An entry without an endpoint of its own (none configured, or
 *   its baseUrl left empty) resolves the KCLAW_LLM_* env endpoint on the model
 *   call, never here: the daemon starts unconfigured, so the failure has to
 *   land on the run, after the user message is persisted.
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
  // One client per run at most (the instance holds the "markers rejected"
  // verdict), built on the first model call so a later configuration counts.
  // The endpoint is checked before the model: a fresh install lacks both, and
  // "add a provider" is the message that helps there.
  const deferredClient = (entry: ProviderEntry | undefined): LlmClient => {
    let client: LlmClient | undefined
    return {
      async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
        if (client === undefined) {
          const endpoint = resolveProviderEndpoint(cfg)
          client = requireModel(createProviderClient({ entry: { model: "", ...entry, ...endpoint }, timeoutMs: cfg.providers.timeoutMs, fetchImpl }))
        }
        yield* client.stream(req)
      },
    }
  }
  const llmOf = (entryKey?: string): LlmClient => {
    const entry = (entryKey !== undefined ? cfg.providers.entries[entryKey] : undefined)
      ?? cfg.providers.entries[cfg.providers.default]
    if (entry === undefined || entry.baseUrl === "") return deferredClient(entry)
    // promptCache participates in the signature so flipping the flag rebuilds
    // the client — and with it any in-instance "markers rejected" verdict.
    const sig = `${resolveProviderFormat(entry)}|${entry.baseUrl}|${entry.apiKey}|${cfg.providers.timeoutMs}|${entry.promptCache ?? "auto"}`
    const key = entryKey ?? ""
    const hit = llmCache.get(key)
    if (hit !== undefined && hit.sig === sig) return hit.client
    const client = requireModel(createProviderClient({ entry, timeoutMs: cfg.providers.timeoutMs, fetchImpl }))
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
