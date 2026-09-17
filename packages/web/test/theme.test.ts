/**
 * Theme registry tests: the stylesheet list and THEME_META agree (one theme =
 * one stylesheet + one metadata entry), loadTheme falls back to the default on
 * empty/corrupt storage, and applyTheme writes the <html data-theme> attribute
 * (the CSS swap hook), the browser-chrome theme color, and localStorage.
 */
import { describe, it, expect, beforeEach } from "vitest"
import {
  applyTheme, DEFAULT_THEME, isThemeName, loadTheme, themeOptions,
  themeStylesheetIds, THEME_META,
} from "../src/theme.js"

describe("shell theme", () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    // The real page carries this meta; jsdom loads no HTML file.
    document.head.innerHTML = '<meta name="theme-color" content="#0b0b0d" />'
  })

  it("derives the registry from the theme stylesheets (one file ↔ one entry)", () => {
    expect(themeStylesheetIds()).not.toHaveLength(0)
    expect([...themeStylesheetIds()].sort()).toEqual(Object.keys(THEME_META).sort())
  })

  it("lists every theme with the default first and a display label", () => {
    const options = themeOptions()
    expect(options.length).toBe(Object.keys(THEME_META).length)
    expect(options[0]!.id).toBe(DEFAULT_THEME)
    expect(new Set(options.map((o) => o.id)).size).toBe(options.length)
    for (const option of options) expect(option.label).not.toBe("")
  })

  it("defaults to phantom when nothing is stored", () => {
    expect(DEFAULT_THEME).toBe("phantom")
    expect(loadTheme()).toBe("phantom")
  })

  it("falls back to the default on a corrupt value", () => {
    localStorage.setItem("kclaw_theme", "neon-pink")
    expect(loadTheme()).toBe("phantom")
    expect(isThemeName("amber")).toBe(true)
    expect(isThemeName("neon-pink")).toBe(false)
  })

  it("applyTheme sets the html attribute, the theme-color meta, and persists the choice", () => {
    applyTheme("amber")
    expect(document.documentElement.dataset.theme).toBe("amber")
    expect(localStorage.getItem("kclaw_theme")).toBe("amber")
    expect(loadTheme()).toBe("amber")
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content"))
      .toBe(THEME_META.amber.themeColor)
  })
})
