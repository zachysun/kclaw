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
import { createBashTool } from "./bash.js"
import type { BashSandboxSpawn } from "../sandbox/provider.js"
import type { ProcessRegistry } from "../process/registry.js"
import { createProcessTools } from "./process.js"
import type { CronScheduler } from "../cron/scheduler.js"
import { createCronTools } from "./cron.js"
import { createTodoTools } from "./todo.js"
import type { TodoStore } from "./todo.js"
import { createGoalTools } from "./goal.js"
import type { GoalToolHost } from "./goal.js"
import { createFsTools } from "./fs.js"
import { createSearchTools } from "./search.js"
import { createMemoryTools } from "./memory.js"
import { createSessionTools, type SessionSearchFn } from "./session.js"
import { createHistoryTool, HISTORY_SEARCH_DESCRIPTION, type HistorySearchFn } from "./history.js"
import { createSkillTools, SKILL_CREATE_DESCRIPTION, SKILL_LIST_DESCRIPTION, SKILL_READ_DESCRIPTION } from "./skills.js"
import { createSubagentTool, createSubagentCollectTool, SUBAGENT_RUN_DESCRIPTION, SUBAGENT_COLLECT_DESCRIPTION } from "./subagent.js"
import type { SubagentCollector } from "../agent/subagent.js"
import { createTeamToolEntries } from "./team.js"
import { createWebTools } from "./web.js"

export { createAskUserQuestionsTool, ASK_USER_QUESTIONS_DESCRIPTION, type QuestionEventEmitter } from "./ask.js"
export { createBashTool, truncateMiddle } from "./bash.js"
export { createProcessTools } from "./process.js"
export { createCronTools } from "./cron.js"
export { createTodoTools } from "./todo.js"
export type { TodoStore } from "./todo.js"
export { createGoalTools } from "./goal.js"
export type { GoalToolHost } from "./goal.js"
export { ProcessRegistry } from "../process/registry.js"
export type { ProcessEntry, PendingNotice } from "../process/registry.js"
export { createFsTools } from "./fs.js"
export { createSearchTools } from "./search.js"
export { createMemoryTools } from "./memory.js"
export { createSessionTools, type SessionSearchFn } from "./session.js"
export { createHistoryTool, HISTORY_SEARCH_DESCRIPTION, HISTORY_SEARCH_MAX_LIMIT, type HistorySearchFn } from "./history.js"
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
  bash?: Partial<{ timeoutMs: number; maxOutputBytes: number; sandbox: BashSandboxSpawn; spillDir: string }>
  /**
   * Session identity injected into the bash child environment
   * (KCLAW_SESSION_ID / KCLAW_WORKSPACE). Absent = bash inherits the daemon
   * environment unchanged.
   */
  sessionId?: string
  web?: Partial<{ timeoutMs: number; allowPrivateNetworks: boolean; spillDir: string }>
  sessionSearch?: SessionSearchFn
  /** 跨会话原始消息检索（history_search 的数据源）；默认返回固定不可用文案。 */
  historySearch?: HistorySearchFn
  /** Skills scanned for this run (progressive disclosure's on-demand half). */
  skills?: SkillRecord[]
  /** skill_read 使用遥测（curator 生命数据）；默认不记。 */
  recordSkillUse?: (name: string, origin: "global" | "project") => void
  /**
   * skill_create（提案制技能进化）的模型面：在位才注册该工具。daemon 组装
   * 时传（enabled 随 config；propose 指向 skillsEvolution 的提案面）；裸引擎
   * 测试省略。enabled=false 时调用得到固定关闭文案。
   */
  skillCreate?: { enabled: boolean; sessionId: string; propose: import("../skills/evolution.js").SkillEvolutionTriggers["propose"] }
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
   * named member) from the team host before constructing; a cron session —
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
  /**
   * Background-process registry (daemon wires it; bare engine tests omit it).
   * When present: `bash` gains run_in_background (spawning detached with
   * spill-file output, registered here) and the process_* trio joins the
   * registry surface, scoped to this run's session.
   */
  processes?: ProcessRegistry
  /**
   * Cron model face: when set, the cron tools join the registry wired to
   * this scheduler. `writeTools: false` (cron-fired runs, anti-recursion)
   * registers only cron_list. The daemon always wires it.
   */
  cron?: { scheduler: CronScheduler; writeTools?: boolean }
  /**
   * Session todo surface: when set, todo_list_write/todo_list_read join the registry
   * (safe, mainline and child runs alike). The store closes over this
   * run's session; allowParallelInProgress relaxes the single-in_progress
   * check (config todo.allowParallelInProgress).
   */
  todo?: { store: TodoStore; allowParallelInProgress?: boolean }
  /**
   * Goal model face (root sessions only — childRun never registers): the
   * three industry-standard tools projecting the goal loop host. create /
   * update are sensitive (approval = the user's say-so); complete requests
   * a judge pass and never writes the terminal state itself.
   */
  goal?: { host: GoalToolHost; sessionId: string }
}): { tools: Map<string, ToolExecutor>; toolDefs: ToolDefinition[] } {
  const bash = createBashTool({
    workspace: opts.workspace,
    timeoutMs: opts.bash?.timeoutMs,
    maxOutputBytes: opts.bash?.maxOutputBytes,
    // The run assembly passes the sandbox wrapper here only when it is
    // actually available — single source with the gate's sandboxedTools set.
    sandbox: opts.bash?.sandbox,
    spillDir: opts.bash?.spillDir,
    ...(opts.sessionId === undefined
      ? {}
      : { env: { KCLAW_SESSION_ID: opts.sessionId, KCLAW_WORKSPACE: opts.workspace } }),
    ...(opts.processes === undefined ? {} : { processes: opts.processes, sessionId: opts.sessionId }),
  })
  const fs = createFsTools({ workspace: opts.workspace })
  const search = createSearchTools({ workspace: opts.workspace, spillDir: opts.bash?.spillDir })
  const processTools =
    opts.processes !== undefined && opts.sessionId !== undefined
      ? createProcessTools({ registry: opts.processes, sessionId: opts.sessionId })
      : undefined
  const cronTools = opts.cron !== undefined ? createCronTools(opts.cron) : undefined
  const todoTools = opts.todo !== undefined ? createTodoTools(opts.todo) : undefined
  const goalTools =
    opts.goal !== undefined && opts.childRun !== true ? createGoalTools(opts.goal) : undefined
  const web = createWebTools({
    tavilyApiKey: opts.tavilyApiKey,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.web?.timeoutMs,
    allowPrivateNetworks: opts.web?.allowPrivateNetworks,
    spillDir: opts.web?.spillDir,
  })
  const memory = createMemoryTools(opts.memoryCtx)
  const session = createSessionTools(opts.sessionSearch)
  const history = createHistoryTool(opts.historySearch)
  const skill = createSkillTools(opts.skills ?? [], opts.skillCreate, opts.recordSkillUse)

  const entries: Array<{ name: string; tool: ToolExecutor; def: ToolDefinition }> = [
    {
      name: "bash",
      tool: bash,
      def: def(
        "bash",
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
      name: "grep",
      tool: search.grep,
      def: def(
        "grep",
        "Search file contents in the workspace with a regex (workspace-relative line output `path:lineNo: content`). Respects .gitignore inside git repos; skips binary files; results capped with a truncation marker and a spill-file pointer to the full list.",
        {
          pattern: str("Regular expression (JS RegExp syntax)"),
          path: str("Optional: workspace-relative directory or file to scope the search"),
          glob: str("Optional: glob filter on file paths, e.g. `**/*.ts`"),
          maxResults: int(1, 200),
        },
        ["pattern"],
      ),
    },
    {
      name: "glob",
      tool: search.glob,
      def: def(
        "glob",
        "Find files in the workspace by filename pattern (standard glob like `**/*.ts`). Respects .gitignore inside git repos; results capped with a truncation marker and a spill-file pointer to the full list.",
        {
          pattern: str("Glob pattern to match file paths against"),
          path: str("Optional: workspace-relative directory to scope the search"),
        },
        ["pattern"],
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
        "立即把当前这轮对话沉淀进长期记忆（触发记忆写入 pipeline，处理当前轮）。判断权在你：用户明确要求记住时调用；对话里刚敲定重要决定、暴露稳定偏好、得出关键结论时也应自主调用。text 用一句话说明要记什么。",
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
      name: "history_search",
      tool: history.history_search,
      def: def(
        "history_search",
        HISTORY_SEARCH_DESCRIPTION,
        {
          query: str("要在全部历史会话的原始消息里找什么（关键词，中文友好）"),
          limit: int(1, 20),
          session_id: str("可选：只检索这一个会话"),
        },
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
      def: def("skill_list", SKILL_LIST_DESCRIPTION, { query: str("可选：按名字与描述子串过滤（大小写不敏感）；不传则列出全部模型可见技能") }, []),
    },
    ...(todoTools === undefined
      ? []
      : [
          {
            name: "todo_list_write",
            tool: todoTools.todo_list_write,
            def: def(
              "todo_list_write",
              "Replace the session's checklist in one full snapshot (no item ids; last write wins). Use it to plan multi-step work and keep the plan honest across runs. Exactly one in_progress item by default. An empty array clears the list.",
              {
                todos: {
                  type: "array",
                  description: "The complete list: every item, not just changes",
                  items: {
                    type: "object",
                    properties: {
                      content: str("Item text (non-empty, ≤200 chars)"),
                      status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "pending / in_progress / completed" },
                    },
                    required: ["content", "status"],
                  },
                },
              },
              ["todos"],
            ),
          },
          {
            name: "todo_list_read",
            tool: todoTools.todo_list_read,
            def: def("todo_list_read", "Read the session's current checklist (survives compaction — read it back after a compaction).", {}, []),
          },
        ]),
    ...(goalTools === undefined
      ? []
      : [
          {
            name: "create_goal",
            tool: goalTools.create_goal,
            def: def(
              "create_goal",
              "Start a goal loop ONLY when the user explicitly asked for persistent autonomous work (e.g. keep iterating until tests pass). The loop self-continues with an independent judge at each run boundary; acceptance commands run sandboxed and unattended. One goal per session; a live goal must be stopped first.",
              {
                text: str("The objective, stated so an independent judge can evaluate it"),
                acceptance: { type: "array", items: { type: "string" }, description: "Optional acceptance commands (each must pass; run sandboxed). Absent = judged on the conversation alone" },
              },
              ["text"],
            ),
          },
          {
            name: "get_goal",
            tool: goalTools.get_goal,
            def: def("get_goal", "Read the current goal's view: state, round position, budget spent, latest verdict, acceptance commands.", {}, []),
          },
          {
            name: "update_goal",
            tool: goalTools.update_goal,
            def: def(
              "update_goal",
              "Act on the current goal. `complete` requests an immediate judge pass — the independent judge decides met/not_met/impossible, this tool never closes the goal itself. `pause` disarms (no self-continuation). `resume` re-arms and checks. `stop` aborts the active run and parks the goal (user-stop).",
              {
                action: { type: "string", enum: ["complete", "pause", "resume", "stop"], description: "complete / pause / resume / stop" },
                note: str("Optional context note (recorded, not used as judge evidence)"),
              },
              ["action"],
            ),
          },
        ]),
    // process 三件仅在组装传入后台进程注册表时存在（daemon 恒有；裸引擎测试
    // 没有）。归属按会话隔离：registry 只暴露本 sessionId 的条目。
    ...(processTools === undefined
      ? []
      : [
          {
            name: "process_list",
            tool: processTools.process_list,
            def: def(
              "process_list",
              "List this session's background processes (id, command, status, exit code, output file). Completion is announced automatically; use process_output to read output incrementally.",
              {},
              [],
            ),
          },
          {
            name: "process_output",
            tool: processTools.process_output,
            def: def(
              "process_output",
              "Read a background process's output since a byte offset (incremental cursor; the completion notice arrives automatically — do not poll). Optional wait blocks for new output or exit, bounded by timeoutMs (default 30s, max 600s).",
              {
                processId: str("Background process id (from the run_in_background result or the completion notice)"),
                offset: int(0, Number.MAX_SAFE_INTEGER),
                wait: { type: "boolean", description: "True = block until new output or termination (bounded by timeoutMs)" },
                timeoutMs: int(1_000, 600_000),
              },
              ["processId"],
            ),
          },
          {
            name: "process_kill",
            tool: processTools.process_kill,
            def: def(
              "process_kill",
              "Terminate a background process (SIGKILL to its whole process group). Killing an already-finished process is not an error.",
              { processId: str("Background process id") },
              ["processId"],
            ),
          },
        ]),
    // cron 模型面四件仅在组装传入调度器时存在（daemon 恒有）。writeTools=false
    // （cron 触发的 run，防递归：定时会话不能再建定时）只注册 cron_list。
    ...(cronTools === undefined
      ? []
      : opts.cron!.writeTools === false
        ? [
            {
              name: "cron_list",
              tool: cronTools.cron_list,
              def: def("cron_list", "List scheduled crons (id, schedule, enabled, next run, last result).", {}, []),
            },
          ]
        : [
            {
              name: "cron_create",
              tool: cronTools.cron_create,
              def: def(
                "cron_create",
                "Create a scheduled cron ONLY when the user explicitly asked for a reminder/recurring task. Exactly one of `cron` (standard 5-field expression) or `delayMinutes` (one-shot, fires once then auto-disables — never compute an absolute time yourself). The prompt must be self-contained: firing creates a fresh session that sees nothing of this conversation.",
                {
                  name: str("Display name of the cron"),
                  prompt: str("Self-contained prompt fired as the user message of a fresh session"),
                  cron: str("Standard 5-field cron expression (mutually exclusive with delayMinutes)"),
                  delayMinutes: { type: "integer", minimum: 1, maximum: 525600, description: "One-shot: fire once N minutes from now (mutually exclusive with cron)" },
                },
                ["name", "prompt"],
              ),
            },
            {
              name: "cron_list",
              tool: cronTools.cron_list,
              def: def("cron_list", "List scheduled crons (id, schedule, enabled, next run, last result).", {}, []),
            },
            {
              name: "cron_update",
              tool: cronTools.cron_update,
              def: def(
                "cron_update",
                "Update a scheduled cron (partial patch; at least one field). Changing cron/delayMinutes converts the trigger form and reschedules from now.",
                {
                  id: str("Cron id from cron_list"),
                  name: str("Optional: new display name"),
                  prompt: str("Optional: new prompt"),
                  cron: str("Optional: switch to a recurring 5-field expression"),
                  delayMinutes: { type: "integer", minimum: 1, maximum: 525600, description: "Optional: switch to one-shot N minutes from now" },
                  enabled: { type: "boolean", description: "Optional: enable/disable without deleting" },
                },
                ["id"],
              ),
            },
            {
              name: "cron_delete",
              tool: cronTools.cron_delete,
              def: def("cron_delete", "Delete a scheduled cron permanently.", { id: str("Cron id from cron_list") }, ["id"]),
            },
          ]),
    // skill_create 仅在组装传入 skillCreate 时存在（提案制功能面；功能关闭的
    // 安装里模型根本看不到这个工具）。
    ...(skill.skill_create === undefined
      ? []
      : [
          {
            name: "skill_create",
            tool: skill.skill_create,
            def: def(
              "skill_create",
              SKILL_CREATE_DESCRIPTION,
              {
                name: str("技能目录名：小写字母、数字、连字符（如 deploy-runbook）"),
                content: str("完整的 SKILL.md 文件内容：YAML frontmatter（含 description）+ Markdown 正文"),
                rationale: str("可选：为什么这段经验值得沉淀为技能"),
              },
              ["name", "content"],
            ),
          },
        ]),
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
          role: str("Optional role supplement for the child's system prompt: who it is for THIS task (e.g. '只读代码侦探，定位调用链'). Plain text, a few sentences at most"),
          tools: { type: "array", items: { type: "string" }, description: "Optional tool allowlist for the child (exact tool names, e.g. ['fs_read','fs_list']). Narrowing only — omitted tools vanish from the child. Empty/absent = the child gets the full default surface" },
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
