import { describe, it, expect } from "vitest"
import { fetchProviderModels, probeProviderChat } from "../../src/provider/probe.js"

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

describe("probeProviderChat", () => {
  it("openai format: POST {base}/chat/completions with Bearer and a 1-token completion", async () => {
    let captured: Request | undefined
    let capturedBody = ""
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      capturedBody = String(init?.body ?? "")
      return jsonResponse({ choices: [] })
    }) as unknown as typeof fetch
    const out = await probeProviderChat({ format: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x", model: "deepseek-chat", fetchImpl })
    expect(out).toEqual({ status: 200, body: '{"choices":[]}' })
    expect(captured!.url).toBe("https://api.deepseek.com/v1/chat/completions")
    expect(captured!.method).toBe("POST")
    expect(captured!.headers.get("authorization")).toBe("Bearer sk-x")
    const payload = JSON.parse(capturedBody) as { model: string; max_tokens: number; messages: unknown[]; stream?: boolean }
    expect(payload.model).toBe("deepseek-chat")
    expect(payload.max_tokens).toBe(1)
    expect(payload.messages).toEqual([{ role: "user", content: "hi" }])
    expect(payload.stream).toBe(false)
  })

  it("anthropic format: POST {base}/v1/messages with x-api-key + anthropic-version and block content", async () => {
    let captured: Request | undefined
    let capturedBody = ""
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      capturedBody = String(init?.body ?? "")
      return jsonResponse({ content: [] })
    }) as unknown as typeof fetch
    await probeProviderChat({ format: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-a", model: "claude-sonnet-4", fetchImpl })
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages")
    expect(captured!.headers.get("x-api-key")).toBe("sk-a")
    expect(captured!.headers.get("anthropic-version")).toBe("2023-06-01")
    const payload = JSON.parse(capturedBody) as { messages: Array<{ content: Array<{ type: string; text: string }> }>; max_tokens: number }
    expect(payload.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    expect(payload.max_tokens).toBe(1)
  })

  it("empty apiKey sends no auth header; http errors and network failures are results, not throws", async () => {
    let captured: Request | undefined
    const okFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return jsonResponse({})
    }) as unknown as typeof fetch
    await probeProviderChat({ format: "openai", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3", fetchImpl: okFetch })
    expect(captured!.headers.get("authorization")).toBeNull()

    const denied = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch
    const http = await probeProviderChat({ format: "openai", baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: denied })
    expect(http).toEqual({ status: 401, body: "bad key" })

    const dead = (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch
    const net = await probeProviderChat({ format: "openai", baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: dead })
    expect(net).toEqual({ status: null, body: "" })
  })
})
