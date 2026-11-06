/**
 * `kclaw session list` (spec A9): GET /sessions (newest update first, child
 * and deleted sessions excluded by the daemon) as a table aligned by display
 * width, or the array verbatim with --json.
 */
import type { SessionMeta } from "@kclaw/core"
import { alignColumns } from "./text-width.js"

/** The GET /sessions fields the table shows. */
export type SessionRow = Pick<SessionMeta, "id" | "title" | "updatedAt" | "workdir">

/** Local-time short form: `2026-11-07 14:03`. */
function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Titles are model-generated and workdirs come from clients: control
 * characters (escape sequences included) are replaced before the text
 * reaches the terminal.
 */
function plain(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
}

export function renderSessionTable(rows: readonly SessionRow[]): string {
  if (rows.length === 0) return "还没有会话：运行 kclaw 或 kclaw run 开始一个"
  return alignColumns([
    ["id", "title", "workdir", "updatedAt"],
    ...rows.map((r) => [r.id, plain(r.title), plain(r.workdir ?? "-"), shortTime(r.updatedAt)]),
  ]).join("\n")
}
