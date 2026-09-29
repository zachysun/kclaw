/**
 * Canonical identity of an MCP project group. Every boundary that turns a
 * recorded workdir into a group key — session metas at discovery, the daemon
 * workspace, mount calls, the run-side use-view lookup — canonicalizes
 * through here, so one directory is always one group regardless of spelling
 * (trailing slash, `.`/`..` segments, a relative path). Filesystem realpath
 * is deliberately out of scope — the same lexical-identity rationale as
 * projectMcpCollidesWithGlobal: a project layer follows the directory it was
 * mounted from, and symlinked spellings of one physical dir stay distinct.
 */
import { resolve } from "node:path"

/** The canonical group id for a project workdir ("global" never passes here). */
export function resolveProjectIdentity(workdir: string): string {
  return resolve(workdir)
}
