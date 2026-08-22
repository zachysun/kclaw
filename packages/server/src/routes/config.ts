import type { FastifyInstance } from "fastify"
import type { KclawConfig } from "@kclaw/core"

/** Store dependencies for the config route (injected by createApp). */
export interface ConfigStores {
  config: KclawConfig
}

/**
 * Mask a secret for display: `"***" + <last 4 chars>` when at least 4 chars
 * long, plain `"***"` otherwise (also for the empty string). Never throws.
 */
export function maskSecret(secret: string): string {
  return secret.length < 4 ? "***" : `***${secret.slice(-4)}`
}

/**
 * Return a sanitized deep copy of `config`: every provider entry's `apiKey`
 * and `web.tavilyApiKey` are masked, everything else passes through as-is.
 * The input object is never mutated (the copy is made before masking).
 */
export function sanitizeConfig(config: KclawConfig): KclawConfig {
  const safe = structuredClone(config)
  for (const entry of Object.values(safe.providers.entries)) {
    entry.apiKey = maskSecret(entry.apiKey)
  }
  safe.web.tavilyApiKey = maskSecret(safe.web.tavilyApiKey)
  return safe
}

/**
 * Register `GET /config` on the app, returning the sanitized configuration.
 * The parent app's bearer-token auth hook still applies to the route.
 */
export function registerConfigRoutes(app: FastifyInstance, stores: ConfigStores): void {
  app.get("/config", async () => sanitizeConfig(stores.config))
}
