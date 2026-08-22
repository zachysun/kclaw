/**
 * Shared plumbing for built-in tool modules: the control-flow error type,
 * arg validators, and the makeTool wrapper that turns thrown ToolErrors into
 * `{status: "error"}` results.
 *
 * Extracted when memory.ts became the third module to need the same helpers
 * (previously duplicated in fs.ts and web.ts).
 */
import type { ToolExecutor } from "../agent/tools.js"

export type ToolResult = { status: "ok" | "error"; output: string; data?: unknown }

/** Control-flow error carrying a user-facing message; caught by makeTool. */
export class ToolError extends Error {}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Validate a string arg. Empty/whitespace-only strings are rejected unless
 * `allowEmpty` (content/new in write/edit and similar body args may
 * legitimately be "").
 */
export function requireString(
  args: unknown,
  key: string,
  opts: { allowEmpty?: boolean } = {},
): string {
  const v = (args as Record<string, unknown> | null)?.[key]
  if (typeof v !== "string") throw new ToolError(`args.${key} must be a string`)
  if (!opts.allowEmpty && v.trim() === "") {
    throw new ToolError(`args.${key} must be a non-empty string`)
  }
  return v
}

/** Optional string-array arg; missing → `[]`, anything but string[] → error. */
export function optStringArray(args: unknown, key: string): string[] {
  const v = (args as Record<string, unknown> | null)?.[key]
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((t) => typeof t !== "string")) {
    throw new ToolError(`args.${key} must be an array of strings`)
  }
  return v
}

/** Optional integer arg, clamped to [min, max]; `undefined` → `fallback`. */
export function optInt(args: unknown, key: string, fallback: number, min: number, max: number): number {
  const v = (args as Record<string, unknown> | null)?.[key]
  if (v === undefined) return fallback
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ToolError(`args.${key} must be an integer`)
  }
  return Math.min(max, Math.max(min, v))
}

/** Wrap a fn into a ToolExecutor, converting thrown ToolErrors to results. */
export function makeTool<N extends string>(
  name: N,
  risk: "safe" | "sensitive",
  concurrency: "parallel" | "serial",
  fn: (args: unknown) => ToolResult | Promise<ToolResult>,
): ToolExecutor & { name: N } {
  return {
    name,
    risk,
    concurrency,
    async execute(args) {
      try {
        return await fn(args)
      } catch (e) {
        return { status: "error", output: `${name}: ${e instanceof ToolError ? e.message : errMsg(e)}` }
      }
    },
  }
}
