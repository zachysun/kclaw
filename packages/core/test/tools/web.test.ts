import { describe, it, expect } from "vitest"
import { createWebTools } from "../../src/tools/web.js"

const HTML = `<!doctype html><html><head><title>T</title><script>bad()</script></head>
<body><article><h1>Big News</h1><p>The quick brown fox jumps over the lazy dog. ${"x".repeat(50)}</p></article></body></html>`

const call = (t: { execute(a: unknown, c: unknown): Promise<{ status: string; output: string; data?: unknown }> }, args: unknown) =>
  t.execute(args, { onOutput: () => {} })

describe("web tools", () => {
  it("web_search posts to tavily and formats both output and data", async () => {
    let captured: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input, init)
      return new Response(JSON.stringify({ results: [{ title: "Result A", url: "https://a.com", content: "about a" }] }), { status: 200 })
    }) as typeof fetch
    const t = createWebTools({ tavilyApiKey: "tvly-x", fetchImpl })
    const r = await call(t.web_search, { query: "hello" })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("[Result A](https://a.com)")
    expect((r.data as { results: unknown[] }).results).toHaveLength(1)
    expect(captured!.url).toBe("https://api.tavily.com/search")
    expect(JSON.parse(await captured!.text()).api_key).toBe("tvly-x")
  })
  it("web_fetch extracts readable text and strips scripts", async () => {
    const fetchImpl = (async () => new Response(HTML, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch
    const t = createWebTools({
      tavilyApiKey: "k",
      fetchImpl,
      lookupImpl: (async () => ["93.184.216.34"]) as (host: string) => Promise<string[]>,
    })
    const r = await call(t.web_fetch, { url: "https://example.com/post" })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("Big News")
    expect(r.output).not.toContain("bad()")
  })
  it("web_fetch surfaces http errors", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch
    const t = createWebTools({
      tavilyApiKey: "k",
      fetchImpl,
      lookupImpl: (async () => ["93.184.216.34"]) as (host: string) => Promise<string[]>,
    })
    const r = await call(t.web_fetch, { url: "https://example.com/404" })
    expect(r.status).toBe("error")
    expect(r.output).toMatch(/404/)
  })
  it("web_fetch aborts a hung fetch after timeoutMs", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
    }) as typeof fetch
    const t = createWebTools({
      tavilyApiKey: "k",
      fetchImpl,
      timeoutMs: 50,
      lookupImpl: (async () => ["93.184.216.34"]) as (host: string) => Promise<string[]>,
    })
    const r = await call(t.web_fetch, { url: "https://example.com/hang" })
    expect(r.status).toBe("error")
    expect(r.output).toMatch(/timeout|aborted/i)
  })
  it("passes an AbortSignal to web_search too", async () => {
    let sawSignal = false
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      sawSignal = init?.signal !== undefined
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as typeof fetch
    const t = createWebTools({ tavilyApiKey: "k", fetchImpl })
    await call(t.web_search, { query: "x" })
    expect(sawSignal).toBe(true)
  })
})

describe("private-network deny", () => {
  const pub = (async () => new Response(HTML, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch
  const lookup = (async (host: string) => {
    if (host === "localhost") return ["127.0.0.1", "::1"]
    if (host === "internal.corp") return ["10.1.2.3"]
    return ["93.184.216.34"]
  }) as (host: string) => Promise<string[]>

  it("rejects a literal loopback url", async () => {
    const t = createWebTools({ tavilyApiKey: "k", fetchImpl: pub, lookupImpl: lookup })
    const r = await call(t.web_fetch, { url: "http://127.0.0.1:8080/health" })
    expect(r.status).toBe("error")
    expect(r.output).toMatch(/private network|allowPrivateNetworks/)
  })
  it("rejects a hostname that resolves to a private address (localhost, ::1)", async () => {
    const t = createWebTools({ tavilyApiKey: "k", fetchImpl: pub, lookupImpl: lookup })
    const r = await call(t.web_fetch, { url: "http://localhost/x" })
    expect(r.status).toBe("error")
  })
  it("follows a redirect but blocks a hop into a private address", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === "https://public.example/start") {
        return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/secret" } })
      }
      return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } })
    }) as typeof fetch
    const t = createWebTools({ tavilyApiKey: "k", fetchImpl, lookupImpl: lookup })
    const r = await call(t.web_fetch, { url: "https://public.example/start" })
    expect(r.status).toBe("error")
    expect(r.output).toMatch(/private network/)
  })
  it("allowPrivateNetworks opts-in (local Ollama case)", async () => {
    const t = createWebTools({ tavilyApiKey: "k", fetchImpl: pub, lookupImpl: lookup, allowPrivateNetworks: true })
    const r = await call(t.web_fetch, { url: "http://127.0.0.1:11434/v1" })
    expect(r.status).toBe("ok")
  })
  it("public urls still work through the redirect loop", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u === "https://a.example/") {
        return new Response(null, { status: 301, headers: { location: "https://b.example/final" } })
      }
      return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } })
    }) as typeof fetch
    const t = createWebTools({ tavilyApiKey: "k", fetchImpl, lookupImpl: lookup })
    const r = await call(t.web_fetch, { url: "https://a.example/" })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("Big News")
  })
})
