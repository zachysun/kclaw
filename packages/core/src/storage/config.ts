import { readFileSync } from "node:fs"
import { parse, stringify } from "yaml"
import { writeFileAtomic } from "./atomic.js"
import { DEFAULT_LLM_TIMEOUT_MS } from "../provider/openai-compat.js"
import type { KclawPaths } from "./paths.js"
import type { NotifyChannel } from "../notify/notify.js"
import type { McpServerConfig } from "../mcp/manager.js"

export interface KclawConfig {
  providers: {
    default: string
    entries: Record<string, { baseUrl: string; apiKey: string; model: string }>
    /**
     * Per-request llm timeout the daemon passes to the provider client:
     * bounds the fetch AND the SSE body so a hung provider
     * stream can never park a run forever. Optional only because older
     * config.yaml files predate it; defaults to 120s (defaultConfig).
     */
    timeoutMs?: number
  }
  permissions: { allow: string[]; deny: string[]; confirmTimeoutMs: number; sessionGrants: boolean }
  memory: { autoExtract: boolean; extractModel: string }
  web: {
    tavilyApiKey: string
    /**
     * AbortSignal timeout applied to every web tool fetch (search + page
     * fetch), so a hung host can never park a run forever. Optional only
     * because older config.yaml files predate it; defaults to 20s
     * (defaultConfig).
     */
    timeoutMs?: number
    /**
     * Opt out of web_fetch's private/loopback target denial (SSRF guard):
     * true allows fetching e.g. http://127.0.0.1:11434 (a local Ollama
     * endpoint). Optional only because older config.yaml files predate it;
     * defaults to false (defaultConfig).
     */
    allowPrivateNetworks?: boolean
  }
  exec: { timeoutMs: number; maxOutputBytes: number }
  sessions: {
    recycleBinTtlMs: number
    /** DEPRECATED (v1 compaction, inert): compact at N messages. */
    compactThreshold?: number
    /** DEPRECATED (v1 compaction, inert): keep newest N messages verbatim. */
    compactKeep?: number
    /** v2: context token budget. Default 128000 (read site applies ?? default). */
    contextTokens?: number
    /** v2: compact when the estimate exceeds budget × ratio. Default 0.66. */
    compactAtRatio?: number
    /** v2: post-compaction target for the verbatim window (× budget). Default 0.33. */
    compactTargetRatio?: number
    /** v2: tool results kept verbatim in the provider view. Default 8. */
    toolResultKeep?: number
  }
  /**
   * Job-finish notifications. Delivery failures are only logged (onError),
   * never retried and never thrown. An empty channels list disables
   * notifications entirely (zero cost).
   */
  notify: { channels: NotifyChannel[]; timeoutMs?: number }
  /**
   * Token cost pricing (USD per 1M tokens per model) for the usage view.
   * Optional only because older config.yaml files predate it; empty map =
   * tokens shown, cost 0.
   */
  usage?: { prices?: Record<string, { inputPerM?: number; outputPerM?: number }> }
  /**
   * External MCP servers. Optional only because older config.yaml files
   * predate it; defaults to an empty server map (defaultConfig).
   */
  mcp?: { servers?: Record<string, McpServerConfig> }
  workspace: string
}

export const defaultConfig: KclawConfig = {
  providers: { default: "", entries: {}, timeoutMs: DEFAULT_LLM_TIMEOUT_MS },
  permissions: { allow: [], deny: ["exec:sudo*", "exec:rm -rf*"], confirmTimeoutMs: 120_000, sessionGrants: true },
  memory: { autoExtract: false, extractModel: "" },
  web: { tavilyApiKey: "", timeoutMs: 20_000, allowPrivateNetworks: false },
  exec: { timeoutMs: 60_000, maxOutputBytes: 100 * 1024 },
  sessions: { recycleBinTtlMs: 30 * 24 * 60 * 60 * 1000 },
  notify: { channels: [], timeoutMs: 10_000 },
  usage: { prices: {} },
  mcp: { servers: {} },
  workspace: process.cwd(),
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge `override` onto `defaults`: plain objects recurse per key,
 * arrays and scalars replace wholesale. Neither input is mutated.
 */
function deepMerge<T>(defaults: T, override: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(override)) {
    return (override === undefined ? defaults : override) as T
  }
  const merged: Record<string, unknown> = { ...defaults }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    merged[key] = deepMerge(merged[key], value)
  }
  return merged as T
}

/**
 * Load config.yaml under paths.home, deep-merged over defaults.
 * A missing or empty file yields the defaults; unparseable YAML throws
 * (silently falling back could drop the user's permission rules).
 *
 * The returned config never shares references with defaultConfig:
 * the merge starts from a clone, so callers may mutate the result freely.
 */
export function loadConfig(paths: KclawPaths): KclawConfig {
  let raw: string
  try {
    raw = readFileSync(paths.config, "utf8")
  } catch {
    return structuredClone(defaultConfig)
  }
  let file: unknown
  try {
    file = parse(raw)
  } catch (err) {
    throw new Error(`invalid yaml in ${paths.config}: ${(err as Error).message}`)
  }
  if (file === null || file === undefined) return structuredClone(defaultConfig)
  if (!isPlainObject(file)) {
    throw new Error(`invalid config in ${paths.config}: expected a yaml mapping`)
  }
  return deepMerge(structuredClone(defaultConfig), file)
}

/** Serialize config to config.yaml (atomic whole-file rewrite; 0600 — holds apiKey plaintext). */
export function saveConfig(paths: KclawPaths, config: KclawConfig): void {
  writeFileAtomic(paths.config, stringify(config), 0o600)
}
