/**
 * Builtin tool registry: instantiates every built-in tool factory
 * and pairs each executor with its provider-facing JSON-Schema definition.
 *
 * Tool and def sit side by side in one entry list, so the `tools` Map keys
 * and the `toolDefs` names are the same set by construction (registry.test.ts
 * asserts it stays that way in both directions).
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { MemoryQuery, MemoryTriggers } from "../memory/system.js"
import type { SkillRecord } from "../skills/index.js"
import type { ToolDefinition } from "../provider/types.js"
import { createExecTool } from "./exec.js"
import { createFsTools } from "./fs.js"
import { createMemoryTools } from "./memory.js"
import { createSessionTools, type SessionSearchFn } from "./session.js"
import { createSkillTools, SKILL_READ_DESCRIPTION } from "./skills.js"
import { createWebTools } from "./web.js"

export { createExecTool, truncateMiddle } from "./exec.js"
export { createFsTools } from "./fs.js"
export { createMemoryTools } from "./memory.js"
export { createSessionTools, type SessionSearchFn } from "./session.js"
export { searchSessionEvents, type SessionHit } from "./session-search.js"
export { createSkillTools, SKILL_READ_DESCRIPTION } from "./skills.js"
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
  memoryCtx: { system: Pick<MemoryTriggers, "triggerImmediate"> & Pick<MemoryQuery, "searchAll">; sessionId: string; workdir: string; immediateEnabled: boolean }
  tavilyApiKey: string
  exec?: Partial<{ timeoutMs: number; maxOutputBytes: number }>
  web?: Partial<{ timeoutMs: number; allowPrivateNetworks: boolean }>
  sessionSearch?: SessionSearchFn
  /** Skills scanned for this run (progressive disclosure's on-demand half). */
  skills?: SkillRecord[]
  fetchImpl?: typeof fetch
}): { tools: Map<string, ToolExecutor>; toolDefs: ToolDefinition[] } {
  const exec = createExecTool({
    workspace: opts.workspace,
    timeoutMs: opts.exec?.timeoutMs,
    maxOutputBytes: opts.exec?.maxOutputBytes,
  })
  const fs = createFsTools({ workspace: opts.workspace })
  const web = createWebTools({
    tavilyApiKey: opts.tavilyApiKey,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.web?.timeoutMs,
    allowPrivateNetworks: opts.web?.allowPrivateNetworks,
  })
  const memory = createMemoryTools(opts.memoryCtx)
  const session = createSessionTools(opts.sessionSearch)
  const skill = createSkillTools(opts.skills ?? [])

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
        "立即把当前这轮对话沉淀进长期记忆（触发记忆写入管线，处理当前轮）。判断权在你：用户明确要求记住时调用；对话里刚敲定重要决定、暴露稳定偏好、得出关键结论时也应自主调用。text 用一句话说明要记什么。",
        { text: str("要记内容的提示（说明这轮什么内容值得沉淀）") },
        ["text"],
      ),
    },
    {
      name: "memory_search",
      tool: memory.memory_search,
      def: def(
        "memory_search",
        "跨项目经历与全局认知的混合检索（关键词+向量）。每个命中带 [经历]/[认知] 与 [project:<id>]/[global] 标注。",
        { query: str("要在长期记忆里找什么"), limit: int(1, 20) },
        ["query"],
      ),
    },
    {
      name: "session_search",
      tool: session.session_search,
      def: def(
        "session_search",
        "全文检索本会话早期已被压缩的对话内容（中文友好）。每个命中返回段摘要和匹配位置的原文片段。",
        { query: str("要在早期对话里找什么"), limit: int(1, 20) },
        ["query"],
      ),
    },
    {
      name: "skill_read",
      tool: skill.skill_read,
      def: def("skill_read", SKILL_READ_DESCRIPTION, { name: str("要加载哪个技能（目录名，见系统提示词的可用技能列表）") }, ["name"]),
    },
  ]

  return {
    tools: new Map(entries.map((e) => [e.name, e.tool])),
    toolDefs: entries.map((e) => e.def),
  }
}
