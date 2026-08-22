import { randomUUID, timingSafeEqual } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Mode for the token file: owner read/write only. */
const TOKEN_FILE_MODE = 0o600

/**
 * Read the daemon auth token from `<home>/token`, creating it (mode 0600)
 * with a fresh UUID when missing. The token is reused across restarts.
 */
export function loadOrCreateToken(home: string): string {
  const file = join(home, "token")
  try {
    const existing = readFileSync(file, "utf8").trim()
    if (existing.length > 0) return existing
  } catch {
    // No readable token file yet — fall through and create one.
  }
  const token = randomUUID()
  writeFileSync(file, token, { mode: TOKEN_FILE_MODE })
  return token
}

/** Constant-time comparison of two raw strings (same length requirement as timingSafeEqual). */
export function tokenEquals(actual: string, expected: string): boolean {
  const got = Buffer.from(actual)
  const want = Buffer.from(expected)
  return got.length === want.length && timingSafeEqual(got, want)
}

/** Constant-time comparison of the raw Authorization header against the expected value. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false
  return tokenEquals(header, `Bearer ${token}`)
}
