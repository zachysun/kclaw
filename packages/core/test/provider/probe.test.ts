import { describe, it, expect } from "vitest"
import { fetchProviderModels } from "../../src/provider/probe.js"

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

describe("fetchProviderModels", () => {
  it("openai format: GET {base}/models with Bearer, dedupes ids", async () => {
    let captured: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return jsonResponse({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, { id: "" }] })
    }) as unknown as typeof fetch
    const models = await fetchProviderModels({ format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x", fetchImpl })
    expect(captured!.url).toBe("https://api.deepseek.com/v1/models")
    expect(captured!.headers.get("authorization")).toBe("Bearer sk-x")
    expect(models).toEqual(["b", "a"])
  })

  it("anthropic format: GET {base}/v1/models with x-api-key + anthropic-version", async () => {
    let captured: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return jsonResponse({ data: [{ id: "claude-sonnet-4" }], has_more: false })
    }) as unknown as typeof fetch
    const models = await fetchProviderModels({ format: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-a", fetchImpl })
    expect(captured!.url).toBe("https://api.anthropic.com/v1/models")
    expect(captured!.headers.get("x-api-key")).toBe("sk-a")
    expect(models).toEqual(["claude-sonnet-4"])
  })

  it("empty apiKey sends no auth header", async () => {
    let captured: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return jsonResponse({ data: [] })
    }) as unknown as typeof fetch
    await fetchProviderModels({ format: "openai", baseUrl: "http://localhost:11434/v1", apiKey: "", fetchImpl })
    expect(captured!.headers.get("authorization")).toBeNull()
  })

  it("surfaces http errors and malformed payloads", async () => {
    const errFetch = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch
    await expect(fetchProviderModels({ format: "openai", baseUrl: "https://x", apiKey: "k", fetchImpl: errFetch }))
      .rejects.toThrow("llm http 403")
    const badFetch = (async () => jsonResponse({ models: [] })) as unknown as typeof fetch
    await expect(fetchProviderModels({ format: "openai", baseUrl: "https://x", apiKey: "k", fetchImpl: badFetch }))
      .rejects.toThrow("no data array")
  })
})
