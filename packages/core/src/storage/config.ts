import { readFileSync, writeFileSync } from "node:fs"
import { parse, stringify } from "yaml"
import { DEFAULT_LLM_TIMEOUT_MS } from "../provider/openai-compat.js"
import type { KclawPaths } from "./paths.js"

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
  web: { tavilyApiKey: string }
  exec: { timeoutMs: number; maxOutputBytes: number }
  sessions: { recycleBinTtlMs: number }
  workspace: string
}

export const defaultConfig: KclawConfig = {
  providers: { default: "", entries: {}, timeoutMs: DEFAULT_LLM_TIMEOUT_MS },
  permissions: { allow: [], deny: ["exec:sudo*", "exec:rm -rf*"], confirmTimeoutMs: 120_000, sessionGrants: true },
  memory: { autoExtract: false, extractModel: "" },
  web: { tavilyApiKey: "" },
  exec: { timeoutMs: 60_000, maxOutputBytes: 100 * 1024 },
  sessions: { recycleBinTtlMs: 30 * 24 * 60 * 60 * 1000 },
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

/** Serialize config to config.yaml (whole-file rewrite). */
export function saveConfig(paths: KclawPaths, config: KclawConfig): void {
  writeFileSync(paths.config, stringify(config), "utf8")
}
