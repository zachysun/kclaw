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

/**
 * Append one value as a JSONL line, repairing any torn tail first. Returns
 * the line text actually written: callers that derive from the line (the
 * `$prev` chain digest) must take this return value, so the stored text and
 * the derived text can never diverge into two serializations.
 */
export function appendJsonlLine(file: string, value: unknown): string {
  repairTornTail(file)
  const line = JSON.stringify(value)
  appendFileSync(file, line + "\n", "utf8")
  return line
}

/**
 * Split raw JSONL text into its lines plus the torn-tail flag — the single
 * definition of "what counts as a torn line" shared by the value reader
 * (readJsonlFrom), the chain verifier (session/integrity.ts), and the line
 * reader (readCompleteLines). `lines` drops the trailing empty string after
 * a complete append; `tornTail` is true when the final line lacks its "\n"
 * (crash mid-append). Whether a torn fragment is then dropped or kept is
 * each caller's policy: readCompleteLines drops it (matching
 * repairTornTail's truncation), readJsonlFrom and the verifier keep a
 * parseable one and drop only an unparseable one.
 */
export function splitLinesCanonical(raw: string): { lines: string[]; tornTail: boolean } {
  const parts = raw.split("\n")
  const tornTail = parts[parts.length - 1] !== ""
  if (!tornTail) parts.pop()
  return { lines: parts, tornTail }
}

/**
 * Read the file's complete line texts (no JSON parsing), dropping a torn
 * trailing fragment — the read-side twin of repairTornTail's truncation, so
 * chain-tail readers see exactly the lines the next append will build on.
 * A missing file yields [].
 */
export function readCompleteLines(file: string): string[] {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const { lines, tornTail } = splitLinesCanonical(raw)
  return tornTail ? lines.slice(0, -1) : lines
}

/**
 * Read a JSONL file oldest-first as parsed values; a missing file yields [].
 * The trailing newline after a complete append is dropped; a torn trailing
 * line (crash artifact) is dropped; a corrupt line anywhere earlier is
 * corruption, not a crash artifact, so it throws.
 */
export function readJsonl(file: string): unknown[] {
  return readJsonlFrom(file, 0)
}

/**
 * Tail read: parse only the lines at indexes >= since, skipping the prefix
 * without parsing it (the tail-pull path: one line per ?since= increment).
 * The file is still read whole — there is no byte index for line offsets —
 * but skipped lines cost neither JSON.parse nor array slots. Corruption
 * semantics match readJsonl for the parsed region; a corrupt line inside
 * the skipped prefix is never observed.
 */
export function readJsonlFrom(file: string, since: number): unknown[] {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const { lines } = splitLinesCanonical(raw)
  const values: unknown[] = []
  for (let i = since; i < lines.length; i++) {
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
