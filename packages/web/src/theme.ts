/// <reference types="vite/client" />
/**
 * Theme selection for the web shell: one theme = one stylesheet in ./themes/
 * (palette, color-scheme, radii, decorations) plus one THEME_META entry below
 * (display name + browser-chrome color). The choice rides <html data-theme>
 * so the whole swap is pure CSS — components only reference tokens.
 * index.html applies the stored value inline before the stylesheet loads and
 * does not know the theme list: an unknown value matches no theme block and
 * renders the default palette via the default theme's :root. This module owns
 * validating, applying and persisting the choice afterwards.
 */

const THEME_KEY = "kclaw_theme"

/** Display name + browser-chrome theme color, one entry per theme. A theme
 *  stylesheet without an entry here (or the reverse) fails the theme unit
 *  test — the registry and the stylesheets must stay in lockstep. */
export const THEME_META = {
  phantom: { label: "红黑", themeColor: "#0b0b0d" },
  amber: { label: "琥珀", themeColor: "#131518" },
  paper: { label: "纸白", themeColor: "#edeae1" },
} as const

export type ThemeName = keyof typeof THEME_META

export const DEFAULT_THEME: ThemeName = "phantom"

/** Theme ids derived from the ./themes/ stylesheet filenames (build-time scan,
 *  eagerly inlined into the bundle — no extra requests). */
export function themeStylesheetIds(): string[] {
  const modules = import.meta.glob("./themes/*.css", { eager: true })
  return Object.keys(modules)
    .map((path) => /^\.\/themes\/(.+)\.css$/.exec(path)?.[1])
    .filter((id): id is string => id !== undefined)
}

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && Object.hasOwn(THEME_META, value)
}

/** The stored theme, or the default when nothing/corrupt is stored. */
export function loadTheme(): ThemeName {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return isThemeName(stored) ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Apply to the document and persist; storage failures stay session-only. */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
  // Keep the browser chrome (PWA window, mobile status bar) on the theme's
  // canvas color.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_META[theme].themeColor)
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // ignore — the choice still applies for this session
  }
}

/** Registered themes in dropdown order: the default first, the rest alphabetical. */
export function themeOptions(): Array<{ id: ThemeName; label: string }> {
  return (Object.keys(THEME_META) as ThemeName[])
    .sort((a, b) => (a === DEFAULT_THEME ? -1 : b === DEFAULT_THEME ? 1 : a.localeCompare(b)))
    .map((id) => ({ id, label: THEME_META[id].label }))
}
