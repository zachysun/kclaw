/**
 * User hook loader (spec issue #6): scans the flat user hooks directory and
 * turns conforming files into HookEntries — the "new capability = new file"
 * door.
 *
 * File contract (same shape as builtin registrations):
 *   export const hook = { position, description?, enabled?, order? }
 *   export default async (ctx) => { ... }
 *
 * Load rules pinned here:
 * - Extensions: .js / .mjs always; .ts too (Node 24+ native type stripping —
 *   a lower Node rejects the import with a clear message instead of magic).
 * - No dependency resolution beyond Node builtins: the file is imported by
 *   absolute URL, so bare-specifier imports fail with Node's own ERR_*
 *   (third-party packages are out of scope, spec Out-of-Scope).
 * - `?t=<mtimeMs>` cache-buster: dynamic import caches by URL, so the same
 *   path edited between runs must re-execute ("edit file, next run picks it
 *   up" — same mental model as skills' per-run rescan).
 * - User files may NOT declare failure: "fatal" — the loader rejects it
 *   (user code has no power to kill a run). enabled defaults to true,
 *   order defaults to a large number (after explicit orders), name is the
 *   file basename.
 * - A broken file (bad syntax, unknown position, non-function default,
 *   illegal failure) becomes a load FAILURE, never a daemon error.
 */
import { readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { HookEntry, HookModule, HookPosition } from "./types.js"
import { HOOK_POSITIONS } from "./positions.js"

const USER_HOOK_EXTS = new Set([".js", ".mjs", ".ts"])
/** order default: after every explicit order (builtins and declared users). */
const DEFAULT_USER_ORDER = 1000

export interface LoadFailure {
  /** File basename — the hook's identity (shown in the管理面). */
  name: string
  path: string
  error: string
  /** mtimeMs at load time — the registry's dedup key for failure events. */
  mtimeMs: number
}

export interface ScanResult {
  entries: HookEntry[]
  failures: LoadFailure[]
}

function isHookModule(value: unknown): value is HookModule {
  if (typeof value !== "object" || value === null) return false
  const v = value as { hook?: unknown; default?: unknown }
  if (typeof v.default !== "function") return false
  const h = v.hook
  if (typeof h !== "object" || h === null) return false
  const meta = h as { position?: unknown }
  return typeof meta.position === "string"
}

/**
 * Scan and import every candidate file. Per-entry failures (syntax error,
 * illegal position, missing handler) are collected — one bad file must not
 * wipe the directory (scanSkillDirs precedent).
 */
export async function scanUserHooks(dir: string): Promise<ScanResult> {
  const result: ScanResult = { entries: [], failures: [] }
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return result // missing / unreadable dir → no user hooks
  }
  for (const name of names) {
    if (!USER_HOOK_EXTS.has(name.slice(name.lastIndexOf(".")))) continue
    const path = join(dir, name)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch (err) {
      result.failures.push({ name, path, error: `stat failed: ${messageOf(err)}`, mtimeMs: 0 })
      continue
    }
    try {
      const mod = (await import(`${pathToFileURL(path).href}?t=${mtimeMs}`)) as unknown
      if (!isHookModule(mod)) {
        result.failures.push({ name, path, error: "missing `export const hook = { position }` or default function", mtimeMs })
        continue
      }
      const declared = mod.hook as HookModule["hook"]
      if (!HOOK_POSITIONS.includes(declared.position as HookPosition)) {
        result.failures.push({
          name, path, mtimeMs,
          error: `unknown position "${declared.position}" (valid: ${HOOK_POSITIONS.join(", ")})`,
        })
        continue
      }
      if (declared.failure === "fatal") {
        result.failures.push({ name, path, mtimeMs, error: 'user hooks may not declare failure: "fatal"' })
        continue
      }
      result.entries.push({
        meta: {
          name,
          position: declared.position,
          ...(declared.description !== undefined ? { description: declared.description } : {}),
          enabled: declared.enabled ?? true,
          order: declared.order ?? DEFAULT_USER_ORDER,
          failure: "skip",
          origin: "user",
        },
        handler: mod.default as HookEntry["handler"],
      })
    } catch (err) {
      result.failures.push({ name, path, mtimeMs, error: messageOf(err) })
    }
  }
  return result
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  const s = String(err)
  // 非 Error 抛出物（运行时差异）：别让对象退化成 "[object Object]"
  return s === "[object Object]" ? JSON.stringify(err) : s
}

/** Display name for a hook file path (basenamed once at the call site's edge). */
export function hookFileBase(path: string): string {
  return basename(path)
}
