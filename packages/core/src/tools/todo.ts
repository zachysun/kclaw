/**
 * todo_write / todo_read: the model's session-scoped scratch checklist.
 *
 * Full-snapshot semantics: one write replaces the whole list (no item ids —
 * replacement needs no stable identity), last write wins. Every write lands
 * as one todo.written persistence event, so replay/audit/UI need zero merge
 * logic and the checklist survives across runs inside the session.
 *
 * Caps keep a runaway plan from eating context (50 items / 200 chars per
 * item / 4000 chars total). Exactly one in_progress item is enforced by
 * default — the plan should reflect what is actually being worked on — with
 * a config escape (todo.allowParallelInProgress) for parallel-subagent
 * flows; one surveyed harness had to remove this check outright under
 * parallelism, so the escape must exist.
 *
 * Both tools are safe: the checklist is model-owned scratch state, not a
 * capability frontier. Registered for mainline and child runs alike (each
 * session keeps its own list — parallel subagents do not share plan state).
 *
 * Glossary split: todo (this — session-scrapped plan) vs the team task
 * board (cross-session collaboration) vs /goal (the user-controlled target
 * loop).
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { TodoItem } from "../protocol/session-events.js"
import { makeTool } from "./shared.js"

const MAX_ITEMS = 50
const MAX_ITEM_CHARS = 200
const MAX_TOTAL_CHARS = 4000
const STATUSES = ["pending", "in_progress", "completed"] as const
type Status = (typeof STATUSES)[number]

export interface TodoStore {
  /** Append one snapshot event (full replacement, last write wins). */
  write(todos: TodoItem[]): void
  /** Current projected list; undefined = never written. */
  read(): TodoItem[] | undefined
}

export function createTodoTools(opts: {
  store: TodoStore
  /** true = relax the single-in_progress check (parallel-subagent flows). */
  allowParallelInProgress?: boolean
}): {
  "todo_write": ToolExecutor & { name: "todo_write" }
  "todo_read": ToolExecutor & { name: "todo_read" }
} {
  const { store, allowParallelInProgress = false } = opts

  const render = (todos: TodoItem[]): string => {
    const mark = (s: Status): string => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]")
    return todos.map((t) => `${mark(t.status)} ${t.content}`).join("\n")
  }

  const todo_write = makeTool("todo_write", "safe", "serial", (args) => {
    const raw = (args as { todos?: unknown } | null)?.todos
    if (!Array.isArray(raw)) {
      return { status: "error", output: "todo_write: args.todos must be an array of {content, status}" }
    }
    if (raw.length > MAX_ITEMS) {
      return { status: "error", output: `todo_write: 条数超上限（${raw.length} > ${MAX_ITEMS}）` }
    }
    const todos: TodoItem[] = []
    let total = 0
    let inProgress = 0
    for (const item of raw) {
      const content = (item as { content?: unknown } | null)?.content
      const status = (item as { status?: unknown } | null)?.status
      if (typeof content !== "string" || content.trim() === "") {
        return { status: "error", output: "todo_write: 每条目必须有非空 content" }
      }
      if (typeof status !== "string" || !STATUSES.includes(status as Status)) {
        return { status: "error", output: `todo_write: status 必须是 ${STATUSES.join(" / ")} 之一` }
      }
      if (content.length > MAX_ITEM_CHARS) {
        return { status: "error", output: `todo_write: 单条 content 超上限（${content.length} > ${MAX_ITEM_CHARS} 字符）` }
      }
      total += content.length
      if (status === "in_progress") inProgress++
      todos.push({ content, status: status as Status })
    }
    if (total > MAX_TOTAL_CHARS) {
      return { status: "error", output: `todo_write: 总字符超上限（${total} > ${MAX_TOTAL_CHARS}）` }
    }
    if (!allowParallelInProgress && inProgress > 1) {
      return {
        status: "error",
        output: `todo_write: 同时只能有一条 in_progress（收到 ${inProgress} 条）；确实需要并行时由用户在配置开启 todo.allowParallelInProgress`,
      }
    }
    store.write(todos)
    const remaining = todos.filter((t) => t.status !== "completed").length
    return {
      status: "ok",
      output: `清单已更新：${todos.length} 项（未完成 ${remaining}）\n${render(todos)}`,
      data: { count: todos.length, remaining },
    }
  })

  const todo_read = makeTool("todo_read", "safe", "parallel", () => {
    const todos = store.read()
    if (todos === undefined || todos.length === 0) {
      return { status: "ok", output: "(清单为空——从未写入，或最近一次写入是空数组)" }
    }
    const remaining = todos.filter((t) => t.status !== "completed").length
    return { status: "ok", output: `${todos.length} 项（未完成 ${remaining}）：\n${render(todos)}` }
  })

  return { "todo_write": todo_write, "todo_read": todo_read }
}
