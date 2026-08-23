import { renameSync, writeFileSync } from "node:fs"

/**
 * Crash-atomic whole-file replacement: write the payload to `<path>.tmp`
 * (created with `mode`, default 0644 to match plain writeFileSync) and
 * rename over the target. rename within one directory is atomic on POSIX,
 * so a crash mid-write can never leave a truncated target behind — the
 * worst case is a leftover .tmp file.
 */
export function writeFileAtomic(path: string, data: string, mode: number = 0o644): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, { encoding: "utf8", mode })
  renameSync(tmp, path)
}
