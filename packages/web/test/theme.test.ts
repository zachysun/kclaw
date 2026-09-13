/**
 * Theme persistence tests: loadTheme falls back to phantom on empty/corrupt
 * storage, applyTheme writes both the <html data-theme> attribute (the CSS
 * swap hook) and localStorage, and nextTheme toggles.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { applyTheme, isThemeName, loadTheme, nextTheme } from "../src/theme.js"

describe("shell theme", () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
  })

  it("defaults to phantom when nothing is stored", () => {
    expect(loadTheme()).toBe("phantom")
  })

  it("falls back to phantom on a corrupt value", () => {
    localStorage.setItem("kclaw_theme", "neon-pink")
    expect(loadTheme()).toBe("phantom")
    expect(isThemeName("amber")).toBe(true)
    expect(isThemeName("neon-pink")).toBe(false)
  })

  it("applyTheme sets the html attribute and persists the choice", () => {
    applyTheme("amber")
    expect(document.documentElement.dataset.theme).toBe("amber")
    expect(localStorage.getItem("kclaw_theme")).toBe("amber")
    expect(loadTheme()).toBe("amber")
  })

  it("nextTheme toggles between the two", () => {
    expect(nextTheme("phantom")).toBe("amber")
    expect(nextTheme("amber")).toBe("phantom")
  })
})
