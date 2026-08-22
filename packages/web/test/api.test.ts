import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createApi, ApiError } from "../src/api.js"

/** Minimal fetch Response stand-in for the tests below. */
function mockResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response
}

describe("api.ts", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("GET resolves parsed JSON from a 2xx response", async () => {
    fetchMock.mockResolvedValue(mockResponse(200, { ok: true }))
    const api = createApi("", () => null)
    await expect(api.get("/status")).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith("/status", expect.anything())
  })

  it("resolves undefined for 204 No Content", async () => {
    fetchMock.mockResolvedValue(mockResponse(204))
    const api = createApi("", () => null)
    await expect(api.del("/sessions/1")).resolves.toBeUndefined()
  })

  it("throws ApiError with status 401 and the body error message", async () => {
    fetchMock.mockResolvedValue(mockResponse(401, { error: "unauthorized" }))
    const api = createApi("", () => null)
    const err = await api.get("/sessions").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 401, message: "unauthorized" })
  })

  it("fires onUnauthorized on a 401 and still throws the ApiError", async () => {
    fetchMock.mockResolvedValue(mockResponse(401, { error: "unauthorized" }))
    const onUnauthorized = vi.fn()
    const api = createApi("", () => null, { onUnauthorized })
    await expect(api.get("/status")).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it("does not fire onUnauthorized for other non-2xx responses", async () => {
    fetchMock.mockResolvedValue(mockResponse(500, { error: "boom" }))
    const onUnauthorized = vi.fn()
    const api = createApi("", () => null, { onUnauthorized })
    await expect(api.get("/sessions")).rejects.toMatchObject({ status: 500 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("propagates body.error for other non-2xx responses", async () => {
    fetchMock.mockResolvedValue(mockResponse(500, { error: "boom" }))
    const api = createApi("", () => null)
    await expect(api.post("/sessions")).rejects.toMatchObject({ status: 500, message: "boom" })
  })

  it("falls back to HTTP <status> when the error body is not JSON", async () => {
    fetchMock.mockResolvedValue({ ...mockResponse(502), text: async () => "bad gateway" } as unknown as Response)
    const api = createApi("", () => null)
    await expect(api.get("/x")).rejects.toMatchObject({ status: 502, message: "HTTP 502" })
  })

  it("sends the Bearer header when a token is present", async () => {
    fetchMock.mockResolvedValue(mockResponse(200, []))
    const api = createApi("", () => "tok-1")
    await api.get("/sessions")
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(init.headers).toMatchObject({ authorization: "Bearer tok-1" })
  })

  it("omits the Authorization header when there is no token", async () => {
    fetchMock.mockResolvedValue(mockResponse(200, []))
    const api = createApi("", () => null)
    await api.get("/sessions")
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(init.headers).not.toHaveProperty("authorization")
  })

  it("resolves paths against a full base URL", async () => {
    fetchMock.mockResolvedValue(mockResponse(200, {}))
    const api = createApi("http://127.0.0.1:52143", () => null)
    await api.get("/status")
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:52143/status")
  })

  it("JSON-encodes bodies on post/patch", async () => {
    fetchMock.mockResolvedValue(mockResponse(200, {}))
    const api = createApi("", () => null)
    await api.post("/sessions", { title: "hi" })
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(init.method).toBe("POST")
    expect(init.body).toBe(JSON.stringify({ title: "hi" }))
    expect(init.headers).toMatchObject({ "content-type": "application/json" })
  })
})
