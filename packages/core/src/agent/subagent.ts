/**
 * Subagent delegation — the core-side contract of `subagent_run`.
 *
 * The TOOL lives in the builtin registry (tools/subagent.ts); the EXECUTION
 * lives in the server (a real session + run submission). This module holds
 * only what both sides share: the spawner interface the assembly injects,
 * the lean system prompt a child run sees, and the answer-shaping helpers.
 *
 * Design pins (issue #16 / the grill session):
 * - A subagent is an independent SESSION whose meta carries `parentSessionId`;
 *   everything child-specific in the engine (lean prompt, hook skippings,
 *   usage attribution) derives from that field, not from run-time flags.
 * - Blocking call: the executor waits for the child run to settle and returns
 *   the child's final assistant text; process text never enters the parent
 *   context. Parallelism = several spawns in one tool batch.
 * - Permissions are NOT relaxed: the child run gets its own gate with the
 *   parent's mode; confirmations surface on the parent's channel labeled
 *   with the subagent (the server-side spawner forwards them).
 */

/** What the tool hands the spawner for one dispatch. */
export interface SubagentSpawnRequest {
  /** The session the dispatching run belongs to (the future child's parent). */
  parentSessionId: string
  /** The task in full — the child's only user message. */
  task: string
  /** Optional display name (confirmation cards, session title, status lines). */
  label?: string
  /**
   * Background mode (issue #22): the dispatch returns immediately and the
   * child's lifecycle attaches to the PARENT SESSION, not the parent run —
   * the signal is deliberately NOT tied to the child (a parent-run abort
   * must not cancel it).
   */
  background?: boolean
  /** The parent run's abort signal: aborting it must stop the child run too (blocking mode). */
  signal?: AbortSignal
  /** Live one-line status sink (the tool's onOutput channel, bus-fed). */
  onStatus(line: string): void
}

/** The spawner's settlement: the tool result the parent model sees. */
export interface SubagentSpawnResult {
  status: "ok" | "error"
  output: string
  /** The child session — carried in the tool result's `data` for audit links. */
  childSessionId?: string
}

/**
 * The collect seam (issue #22): fetch a background child's final answer long
 * after its dispatch. Implemented server-side (it reads the child session's
 * messages); the request carries the parent id so a session can only collect
 * its OWN children.
 */
export type SubagentCollector = (req: {
  parentSessionId: string
  childSessionId: string
}) => Promise<SubagentSpawnResult>

/**
 * The narrow seam the assembly injects (server implements with real session
 * infrastructure; tests mock). One call = one subagent lifetime.
 */
export type SubagentSpawner = (req: SubagentSpawnRequest) => Promise<SubagentSpawnResult>

/** Cap on the returned answer (chars); head+tail kept, middle elided. */
export const SUBAGENT_ANSWER_MAX_CHARS = 16_000

/** Chars kept at each end when the answer exceeds the cap. */
const TRUNCATE_KEEP = 4_000

/**
 * The lean system prompt a child run sees: identity + workspace + discipline.
 * Deliberately WITHOUT the persona (AGENTS.md), memory cognition and the skill
 * list — a subagent is a short-lived executor whose necessary background lives
 * in the task text itself. The room to add materials later is this template.
 */
export function subagentSystemPrompt(workspace: string): string {
  return [
    "你是 kclaw 的子代理（subagent）：由主对话派出的短命执行单元，独立会话、单层委派（不能再派子代理）。",
    `工作区：${workspace}`,
    "任务就是你的唯一指令。自主把它做完：需要什么信息就用工具取，不要反问（没有人在听）。",
    "权限规则与主会话一致：敏感操作会请求人工确认，批准后照常继续；被拒绝就换路。",
    "结束时给出完整的结题答复——它是主对话收到的全部内容，过程不会带回。",
  ].join("\n")
}

/** Keep head+tail of an overlong answer, with an elision marker in between. */
export function truncateAnswer(text: string): string {
  if (text.length <= SUBAGENT_ANSWER_MAX_CHARS) return text
  return `${text.slice(0, TRUNCATE_KEEP)}\n\n…[子代理答复超长，中段已截断（共 ${text.length} 字符）]…\n\n${text.slice(-TRUNCATE_KEEP)}`
}

/** A child-session title from the dispatch: the label, else the task's head. */
export function subagentTitle(label: string | undefined, task: string): string {
  const base = (label ?? task).replace(/\s+/g, " ").trim()
  const shortened = base.length > 40 ? `${base.slice(0, 40)}…` : base
  return `子代理 · ${shortened}`
}
