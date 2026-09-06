/** 云端 OpenAI 兼容 /v1/embeddings 客户端：不内置本地模型。 */
export interface EmbeddingClient {
  embed(texts: string[]): Promise<Float32Array[]>
}

const DEFAULT_TIMEOUT_MS = 30_000

export function createEmbeddingClient(opts: {
  baseUrl: string; apiKey: string; model: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): EmbeddingClient {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const res = await doFetch(`${opts.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: opts.model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        let text = ""
        try { text = await res.text() } catch { /* keep status-only */ }
        throw new Error(`embeddings http ${res.status}: ${text.slice(0, 200)}`)
      }
      const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
      const out = body.data ?? []
      if (out.length !== texts.length || out.some((d) => !Array.isArray(d.embedding))) {
        throw new Error("embeddings response shape mismatch")
      }
      return out.map((d) => new Float32Array(d.embedding!))
    },
  }
}

export function serializeVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

export function deserializeVector(b: Buffer): Float32Array {
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

/** 余弦相似度；长度不等或零向量 → 0（降级语义，不报错）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
