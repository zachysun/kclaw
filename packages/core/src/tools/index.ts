/**
 * Builtin tool registry: instantiates every built-in tool factory
 * and pairs each executor with its provider-facing JSON-Schema definition.
 *
 * Tool and def sit side by side in one entry list, so the `tools` Map keys
 * and the `toolDefs` names are the same set by construction (registry.test.ts
 * asserts it stays that way in both directions).
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { MemoryStore } from "../memory/store.js"
import type { ToolDefinition } from "../provider/types.js"
import { createExecTool } from "./exec.js"
import { createFsTools } from "./fs.js"
import { createMemoryTools } from "./memory.js"
import { createWebTools } from "./web.js"

export { createExecTool, truncateMiddle } from "./exec.js"
export { createFsTools } from "./fs.js"
export { createMemoryTools } from "./memory.js"
export { createWebTools } from "./web.js"

/** A string property with a model-facing description. */
const str = (description: string) => ({ type: "string", description })

/** An integer property clamped to [min, max] by the tool. */
const int = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum })

/** Assemble a ToolDefinition from a name, description, properties and required list. */
function def(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition {
  return { name, description, parameters: { type: "object", properties, required } }
}

export function createBuiltinTools(opts: {
  workspace: string
  memory: MemoryStore
  tavilyApiKey: string
  exec?: Partial<{ timeoutMs: number; maxOutputBytes: number }>
  fetchImpl?: typeof fetch
}): { tools: Map<string, ToolExecutor>; toolDefs: ToolDefinition[] } {
  const exec = createExecTool({
    workspace: opts.workspace,
    timeoutMs: opts.exec?.timeoutMs,
    maxOutputBytes: opts.exec?.maxOutputBytes,
  })
  const fs = createFsTools({ workspace: opts.workspace })
  const web = createWebTools({ tavilyApiKey: opts.tavilyApiKey, fetchImpl: opts.fetchImpl })
  const memory = createMemoryTools(opts.memory)

  const entries: Array<{ name: string; tool: ToolExecutor; def: ToolDefinition }> = [
    {
      name: "exec",
      tool: exec,
      def: def(
        "exec",
        "Run a shell command in the workspace. stdout and stderr are merged; long output is truncated head+tail; non-zero exit or timeout returns an error with the partial output.",
        { command: str("Shell command to run; cwd is the workspace root") },
        ["command"],
      ),
    },
    {
      name: "fs_read",
      tool: fs.fs_read,
      def: def(
        "fs_read",
        "Read a UTF-8 text file inside the workspace (up to 1 MiB).",
        { path: str("Workspace-relative or absolute path of the file to read") },
        ["path"],
      ),
    },
    {
      name: "fs_list",
      tool: fs.fs_list,
      def: def(
        "fs_list",
        "List a directory inside the workspace: subdirectories get a trailing /, files show their size in bytes.",
        { path: str("Workspace-relative or absolute path of the directory to list") },
        ["path"],
      ),
    },
    {
      name: "fs_write",
      tool: fs.fs_write,
      def: def(
        "fs_write",
        "Create or overwrite a file inside the workspace; missing parent directories are created.",
        {
          path: str("Workspace-relative or absolute path of the file to write"),
          content: str("Full file content to write (may be empty)"),
        },
        ["path", "content"],
      ),
    },
    {
      name: "fs_edit",
      tool: fs.fs_edit,
      def: def(
        "fs_edit",
        "Replace exactly one occurrence of `old` with `new` in a workspace file. Replacement is literal (no regex, no $-patterns); 0 or multiple occurrences of `old` is an error.",
        {
          path: str("Workspace-relative or absolute path of the file to edit"),
          old: str("Exact text to replace (must occur exactly once)"),
          new: str("Replacement text (may be empty)"),
        },
        ["path", "old", "new"],
      ),
    },
    {
      name: "web_search",
      tool: web.web_search,
      def: def(
        "web_search",
        "Web search via Tavily. Returns a markdown list of `- [title](url)：content` lines.",
        { query: str("Search query"), maxResults: int(1, 10) },
        ["query"],
      ),
    },
    {
      name: "web_fetch",
      tool: web.web_fetch,
      def: def(
        "web_fetch",
        "Fetch an http(s) URL and return its readable text: HTML is extracted to article text, other content types come back as plain text; bodies are capped at 512 KiB.",
        { url: str("Absolute http(s) URL to fetch") },
        ["url"],
      ),
    },
    {
      name: "memory_save",
      tool: memory.memory_save,
      def: def(
        "memory_save",
        "Persist a durable note to long-term memory (markdown files + full-text index). A very similar existing note is updated in place instead of duplicated.",
        {
          text: str("The memory to store, phrased as a standalone fact or preference"),
          tags: { type: "array", items: { type: "string" }, description: "Optional categorization tags" },
        },
        ["text"],
      ),
    },
    {
      name: "memory_search",
      tool: memory.memory_search,
      def: def(
        "memory_search",
        "Full-text search (CJK-aware) over saved memories; returns one `- <text>` line per hit, ranked by relevance.",
        { query: str("What to look for in stored memories"), limit: int(1, 20) },
        ["query"],
      ),
    },
  ]

  return {
    tools: new Map(entries.map((e) => [e.name, e.tool])),
    toolDefs: entries.map((e) => e.def),
  }
}
