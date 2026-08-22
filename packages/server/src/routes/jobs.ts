import type { FastifyError, FastifyInstance } from "fastify"
import type { Job, JobScheduler } from "@kclaw/core"

/** Store dependencies for the job routes (injected by createApp). */
export interface JobStores {
  jobs: JobScheduler
}

const NOT_FOUND = { error: "job not found" } as const

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
 * Validate a `POST /jobs` body: `name`, `cron` and `prompt` are all required
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
  return { ok: true, input: { name: name.value, cron: cron.value, prompt: prompt.value } }
}

/**
 * Validate a `PATCH /jobs/:id` body into a partial Job patch: only `name`,
 * `prompt`, `enabled` and `cron` are accepted; unknown keys are ignored.
 */
function patchFromBody(body: unknown): { ok: true; patch: Partial<Job> } | { ok: false; error: string } {
  if (!isBodyObject(body)) return { ok: false, error: "body must be a JSON object" }
  const patch: Partial<Job> = {}
  for (const key of ["name", "prompt", "cron"] as const) {
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
 * Register the job CRUD routes on the app, backed by the injected
 * JobScheduler. The scope's error handler normalizes body-parse failures
 * into `{error}`; cron validation errors from the scheduler (cron-parser's
 * own messages) are caught at the call sites and returned as 400s.
 * The parent app's bearer-token auth hook still applies to every route.
 */
export function registerJobRoutes(app: FastifyInstance, stores: JobStores): void {
  app.register(async (scope) => {
    scope.setErrorHandler((error: FastifyError, _request, reply) => {
      reply.status(error.statusCode ?? 500).send({ error: error.message })
    })

    scope.post("/jobs", async (request, reply) => {
      const parsed = createInputFromBody(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      try {
        return reply.code(201).send(stores.jobs.create(parsed.input))
      } catch (error) {
        // The scheduler's only throw path here is cron parsing; its message
        // (from cron-parser) is passed through untouched.
        return reply.code(400).send({ error: (error as Error).message })
      }
    })

    scope.get("/jobs", async () => stores.jobs.list())

    scope.patch("/jobs/:id", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (stores.jobs.get(id) === undefined) return reply.code(404).send(NOT_FOUND)
      const parsed = patchFromBody(request.body)
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
      try {
        const job = stores.jobs.update(id, parsed.patch)
        if (job === undefined) return reply.code(404).send(NOT_FOUND)
        return job
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message })
      }
    })

    scope.delete("/jobs/:id", async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!stores.jobs.remove(id)) return reply.code(404).send(NOT_FOUND)
      return reply.code(204).send()
    })
  })
}
