/**
 * GoalPanelCard — /goal 目标循环的浮动详情卡（issue #47），与团队卡同一
 * 挂载位（聊天区右上角、滚动日志之外）。整体可折叠成一行徽标：状态 +
 * 轮数进度。展开显示目标原文、验收命令、计数（连续/累计轮数、token
 * 预算）、判定器最近意见与停止说明；动作区提供 暂停/恢复/停止目标/移除
 * 与改写表单（改写含验收命令编辑——创建走 /goal 命令，验收命令的完整
 * 编辑入口在这里）。纯展示组件：数据经 props 进、动作经回调出。
 */
import { useState } from "react"
import type { GoalSnapshot, GoalView } from "@kclaw/core/protocol"

export interface GoalPanelCardProps {
  view: GoalView
  /** 暂停（active 时可用）。 */
  onPause: () => void
  /** 恢复（paused/blocked 时可用）。 */
  onResume: () => void
  /** 停止目标循环：掐活跃 run + 清排队 + 停止（与「仅停本轮」互补）。 */
  onStop: () => void
  /** 移除目标（任何状态）。 */
  onClear: () => void
  /** 改写目标（文本 + 验收命令），提交时带完整表单值。 */
  onEdit: (text: string, acceptance: string[]) => void
}

const STATE_LABEL: Record<GoalSnapshot["state"], string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "待裁决",
  complete: "已终态",
}

const VERDICT_LABEL: Record<NonNullable<GoalSnapshot["lastJudgeVerdict"]>, string> = {
  not_met: "未达成",
  met: "已达成",
  impossible: "不可能",
}

/** 停止/终态原因的中文短语（徽标摘要用；完整说明走 stoppedNote）。 */
const REASON_SHORT: Record<NonNullable<GoalSnapshot["stoppedReason"]>, string> = {
  met: "已达成",
  impossible: "不可能达成",
  "round-limit": "轮数达上限",
  "budget-limit": "预算耗尽",
  "gate-exhausted": "验收连续失败",
  "no-progress": "无进展",
  permission: "待人工裁决",
  "judge-failed": "判定器失败",
  "run-error": "运行出错",
  "user-stop": "已停止",
}

const FOLD_KEY = "kclaw_goal_panel_open"

function initialOpen(): boolean {
  try {
    return window.localStorage.getItem(FOLD_KEY) !== "0"
  } catch {
    return true
  }
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}k` : String(n)
}

export function GoalPanelCard({ view, onPause, onResume, onStop, onClear, onEdit }: GoalPanelCardProps) {
  const [open, setOpen] = useState(initialOpen)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState("")
  const [acceptance, setAcceptance] = useState("")
  const { goal, derived, armed, limits } = view
  const toggle = (): void => {
    setOpen((v) => {
      try {
        window.localStorage.setItem(FOLD_KEY, v ? "0" : "1")
      } catch {
        // storage unavailable — the fold just won't persist
      }
      return !v
    })
  }
  const startEdit = (): void => {
    setText(goal.text)
    setAcceptance(goal.acceptance.join("\n"))
    setEditing(true)
  }
  const submitEdit = (): void => {
    const trimmed = text.trim()
    if (trimmed === "") return
    onEdit(trimmed, acceptance.split("\n").map((l) => l.trim()).filter((l) => l !== ""))
    setEditing(false)
  }
  const summary =
    goal.state === "complete" && goal.stoppedReason !== undefined
      ? `目标 ${REASON_SHORT[goal.stoppedReason]}`
      : goal.state === "active"
        ? `目标 进行中 · 第 ${derived.rounds + 1}/${limits.maxRounds} 轮`
        : `目标 ${STATE_LABEL[goal.state]}${goal.stoppedReason !== undefined ? ` · ${REASON_SHORT[goal.stoppedReason]}` : ""}`
  return (
    <details className="goal-panel" data-testid="goal-panel" open={open}>
      <summary
        className={`goal-panel-head goal-state-${goal.state}`}
        data-testid="goal-panel-toggle"
        onClick={(e) => {
          e.preventDefault()
          toggle()
        }}
      >
        <span>{summary}</span>
      </summary>
      <div className="goal-panel-body">
        <div className="goal-text" data-testid="goal-text">{goal.text}</div>
        {goal.acceptance.length > 0 && (
          <ul className="goal-acceptance" data-testid="goal-acceptance">
            {goal.acceptance.map((cmd) => (
              <li key={cmd}>
                <code>{cmd}</code>
              </li>
            ))}
          </ul>
        )}
        <div className="goal-counters muted" data-testid="goal-counters">
          <span>连续轮 {derived.rounds}/{limits.maxRounds}</span>
          <span>累计 {derived.totalRounds} 轮</span>
          <span>token {fmtTokens(derived.tokensUsed)}/{fmtTokens(limits.tokenBudget)}</span>
          <span>{armed ? "自动续跑中" : "不自动续跑"}</span>
        </div>
        {goal.lastJudgeReason !== undefined && (
          <div className="goal-judge" data-testid="goal-judge">
            <span className="goal-judge-verdict">
              判定 {goal.lastJudgeVerdict !== undefined ? VERDICT_LABEL[goal.lastJudgeVerdict] : ""}
              {goal.lastJudgeAt !== undefined ? ` · ${goal.lastJudgeAt.slice(11, 19)}` : ""}
            </span>
            <span className="muted">{goal.lastJudgeReason}</span>
          </div>
        )}
        {goal.stoppedNote !== undefined && (
          <div className="goal-stopped-note" data-testid="goal-stopped-note">{goal.stoppedNote}</div>
        )}
        {editing ? (
          <div className="goal-edit" data-testid="goal-edit">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              aria-label="目标描述"
              data-testid="goal-edit-text"
            />
            <textarea
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
              rows={2}
              placeholder="验收命令（每行一条，沙箱内执行；留空 = 无验收命令）"
              aria-label="验收命令"
              data-testid="goal-edit-acceptance"
            />
            <div className="goal-edit-actions">
              <button type="button" data-testid="goal-edit-submit" onClick={submitEdit}>
                保存并重新起跑
              </button>
              <button type="button" onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="goal-actions" data-testid="goal-actions">
            {goal.state === "active" && (
              <button type="button" data-testid="goal-pause" onClick={onPause}>
                暂停
              </button>
            )}
            {(goal.state === "paused" || goal.state === "blocked") && (
              <button type="button" data-testid="goal-resume" onClick={onResume}>
                恢复
              </button>
            )}
            {goal.state !== "complete" && (
              <button type="button" className="goal-stop" data-testid="goal-stop" onClick={onStop}>
                停止目标
              </button>
            )}
            <button type="button" data-testid="goal-edit-open" onClick={startEdit}>
              改写
            </button>
            <button type="button" className="goal-clear" data-testid="goal-clear" onClick={onClear}>
              移除
            </button>
          </div>
        )}
      </div>
    </details>
  )
}
