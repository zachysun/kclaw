/**
 * Terminal display width: a CJK character takes two columns, an emoji two, a
 * combining mark none — counting characters misaligns any table with Chinese
 * text in it. Shared by `session list` (A9) and the TUI status line (B10).
 */
import stringWidth from "string-width"

export function displayWidth(text: string): number {
  return stringWidth(text)
}

/** Right-pad `text` with spaces to `width` display columns. */
export function padDisplay(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - stringWidth(text)))
}

/**
 * Align rows of cells into columns two spaces apart; the last column is not
 * padded. Every row must have the same number of cells.
 */
export function alignColumns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stringWidth(cell))
    })
  }
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : padDisplay(cell, widths[i]!))).join("  "))
}

/**
 * Wrap one logical line into visual lines of at most `width` display
 * columns (CJK-aware, so 中文 breaks at the right column). The transcript
 * overlay slices scrollable content by VISUAL line; ink's own wrapping is
 * layout-only (unquery-able line counts), so long text must be wrapped here
 * first for the line offsets to match what is on screen.
 */
export function wrapDisplay(text: string, width: number): string[] {
  const cap = Math.max(1, width)
  const lines: string[] = []
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") {
      lines.push("")
      continue
    }
    let current = ""
    let currentWidth = 0
    for (const ch of rawLine) {
      const w = stringWidth(ch)
      if (currentWidth + w > cap && current !== "") {
        lines.push(current)
        current = ""
        currentWidth = 0
      }
      current += ch
      currentWidth += w
    }
    lines.push(current)
  }
  return lines
}
