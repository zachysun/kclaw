import type { ProviderApiFormat, ProviderEntry } from "../storage/config.js"

/**
 * Built-in provider presets: well-known endpoints the Model tab offers so a
 * preset entry only needs an API key (and a model pick). A preset fixes the
 * wire format and the base URL; the user never types those for a preset.
 */
export interface ProviderPreset {
  id: string
  label: string
  format: ProviderApiFormat
  baseUrl: string
  /** Local runtimes that need no API key; the form leaves the key blank. */
  authOptional?: boolean
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "openai", label: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic", format: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "deepseek", label: "DeepSeek", format: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "ollama", label: "Ollama", format: "openai", baseUrl: "http://localhost:11434/v1", authOptional: true },
]

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

/**
 * Validate a user-submitted provider entry and return a clean one (unknown
 * fields dropped). Throws user-readable messages; the /providers routes map
 * them to 400.
 */
export function parseProviderEntry(input: unknown): ProviderEntry {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("provider entry must be an object")
  }
  const raw = input as Record<string, unknown>
  const format = raw.format === undefined ? "openai" : raw.format
  if (format !== "openai" && format !== "anthropic") {
    throw new Error(`provider format must be "openai" or "anthropic", got ${JSON.stringify(format)}`)
  }
  const baseUrl = requireNonEmptyString(raw.baseUrl, "baseUrl")
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("baseUrl must start with http:// or https://")
  }
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : ""
  const model = requireNonEmptyString(raw.model, "model")
  const entry: ProviderEntry = { format, baseUrl, apiKey, model }
  for (const key of ["contextWindow", "maxOutput"] as const) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${key} must be a positive number`)
    }
    entry[key] = value
  }
  return entry
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`)
  }
  return value.trim()
}
