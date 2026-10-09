/**
 * The wire-format registry: everything the system needs to know about one
 * LLM wire format — auth headers, endpoint URL policy, the embeddings
 * capability, the minimal probe request — lives in one object per format,
 * keyed by the format id used in config.json and the REST payloads.
 * Adapters, the probes, config/REST validation, the daemon's embedding
 * gate, the Model tab, and the wizard all read this table. Web reaches it
 * through the `@kclaw/core/provider-formats` subpath, so this module must
 * stay free of Node imports. Adding a wire format means writing the
 * adapter plus one entry here; the exhaustive `Record` keys and the
 * `isProviderApiFormat` guard keep every consumer honest.
 */

/**
 * Wire API format a provider entry speaks. "openai" is the OpenAI-compatible
 * chat-completions protocol (also what DeepSeek/Ollama speak); "anthropic" is
 * the Anthropic Messages protocol (x-api-key + anthropic-version headers,
 * with the same key also sent as Authorization: Bearer for gateways that
 * only read Bearer).
 */
export type ProviderApiFormat = "openai" | "anthropic"

/** Value of the mandatory anthropic-version header on every Messages API call. */
export const ANTHROPIC_VERSION = "2023-06-01"

export interface ProviderWireFormat {
  readonly id: ProviderApiFormat
  /**
   * Auth headers for one request. An empty apiKey sends no auth header
   * (local runtimes). content-type is NOT included; callers add it per
   * request shape.
   */
  readonly authHeaders: (apiKey: string) => Record<string, string>
  /** Endpoint URL for one request path. */
  readonly endpoint: (baseUrl: string, path: string) => string
  /**
   * Whether endpoints of this family serve an embeddings API. The memory
   * vector path needs one; a chat-capable entry without it (Anthropic)
   * must be rejected at assembly, not at first embed.
   */
  readonly hasEmbeddings: boolean
  /** The minimal 1-token chat request that proves a model name works (the wizard probe). */
  readonly probeRequest: (model: string) => { path: string; payload: Record<string, unknown> }
}

/**
 * Anthropic base URLs conventionally exclude the version segment (the
 * official base is https://api.anthropic.com), but users pasting a proxy
 * base often already include /v1 — accept both: a trailing /v1 is kept and
 * the path appended, otherwise /v1 is inserted.
 */
export function anthropicEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, "")
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`
}

/**
 * The one auth-semantics source for both formats: Bearer for
 * OpenAI-compatible bases; anthropic-version plus x-api-key + Bearer for
 * Anthropic bases — the official API prefers x-api-key when both are
 * present, while some Anthropic-compatible gateways only read Bearer on
 * their models route.
 */
export const PROVIDER_WIRE_FORMATS: Readonly<Record<ProviderApiFormat, ProviderWireFormat>> = {
  openai: {
    id: "openai",
    authHeaders: (apiKey: string): Record<string, string> => {
      if (apiKey === "") return {}
      return { authorization: `Bearer ${apiKey}` }
    },
    endpoint: (baseUrl, path) => `${baseUrl.replace(/\/$/, "")}${path}`,
    hasEmbeddings: true,
    probeRequest: (model) => ({
      path: "/chat/completions",
      payload: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false },
    }),
  },
  anthropic: {
    id: "anthropic",
    authHeaders: (apiKey) => ({
      "anthropic-version": ANTHROPIC_VERSION,
      ...(apiKey === "" ? {} : { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` }),
    }),
    endpoint: anthropicEndpoint,
    // Anthropic has no embeddings endpoint: an anthropic-format entry can
    // serve chat but never the memory vector path.
    hasEmbeddings: false,
    probeRequest: (model) => ({
      path: "/messages",
      payload: { model, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], max_tokens: 1 },
    }),
  },
}

/** Every registered format id, in registry order (form UIs derive their options from this). */
export const PROVIDER_WIRE_FORMAT_IDS: readonly ProviderApiFormat[] = Object.keys(
  PROVIDER_WIRE_FORMATS,
) as readonly ProviderApiFormat[]

/** Type guard for untrusted input: config parsing and REST bodies. */
export function isProviderApiFormat(value: unknown): value is ProviderApiFormat {
  return typeof value === "string" && Object.hasOwn(PROVIDER_WIRE_FORMATS, value)
}

/**
 * Entries may omit `format`; everything downstream reads through this. The
 * one default-format source shared by the daemon, the web Model tab, and
 * the wizard.
 */
export function resolveFormat(format: ProviderApiFormat | undefined): ProviderApiFormat {
  return format ?? "openai"
}

/**
 * Parse untrusted input as a format id or throw the shared user-readable
 * error (parseProviderEntry and the /providers routes surface it; the
 * routes map it to 400).
 */
export function expectProviderApiFormat(value: unknown): ProviderApiFormat {
  if (!isProviderApiFormat(value)) {
    throw new Error(
      `provider format must be one of ${PROVIDER_WIRE_FORMAT_IDS.map((id) => `"${id}"`).join(", ")}, got ${JSON.stringify(value)}`,
    )
  }
  return value
}
