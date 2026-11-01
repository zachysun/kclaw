/**
 * CodeView — the current-content (and fs_write payload) viewer: one line per
 * row with a gutter line number and per-line syntax highlighting (lines are
 * highlighted individually, so a highlight span can never run across the
 * gutter markup).
 */
import { useMemo } from "react"
import type React from "react"
import { escapeHtml, highlightLine } from "./lang.js"

export interface CodeViewProps {
  content: string
  lang?: string
  /** Tool-card form: tighter paddings. */
  compact?: boolean
}

export function CodeView({ content, lang, compact }: CodeViewProps): React.ReactElement {
  const lines = useMemo(() => {
    const split = content.split("\n")
    // A trailing newline is the file's final line ending, not an extra empty line.
    if (split.length > 0 && split[split.length - 1] === "") split.pop()
    return split
  }, [content])
  return (
    // `md` rides along so the shared highlight token colors (.md .hljs-*) apply.
    <div className={`codeview md${compact ? " codeview-compact" : ""}`}>
      {lines.map((line, idx) => (
        <div key={idx} className="codeview-row">
          <span className="codeview-no">{idx + 1}</span>
          <span
            className="codeview-text hljs"
            dangerouslySetInnerHTML={{ __html: line === "" ? escapeHtml("") : highlightLine(line, lang) }}
          />
        </div>
      ))}
    </div>
  )
}
