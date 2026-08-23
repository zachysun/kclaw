/**
 * Shared JSONL append/read mechanics with torn-tail crash tolerance,
 * used by SessionStore for its append-only message log.
 *
 * Invariant every writer here relies on: one JSON.stringify(value) per line,
 * and every complete append terminated with "\n".
 */
import {
  appendFileSync, closeSync, fstatSync, ftruncateSync, openSync,
  readFileSync, readSync,
} from "node:fs"

/**
 * Repair a torn trailing line left by a crash mid-append (every complete
 * append ends with "\n", so a non-newline last byte marks a fragment).
 * The fragment is truncated away: left in place, the next append would
 * concatenate onto it and lose both records on read. With the repair,
 * only the torn record is lost and the appended line stays a
 * standalone, parseable line. A missing file has nothing torn, so it is
 * a no-op.
 */
export function repairTornTail(file: string): void {
  let fd: number
  try {
    fd = openSync(file, "r+")
  } catch {
    return // no file yet → nothing torn
  }
  try {
    const { size } = fstatSync(fd)
    if (size === 0) return
    const tail = Buffer.alloc(1)
    readSync(fd, tail, 0, 1, size - 1)
    if (tail[0] === 0x0a) return // last byte is "\n" → cleanly terminated
    // Truncate at a BYTE offset: Buffer.lastIndexOf(0x0a) is exact because
    // UTF-8 continuation/lead bytes are >= 0x80, so 0x0a never occurs inside
    // a multibyte sequence. A decoded-string indexOf would yield UTF-16 code
    // units and cut mid-character, destroying the previous line.
    const buf = readFileSync(file)
    ftruncateSync(fd, buf.lastIndexOf(0x0a) + 1) // start of the fragment, in bytes
  } finally {
    closeSync(fd)
  }
}

/** Append one value as a JSONL line, repairing any torn tail first. */
export function appendJsonlLine(file: string, value: unknown): void {
  repairTornTail(file)
  appendFileSync(file, JSON.stringify(value) + "\n", "utf8")
}

/**
 * Read a JSONL file oldest-first as parsed values; a missing file yields [].
 * The trailing newline after a complete append is dropped; a torn trailing
 * line (crash artifact) is dropped; a corrupt line anywhere earlier is
 * corruption, not a crash artifact, so it throws.
 */
export function readJsonl(file: string): unknown[] {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const lines = raw.split("\n")
  if (lines[lines.length - 1] === "") lines.pop() // trailing newline after a complete append
  const values: unknown[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === "") continue
    try {
      values.push(JSON.parse(line))
    } catch (err) {
      if (i === lines.length - 1) break // torn trailing line: crash artifact, drop it
      throw new Error(`corrupt jsonl line ${i + 1} in ${file}: ${(err as Error).message}`)
    }
  }
  return values
}
