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
 * useSilentFetch is the one implementation of the one-shot session-data
 * fetch skeleton (cancelled flag → request → guard-and-set → silent catch →
 * cleanup-cancel) that ChatPanel previously copy-pasted per effect.
 * useSessionResource is the interactive sibling — fetch + busy debounce +
 * session guard + reset-on-switch + conditional polling + imperative
 * refresh — that the team/goal panels had copy-pasted as two wiring sets.
 */
import { useCallback, useEffect, useMemo, useState, useRef, type DependencyList, type Dispatch, type RefObject, type SetStateAction } from "react"
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

/**
 * One interactive session-scoped resource skeleton: fetch + busy debounce +
 * late-response session guard + optional reset-on-switch + conditional
 * polling + imperative refresh. The team and goal panels carried this shape
 * as two copy-pasted wiring sets before this hook existed; a third
 * session-level panel is now one call instead of a seventh copy of the
 * subtle parts (the session guard is the one a hand copy gets wrong — it is
 * what keeps a late response from the previous session out of the new
 * one's state).
 *
 * `fetcher`/`poll`/`resetOnSwitch` are read through refs on each render —
 * callers pass plain closures, no memo discipline required — while
 * `refresh` is identity-stable, so effects depending on it restart exactly
 * on session switches and never because a closure was rebuilt.
 */
export interface SessionResource<T> {
  /** Latest data (render-time snapshot); null = nothing to render. */
  data: T | null
  /** Live mirror of `data` for non-render paths (the ws frame loop reads it). */
  dataRef: RefObject<T | null>
  /** Escape hatch for callers that clear the data on a user action. */
  setData: Dispatch<SetStateAction<T | null>>
  /** Imperative re-fetch: busy-debounced, silently failing, session-guarded. */
  refresh: () => void
}

export function useSessionResource<T>(opts: {
  sessionId: string
  /**
   * One session-scoped fetch. A rejection is silent — the panel keeps its
   * stale data and the next frame or poll retries; surface 404-shaped
   * "no such resource" as null inside the fetcher (the team panel does).
   */
  fetcher: (sessionId: string) => Promise<T | null>
  /** Reset to null on session switch (the goal view does; the team panel keeps its stale panel until the fresh answer lands). */
  resetOnSwitch?: boolean
  /** Optional conditional polling; `when` is re-evaluated against the latest data each render. */
  poll?: { intervalMs: number; when: (data: T | null) => boolean }
}): SessionResource<T> {
  const { sessionId } = opts
  const [data, setData] = useState<T | null>(null)
  const fetcherRef = useRef(opts.fetcher)
  fetcherRef.current = opts.fetcher
  const pollRef = useRef(opts.poll)
  pollRef.current = opts.poll
  const resetOnSwitchRef = useRef(opts.resetOnSwitch === true)
  resetOnSwitchRef.current = opts.resetOnSwitch === true
  const busyRef = useRef(false)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const dataRef = useRef<T | null>(null)
  dataRef.current = data
  const refresh = useCallback((): void => {
    if (busyRef.current) return
    busyRef.current = true
    const sid = sessionRef.current
    fetcherRef
      .current(sid)
      .then((value) => {
        if (sessionRef.current === sid) setData(value)
      })
      .catch(() => {
        // Silent by design — same contract as useSilentFetch above.
      })
      .finally(() => {
        busyRef.current = false
      })
  }, [])
  useEffect(() => {
    if (resetOnSwitchRef.current) setData(null)
    refresh()
  }, [sessionId, refresh])
  const pollActive = opts.poll !== undefined && opts.poll.when(data)
  useEffect(() => {
    if (!pollActive) return
    const timer = setInterval(refresh, pollRef.current?.intervalMs ?? 5000)
    return () => clearInterval(timer)
  }, [pollActive, refresh])
  return { data, dataRef, setData, refresh }
}
