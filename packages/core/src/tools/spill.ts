/**
 * spill — full tool output kept on disk when the model view truncates.
 *
 * Truncating tool output keeps the context small but throws away data the
 * task may need. When a capped output is about to be returned, the captured
 * span is written once under <home>/spill and the truncated view carries a
 * locator line: the model re-reads the missing span itself via fs_read (the
 * spill dir sits on the permission gate's readRoots). Best-effort by
 * contract — any spill failure degrades silently to the plain truncated
 * output; the tool call must never fail because spilling did.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Single spill file ceiling: beyond this even the spilled copy is partial. */
export const SPILL_MAX_BYTES = 10 * 1024 * 1024

export interface SpillResult {
  /** Spill file path; undefined = nothing was spilled (no dir / write failed). */
  path?: string
  /** true = the captured span itself exceeded SPILL_MAX_BYTES and the copy is partial. */
  partial?: boolean
}

/** Monotonic per-process suffix so same-second spills never collide. */
let counter = 0

export function spillToolOutput(spillDir: string | undefined, toolName: string, captured: string): SpillResult {
  if (spillDir === undefined || captured === "") return {}
  try {
    mkdirSync(spillDir, { recursive: true })
    counter = (counter + 1) % 1_000_000
    const name = `${Date.now().toString(36)}-${counter.toString(36).padStart(4, "0")}-${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`
    const path = join(spillDir, name)
    const buf = Buffer.from(captured, "utf8")
    // Tool output can embed secrets (env dumps, curl bodies) — the spilled
    // copy gets the same 0600 treatment as the daemon's own config/token
    // files, not the 0644 default.
    if (buf.length > SPILL_MAX_BYTES) {
      writeFileSync(path, buf.subarray(0, SPILL_MAX_BYTES), { mode: 0o600 })
      return { path, partial: true }
    }
    writeFileSync(path, buf, { mode: 0o600 })
    return { path }
  } catch {
    return {}
  }
}

/** Locator line appended after a truncated tool output ("" when nothing spilled). */
export function spillLocatorLine(result: SpillResult): string {
  if (result.path === undefined) return ""
  const note = result.partial === true ? "（该文件仅保留了前 10MB）" : ""
  return `\n[完整输出已存盘: ${result.path}${note}；需要更多内容时用 fs_read 读取该文件]`
}
