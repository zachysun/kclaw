/**
 * TeamPanelCard — the agent-team panel floating over the chat area's
 * top-right corner (outside the scrolling log, so it stays visible while
 * reading history): member cards on top (lifecycle badge, busy/idle, current
 * task, per-member stop), the shared task board below (status/owner/
 * dependency badges + segment stats). The whole panel folds to its summary
 * chip (preference kept in localStorage). Presentational only: data arrives
 * via props, actions escape as callbacks (点选说话 / 逐个停止 / 审计跳转).
 * Rendered by ChatView when the session's team panel payload exists; no
 * team → nothing rendered at all.
 */
import { useState } from "react"

export interface TeamMemberView {
  name: string
  status: "provisioning" | "active" | "failed"
  busy?: boolean
  role?: string
  model?: string
  failReason?: string
  sessionId?: string
  currentTask?: string
}

export interface TeamTaskView {
  id: number
  subject: string
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled"
  assignee: string | null
  dependencies: number[]
  attempt: number
}

export interface TeamPanelData {
  team: { teamId: string; name: string; leadSessionId: string }
  identity: "lead" | "member"
  members: TeamMemberView[]
  tasks: TeamTaskView[]
}

export interface TeamPanelCardProps {
  panel: TeamPanelData
  /** The member the composer currently talks to (null = the lead). */
  target: string | null
  /** 点选说话：切 composer 目标（成员名；null = 切回组长）。 */
  onTalkTo: (name: string | null) => void
  /** 逐个停止：结束该成员的当前轮（回到 idle，不移除）。 */
  onStopMember: (sessionId: string) => void
  /** 成员卡深链到审计轨迹（可选）。 */
  onOpenAudit?: (sessionId: string) => void
}

const TASK_STATUS: Record<TeamTaskView["status"], string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

/** Fold preference survives reloads and session switches (a floating panel
 * the user collapsed should stay collapsed). */
const FOLD_KEY = "kclaw_team_panel_open"

function initialOpen(): boolean {
  try {
    return window.localStorage.getItem(FOLD_KEY) !== "0"
  } catch {
    return true
  }
}

export function TeamPanelCard({ panel, target, onTalkTo, onStopMember, onOpenAudit }: TeamPanelCardProps) {
  const [open, setOpen] = useState(initialOpen)
  const toggle = (): void =>
    setOpen((v) => {
      try {
        window.localStorage.setItem(FOLD_KEY, v ? "0" : "1")
      } catch {
        // storage unavailable (private mode) — the fold just won't persist
      }
      return !v
    })
  const stats = countByStatus(panel.tasks)
  const working = panel.members.filter((m) => m.busy === true).length
  return (
    <details className="team-panel" data-testid="team-panel" open={open}>
      <summary
        className="team-panel-head"
        data-testid="team-panel-toggle"
        onClick={(e) => {
          e.preventDefault()
          toggle()
        }}
      >
        <span>团队 {panel.team.name}</span>
        <span className="team-panel-meta muted">
          {panel.members.length} 名组员 · {working} 人干活中 · 任务 {stats.completed}/{panel.tasks.length} 完成
        </span>
      </summary>
      <div className="team-panel-body">
        <div className="team-members" data-testid="team-members">
          <div className={memberClass(null, target)}>
            <span className="team-member-name">组长（我）</span>
            <span className="team-member-actions">
              <button
                type="button"
                className={target === null ? "team-talk active" : "team-talk"}
                data-testid="team-talk-lead"
                onClick={() => onTalkTo(null)}
              >
                {target === null ? "对话中" : "说话"}
              </button>
            </span>
          </div>
          {panel.members.map((m) => (
            <div className={memberClass(m.name, target)} key={m.name} data-testid={`team-member-card-${m.name}`}>
              <span className="team-member-name">
                {m.name}
                <MemberBadge member={m} />
              </span>
              <span className="team-member-sub muted">
                {m.role !== undefined ? `${m.role} · ` : ""}
                {m.model !== undefined ? `${m.model} · ` : ""}
                {m.currentTask !== undefined ? `正在做：${m.currentTask}` : ""}
                {m.status === "failed" && m.failReason !== undefined ? m.failReason : ""}
              </span>
              <span className="team-member-actions">
                {m.status === "active" && (
                  <button
                    type="button"
                    className={target === m.name ? "team-talk active" : "team-talk"}
                    data-testid={`team-talk-${m.name}`}
                    onClick={() => onTalkTo(m.name)}
                  >
                    {target === m.name ? "对话中" : "说话"}
                  </button>
                )}
                {m.busy === true && m.sessionId !== undefined && (
                  <button
                    type="button"
                    className="team-stop"
                    data-testid={`team-stop-${m.name}`}
                    onClick={() => onStopMember(m.sessionId!)}
                  >
                    停止
                  </button>
                )}
                {m.sessionId !== undefined && onOpenAudit !== undefined && (
                  <button type="button" className="team-trail" onClick={() => onOpenAudit(m.sessionId!)}>
                    轨迹
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
        <div className="team-board" data-testid="team-board">
          <div className="team-board-stats" data-testid="team-board-stats">
            <span>待办 {stats.pending}</span>
            <span>进行中 {stats.in_progress}</span>
            <span>完成 {stats.completed}</span>
            <span>失败 {stats.failed}</span>
            <span>取消 {stats.cancelled}</span>
          </div>
          {panel.tasks.length === 0 ? (
            <div className="team-board-empty muted">任务板还是空的</div>
          ) : (
            <ul className="team-task-list">
              {panel.tasks.map((t) => (
                <li className={`team-task-row team-task-${t.status}`} key={t.id} data-testid={`team-task-row-${t.id}`}>
                  <span className="team-task-subject">
                    #{t.id} {t.subject}
                  </span>
                  <span className="team-task-meta muted">
                    {TASK_STATUS[t.status]}
                    {t.assignee !== null ? ` · ${t.assignee}` : ""}
                    {t.attempt > 0 ? ` · 第 ${t.attempt} 次尝试` : ""}
                    {t.dependencies.length > 0 ? ` · 依赖 #${t.dependencies.join(" #")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  )
}

function memberClass(name: string | null, target: string | null): string {
  return (name ?? null) === target ? "team-member-card active" : "team-member-card"
}

function MemberBadge({ member }: { member: TeamMemberView }) {
  if (member.status === "provisioning") return <span className="team-badge provisioning">生成中</span>
  if (member.status === "failed") return <span className="team-badge failed">失败</span>
  return member.busy === true
    ? <span className="team-badge busy">干活中</span>
    : <span className="team-badge idle">待命</span>
}

function countByStatus(tasks: TeamTaskView[]): Record<TeamTaskView["status"], number> {
  const out = { pending: 0, in_progress: 0, completed: 0, failed: 0, cancelled: 0 }
  for (const t of tasks) out[t.status] += 1
  return out
}
