/**
 * Daemon client hooks for the web shell.
 *
 * useDaemonClients owns the api/wsUrl/createWs construction with the memo
 * hooks INSIDE, so the App consumes render-stable references structurally
 * instead of remembering to wrap them (the old contract lived in a prose
 * comment over App.tsx — an inline createWs would have re-fired the chat
 * panel's effects and reconnected in a loop, and nothing but the comment
 * stood in the way).
 *
 * The per-session `ws` client deliberately stays in App: its rebuild timing
 * is business state (session selection + ready message baseline), which must
 * not leak into this hook.
 *
 * useSilentFetch is the one implementation of the session-data fetch
 * skeleton (cancelled flag → request → guard-and-set → silent catch →
 * cleanup-cancel) that ChatPanel previously copy-pasted per effect.
 */
import { useCallback, useEffect, useMemo, useState, type DependencyList } from "react"
import { createApi, type ApiClient } from "./api.js"
import { createWsClient, type WsClient } from "./ws.js"

/** Same-origin ws endpoint (the daemon serves the SPA itself). */
function wsUrlFor(): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws"
  return `${protocol}://${window.location.host}/ws`
}

export interface DaemonClients {
  api: ApiClient
  createWs: () => WsClient
  wsUrl: string
}

/**
 * One api client + ws client factory per token. Both references are stable
 * across re-renders; `onUnauthorized` participates in the api identity (a
 * changed handler rebuilds the client) exactly as the old useMemo did.
 */
export function useDaemonClients(token: string, onUnauthorized: () => void): DaemonClients {
  const api = useMemo(
    () => createApi("", () => token, { onUnauthorized }),
    [token, onUnauthorized],
  )
  const [wsUrl] = useState(() => wsUrlFor())
  const createWs = useCallback(() => createWsClient(wsUrl, token), [wsUrl, token])
  return { api, createWs, wsUrl }
}

/**
 * One silent data fetch, cancelled on unmount or re-run: `run` issues the
 * request(s), `onData` lands the result in state only while still mounted.
 * Failures are silent by design — every caller here fetches enhancement data
 * whose absence must not surface as an error (the original four copies each
 * carried this same comment in their own words).
 */
export function useSilentFetch<T>(run: () => Promise<T>, onData: (data: T) => void, deps: DependencyList): void {
  useEffect(() => {
    let cancelled = false
    run()
      .then((data) => {
        if (!cancelled) onData(data)
      })
      .catch(() => {
        // Silent: the enhancement stays at its default; the next dependency
        // change (session switch / refresh) retries.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
