/**
 * Tiered tool disclosure (tool_search): the registry's third declaration
 * attribute, beside risk and concurrency.
 *
 * - full: schema ships in every request's tools array (the core loop —
 *   shell, files, search, alignment; hiding these would add a lookup
 *   round-trip to nearly every step).
 * - directory: name + one-line description in the system prompt's stable
 *   tool-directory section — callable directly, runtime argument validation
 *   as the safety net; parameter details via tool_search.
 * - deferred: searchable only via tool_search (complete card back, hits
 *   promoted into the run's active set). The team tools and every MCP
 *   adapter tool live here — long-tail, schema-unbounded.
 *
 * The tier list is STATIC and human-reviewed: per-tool call frequencies
 * are recorded continuously (usage.db), but tiers change only in
 * deliberate batch reviews — every catalog change breaks the prompt
 * prefix cache at the tools segment, so re-tiering on a hair is a cost,
 * not a feature. The default for an undeclared tool is "full": an
 * unclassified tool must never silently vanish from the model's view.
 */
export type Exposure = "full" | "directory" | "deferred"

/** Initial tier assignment (2026-10-19 review; next review uses usage data). */
export const TOOL_EXPOSURE: Record<string, Exposure> = {
  // full — the core loop
  bash: "full",
  fs_read: "full",
  fs_list: "full",
  fs_write: "full",
  fs_edit: "full",
  grep: "full",
  glob: "full",
  ask_user_questions: "full",
  skill_read: "full",
  skill_list: "full",
  todo_write: "full",
  todo_read: "full",
  // directory — known by name + one line; schema on demand
  web_search: "directory",
  web_fetch: "directory",
  memory_save: "directory",
  memory_search: "directory",
  session_search: "directory",
  history_search: "directory",
  subagent_run: "directory",
  subagent_collect: "directory",
  process_list: "directory",
  process_output: "directory",
  process_kill: "directory",
  cron_create: "directory",
  cron_list: "directory",
  cron_update: "directory",
  cron_delete: "directory",
  skill_create: "directory",
  create_goal: "directory",
  get_goal: "directory",
  update_goal: "directory",
  // deferred — searchable only (low-frequency orchestration)
  create_team: "deferred",
  spawn_teammate: "deferred",
  send_message: "deferred",
  list_agents: "deferred",
  task_create: "deferred",
  task_update: "deferred",
  task_list: "deferred",
}
