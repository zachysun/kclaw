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
    const t = createWebTools({ tavilyApiKey: "k", fetchImpl })
    const r = await call(t.web_fetch, { url: "https://example.com/post" })
    expect(r.status).toBe("ok")
    expect(r.output).toContain("Big News")
    expect(r.output).not.toContain("bad()")
  })
  it("web_fetch surfaces http errors", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch
    const t = createWebTools({ tavilyApiKey: "k", fetchImpl })
    const r = await call(t.web_fetch, { url: "https://example.com/404" })
    expect(r.status).toBe("error")
    expect(r.output).toMatch(/404/)
  })
})
