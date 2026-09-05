import { afterEach, describe, expect, it, vi } from "vitest"
import { HttpRequestError, httpRequest } from "../src/client-http.js"

/** Install a fetch stub for one test; restored after each. */
function stubFetch(impl: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(impl))
}

const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("httpRequest", () => {
  it("sends the bearer token and serializes a JSON body", async () => {
    const fetchMock = vi.fn(async () => okJson({ fine: true }))
    vi.stubGlobal("fetch", fetchMock)

    await httpRequest("http://x/status", { body: { a: 1 }, getToken: () => "t0" })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://x/status")
    expect(init.method).toBe("GET")
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer t0")
    expect(headers["content-type"]).toBe("application/json")
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
  })

  it("re-evaluates getToken per request (a null token drops the header)", async () => {
    const fetchMock = vi.fn(async () => okJson({}))
    vi.stubGlobal("fetch", fetchMock)

    await httpRequest("http://x/a", { getToken: () => "t1" })
    await httpRequest("http://x/b", { getToken: () => null })

    const h1 = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    const h2 = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>
    expect(h1.authorization).toBe("Bearer t1")
    expect(h2.authorization).toBeUndefined()
  })

  it("throws HttpRequestError with the body error message and status", async () => {
    stubFetch(async () => okJson({ error: "session not found" }, 404))

    const err = await httpRequest("http://x/sessions/nope", { getToken: () => "t" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpRequestError)
    expect((err as HttpRequestError).status).toBe(404)
    expect((err as HttpRequestError).message).toBe("session not found")
  })

  it("falls back to `HTTP <status>` on a non-JSON error body", async () => {
    stubFetch(async () => new Response("gateway exploded", { status: 502 }))

    const err = await httpRequest("http://x/", { getToken: () => "t" }).catch((e: unknown) => e)
    expect((err as HttpRequestError).status).toBe(502)
    expect((err as HttpRequestError).message).toBe("HTTP 502")
  })

  it("fires onUnauthorized once per 401, before the throw", async () => {
    stubFetch(async () => okJson({ error: "stale token" }, 401))
    const onUnauthorized = vi.fn()

    await expect(
      httpRequest("http://x/status", { getToken: () => "t", onUnauthorized }),
    ).rejects.toBeInstanceOf(HttpRequestError)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it("resolves undefined on 204 and on an empty body; parses JSON otherwise", async () => {
    stubFetch(async () => new Response(null, { status: 204 }))
    await expect(httpRequest("http://x/a", { getToken: () => "t" })).resolves.toBeUndefined()

    stubFetch(async () => new Response("", { status: 200 }))
    await expect(httpRequest("http://x/b", { getToken: () => "t" })).resolves.toBeUndefined()

    stubFetch(async () => okJson({ v: 7 }))
    await expect(httpRequest("http://x/c", { getToken: () => "t" })).resolves.toEqual({ v: 7 })
  })

  it("passes a raw body through with the given content type (uploads)", async () => {
    const fetchMock = vi.fn(async () => okJson({ file: { path: "p", name: "n", size: 1 } }))
    vi.stubGlobal("fetch", fetchMock)
    const raw = new Uint8Array([1, 2, 3])

    await httpRequest("http://x/sessions/s/attachments", {
      method: "POST",
      body: raw,
      contentType: "application/octet-stream",
      getToken: () => "t",
    })

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe("POST")
    expect(init.body).toBe(raw)
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream")
  })
})
