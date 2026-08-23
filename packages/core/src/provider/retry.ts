import type { LlmClient, LlmRequest, LlmStreamEvent } from "./types.js"

export interface RetryOpts {
  maxAttempts?: number
  baseDelayMs?: number
  jitter?: () => number
  onRetry?: (info: { attempt: number; error: unknown }) => void
}

/**
 * Transient errors worth retrying: network-layer failures (TypeError), 429,
 * HTTP 5xx, and provider timeouts.
 *
 * Message contract (openai-compat.ts classifies, this regex consumes): HTTP
 * failures throw `llm http <status>: ...` and timeouts throw
 * `llm http timeout after <n>ms` — the timeout arm was added with the
 * provider stream timeout so an aborted hung stream retries with
 * backoff like any other transient failure. Keep both patterns in sync when
 * touching either side.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof TypeError) return true // network layer
  const msg = err instanceof Error ? err.message : String(err)
  return /llm http (429|5\d\d|timeout)/.test(msg)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function withRetry(client: LlmClient, opts: RetryOpts = {}): LlmClient {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 500
  const jitter = opts.jitter ?? Math.random
  return {
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      let lastErr: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let yielded = false
        try {
          for await (const e of client.stream(req)) {
            yielded = true
            yield e
          }
          return
        } catch (err) {
          lastErr = err
          // Never retry after the stream has produced events: the consumer
          // may already have received them, so a retry would duplicate output.
          if (yielded || attempt === maxAttempts || !isTransient(err)) throw err
          opts.onRetry?.({ attempt, error: err })
          await sleep(baseDelayMs * 2 ** (attempt - 1) + jitter() * 100)
        }
      }
      throw lastErr
    },
  }
}
