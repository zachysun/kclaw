/**
 * HTTP client for the kclaw daemon. Wraps fetch with the bearer token and
 * turns non-2xx responses into {@link ApiError} carrying the server's
 * `body.error` message. A 401 propagates as a plain ApiError with status 401
 * so the App can drop back to the token form.
 */

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export interface ApiClient {
  get<T = unknown>(path: string): Promise<T>
  post<T = unknown>(path: string, body?: unknown): Promise<T>
  patch<T = unknown>(path: string, body?: unknown): Promise<T>
  del<T = unknown>(path: string): Promise<T>
  /** Upload a raw file to a session's attachments dir (drag-and-drop). */
  upload(sessionId: string, file: File): Promise<{ path: string; name: string; size: number }>
}

/**
 * Resolve a request path against the base. An empty base means same-origin:
 * the daemon serves the SPA itself, so paths are relative.
 */
function resolveUrl(base: string, path: string): string {
  return base === "" ? path : `${base}${path}`
}

export interface ApiClientOptions {
  /**
   * Fired once per 401 response (status ping, sessions, jobs, audit, message
   * pulls — any request through the client). The App uses it to clear the
   * stored token and drop back to the token form, so a stale token cannot
   * loop the "refresh to re-enter" notice forever.
   */
  onUnauthorized?: () => void
}

/**
 * Create an API client for the daemon. `getToken` is re-evaluated per request
 * so a rotated token (re-entered on 401) takes effect immediately.
 */
export function createApi(
  base: string,
  getToken: () => string | null,
  options: ApiClientOptions = {},
): ApiClient {
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const token = getToken()
    const headers: Record<string, string> = {}
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers["content-type"] = "application/json"

    const res = await fetch(resolveUrl(base, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (!res.ok) {
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
      const err = new ApiError(res.status, message)
      // The App drops back to the token form on any 401 (the re-entry path).
      if (err.status === 401) options.onUnauthorized?.()
      throw err
    }

    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text === "" ? undefined : (JSON.parse(text) as T)) as T
  }

  const upload = async (sessionId: string, file: File): Promise<{ path: string; name: string; size: number }> => {
    const token = getToken()
    const res = await fetch(
      resolveUrl(base, `/sessions/${encodeURIComponent(sessionId)}/attachments?filename=${encodeURIComponent(file.name)}`),
      {
        method: "POST",
        headers: {
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
          "content-type": file.type || "application/octet-stream",
        },
        body: file,
      },
    )
    if (res.status === 401) options.onUnauthorized?.()
    if (!res.ok) {
      let message = `HTTP ${res.status}`
      try {
        const data: unknown = await res.json()
        if (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>).error === "string") {
          message = (data as { error: string }).error
        }
      } catch {
        // keep HTTP fallback
      }
      throw new ApiError(res.status, message)
    }
    const body = (await res.json()) as { file: { path: string; name: string; size: number } }
    return body.file
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    del: (path) => request("DELETE", path),
    upload,
  }
}
