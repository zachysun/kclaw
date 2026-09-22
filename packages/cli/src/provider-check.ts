/**
 * Provider configuration triage: decides how provider settings will be
 * sourced, the branch point for the first-run wizard and the chat entry.
 * Priority: a config.json whose providers.default names an
 * existing entry wins; otherwise any non-empty KCLAW_LLM_* env var; else
 * nothing is configured. Paths come from core's own resolvePaths (the real
 * KclawPaths shape, home et al.) so the resolution can never drift from the
 * daemon's — its mkdir side effect merely pre-creates the home tree any
 * kclaw invocation creates anyway.
 */
import { loadConfig, resolvePaths } from "@kclaw/core"

export type ProviderStatus = "config" | "env" | "missing"

export function detectProviderStatus(home: string): ProviderStatus {
  const cfg = loadConfig(resolvePaths(home))
  const d = cfg.providers?.default
  if (d && cfg.providers?.entries?.[d]) return "config"
  const envSet = ["KCLAW_LLM_BASE_URL", "KCLAW_LLM_API_KEY", "KCLAW_LLM_MODEL"]
    .some((k) => (process.env[k] ?? "") !== "")
  return envSet ? "env" : "missing"
}
