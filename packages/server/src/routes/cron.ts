import type { FastifyError, FastifyInstance } from "fastify"
import type { Cron, CronScheduler } from "@kclaw/core"

/** Store dependencies for the cron routes (injected by createApp). */
export interface CronStores {
  crons: CronScheduler
}

const NOT_FOUND = { error: "cron not found" } as const

function isBodyObject(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
}

/** A create/patch string field must be present-or-absent and non-empty. */
function stringField(body: Record<string, unknown>, key: string): { ok: true; value?: string } | { ok: false; error: string } {
  const value = body[key]
  if (value === undefined) return { ok: true }
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: `${key} must be a non-empty string` }
  }
  return { ok: true, value }
}

/**
 * Validate a `POST /cron` body: `name`, `cron` and `prompt` are all required
 * non-empty strings. A missing body counts as all-missing.
 */
function createInputFromBody(
  body: unknown,
): { ok: true; input: { name: string; cron: string; prompt: string } } | { ok: false; error: string } {
  if (!isBodyObject(body)) return { ok: false, error: "body must be a JSON object" }
  const name = stringField(body, "name")
  if (!name.ok) return name
  const cron = stringField(body, "cron")
  if (!cron.ok) return cron
  const prompt = stringField(body, "prompt")
  if (!prompt.ok) return prompt
  if (name.value === undefined) return { ok: false, error: "name is required" }
  if (cron.value === undefined) return { ok: false, error: "cron is required" }
  if (prompt.value === undefined) return { ok: false, error: "prompt is required" }
  const model = stringField(body, "model")
  if (!model.ok) return model
  return { ok: true, input: { name: name.value, cron: cron.value, prompt: prompt.value, ...(model.value !== undefined ? { model: model.value } : {}) } }
}

/**
 * Validate a `PATCH /cron/:id` body into a partial Cron patch: only `name`,
 * `prompt`, `enabled` and `cron` are accepted; unknown keys are ignored.
 */
function patchFromBody(body: unknown): { ok: true; patch: Partial<Cron> } | { ok: false; error: string } {
  if (!isBodyObject(body)) return { ok: false, error: "body must be a JSON object" }
  const patch: Partial<Cron> = {}
  for (const key of ["name", "prompt", "cron", "model"] as const) {
    const field = stringField(body, key)
    if (!field.ok) return field
    if (field.value !== undefined) patch[key] = field.value
  }
  const enabled = body.enabled
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" }
    patch.enabled = enabled
  }
  return { ok: true, patch }
}

/**
 * Register the cron CRUD routes on the app, backed by the injected
 * CronScheduler. The scope's error handler normalizes body-parse failures
 * into `{error}`; cron validation errors from the scheduler (cron-parser's
 * own messages) are caught at the call sites and returned as 400s.
 * The parent app's bearer-token auth hook still applies to every route.
 */
export function registerCronRoutes(app: FastifyInstance, stores: CronStores): void {
  app.register(async (scope) => {
    scope.setErrorHandler((error: FastifyError, _request, reply) => {
      reply.status(error.statusCode ?? 500).send({ error: error.message })
    })

    scope.post("/cron", async (request, reply) => {
      const parsed = createInputFromBody(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      try {
        return reply.code(201).send(stores.crons.create(parsed.input))
      } catch (error) {
        // The scheduler's only throw path here is cron parsing; its message
        // (from cron-parser) is passed through untouched.
        return reply.code(400).send({ error: (error as Error).message })
      }
    })

    scope.get("/cron", async () => stores.crons.list())

    scope.patch("/cron/:id", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.crons.get(id) === undefined) return reply.code(404).send(NOT_FOUND)
      const parsed = patchFromBody(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      try {
        const cron = stores.crons.update(id, parsed.patch)
        if (cron === undefined) return reply.code(404).send(NOT_FOUND)
        return cron
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message })
      }
    })

    scope.delete("/cron/:id", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!stores.crons.remove(id)) return reply.code(404).send(NOT_FOUND)
      return reply.code(204).send()
    })
  })
}
