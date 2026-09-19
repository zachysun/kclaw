import { describe, it, expect } from "vitest"
import { createProviderResolver, resolveProviderEndpoint, resolveModel, defaultConfig } from "../../src/index.js"
import type { KclawConfig } from "../../src/index.js"

function sseResponse(): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`))
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function makeConfig(over?: (cfg: KclawConfig) => void): KclawConfig {
  const cfg = structuredClone(defaultConfig)
  cfg.providers = {
    default: "a",
    entries: {
      a: { format: "openai", baseUrl: "https://entry-a", apiKey: "key-a", model: "model-a" },
      b: { format: "openai", baseUrl: "https://entry-b", apiKey: "key-b", model: "model-b" },
    },
    timeoutMs: 5000,
  }
  over?.(cfg)
  return cfg
}

/** Instrumented fetch capturing one line per request (url + auth header). */
function recordingFetch(): { fetch: typeof fetch; requests: Array<{ url: string; auth: string | null }> } {
  const requests: Array<{ url: string; auth: string | null }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    requests.push({ url: req.url, auth: req.headers.get("authorization") })
    return sseResponse()
  }) as unknown as typeof fetch
  return { fetch, requests }
}

const REQ = { model: "m", system: "s", messages: [], tools: [] }

async function drain(c: { stream(r: never): AsyncIterable<never> }): Promise<void> {
  for await (const _ of c.stream(REQ)) void _
}

describe("resolveProviderEndpoint / resolveModel", () => {
  it("config wins, env fills what the entry leaves empty", () => {
    const cfg = makeConfig((c) => {
      c.providers.entries.a!.baseUrl = ""
      c.providers.entries.a!.model = ""
    })
    const prev = {
      base: process.env.KCLAW_LLM_BASE_URL,
      key: process.env.KCLAW_LLM_API_KEY,
      model: process.env.KCLAW_LLM_MODEL,
    }
    try {
      process.env.KCLAW_LLM_BASE_URL = "https://from-env"
      process.env.KCLAW_LLM_MODEL = "env-model"
      expect(resolveProviderEndpoint(cfg)).toEqual({ baseUrl: "https://from-env", apiKey: "key-a" })
      expect(resolveModel(cfg)).toBe("env-model")
    } finally {
      if (prev.base === undefined) delete process.env.KCLAW_LLM_BASE_URL; else process.env.KCLAW_LLM_BASE_URL = prev.base
      if (prev.key === undefined) delete process.env.KCLAW_LLM_API_KEY; else process.env.KCLAW_LLM_API_KEY = prev.key
      if (prev.model === undefined) delete process.env.KCLAW_LLM_MODEL; else process.env.KCLAW_LLM_MODEL = prev.model
    }
  })

  it("a still-missing endpoint is a launch error", () => {
    const cfg = makeConfig((c) => { c.providers.entries = {} })
    const hadBase = "KCLAW_LLM_BASE_URL" in process.env
    const saved = process.env.KCLAW_LLM_BASE_URL
    try {
      delete process.env.KCLAW_LLM_BASE_URL
      expect(() => resolveProviderEndpoint(cfg)).toThrow("no llm provider configured")
    } finally {
      if (hadBase) process.env.KCLAW_LLM_BASE_URL = saved
    }
  })
})

describe("createProviderResolver", () => {
  it("caches one client per entry key; unchanged entries reuse it", () => {
    const cfg = makeConfig()
    const resolver = createProviderResolver(cfg)
    const first = resolver.llm()
    expect(resolver.llm()).toBe(first)
    expect(resolver.llm("a")).toBe(resolver.llm("a"))
    expect(resolver.llm("b")).not.toBe(first)
  })

  it("a changed entry (apiKey/timeout) rebuilds the client", () => {
    const cfg = makeConfig()
    const resolver = createProviderResolver(cfg)
    const first = resolver.llm()
    cfg.providers.entries.a!.apiKey = "rotated"
    const second = resolver.llm()
    expect(second).not.toBe(first)
    cfg.providers.timeoutMs = 9999
    expect(resolver.llm()).not.toBe(second)
  })

  it("invalidate drops the cache wholesale, even without a config change", () => {
    const cfg = makeConfig()
    const resolver = createProviderResolver(cfg)
    const first = resolver.llm()
    resolver.invalidate()
    expect(resolver.llm()).not.toBe(first)
  })

  it("the named entry serves the request; an unknown key falls back to the default entry", async () => {
    const cfg = makeConfig()
    const { fetch, requests } = recordingFetch()
    const resolver = createProviderResolver(cfg, fetch)
    await drain(resolver.llm("a"))
    expect(requests[0]!.url).toBe("https://entry-a/chat/completions")
    expect(requests[0]!.auth).toBe("Bearer key-a")
    await drain(resolver.llm("missing"))
    expect(requests[1]!.url).toBe("https://entry-a/chat/completions")
  })

  it("with no entries at all, llm() rides the KCLAW_LLM_* env endpoint", async () => {
    const cfg = makeConfig((c) => { c.providers.entries = {} })
    const prev = { base: process.env.KCLAW_LLM_BASE_URL, model: process.env.KCLAW_LLM_MODEL }
    try {
      process.env.KCLAW_LLM_BASE_URL = "https://env-endpoint"
      process.env.KCLAW_LLM_MODEL = "env-model"
      const { fetch, requests } = recordingFetch()
      const resolver = createProviderResolver(cfg, fetch)
      await drain(resolver.llm())
      expect(requests[0]!.url).toBe("https://env-endpoint/chat/completions")
    } finally {
      if (prev.base === undefined) delete process.env.KCLAW_LLM_BASE_URL; else process.env.KCLAW_LLM_BASE_URL = prev.base
      if (prev.model === undefined) delete process.env.KCLAW_LLM_MODEL; else process.env.KCLAW_LLM_MODEL = prev.model
    }
  })

  it("embed resolves the named entry, reuses its client, and rebuilds on change", async () => {
    const cfg = makeConfig()
    const requests: Array<{ url: string; auth: string | null; model: string }> = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      requests.push({
        url: req.url,
        auth: req.headers.get("authorization"),
        model: (JSON.parse(String(init?.body)) as { model: string }).model,
      })
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 })
    }) as unknown as typeof fetch
    const resolver = createProviderResolver(cfg, fetch)
    const embed = resolver.embed("b", "embed-model")
    await embed.embed(["x"])
    await embed.embed(["y"])
    expect(requests.length).toBe(2)
    expect(requests[0]!.url).toBe("https://entry-b/embeddings")
    expect(requests[0]!.auth).toBe("Bearer key-b")
    expect(requests[0]!.model).toBe("embed-model")
    cfg.providers.entries.b!.apiKey = "rotated"
    await embed.embed(["z"])
    expect(requests[2]!.auth).toBe("Bearer rotated")
  })

  it("embed with no default entry to fall back to throws (vector path gated at launch)", async () => {
    const cfg = makeConfig((c) => { c.providers.entries = {} })
    const resolver = createProviderResolver(cfg)
    await expect(resolver.embed("ghost", "m").embed(["x"])).rejects.toThrow("embedding provider entry not found")
  })

  it("invalidate also drops embed caches", async () => {
    const cfg = makeConfig()
    let calls = 0
    const fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 })
    }) as unknown as typeof fetch
    const resolver = createProviderResolver(cfg, fetch)
    const embed = resolver.embed("b", "embed-model")
    await embed.embed(["x"])
    resolver.invalidate()
    await embed.embed(["x"])
    expect(calls).toBe(2)
  })
})
