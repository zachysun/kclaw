/**
 * Theme selection for the web shell: "phantom" (red/black, the default) or
 * "amber" (the classic warm look). The choice rides <html data-theme> so the
 * whole swap is pure CSS — components only reference tokens. index.html sets
 * the attribute inline before the stylesheet loads (no wrong-theme flash);
 * this module owns reading and persisting the choice afterwards.
 */
export type ThemeName = "phantom" | "amber"

const THEME_KEY = "kclaw_theme"
const THEMES: ThemeName[] = ["phantom", "amber"]

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEMES as string[]).includes(value)
}

/** The stored theme, or the phantom default when nothing/corrupt is stored. */
export function loadTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return isThemeName(stored) ? stored : "phantom"
  } catch {
    return "phantom"
  }
}

/** Apply to the document and persist; storage failures stay session-only. */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
  // Keep the browser chrome (PWA window, mobile status bar) on the theme's
  // canvas color.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "phantom" ? "#0b0b0d" : "#131518")
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // ignore — the choice still applies for this session
  }
}

/** The other theme, in toggle order. */
export function nextTheme(theme: ThemeName): ThemeName {
  return theme === "phantom" ? "amber" : "phantom"
}
