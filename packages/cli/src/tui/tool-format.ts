/**
 * Per-tool one-line formatters (spec B7): a tool call renders as one line —
 * `⏺ bash git status` — where the argument summary follows the tool name in
 * the tool's own most-readable term (bash → command text, fs_* → target
 * path, grep/glob → pattern, search family → query). Unregistered tools
 * fall back to the compact JSON summary the readline path already uses.
 */
import { summarizeArgs } from "../frame-view.js"

type Args = Record<string, unknown>

const asText = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

/** One argument value, or a nested fallback chain of alternatives. */
const firstText = (args: unknown, ...keys: string[]): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined
  const record = args as Args
  for (const key of keys) {
    const text = asText(record[key])
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * The registry: tool name → the argument text its line shows. Keyed by the
 * canonical builtin names (docs/reference/tools.md); MCP and future tools
 * simply stay unregistered and take the JSON fallback.
 */
const FORMATTERS: Readonly<Record<string, (args: unknown) => string | undefined>> = {
  bash: (args) => firstText(args, "command"),
  fs_read: (args) => firstText(args, "path"),
  fs_list: (args) => firstText(args, "path"),
  fs_write: (args) => firstText(args, "path"),
  fs_edit: (args) => firstText(args, "path"),
  grep: (args) => firstText(args, "pattern"),
  glob: (args) => firstText(args, "pattern"),
  web_search: (args) => firstText(args, "query"),
  session_search: (args) => firstText(args, "query"),
  history_search: (args) => firstText(args, "query"),
  memory_search: (args) => firstText(args, "query"),
  skill_read: (args) => firstText(args, "name"),
}

/** The argument text for a tool call line: registered formatter, else the compact JSON summary. */
export function toolArgLine(name: string, args: unknown): string {
  const text = FORMATTERS[name]?.(args)
  return text ?? summarizeArgs(args)
}
