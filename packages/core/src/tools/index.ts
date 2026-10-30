/**
 * Builtin tool registry: assembles the registry from the entry bundles the
 * tool modules own.
 *
 * Each module exports a `createXxxToolEntries` factory pairing its executors
 * with their provider-facing JSON-Schema definitions (schema and validator
 * live side by side in the owning module); this file only routes assembly
 * opts and concatenates the bundles into one entries list, so the `tools`
 * Map keys and the `toolDefs` names are the same set by construction
 * (registry.test.ts asserts it stays that way in both directions). Adding a
 * tool = writing its module + one spread here (plus the genuine wiring: deps,
 * exposure tier).
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { SubagentSpawner } from "../agent/subagent.js"
import type { MemoryQuery, MemoryTriggers } from "../memory/system.js"
import type { SkillRecord } from "../skills/index.js"
import type { ToolDefinition } from "../provider/types.js"
import type { QuestionEventEmitter } from "./ask.js"
import type { ConfirmationBroker } from "../permissions/broker.js"
import type { BashSandboxSpawn } from "../sandbox/provider.js"
import type { ProcessRegistry } from "../process/registry.js"
import type { CronScheduler } from "../cron/scheduler.js"
import type { TodoStore } from "./todo.js"
import type { GoalToolHost } from "./goal.js"
import type { SessionSearchFn } from "./session.js"
import type { HistorySearchFn } from "./history.js"
import type { SubagentCollector } from "../agent/subagent.js"
import type { ToolEntry } from "./shared.js"
import { createBashToolEntries } from "./bash.js"
import { createFsToolEntries } from "./fs.js"
import { createSearchToolEntries } from "./search.js"
import { createWebToolEntries } from "./web.js"
import { createMemoryToolEntries } from "./memory.js"
import { createSessionToolEntries } from "./session.js"
import { createHistoryToolEntries } from "./history.js"
import { createSkillToolEntries } from "./skills.js"
import { createTodoToolEntries } from "./todo.js"
import { createGoalToolEntries } from "./goal.js"
import { createProcessToolEntries } from "./process.js"
import { createCronToolEntries } from "./cron.js"
import { createSubagentToolEntries } from "./subagent.js"
import { createTeamToolEntries } from "./team.js"
import { createAskToolEntries } from "./ask.js"
import { createUiRenderToolEntries } from "./ui-render.js"

export { createAskUserQuestionsTool, createAskToolEntries, ASK_USER_QUESTIONS_DESCRIPTION, type QuestionEventEmitter } from "./ask.js"
export { createBashTool, createBashToolEntries, truncateMiddle } from "./bash.js"
export { createProcessTools, createProcessToolEntries } from "./process.js"
export { createCronTools, createCronToolEntries } from "./cron.js"
export { createTodoTools, createTodoToolEntries } from "./todo.js"
export type { TodoStore } from "./todo.js"
export { createGoalTools, createGoalToolEntries } from "./goal.js"
export type { GoalToolHost } from "./goal.js"
export { ProcessRegistry } from "../process/registry.js"
export type { ProcessEntry, PendingNotice } from "../process/registry.js"
export { createFsTools, createFsToolEntries } from "./fs.js"
export { createSearchTools, createSearchToolEntries } from "./search.js"
export { createMemoryTools, createMemoryToolEntries } from "./memory.js"
export { createSessionTools, createSessionToolEntries, type SessionSearchFn } from "./session.js"
export { createHistoryTool, createHistoryToolEntries, HISTORY_SEARCH_DESCRIPTION, HISTORY_SEARCH_MAX_LIMIT, type HistorySearchFn } from "./history.js"
export { searchSessionEvents, type SessionHit } from "./session-search.js"
export { createSkillTools, createSkillToolEntries, SKILL_READ_DESCRIPTION } from "./skills.js"
export { createSubagentTool, createSubagentCollectTool, createSubagentToolEntries, SUBAGENT_RUN_DESCRIPTION, SUBAGENT_COLLECT_DESCRIPTION } from "./subagent.js"
export { createTeamToolEntries, CREATE_TEAM_DESCRIPTION, SPAWN_TEAMMATE_DESCRIPTION } from "./team.js"
export { createWebTools, createWebToolEntries } from "./web.js"

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
  const entries: ToolEntry[] = [
    ...createBashToolEntries({
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
    }),
    ...createFsToolEntries({ workspace: opts.workspace }),
    ...createSearchToolEntries({ workspace: opts.workspace, spillDir: opts.bash?.spillDir }),
    ...createWebToolEntries({
      tavilyApiKey: opts.tavilyApiKey,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.web?.timeoutMs,
      allowPrivateNetworks: opts.web?.allowPrivateNetworks,
      spillDir: opts.web?.spillDir,
    }),
    ...createMemoryToolEntries(opts.memoryCtx),
    ...createSessionToolEntries(opts.sessionSearch),
    ...createHistoryToolEntries(opts.historySearch),
    ...(opts.todo !== undefined ? createTodoToolEntries(opts.todo) : []),
    ...(opts.goal !== undefined && opts.childRun !== true ? createGoalToolEntries(opts.goal) : []),
    // process 三件仅在组装传入后台进程注册表时存在（daemon 恒有；裸引擎测试
    // 没有）。归属按会话隔离：registry 只暴露本 sessionId 的条目。
    ...(opts.processes !== undefined && opts.sessionId !== undefined
      ? createProcessToolEntries({ registry: opts.processes, sessionId: opts.sessionId })
      : []),
    // cron 模型面四件仅在组装传入调度器时存在（daemon 恒有）。writeTools=false
    // （cron 触发的 run，防递归：定时会话不能再建定时）只注册 cron_list。
    ...(opts.cron !== undefined ? createCronToolEntries(opts.cron) : []),
    // skills 家族排在条件组之后不是随意的：directory 档的工具目录节按 entries
    // 顺序渲染且属于冻结的提示词基线（wire 面 tools 数组每请求按名排序，见
    // run-assembly），skill_create 保持在 cron 之后 = 基线字节不变。full 档的
    // skill_read/skill_list 位置无感知（进的是排序后的数组）。
    ...createSkillToolEntries(opts.skills ?? [], opts.skillCreate, opts.recordSkillUse),
    // ui_render 无条件注册（safe 展示面，主线程与子会话同享）；directory 档，
    // 完整 schema 经 tool_search 取回（25 分支不进每请求基线）。
    ...createUiRenderToolEntries(),
  ]

  // Subagent surface rules (issue #16): a child run drops memory_save (memory
  // stays a mainline responsibility) and never carries subagent_run (single-
  // level delegation). A mainline run gains subagent_run only when the
  // assembly injected a spawner (the daemon does; bare engine tests do not).
  const surface = opts.childRun === true
    ? entries.filter((e) => e.name !== "memory_save")
    : [...entries]
  if (opts.subagent !== undefined && opts.childRun !== true) {
    surface.push(...createSubagentToolEntries(opts.subagent))
  }
  if (opts.team !== undefined) {
    surface.push(...createTeamToolEntries(opts.team.facade, opts.team.identity))
  }
  if (opts.ask !== undefined) {
    surface.push(...createAskToolEntries(opts.ask))
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
