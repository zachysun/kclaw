/**
 * DiffView — the red/green diff for fs_edit changes (tool cards use the
 * compact form, the change drawer the full form). Line alignment comes from
 * jsdiff's line diff; paired lines additionally get a word-level overlay,
 * with syntax highlighting applied per fragment (validated in the diff
 * rendering prototype: fragment-level highlight survives the overlay, and
 * unpairable surplus lines fall back to whole-line coloring — the old
 * index-pairing card misaligned exactly there).
 */
import { useMemo } from "react"
import type React from "react"
import { diffLines, diffWords } from "diff"
import { highlightLine } from "./lang.js"

interface DiffRow {
  kind: "del" | "add" | "ctx"
  oldNo?: number
  newNo?: number
  text: string
  /** The counterpart line when a del/add pair exists (enables the word overlay). */
  pair?: string
}

/** jsdiff line blocks → flat rows; adjacent removed/added blocks pair up by index, surplus lines stay whole-line colored. */
function buildRows(oldText: string, newText: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  const blocks = diffLines(oldText, newText)
  const linesOf = (value: string): string[] => {
    const lines = value.split("\n")
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop() // diffLines values trail a newline
    return lines
  }
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]!
    if (block.removed) {
      let j = i
      const dels: string[] = []
      const adds: string[] = []
      while (j < blocks.length && blocks[j]!.removed) { dels.push(...linesOf(blocks[j]!.value)); j++ }
      while (j < blocks.length && blocks[j]!.added) { adds.push(...linesOf(blocks[j]!.value)); j++ }
      const n = Math.max(dels.length, adds.length)
      for (let k = 0; k < n; k++) {
        const d = dels[k]
        const a = adds[k]
        if (d !== undefined && a !== undefined) {
          rows.push({ kind: "del", oldNo: ++oldNo, text: d, pair: a })
          rows.push({ kind: "add", newNo: ++newNo, text: a, pair: d })
        } else if (d !== undefined) {
          rows.push({ kind: "del", oldNo: ++oldNo, text: d })
        } else {
          rows.push({ kind: "add", newNo: ++newNo, text: a! })
        }
      }
      i = j
    } else if (block.added) {
      for (const line of linesOf(block.value)) rows.push({ kind: "add", newNo: ++newNo, text: line })
      i++
    } else {
      for (const line of linesOf(block.value)) {
        oldNo++
        newNo++
        rows.push({ kind: "ctx", oldNo, newNo, text: line })
      }
      i++
    }
  }
  return rows
}

function WordOverlay({ pair, text, kind, lang }: {
  pair: string
  text: string
  kind: "del" | "add"
  lang: string | undefined
}): React.ReactElement {
  const segs = useMemo(() => {
    const parts = diffWords(pair, text)
    return parts
      .filter((p) => (kind === "del" ? !p.added : !p.removed))
      .map((p) => ({ text: p.value, changed: kind === "del" ? p.removed === true : p.added === true }))
  }, [pair, text, kind])
  return (
    <span className="diff-text">
      {segs.map((s, i) =>
        s.changed ? (
          <span key={i} className={`diff-word-${kind} hljs`} dangerouslySetInnerHTML={{ __html: highlightLine(s.text, lang) }} />
        ) : (
          <span key={i} className="hljs" dangerouslySetInnerHTML={{ __html: highlightLine(s.text, lang) }} />
        ),
      )}
    </span>
  )
}

export interface DiffViewProps {
  oldText: string
  newText: string
  /** highlight.js language for both sides (inferred by the caller from the file path). */
  lang?: string
  /** Tool-card form: tighter paddings, no line numbers. */
  compact?: boolean
}

export function DiffView({ oldText, newText, lang, compact }: DiffViewProps): React.ReactElement {
  const rows = useMemo(() => buildRows(oldText, newText), [oldText, newText])
  return (
    // `md` rides along so the shared highlight token colors (.md .hljs-*) apply.
    // Line numbers render in every form (spec): compact only tightens the box.
    <div className={`diffview md${compact ? " diffview-compact" : ""}`}>
      {rows.map((row, idx) => {
        const nos = (
          <>
            <span className="diff-no">{row.oldNo ?? ""}</span>
            <span className="diff-no">{row.newNo ?? ""}</span>
          </>
        )
        if (row.kind === "ctx") {
          return (
            <div key={idx} className="diff-row diff-ctx">
              {nos}
              <span className="diff-sign" />
              <span className="diff-text hljs" dangerouslySetInnerHTML={{ __html: highlightLine(row.text, lang) }} />
            </div>
          )
        }
        const overlay = row.pair !== undefined
          ? <WordOverlay pair={row.pair} text={row.text} kind={row.kind} lang={lang} />
          : <span className="diff-text">{row.text}</span>
        return (
          <div key={idx} className={`diff-row diff-${row.kind}`}>
            {nos}
            <span className="diff-sign" />
            {overlay}
          </div>
        )
      })}
    </div>
  )
}
