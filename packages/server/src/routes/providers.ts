/**
 * Provider management routes: the Model-tab snapshot (GET /providers —
 * entries with masked keys plus the built-in presets) and the hot-config
 * action family (create/update/rename/delete/set-default/model-probe).
 * Mutations
 * apply to the daemon's shared in-memory config immediately — the next run
 * resolves its entry through it — and persist through saveConfig, whose
 * first write lands in config.json and retires a legacy config.yaml.
 * Delete guards only the default entry (switch first); an entry still
 * referenced by sessions may be deleted — those sessions fall back to the
 * default on their next run, which the WebUI surfaces as a confirm note.
 */
import type { FastifyInstance } from "fastify"
import type { ConfigNotifier, KclawConfig, KclawPaths, ProviderApiFormat, ProviderEntry } from "@kclaw/core"
import { fetchProviderModels, parseProviderEntry, PROVIDER_PRESETS, renameProviderEntry, resolveProviderFormat } from "@kclaw/core"
import { saveConfig } from "@kclaw/core"
import { maskSecret } from "./config.js"

export interface ProvidersRoutesDeps {
  /** The daemon's shared in-memory config; mutations hot-apply to next runs. */
  config: KclawConfig
  paths: KclawPaths
  /**
   * Config-section notifier: every mutation publishes "providers" after
   * persisting so cache-holding consumers (the provider client resolver)
   * drop their state. Absent (bare apps) → no publish.
   */
  notifier?: ConfigNotifier
}

/** Names are entry keys referenced by session meta, jobs, and slash commands. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/

interface NameParams {
  name: string
}

/** The view snapshot: masked entries, the default, and the preset catalog. */
function snapshot(deps: ProvidersRoutesDeps): {
  default: string
  entries: Record<string, ProviderEntry>
  presets: typeof PROVIDER_PRESETS
} {
  const entries: Record<string, ProviderEntry> = {}
  for (const [name, entry] of Object.entries(deps.config.providers.entries)) {
    entries[name] = { ...entry, apiKey: maskSecret(entry.apiKey) }
  }
  return { default: deps.config.providers.default, entries, presets: PROVIDER_PRESETS }
}

/**
 * Persist after a mutation; the in-memory change is already live either way.
 * The publish happens regardless of the save outcome — the in-memory config
 * did change, so caches must not outlive the mutation they reflect.
 */
function persist(deps: ProvidersRoutesDeps): void {
  try {
    saveConfig(deps.paths, deps.config)
  } catch (e) {
    console.error(`kclaw providers: failed to persist config: ${(e as Error).message}`)
  } finally {
    deps.notifier?.publish("providers")
  }
}

/**
 * PATCH keeps the stored apiKey when the body sends an empty one: the WebUI
 * only has the masked value, so a blank key field means "unchanged" (a
 * keyless entry stays keyless the same way).
 */
function mergeEntry(existing: ProviderEntry, incoming: ProviderEntry): ProviderEntry {
  return incoming.apiKey === "" && existing.apiKey !== "" ? { ...incoming, apiKey: existing.apiKey } : incoming
}

export function registerProvidersRoutes(app: FastifyInstance, deps: ProvidersRoutesDeps): void {
  app.get("/providers", async () => snapshot(deps))

  app.post("/providers", async (request, reply) => {
    const body = request.body as { name?: unknown; entry?: unknown } | null | undefined
    if (typeof body?.name !== "string" || body.name.trim() === "") {
      return reply.code(400).send({ error: "name is required" })
    }
    const name = body.name.trim()
    if (!NAME_PATTERN.test(name)) {
      return reply.code(400).send({ error: "name may only contain letters, digits, '_' and '-'" })
    }
    if (deps.config.providers.entries[name] !== undefined) {
      return reply.code(409).send({ error: `provider entry "${name}" already exists` })
    }
    let entry: ProviderEntry
    try {
      entry = parseProviderEntry(body.entry)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    deps.config.providers.entries[name] = entry
    persist(deps)
    return { ok: true, ...snapshot(deps) }
  })

  // PATCH updates the entry and may also rename it (body `name`): the entry
  // key moves, and config-level references follow — the default pointer and
  // the memory extraction/embedding provider. Session references keep the old
  // name by design (they fall back to the default on their next run, the
  // delete semantics).
  app.patch("/providers/:name", async (request, reply) => {
    const { name } = request.params as NameParams
    const existing = deps.config.providers.entries[name]
    if (existing === undefined) return reply.code(404).send({ error: `unknown provider entry: ${name}` })
    const body = request.body as { name?: unknown; entry?: unknown } | null | undefined
    let target = name
    if (typeof body?.name === "string" && body.name.trim() !== "" && body.name.trim() !== name) {
      target = body.name.trim()
      if (!NAME_PATTERN.test(target)) {
        return reply.code(400).send({ error: "name may only contain letters, digits, '_' and '-'" })
      }
      if (deps.config.providers.entries[target] !== undefined) {
        return reply.code(409).send({ error: `provider entry "${target}" already exists` })
      }
    }
    let entry: ProviderEntry
    try {
      entry = parseProviderEntry(body?.entry)
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message })
    }
    if (target !== name) {
      try {
        renameProviderEntry(deps.config, name, target)
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message })
      }
    }
    deps.config.providers.entries[target] = mergeEntry(existing, entry)
    persist(deps)
    return { ok: true, ...snapshot(deps) }
  })

  app.delete("/providers/:name", async (request, reply) => {
    const { name } = request.params as NameParams
    if (deps.config.providers.entries[name] === undefined) {
      return reply.code(404).send({ error: `unknown provider entry: ${name}` })
    }
    if (deps.config.providers.default === name) {
      return reply.code(409).send({ error: `"${name}" is the default provider entry; switch the default before deleting it` })
    }
    delete deps.config.providers.entries[name]
    persist(deps)
    return { ok: true, ...snapshot(deps) }
  })

  app.post("/providers/:name/default", async (request, reply) => {
    const { name } = request.params as NameParams
    if (deps.config.providers.entries[name] === undefined) {
      return reply.code(404).send({ error: `unknown provider entry: ${name}` })
    }
    deps.config.providers.default = name
    persist(deps)
    return { ok: true, ...snapshot(deps) }
  })

  // Model probe: lists the models an endpoint serves. Doubles as the
  // connection test — a successful list proves the URL + key work. A body
  // naming an entry probes it with its real (unmasked) key; explicit
  // format/baseUrl/apiKey fields override the stored ones, so the edit form
  // can probe its draft values while still riding the stored key when the
  // key field is left blank (the masked value is useless on the wire).
  app.post("/providers/models", async (request, reply) => {
    const body = request.body as { name?: unknown; format?: unknown; baseUrl?: unknown; apiKey?: unknown } | null | undefined
    let format: ProviderApiFormat
    let baseUrl: string
    let apiKey: string
    if (typeof body?.name === "string" && body.name !== "") {
      const entry = deps.config.providers.entries[body.name]
      if (entry === undefined) return reply.code(404).send({ error: `unknown provider entry: ${body.name}` })
      format = body.format === "openai" || body.format === "anthropic" ? body.format : resolveProviderFormat(entry)
      baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim() !== "" ? body.baseUrl.trim() : entry.baseUrl
      apiKey = typeof body.apiKey === "string" && body.apiKey !== "" ? body.apiKey : entry.apiKey
    } else {
      if (body?.format !== "openai" && body?.format !== "anthropic") {
        return reply.code(400).send({ error: 'format must be "openai" or "anthropic"' })
      }
      if (typeof body?.baseUrl !== "string" || body.baseUrl.trim() === "") {
        return reply.code(400).send({ error: "baseUrl is required" })
      }
      format = body.format
      baseUrl = body.baseUrl.trim()
      apiKey = typeof body.apiKey === "string" ? body.apiKey : ""
    }
    try {
      const models = await fetchProviderModels({ format, baseUrl, apiKey, timeoutMs: deps.config.providers.timeoutMs })
      return { ok: true, models }
    } catch (e) {
      return reply.code(502).send({ ok: false, error: (e as Error).message })
    }
  })
}
