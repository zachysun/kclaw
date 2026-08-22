/** localStorage key holding the daemon bearer token. */
export const TOKEN_KEY = "kclaw_token"

/**
 * Read the `?token=` query parameter from the current URL and return its
 * URL-decoded value. Returns null when the parameter is absent or empty.
 */
export function extractTokenFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get("token")
  return value === null || value === "" ? null : value
}

/** Persist the daemon token in localStorage. */
export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

/** Load the persisted token, or null when none is stored. */
export function loadToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

/**
 * Drop the persisted token. Called on an API 401 so the App re-renders the
 * token form — without it a reload would re-bootstrap the same stale token and
 * loop the auth notice forever (P4 final-review T4).
 */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/**
 * Bootstrap the session token at app start. A `?token=` query param (the
 * daemon's "open in browser" handoff) is saved to localStorage and stripped
 * from the URL via history.replaceState so it does not linger in the address
 * bar. Falls back to the persisted token. Returns the active token or null
 * when there is none (the App then shows the token form).
 */
export function bootstrapToken(): string | null {
  const fromUrl = extractTokenFromUrl()
  if (fromUrl !== null) {
    saveToken(fromUrl)
    const { pathname, hash } = window.location
    window.history.replaceState({}, "", pathname + hash)
    return fromUrl
  }
  return loadToken()
}
