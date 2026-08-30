import { describe, it, expect, vi } from "vitest"
import { createEmbeddingClient, serializeVector, deserializeVector, cosine } from "../../src/memory/embeddings.js"

describe("createEmbeddingClient", () => {
  it("POSTs /v1/embeddings with model+input and parses data[].embedding", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
      { status: 200 },
    ))
    const client = createEmbeddingClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", fetchImpl: fetchImpl as unknown as typeof fetch })
    const out = await client.embed(["你好", "世界"])
    expect(out).toEqual([new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])])
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.example.com/v1/embeddings")
    expect(JSON.parse(String(init.body))).toEqual({ model: "m", input: ["你好", "世界"] })
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k")
  })
  it("rejects on non-2xx (caller degrades this attempt)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }))
    const client = createEmbeddingClient({ baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.embed(["x"])).rejects.toThrow(/404/)
  })
})

describe("vector codec", () => {
  it("round-trips Float32Array through Buffer", () => {
    const v = new Float32Array([0.5, -0.25, 0])
    expect(Array.from(deserializeVector(serializeVector(v)))).toEqual([0.5, -0.25, 0])
  })
  it("cosine: identical=1, orthogonal=0, zero-vector=0, length-mismatch=0", () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1)
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0)
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0)
    expect(cosine(new Float32Array([1]), new Float32Array([1, 1]))).toBe(0)
  })
})
