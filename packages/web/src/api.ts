/**
 * HTTP client for the kclaw daemon. Wraps the shared `httpRequest` base
 * (@kclaw/core/client-http — bearer token, error-body extraction, 204/empty
 * handling) with the web's URL resolution (empty base = same-origin: the
 * daemon serves the SPA itself) and the 401 re-entry hook.
 */

export { HttpRequestError as ApiError } from "@kclaw/core/client-http"
import { httpRequest } from "@kclaw/core/client-http"

export interface ApiClient {
  get<T = unknown>(path: string): Promise<T>
  post<T = unknown>(path: string, body?: unknown): Promise<T>
  patch<T = unknown>(path: string, body?: unknown): Promise<T>
  del<T = unknown>(path: string, body?: unknown): Promise<T>
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
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
    httpRequest(resolveUrl(base, path), {
      method,
      body,
      getToken,
      onUnauthorized: options.onUnauthorized,
    }) as Promise<T>

  const upload = (sessionId: string, file: File): Promise<{ path: string; name: string; size: number }> =>
    httpRequest(
      resolveUrl(base, `/sessions/${encodeURIComponent(sessionId)}/attachments?filename=${encodeURIComponent(file.name)}`),
      {
        method: "POST",
        body: file,
        contentType: file.type || "application/octet-stream",
        getToken,
        onUnauthorized: options.onUnauthorized,
      },
    ).then((parsed) => (parsed as { file: { path: string; name: string; size: number } }).file)

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    del: (path, body) => request("DELETE", path, body),
    upload,
  }
}
