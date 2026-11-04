/**
 * Subagent delegation — the core-side contract of `subagent_run`.
 *
 * The TOOL lives in the builtin registry (tools/subagent.ts); the EXECUTION
 * lives in the server (a real session + run submission). This module holds
 * only what both sides share: the spawner interface the assembly injects,
 * and the answer-shaping helpers — the lean prompt template a child run
 * sees lives in prompts/subagent.ts.
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
  /**
   * Role supplement for the child's system prompt (the parent model
   * describes WHO the child is for this task). Appended to the lean
   * subagent template, capped; permissions stay untouched.
   */
  role?: string
  /**
   * Tool allowlist for the child run: names not listed are removed from the
   * child's executor and wire surface. Narrowing only — the child's gate is
   * built from the surviving surface, so an allowlist can never widen what
   * the parent's own permissions permit. Empty/absent = unrestricted.
   */
  toolAllow?: string[]
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
export const SUBAGENT_ANSWER_MAX_CHARS = 32_000

/** Chars kept at each end when the answer exceeds the cap. */
const TRUNCATE_KEEP = 4_000

/** Keep head+tail of an overlong answer, with an elision marker in between. */
export function truncateAnswer(text: string): string {
  if (text.length <= SUBAGENT_ANSWER_MAX_CHARS) return text
  return `${text.slice(0, TRUNCATE_KEEP)}\n\n…[subagent答复超长，中段已截断（共 ${text.length} 字符）]…\n\n${text.slice(-TRUNCATE_KEEP)}`
}

/** A child-session title from the dispatch: the label, else the task's head. */
export function subagentTitle(label: string | undefined, task: string): string {
  const base = (label ?? task).replace(/\s+/g, " ").trim()
  // 前缀"subagent · "占 11 字符，正文连省略号至多 39，标题总长守住 50。
  const shortened = base.length > 38 ? `${base.slice(0, 38)}…` : base
  return `subagent · ${shortened}`
}
