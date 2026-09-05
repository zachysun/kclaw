/**
 * HTTP request base shared by every client of the daemon (CLI, WebUI,
 * daemon-ctl): bearer injection, JSON body serialization, and one error path
 * — non-2xx resolves the server's `body.error` message (falling back to
 * `HTTP <status>`) and throws {@link HttpRequestError} carrying the status.
 *
 * Runs on plain fetch, so it works in Node and the browser alike; the module
 * must never import `node:*` (the WebUI bundles it).
 */

/** Non-2xx response: the server's `body.error` message (fallback `HTTP <status>`). */
export class HttpRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "HttpRequestError"
    this.status = status
  }
}

export interface HttpRequestInit {
  /** HTTP method (default GET). */
  method?: string
  /**
   * JSON request body (serialized with `application/json`) — unless
   * {@link HttpRequestInit.contentType} is set, in which case the body is
   * passed through raw (attachment uploads).
   */
  body?: unknown
  /** Pass the body through unserialized with this content type. */
  contentType?: string
  /**
   * Re-evaluated per request so a rotated token (re-entered after a 401)
   * takes effect immediately; `null` sends no Authorization header.
   */
  getToken: () => string | null
  /** Fired once per 401 response, before the throw (the App's re-entry hook). */
  onUnauthorized?: () => void
}

/**
 * One request to the daemon: JSON in, JSON out. A 204 (or an empty body)
 * resolves `undefined`.
 */
export async function httpRequest(url: string, init: HttpRequestInit): Promise<unknown> {
  const { method = "GET", body, contentType, getToken, onUnauthorized } = init
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers["content-type"] = contentType ?? "application/json"

  const res = await fetch(url, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : contentType === undefined
          ? JSON.stringify(body)
          : (body as BodyInit),
  })

  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.()
    let message = `HTTP ${res.status}`
    try {
      const data: unknown = await res.json()
      if (
        typeof data === "object" && data !== null &&
        typeof (data as { error?: unknown }).error === "string"
      ) {
        message = (data as { error: string }).error
      }
    } catch {
      // Non-JSON error body: keep the HTTP fallback.
    }
    throw new HttpRequestError(res.status, message)
  }

  if (res.status === 204) return undefined
  const text = await res.text()
  return text === "" ? undefined : (JSON.parse(text) as unknown)
}
