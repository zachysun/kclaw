import { describe, it, expect, beforeEach } from "vitest"
import { extractTokenFromUrl, saveToken, loadToken, clearToken, bootstrapToken } from "../src/token.js"

const TOKEN_KEY = "kclaw_token"

describe("token.ts", () => {
  beforeEach(() => {
    localStorage.clear()
    history.replaceState({}, "", "/")
  })

  it("extracts a decoded token from ?token= in the URL", () => {
    history.replaceState({}, "", "/?token=abc")
    expect(extractTokenFromUrl()).toBe("abc")
  })

  it("URL-decodes the token value", () => {
    history.replaceState({}, "", "/?token=hello%20world")
    expect(extractTokenFromUrl()).toBe("hello world")
  })

  it("returns null when no token query is present", () => {
    expect(extractTokenFromUrl()).toBeNull()
  })

  it("persists and loads the token in localStorage", () => {
    expect(loadToken()).toBeNull()
    saveToken("tok-1")
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok-1")
    expect(loadToken()).toBe("tok-1")
  })

  it("clearToken removes the stored token (401 re-entry)", () => {
    saveToken("stale")
    clearToken()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(loadToken()).toBeNull()
    // clearing an already-empty store is a no-op
    clearToken()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it("bootstrap saves the URL token, strips the query, and returns it", () => {
    history.replaceState({}, "", "/?token=from-url")
    expect(bootstrapToken()).toBe("from-url")
    expect(localStorage.getItem(TOKEN_KEY)).toBe("from-url")
    expect(window.location.search).toBe("")
  })

  it("bootstrap keeps the hash when stripping the query", () => {
    history.replaceState({}, "", "/?token=stray#/settings")
    expect(bootstrapToken()).toBe("stray")
    expect(window.location.pathname).toBe("/")
    expect(window.location.hash).toBe("#/settings")
    expect(window.location.search).toBe("")
  })

  it("bootstrap falls back to the stored token when no URL token exists", () => {
    saveToken("stored")
    expect(bootstrapToken()).toBe("stored")
    expect(window.location.search).toBe("")
  })

  it("bootstrap returns null when neither URL nor storage has a token", () => {
    expect(bootstrapToken()).toBeNull()
  })
})
