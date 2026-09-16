/**
 * Builtin tool registry: instantiates every built-in tool factory
 * and pairs each executor with its provider-facing JSON-Schema definition.
 *
 * Tool and def sit side by side in one entry list, so the `tools` Map keys
 * and the `toolDefs` names are the same set by construction (registry.test.ts
 * asserts it stays that way in both directions).
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { SubagentSpawner } from "../agent/subagent.js"
import type { MemoryQuery, MemoryTriggers } from "../memory/system.js"
import type { SkillRecord } from "../skills/index.js"
import type { ToolDefinition } from "../provider/types.js"
import { createAskUserQuestionsTool, ASK_USER_QUESTIONS_DESCRIPTION, type QuestionEventEmitter } from "./ask.js"
import type { ConfirmationBroker } from "../permissions/broker.js"
import { createExecTool, type ExecSandboxSpawn } from "./exec.js"
import { createFsTools } from "./fs.js"
import { createMemoryTools } from "./memory.js"
import { createSessionTools, type SessionSearchFn } from "./session.js"
import { createSkillTools, SKILL_LIST_DESCRIPTION, SKILL_READ_DESCRIPTION } from "./skills.js"
import { createSubagentTool, createSubagentCollectTool, SUBAGENT_RUN_DESCRIPTION, SUBAGENT_COLLECT_DESCRIPTION } from "./subagent.js"
import type { SubagentCollector } from "../agent/subagent.js"
import { createTeamToolEntries } from "./team.js"
import { createWebTools } from "./web.js"

export { createAskUserQuestionsTool, ASK_USER_QUESTIONS_DESCRIPTION, type QuestionEventEmitter } from "./ask.js"
export { createExecTool, truncateMiddle } from "./exec.js"
export { createFsTools } from "./fs.js"
export { createMemoryTools } from "./memory.js"
export { createSessionTools, type SessionSearchFn } from "./session.js"
export { searchSessionEvents, type SessionHit } from "./session-search.js"
export { createSkillTools, SKILL_READ_DESCRIPTION } from "./skills.js"
export { createSubagentTool, createSubagentCollectTool, SUBAGENT_RUN_DESCRIPTION, SUBAGENT_COLLECT_DESCRIPTION } from "./subagent.js"
export { createTeamToolEntries, CREATE_TEAM_DESCRIPTION, SPAWN_TEAMMATE_DESCRIPTION } from "./team.js"
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
  exec?: Partial<{ timeoutMs: number; maxOutputBytes: number; sandbox: ExecSandboxSpawn; spillDir: string }>
  web?: Partial<{ timeoutMs: number; allowPrivateNetworks: boolean; spillDir: string }>
  sessionSearch?: SessionSearchFn
  /** Skills scanned for this run (progressive disclosure's on-demand half). */
  skills?: SkillRecord[]
  /**
   * Subagent dispatch (mainline runs only): when set, `subagent_run` joins the
   * registry wired to this spawner. Absent → no dispatch tool (tests, and
   * every child run — children cannot spawn grandchildren). `collector` (when
   * set with it) adds `subagent_collect` for fetching a background child's
   * answer on demand (issue #22).
   */
  subagent?: { spawner: SubagentSpawner; parentSessionId: string; collector?: SubagentCollector }
  /**
   * Mid-run questions (issue #21): when set, `ask_user_questions` joins the
   * registry wired to the shared confirmation broker. Absent → no ask tool
   * (bare engine constructions); the run assembly always injects it — child
   * runs included (forwarded cards follow the confirmation precedent).
   */
  ask?: { broker: ConfirmationBroker; timeoutMs?: number; emit: QuestionEventEmitter }
  /**
   * Agent team surface: when set, the team tools join the registry wired to
   * this facade and identity. The assembly resolves the identity (lead or
   * named member) from the team host before constructing; a job session —
   * or any session outside a team — simply leaves this absent. Member
   * identities never carry create_team / spawn_teammate (enforced inside
   * createTeamToolEntries).
   */
  team?: { facade: import("../team/facade.js").TeamFacade; identity: import("../team/facade.js").TeamIdentity }
  /**
   * True for a subagent's own run: the surface drops `memory_save` (memory
   * stays a mainline responsibility) and `subagent_run` (single-level
   * delegation), leaving the remaining builtins + adapters.
   */
  childRun?: boolean
  fetchImpl?: typeof fetch
}): { tools: Map<string, ToolExecutor>; toolDefs: ToolDefinition[] } {
  const exec = createExecTool({
    workspace: opts.workspace,
    timeoutMs: opts.exec?.timeoutMs,
    maxOutputBytes: opts.exec?.maxOutputBytes,
    // The run assembly passes the sandbox wrapper here only when it is
    // actually available — single source with the gate's sandboxedTools set.
    sandbox: opts.exec?.sandbox,
    spillDir: opts.exec?.spillDir,
  })
  const fs = createFsTools({ workspace: opts.workspace })
  const web = createWebTools({
    tavilyApiKey: opts.tavilyApiKey,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.web?.timeoutMs,
    allowPrivateNetworks: opts.web?.allowPrivateNetworks,
    spillDir: opts.web?.spillDir,
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
      def: def("skill_read", SKILL_READ_DESCRIPTION, { name: str("要加载哪个技能（目录名，见系统提示词的可用技能列表，或用 skill_list 查询）") }, ["name"]),
    },
    {
      name: "skill_list",
      tool: skill.skill_list,
      def: def("skill_list", SKILL_LIST_DESCRIPTION, { query: str("可选：按名字与描述子串过滤（大小写不敏感）；缺省列出全部模型可见技能") }, []),
    },
  ]

  // Subagent surface rules (issue #16): a child run drops memory_save (memory
  // stays a mainline responsibility) and never carries subagent_run (single-
  // level delegation). A mainline run gains subagent_run only when the
  // assembly injected a spawner (the daemon does; bare engine tests do not).
  const surface = opts.childRun === true
    ? entries.filter((e) => e.name !== "memory_save")
    : [...entries]
  if (opts.subagent !== undefined && opts.childRun !== true) {
    const { spawner, parentSessionId, collector } = opts.subagent
    surface.push({
      name: "subagent_run",
      tool: createSubagentTool(spawner, parentSessionId),
      def: def(
        "subagent_run",
        SUBAGENT_RUN_DESCRIPTION,
        {
          task: str("Self-contained task description — the child sees nothing of this conversation"),
          label: str("Short display name shown in status lines and confirmation cards"),
          run_in_background: { type: "boolean", description: "True = return the child session id immediately; the completion notice arrives later and subagent_collect fetches the answer (default false = wait for the result here)" },
        },
        ["task"],
      ),
    })
    if (collector !== undefined) {
      surface.push({
        name: "subagent_collect",
        tool: createSubagentCollectTool(collector, parentSessionId),
        def: def(
          "subagent_collect",
          SUBAGENT_COLLECT_DESCRIPTION,
          { childSessionId: str("The child session id to collect (from the background dispatch result or the completion notice)") },
          ["childSessionId"],
        ),
      })
    }
  }
  if (opts.team !== undefined) {
    surface.push(...createTeamToolEntries(opts.team.facade, opts.team.identity))
  }
  if (opts.ask !== undefined) {
    surface.push({
      name: "ask_user_questions",
      tool: createAskUserQuestionsTool(opts.ask),
      def: def(
        "ask_user_questions",
        ASK_USER_QUESTIONS_DESCRIPTION,
        {
          questions: {
            type: "array",
            description: "1-5 questions to ask the user",
            items: {
              type: "object",
              properties: {
                text: str("The question, self-contained and answerable on its own"),
                options: { type: "array", items: { type: "string" }, description: "2+ choices to pick from; omit for free text" },
                multiSelect: { type: "boolean", description: "With options: allow several picks (default single)" },
              },
              required: ["text"],
            },
            minItems: 1,
            maxItems: 5,
          },
        },
        ["questions"],
      ),
    })
  }

  return {
    tools: new Map(surface.map((e) => [e.name, e.tool])),
    toolDefs: surface.map((e) => e.def),
  }
}

/**
 * Drop every sensitive tool from a live surface, in place, keeping the tools
 * map and the defs list the same set. The readonly mode's gate short-circuits
 * sensitive tools before any rule — even an allow rule cannot save one — so a
 * listed sensitive tool is a call the model can only lose; narrowing the
 * surface spares it those turns. Visibility only: the gate stays the
 * boundary, and only the readonly assembly may call this (every other mode
 * can legitimately authorize a sensitive tool).
 */
export function dropSensitiveTools(tools: Map<string, ToolExecutor>, toolDefs: ToolDefinition[]): void {
  for (const [name, tool] of [...tools]) {
    if (tool.risk !== "sensitive") continue
    tools.delete(name)
    const idx = toolDefs.findIndex((d) => d.name === name)
    if (idx !== -1) toolDefs.splice(idx, 1)
  }
}

/**
 * The permission-relevant facts of the registered tools (risk + schema arg
 * field names), derived in one place from the registry. The permission gate
 * consumes this table and derives every treatment itself — no tool carries
 * permission metadata, and the gate holds no tool-name rosters (issue #9).
 */
export function deriveToolFacts(
  tools: Map<string, ToolExecutor>,
  toolDefs: ToolDefinition[],
): Map<string, { risk: "safe" | "sensitive"; argFields: string[] }> {
  return new Map(
    [...tools].map(([name, t]) => {
      const def = toolDefs.find((d) => d.name === name)
      const properties = (def?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
      return [name, { risk: t.risk, argFields: Object.keys(properties ?? {})}] as const
    }),
  )
}
