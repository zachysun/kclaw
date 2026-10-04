/**
 * The stateful "cache marker" protocol shared by both streaming clients
 * (Anthropic cache_control breakpoints, OpenAI prompt_cache_key):
 *
 * 1. gate — markers go out only when the entry allows it (config
 *    promptCache:"off" opts out), the request carries the marker payload,
 *    and this client instance has no remembered rejection;
 * 2. strip-and-retry-once — a 400 is a schema rejection (never 401/403/429:
 *    auth/ratelimit failures are not schema problems), so the markers are
 *    stripped and the request retried once;
 * 3. verdict — the "this endpoint rejects markers" verdict is remembered
 *    ONLY when the retry succeeded: a retry that still fails points at a
 *    non-marker cause (bad model name etc.) and must not silently disable
 *    markers for this entry.
 *
 * The verdict lives per client instance = per provider entry lifetime (the
 * resolver rebuilds on config change, resetting it). What varies per wire
 * format — where markers sit in the payload and what they are called — stays
 * in the adapters via `buildBody`; the timing rules above exist only here.
 */
export interface CacheMarkerPolicy {
  /** Whether markers may go out for this request (the gate). */
  wanted(requestCarriesMarkers: boolean): boolean
  /**
   * POST with the strip-and-retry-once protocol. `post` performs the HTTP
   * call; `buildBody(marked)` serializes the payload with or without
   * markers. Returns the response the caller streams from.
   */
  send(args: {
    wanted: boolean
    post: (body: string) => Promise<Response>
    buildBody: (marked: boolean) => string
    /** Full console.error line emitted when the strip-and-retry fires. */
    rejectedLogLine: string
  }): Promise<Response>
}

export function createCacheMarkerPolicy(opts: {
  /** Entry-level opt-out (config promptCache:"off"); undefined = allowed. */
  promptCacheEnabled?: boolean
}): CacheMarkerPolicy {
  // "this endpoint rejects cache markers" verdict, per client instance =
  // per provider entry lifetime (resolver rebuilds on config change).
  let rejected = false
  return {
    wanted(requestCarriesMarkers) {
      return opts.promptCacheEnabled !== false && requestCarriesMarkers && !rejected
    },
    async send({ wanted, post, buildBody, rejectedLogLine }) {
      const res = await post(buildBody(wanted))
      if (res.status !== 400 || !wanted) return res
      console.error(rejectedLogLine)
      const retry = await post(buildBody(false))
      // Remember the verdict only when the retry succeeded (rule 3 above).
      if (retry.ok) rejected = true
      return retry
    },
  }
}
