/**
 * ToolCards — the per-tool card registry for the chat stream (the same
 * "one registry owns the display knowledge" pattern the audit view
 * converged on). Registered tools get purpose-built cards; unregistered
 * tools keep the plain collapse rows, so the registry only ever adds.
 *
 * Rendering units pair a tool_call with its tool_result (matched by callId
 * in the message's block list): the card renderer sees both sides, so a
 * bash card can show spinner→check alongside the exit code, and an fs_edit
 * card can show the diff even though old/new live in the call args.
 */
import type { ReactNode } from "react"
import type { ToolCallRender, ToolResultRender } from "./model.js"

export interface ToolCardCtx {
  call: ToolCallRender
  /** The paired settled result, while the call is still running → null. */
  result: ToolResultRender | null
  onOpenAudit?: (sessionId: string) => void
}

type CallCard = (ctx: ToolCardCtx) => ReactNode
type ResultCard = (opts: { result: ToolResultRender; onOpenAudit?: (sessionId: string) => void }) => ReactNode

/** Bash card: spinner while running, then ✓/✗ with duration and the
 * structured exit code (absent on older history → derived from status). */
function BashCard({ call, result }: ToolCardCtx) {
  const cmd = oneLine(call.argsJson)
  if (result === null) {
    return (
      <div className="tool-card" data-testid="tool-card-bash-running">
        <span className="tool-card-status tool-card-running">⏳</span>
        <code className="tool-card-cmd">{cmd}</code>
      </div>
    )
  }
  const exit = (result.data as { exitCode?: number | null } | undefined)?.exitCode
  const ok = result.status === "ok"
  return (
    <details className="tool-card" data-testid="tool-card-bash">
      <summary>
        <span className={`tool-card-status ${ok ? "tool-card-ok" : "tool-card-error"}`}>{ok ? "✓" : "✗"}</span>
        <code className="tool-card-cmd">{cmd}</code>
        <span className="tool-card-meta">
          {Math.round(result.durationMs)}ms
          {exit !== undefined && exit !== null ? ` · exit ${exit}` : ""}
          {!ok && exit === null ? " · 超时/失败" : ""}
        </span>
      </summary>
      <pre className="tool-card-body">{result.output}</pre>
    </details>
  )
}

/** fs_edit card: the old→new diff as aligned red/green lines (both sides
 * from the call args; the payload carries no file content). */
function FsEditCard({ call, result }: ToolCardCtx) {
  let old = ""
  let new_ = ""
  try {
    const args = JSON.parse(call.argsJson) as { old?: unknown; new?: unknown; path?: unknown }
    if (typeof args.old === "string") old = args.old
    if (typeof args.new === "string") new_ = args.new
    return (
      <details className="tool-card" data-testid="tool-card-fs-edit" open={undefined}>
        <summary>
          <span className={`tool-card-status ${result !== null && result.status === "ok" ? "tool-card-ok" : result !== null ? "tool-card-error" : "tool-card-running"}`}>
            {result === null ? "⏳" : result.status === "ok" ? "✓" : "✗"}
          </span>
          <code className="tool-card-cmd">✎ {typeof args.path === "string" ? args.path : ""}</code>
          <span className="tool-card-meta">{result !== null ? `${Math.round(result.durationMs)}ms` : ""}</span>
        </summary>
        <div className="tool-card-diff">
          <div className="diff-lines">
            {old.split("\n").map((l, i) => <div key={`o${i}`} className="diff-del">- {l}</div>)}
            {new_.split("\n").map((l, i) => <div key={`n${i}`} className="diff-add">+ {l}</div>)}
          </div>
        </div>
      </details>
    )
  } catch {
    return undefined // unparseable args → caller falls back to the plain row
  }
}

/** fs_write card: byte count + collapsed new-content preview (a whole-file
 * overwrite has no old side — no fake diff). */
function FsWriteCard({ call, result }: ToolCardCtx) {
  try {
    const args = JSON.parse(call.argsJson) as { content?: unknown; path?: unknown }
    if (typeof args.content !== "string") return undefined
    const bytes = new TextEncoder().encode(args.content).length
    return (
      <details className="tool-card" data-testid="tool-card-fs-write">
        <summary>
          <span className={`tool-card-status ${result !== null && result.status === "ok" ? "tool-card-ok" : result !== null ? "tool-card-error" : "tool-card-running"}`}>
            {result === null ? "⏳" : result.status === "ok" ? "✓" : "✗"}
          </span>
          <code className="tool-card-cmd">+ {typeof args.path === "string" ? args.path : ""}</code>
          <span className="tool-card-meta">{formatBytes(bytes)}{result !== null ? ` · ${Math.round(result.durationMs)}ms` : ""}</span>
        </summary>
        <pre className="tool-card-body">{args.content}</pre>
      </details>
    )
  } catch {
    return undefined
  }
}

/** todo progress card: the executor's {count, remaining} snapshot. */
function TodoCard({ result }: { result: ToolResultRender }) {
  const data = result.data as { count?: unknown; remaining?: unknown } | undefined
  if (data === undefined || typeof data.count !== "number" || typeof data.remaining !== "number") return null
  const done = data.count - data.remaining
  const pct = data.count > 0 ? Math.round((done / data.count) * 100) : 0
  return (
    <div className="tool-card tool-card-plain" data-testid="tool-card-todo">
      <span className="tool-card-status tool-card-ok">☑</span>
      <span className="tool-card-meta">
        任务清单 {done}/{data.count} 完成
      </span>
      <span className="tool-card-progress">
        <span className="tool-card-progress-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  )
}

/** cron snapshot card: schedule, next run, enabled/last status. */
function CronCard({ result }: { result: ToolResultRender }) {
  const cron = result.data as { name?: string; cron?: string; nextRunAt?: string; enabled?: boolean; lastStatus?: string } | undefined
  if (cron?.cron === undefined) return null
  return (
    <details className="tool-card" data-testid="tool-card-cron">
      <summary>
        <span className={`tool-card-status ${cron.enabled === false ? "tool-card-error" : "tool-card-ok"}`}>
          {cron.enabled === false ? "⏸" : "⏰"}
        </span>
        <code className="tool-card-cmd">{cron.name ?? "cron"}</code>
        <span className="tool-card-meta">{cron.cron}{cron.nextRunAt !== undefined ? ` · 下次 ${new Date(cron.nextRunAt).toLocaleString()}` : ""}</span>
      </summary>
      <pre className="tool-card-body">{result.output}</pre>
    </details>
  )
}

/** goal snapshot card: state + round progress. */
function GoalCard({ result }: { result: ToolResultRender }) {
  const goal = result.data as { text?: string; state?: string; rounds?: number; totalRounds?: number } | undefined
  if (goal?.state === undefined) return null
  const done = goal.state === "complete"
  return (
    <div className="tool-card tool-card-plain" data-testid="tool-card-goal">
      <span className={`tool-card-status ${done ? "tool-card-ok" : "tool-card-running"}`}>{done ? "🎯✓" : "🎯"}</span>
      <span className="tool-card-meta">
        {goal.text !== undefined ? oneLine(JSON.stringify(goal.text)) : "目标"}
        {goal.rounds !== undefined && goal.totalRounds !== undefined ? ` · 第 ${goal.rounds}/${goal.totalRounds} 轮 · ${goal.state}` : ` · ${goal.state}`}
      </span>
    </div>
  )
}

/** subagent status card: the live last-line feed plus the audit jump. */
function SubagentCard({ result, onOpenAudit }: { result: ToolResultRender; onOpenAudit?: (sessionId: string) => void }) {
  const childSessionId = (result.data as { childSessionId?: string } | undefined)?.childSessionId
  if (childSessionId === undefined) return null
  return (
    <details className="tool-card" data-testid="blk-tool-result-subagent">
      <summary>
        <span className="tool-card-status tool-card-ok">↳</span>
        <span className="tool-card-meta">subagent · {latestLine(result.output)}</span>
      </summary>
      <pre className="tool-card-body">{result.output}</pre>
      {onOpenAudit !== undefined && (
        <button className="subagent-audit-link" data-testid="subagent-audit-link" onClick={() => onOpenAudit(childSessionId)}>
          查看subagent审计
        </button>
      )}
    </details>
  )
}

/**
 * The registry itself: tool name → card renderers. `call` renders from the
 * (paired) call side; `result` renders result-only cards where the call
 * args add nothing. A renderer returning undefined/null falls back to the
 * plain row — a card must never blank its tool.
 */
export const TOOL_CARDS: Record<string, { call?: CallCard; result?: ResultCard }> = {
  bash: { call: BashCard },
  fs_edit: { call: FsEditCard },
  fs_write: { call: FsWriteCard },
  todo_list_write: { result: TodoCard },
  cron_create: { result: CronCard },
  cron_update: { result: CronCard },
  create_goal: { result: GoalCard },
  update_goal: { result: GoalCard },
  subagent_run: { result: SubagentCard },
}

/** Whitespace-collapsed, first-80-chars summary for a tool card line. */
export function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed
}

/** Last non-empty line of a streaming subagent status feed (the live one-liner). */
function latestLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "")
  return lines[lines.length - 1] ?? ""
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}
