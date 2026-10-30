/**
 * ChatView — the conversation surface assembly: the floating team/goal
 * panels, the message log (with follow-tail scrolling), run/compaction
 * indicators, the decision cards, the notice strip, and the composer.
 * Presentation + local UI state only: no I/O, every action escapes through
 * a callback. The callbacks handed down to message bubbles are render-stable
 * (ids, not per-message closures) so bubble memoization holds during a
 * streaming run.
 */
import { Fragment, useCallback, useRef, useState, type ReactNode } from "react"
import { SLASH_COMMANDS, type SlashCommandMeta } from "@kclaw/core/commands"
import { PERMISSION_MODES, type PermissionMode } from "@kclaw/core/permission-modes"
import type { AttachmentRef, ConfirmationDecision, GoalView, TeamPanel } from "@kclaw/core/protocol"
import type { ChatState, RenderedMessage } from "./model.js"
import type { UiCardAction } from "./UiCardForm.js"
import { MessageBubble, firstRenderedText } from "./MessageBubble.js"
import { ConfirmationCardView, QuestionCardView } from "./Cards.js"
import { AuditContextNote, compactionBars, type CompactionRecordView } from "./CompactionBars.js"
import { Composer } from "./Composer.js"
import { useFollowTail } from "./useFollowTail.js"
import { TeamPanelCard } from "./TeamPanel.js"
import { GoalPanelCard } from "./GoalPanel.js"

/**
 * How a message enters a busy session: steer injects into the live
 * run, wait queues behind it, interrupt preempts with a new run. The trio's
 * current selection; also carried explicitly on every send_message frame.
 */
export type Disposition = "steer" | "wait" | "interrupt"

/**
 * An uploaded attachment queued for the next message. `path` is absent while
 * the upload is still in flight (the chip renders 上传中 and sends are held
 * back); it carries the wire AttachmentRef fields once settled.
 */
export interface PendingAttachment {
  id: string
  name: string
  size: number
  mimeType: string
  path?: string
}

/** The wire shape a settled upload contributes to a send_message frame. */
export type SentAttachment = AttachmentRef

export interface ChatViewProps {
  /** Session identity — keys the follow-tail reset (a session switch scrolls to latest). */
  sessionId: string
  view: ChatState
  /**
   * Submit a composer message. `true` = accepted (the composer clears its
   * draft); `false` = rejected — the draft stays so the user can retry
   * without retyping (socket down, attachment upload still in flight).
   */
  onSend: (text: string) => boolean
  /** Answer an inline confirmation card. */
  onResolveConfirmation: (confirmationId: string, decision: ConfirmationDecision) => void
  /** Answer an inline question card (one string array per question, in ask order). */
  onAnswerQuestion: (questionId: string, answers: string[][]) => void
  /** Attachments queued for the next message (drag-and-drop; uploading ones have no path yet). */
  pendingAttachments: PendingAttachment[]
  /** Drop one queued attachment (by its PendingAttachment.id). */
  onRemoveAttachment: (id: string) => void
  /** Available provider model names (empty → no selector rendered). */
  models?: string[]
  /** Current session model override (undefined → daemon default). */
  sessionModel?: string
  /** Switch the session model ("" clears to default). */
  onSwitchModel?: (name: string) => void
  /** The session's permission mode (always-on selector next to the model one). */
  mode?: PermissionMode
  /** Switch the session permission mode (POSTs; applies from the next run). */
  onSwitchMode?: (m: PermissionMode) => void
  /**
   * Transient status line (command results, reconnect/auth/upload/model
   * messages) — rendered directly above the composer, next to the input that
   * triggered it. Null/undefined hides it.
   */
  notice?: string | null
  /** Optional click action for the notice (memory.written 跳转)。
   * Present → the notice renders as a button; absent → plain text. */
  noticeAction?: (() => void) | null
  /** Dismiss the notice (the × on the notice bar; typing clears it too). */
  onDismissNotice?: () => void
  /** The user typed into the composer — the owner clears the stale notice. */
  onDraftChange?: () => void
  /** The current send disposition (the trio's selection; the owner resolves it from meta/config). */
  disposition?: Disposition
  /** Select the trio — the owner writes the sticky override and carries it on sends. */
  onSetDisposition?: (d: Disposition) => void
  /** Cancel one queued message (its row's cancel button). */
  onCancelQueued?: (messageId: string) => void
  /** Cancel every still-queued message (the banner's 全部取消). */
  onCancelAllQueued?: () => void
  /** Open a subagent's audit view (the spawn row's link). */
  onOpenAudit?: (sessionId: string) => void
  /** UI 卡动作回传（按钮/表单提交，callId 标记来源卡）。 */
  onUiAction?: (callId: string, action: UiCardAction) => void
  /** callId → 已发生的卡动作（持久已选态反查）。 */
  uiPicks?: Map<string, UiCardAction>
  /** Cancel the in-flight automatic compaction (the indicator's cancel button, compaction.cancel). */
  onCancelCompaction?: () => void
  /** Stop the active run (the run indicator's stop button; the run.cancel frame). */
  onStopRun?: () => void
  /**
   * Edit & retry / regenerate: rerun from the last user message (text = the
   * edited or original text; attachments ride along server-side, rebuilt from
   * the discarded message). The edit confirm and the regenerate button both
   * land here.
   */
  onRetry?: (fromMessageId: string, text: string) => void
  /**
   * Session fork（从任意消息处分叉新会话）：消息气泡的 Fork 按钮上抛。
   * 只在非只读会话传入（subagent 会话不给入口）；空闲与否由本组件控制按钮
   * 置灰，POST 与跳转反馈归所有方（ChatPanel/App）。
   */
  onFork?: (messageId: string) => void
  /** fork 请求进行中：禁用全部气泡的 fork 按钮（防重复提交）。 */
  forkPending?: boolean
  /**
   * 压缩审计记录（GET /sessions/:id/compactions 的 UI 镜像，ChatPanel
   * 在会话选中时并行拉取）。null/undefined（未加载或拉取失败）→ 不渲染
   * 审计折叠条。
   */
  compactions?: CompactionRecordView[] | null
  /** 已装用户可见技能的动态命令（/技能名）：合并进建议菜单与 /help 面板（内置优先）。 */
  extraCommands?: SlashCommandMeta[]
  /** 会话工作区内的文件（GET /fs/files，失败静默为空）：@ 文件指定的候选源。 */
  mentionFiles?: readonly string[]
  /** 文件清单在后端被截断（仓库过大）：抽屉尾部显示一行提示。 */
  mentionTruncated?: boolean
  /**
   * A child session (meta.parentSessionId set) is read-only: the
   * whole input area (model/mode selectors, attachments, composer) is replaced
   * by one hint line; the server's submit also rejects user-triggered posts.
   */
  readOnly?: boolean
  /** Back to the parent session — the read-only hint's button (a child never
   * appears in the sidebar, so this is the only visible way back). */
  onReturnToParent?: () => void
  /**
   * Agent-team panel wiring: the panel payload plus the
   * composer target. Undefined/null panel = this session has no team →
   * nothing rendered. `target` shows the "→ 组员名" chip; onTalkTo(null)
   * clears it back to the lead.
   */
  team?: {
    panel: TeamPanel
    target: string | null
    onTalkTo: (name: string | null) => void
    onStopMember: (sessionId: string) => void
  }
  /**
   * /goal 目标循环面板（issue #47）：视图存在即渲染浮动卡（与团队卡同
   * 挂载位）。动作全部经回调上抛（ChatPanel 发 REST 后刷新视图）。
   */
  goal?: {
    view: GoalView
    onPause: () => void
    onResume: () => void
    onStop: () => void
    onClear: () => void
    onEdit: (text: string, acceptance: string[]) => void
  }
  /**
   * 会话用量状态条（SessionUsageStrip）：渲染在输入框下方、chat-host 最底
   * 部的一行灰色小字。取数与刷新节奏归所有方（ChatPanel），本组件只负责
   * 摆放。默认不渲染。
   */
  usage?: ReactNode
}

export function ChatView({ sessionId, view, onSend, onUiAction, uiPicks, onResolveConfirmation, onAnswerQuestion, pendingAttachments, onRemoveAttachment, models, sessionModel, onSwitchModel, mode, onSwitchMode, notice, noticeAction, onDismissNotice, onDraftChange, disposition, onSetDisposition, onCancelQueued, onCancelAllQueued, onOpenAudit, onCancelCompaction, onStopRun, onRetry, onFork, forkPending, compactions, extraCommands, mentionFiles, mentionTruncated, readOnly, onReturnToParent, team, goal, usage }: ChatViewProps) {
  // In-place editor state of edit & retry, keyed by the bubble being edited;
  // both confirm and Esc clear it.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  // 跟随滚动：贴底跟随、上滚暂停、切会话回到底部；暂停时给"回到底部"。
  const { logRef, onLogScroll, pinned, jumpToBottom } = useFollowTail(view.messages, sessionId)

  // 稳定回调的查找源：view.messages 每次渲染都是新数组，闭包持它会让所有
  // 气泡的 memo 失效；ref 同步最新列表，回调本身零依赖、跨渲染稳定。
  const messagesRef = useRef(view.messages)
  messagesRef.current = view.messages

  // 排队列表数据（Master 2026-08-30 改版）：view.queue 本身就是
  // FIFO 行序（先排队的在下标 0），直接渲染即"先排队在上面"。
  // 独立于一次性 notice——它是状态，不随输入清除。
  const queuedRows = view.queue

  // 审计折叠条；未加载/失败（null）→ 空数组。
  const auditBars = compactions == null ? [] : compactionBars(view.messages, compactions)

  // Edit & retry / regenerate are available exactly while the session is
  // idle (no run, no queue, no in-flight compaction); hidden while generating
  // — stop first, then redo. Child sessions are read-only: never offered.
  const idle = view.runState === "idle" && view.queue.length === 0 && view.compacting !== true
  const canRetry = !readOnly && idle && onRetry !== undefined
  // fork：任意消息可点，但只在空闲时可用（复制历史不容竞态）；请求进行中
  // 全体禁点（forkPending，防连点出多个会话）；非空闲置灰并带提示，不隐藏
  // （运行结束后可 fork）。
  const canFork = idle && !forkPending
  const lastUserIdx = findLastIdx(view.messages, (m) => m.role === "user")
  const lastAssistantIdx = findLastIdx(view.messages, (m) => m.role === "assistant")

  const openHelp = useCallback((): void => setHelpOpen(true), [])

  /** Edit confirm: an empty text does not submit (same rule as the composer). */
  const confirmEdit = (): void => {
    if (editing === null) return
    const text = editing.text.trim()
    if (text === "") return
    onRetry?.(editing.id, text)
    setEditing(null)
  }

  /** Editor keys: Enter confirms, Shift+Enter breaks a line, Esc cancels (composer habits). */
  const handleEditKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      confirmEdit()
    } else if (event.key === "Escape") {
      setEditing(null)
    }
  }

  // 气泡动作回调（跨渲染稳定，见 messagesRef 注释）：按 id 从最新列表取正文。
  const startEdit = useCallback((messageId: string): void => {
    const message = messagesRef.current.find((m) => m.id === messageId)
    if (message !== undefined) setEditing({ id: messageId, text: firstRenderedText(message) })
  }, [])
  const regenerate = useCallback((): void => {
    for (let i = messagesRef.current.length - 1; i >= 0; i--) {
      const last = messagesRef.current[i]!
      if (last.role === "user") {
        onRetry?.(last.id, firstRenderedText(last))
        return
      }
    }
  }, [onRetry])

  return (
    <div className="chat" data-testid="chat-view">
      {/* Floating cards (team + goal) stack in one column at the chat
          area's top-right corner, outside the scrolling log. */}
      {(team !== undefined || goal !== undefined) && (
        <div className="chat-float-panels">
          {team !== undefined && (
            <TeamPanelCard
              panel={team.panel}
              target={team.target}
              onTalkTo={team.onTalkTo}
              onStopMember={team.onStopMember}
              onOpenAudit={onOpenAudit}
            />
          )}
          {goal !== undefined && (
            <GoalPanelCard
              view={goal.view}
              onPause={goal.onPause}
              onResume={goal.onResume}
              onStop={goal.onStop}
              onClear={goal.onClear}
              onEdit={goal.onEdit}
            />
          )}
        </div>
      )}
      {helpOpen && (
        <div className="slash-help" data-testid="slash-help">
          <div className="slash-help-head">
            <span>斜杠命令</span>
            <button type="button" data-testid="slash-help-close" aria-label="关闭命令列表" onClick={() => setHelpOpen(false)}>
              ×
            </button>
          </div>
          <ul>
            {SLASH_COMMANDS.filter((c) => c.surfaces.includes("web")).map((c) => (
              <li key={c.name}>
                <code>{c.usage}</code>
                <span>{c.description}</span>
              </li>
            ))}
            {(extraCommands ?? []).map((c) => (
              <li key={c.name}>
                <code>{c.usage}</code>
                <span>{c.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* 流容器包住消息流与"回到底部"：悬浮按钮锚在流的可视底部（.chat 的
          relative 锚的是整列，直接放会被 composer 区域挡住）。 */}
      <div className="chat-log-wrap">
        <div className="chat-log" data-testid="chat-log" ref={logRef} onScroll={onLogScroll}>
          {view.messages.map((message, idx) => (
            <Fragment key={message.id}>
              {auditBars.filter((b) => b.insertIdx === idx).map((b) => (
                <AuditContextNote key={b.key} bar={b} />
              ))}
              {editing !== null && editing.id === message.id ? (
                <div className="message message-user" data-testid="msg-editing">
                  <div className="msg-edit">
                    <textarea
                      className="msg-edit-input"
                      data-testid="msg-edit-input"
                      autoFocus
                      value={editing.text}
                      onChange={(event) => setEditing({ id: editing.id, text: event.target.value })}
                      onKeyDown={handleEditKeyDown}
                      rows={2}
                    />
                    <div className="msg-edit-actions">
                      <button type="button" className="primary" data-testid="msg-edit-confirm" onClick={confirmEdit}>重试</button>
                      <button type="button" data-testid="msg-edit-cancel" onClick={() => setEditing(null)}>取消</button>
                    </div>
                  </div>
                </div>
              ) : (
                <MessageBubble
                  message={message}
                  onOpenAudit={onOpenAudit}
                  onUiAction={onUiAction}
                  uiPicks={uiPicks}
                  canEdit={canRetry && idx === lastUserIdx}
                  canRegenerate={canRetry && idx === lastAssistantIdx && lastUserIdx !== -1}
                  canFork={canFork}
                  onEditStart={startEdit}
                  onRegenerate={regenerate}
                  onFork={onFork}
                />
              )}
            </Fragment>
          ))}
          {/* upto 是最后一条消息（收尾压缩后没有新消息）→ 折叠条挂在消息流末尾。 */}
          {auditBars.filter((b) => b.insertIdx >= view.messages.length).map((b) => (
            <AuditContextNote key={b.key} bar={b} />
          ))}
        </div>
        {!pinned && (
          <button type="button" className="chat-jump" data-testid="chat-jump-bottom" onClick={jumpToBottom}>
            回到底部 ↓
          </button>
        )}
      </div>
      {view.runState === "running" && (
        <div className="run-indicator" data-testid="run-indicator" aria-live="polite">
          running…
          <button type="button" className="run-stop" data-testid="run-stop" onClick={() => onStopRun?.()}>停止</button>
        </div>
      )}
      {view.compacting === true && (
        <div className="run-indicator compacting" data-testid="compacting-indicator" aria-live="polite">
          正在压缩早期对话…
          {/* 取消按钮只在自动压缩（in-run/post-run）渲染：manual 是用户自己发起的
              压缩，服务端 cancelCompaction 也不作用于它，渲染了点了也没用。 */}
          {view.compactingPhase !== "manual" && (
            <button
              type="button"
              className="compaction-cancel"
              data-testid="compaction-cancel"
              onClick={() => onCancelCompaction?.()}
            >取消</button>
          )}
        </div>
      )}
      {view.runState === "running" && view.retryHint !== undefined && view.retryHint !== null && (
        <div className="run-retry" data-testid="run-retry" aria-live="polite">
          重试中…
        </div>
      )}
      {view.hookFailure !== undefined && view.hookFailure !== null && (
        <div className="hook-failure" data-testid="hook-failure" aria-live="polite">
          hook {view.hookFailure.hook} 失败（{view.hookFailure.position}）：{view.hookFailure.error}
        </div>
      )}
      {view.pendingConfirmations.map((card) => (
        <ConfirmationCardView key={card.confirmationId} card={card} onResolve={onResolveConfirmation} />
      ))}
      {view.pendingQuestions.map((card) => (
        <QuestionCardView key={card.questionId} card={card} onAnswer={onAnswerQuestion} />
      ))}
      {!readOnly && ((models !== undefined && models.length > 0 && onSwitchModel !== undefined) || onSwitchMode !== undefined) && (
        <div className="composer-selectors" data-testid="composer-selectors">
          {models !== undefined && models.length > 0 && onSwitchModel !== undefined && (
            <div className="composer-row" data-testid="model-selector-row">
              <label>模型</label>
              <select
                className="model-select"
                data-testid="model-select"
                value={sessionModel ?? ""}
                onChange={(e) => onSwitchModel(e.target.value)}
              >
                <option value="">默认</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          )}
          {onSwitchMode !== undefined && (
            // Always-on permission mode selector (session-scoped, next run
            // effective): readonly denies writes/bash, default confirms
            // out-of-bounds actions, accept-edits skips confirmation for
            // in-workspace file writes.
            <div className="composer-row" data-testid="mode-selector-row">
              <label>权限</label>
              <select
                className="mode-select"
                data-testid="mode-select"
                value={mode ?? "default"}
                onChange={(e) => onSwitchMode(e.target.value as PermissionMode)}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
      {!readOnly && pendingAttachments.length > 0 && (
        <div className="attachment-chips" data-testid="attachment-chips">
          {pendingAttachments.map((a) => (
            <span key={a.id} className={`attachment-chip${a.path === undefined ? " uploading" : ""}`} data-testid="attachment-chip">
              {a.name}（{a.path === undefined ? "上传中…" : `${a.size} 字节`}）
              <button type="button" onClick={() => onRemoveAttachment(a.id)} aria-label={`移除 ${a.name}`}>×</button>
            </span>
          ))}
        </div>
      )}
      {/* 运行失败与帧错误的反馈条：贴着 composer（用户正在操作的位置）渲染，
          不再挂在消息流顶部——长会话里顶部错误等于不可见。清除节奏归所有方：
          下一次 run.started（与 view.error 的过期口径一致）或用户 × 掉 notice。 */}
      {view.error !== undefined && (
        <div className="chat-error" data-testid="chat-error" role="alert">
          {view.error}
        </div>
      )}
      {notice !== undefined && notice !== null && notice !== "" && (
        <div className="chat-notice" data-testid="chat-notice" role="status">
          {noticeAction !== undefined && noticeAction !== null ? (
            // 可点击通知（写入通知）：点击执行跳转并关掉通知条；其余通知为
            // 纯文本 + 关闭按钮（错误类通知不自动消失，用户看完了手动关）。
            <button type="button" data-testid="chat-notice-action" className="chat-notice-link" onClick={() => { noticeAction(); onDismissNotice?.() }}>
              {notice}
            </button>
          ) : (
            <span className="chat-notice-text">{notice}</span>
          )}
          <button
            type="button"
            className="chat-notice-close"
            data-testid="chat-notice-close"
            aria-label="关闭通知"
            onClick={() => onDismissNotice?.()}
          >×</button>
        </div>
      )}
      {queuedRows.length > 0 && (
        <div className="queue-list" data-testid="queue-list" role="status">
          <div className="queue-list-head">
            <span>{queuedRows.length} 条排队中</span>
            <button type="button" data-testid="queue-cancel-all" onClick={() => onCancelAllQueued?.()}>全部取消</button>
          </div>
          {queuedRows.map((e) => (
            <div className="queue-row" data-testid="queue-row" key={e.messageId}>
              <span className="queue-disp" data-testid="queue-disp">
                {e.disposition === "steer" ? "引导" : e.disposition === "wait" ? "等待" : "中断"}
              </span>
              <span className="queue-text" title={e.text}>{e.text}</span>
              {/* 可取消窗口：wait 随时、steer 注入前；interrupt 入队即
                  伴随 abort 紧接着出队执行，无可取消窗口——不渲染取消按钮。 */}
              {e.disposition !== "interrupt" && (
                <button
                  type="button"
                  className="queue-cancel"
                  data-testid="queue-cancel"
                  aria-label="取消这条排队消息"
                  onClick={() => onCancelQueued?.(e.messageId)}
                >取消</button>
              )}
            </div>
          ))}
        </div>
      )}
      {readOnly ? (
        // Child sessions are read-only (spec pin: treat the subagent as a
        // tool): no composer, one hint line pointing at the audit page; the
        // server-side submit rejects user-triggered posts as the backstop.
        // The child never appears in the sidebar — the button is the only
        // visible way back to the parent.
        <div className="chat-readonly-hint" data-testid="subagent-readonly-hint">
          subagent会话只读——它的过程与结题答复在审计页查看
          {onReturnToParent !== undefined && (
            <button type="button" className="return-parent" data-testid="return-to-parent" onClick={onReturnToParent}>
              ← 返回主会话
            </button>
          )}
        </div>
      ) : (
        <Composer
          onSend={onSend}
          onHelpRequest={openHelp}
          onEscape={() => setHelpOpen(false)}
          onDraftChange={onDraftChange}
          extraCommands={extraCommands}
          mentionFiles={mentionFiles}
          mentionTruncated={mentionTruncated}
          running={view.runState === "running"}
          disposition={disposition}
          onSetDisposition={onSetDisposition}
          teamTarget={team?.target ?? null}
          onClearTeamTarget={team === undefined ? undefined : () => team.onTalkTo(null)}
        />
      )}
      {usage}
    </div>
  )
}

/** Index of the last message matching pred; -1 when none. */
function findLastIdx(messages: RenderedMessage[], pred: (m: RenderedMessage) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (pred(messages[i]!)) return i
  }
  return -1
}
