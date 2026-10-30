/**
 * MessageBubble — one rendered chat message with its block tree (text /
 * thinking / note / tool_call / tool_result / attachment) and the hover
 * actions (edit, regenerate, fork). Wrapped in memo: the chat reducer
 * replaces only the touched message object on every frame, so unchanged
 * bubbles keep their reference and skip re-render entirely during a
 * streaming run. The contract that makes memo bite: every callback prop is
 * render-stable (the owner passes ids instead of per-message closures).
 */
import { memo } from "react"
import { MarkdownText } from "./Markdown.js"
import { parseTeamMail, type RenderedBlock, type RenderedMessage, type ToolPairing } from "./model.js"
import { isUiCard, UiCardView } from "./UiCard.js"
import type { UiCardAction } from "./UiCardForm.js"
import { TOOL_CARDS } from "./ToolCards.js"
import { IconButton } from "../ui/IconButton.js"
import { ForkIcon, PencilIcon, RefreshIcon } from "../ui/icons.js"

export interface MessageBubbleProps {
  message: RenderedMessage
  /** Open a subagent's audit view (the spawn row's link). */
  onOpenAudit?: (sessionId: string) => void
  /** UI 卡动作回传（按钮/表单，callId 标记来源卡）。 */
  onUiAction?: (callId: string, action: UiCardAction) => void
  /** callId → 已发生的卡动作（持久已选态反查）。 */
  uiPicks?: Map<string, UiCardAction>
  /** 跨消息工具配对索引（call 在 assistant 消息、result 在 tool 消息）。 */
  toolPairing?: ToolPairing
  /** While the session is idle, the last user bubble offers the edit entry. */
  canEdit?: boolean
  /** While the session is idle, the last assistant bubble offers regenerate. */
  canRegenerate?: boolean
  /** Session is idle and fork is wired: every bubble offers the fork entry. */
  canFork?: boolean
  /** Enter the in-place editor for this bubble (id, not a closure per bubble). */
  onEditStart?: (messageId: string) => void
  /** Rerun the last user message as-is (the same stable callback on every bubble). */
  onRegenerate?: () => void
  /** Fork the conversation from this message. */
  onFork?: (messageId: string) => void
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onOpenAudit,
  onUiAction,
  uiPicks,
  toolPairing,
  canEdit,
  canRegenerate,
  canFork,
  onEditStart,
  onRegenerate,
  onFork,
}: MessageBubbleProps) {
  const streaming = message.pending && message.blocks.length === 0
  // 组员来信（团队收信箱投递的用户消息）不渲染成用户气泡：改为 agent 一侧的
  // 折叠条，点开看原文——模型收到什么不变，只是聊天页的画法。
  const mail = message.role === "user" ? parseTeamMail(firstRenderedText(message)) : null
  return (
    <div
      className={`message message-${message.role}${mail !== null ? " message-mail" : ""}`}
      data-testid={`msg-${message.role}`}
    >
      {streaming && <div className="msg-pending" data-testid="msg-pending">…</div>}
      {/* Only the assistant's side renders Markdown: the user's raw words stay
          literal (a stray * or # in a typed message must not turn into markup). */}
      {mail !== null ? (
        <TeamMailView mail={mail} />
      ) : (
        message.blocks.map((block) => (
          <BlockView
            key={block.blockId}
            block={block}
            markdown={message.role === "assistant"}
            onOpenAudit={onOpenAudit}
            onUiAction={onUiAction}
            uiPicks={uiPicks}
            toolPairing={toolPairing}
          />
        ))
      )}
      {message.aborted === true && (
        <span className="msg-aborted" data-testid="msg-aborted">已中断</span>
      )}
      {message.role === "user" && message.uiAction !== undefined && (
        <span className="msg-ui-action" data-testid="msg-ui-action">来自 UI 卡</span>
      )}
      {(canEdit === true || canRegenerate === true || onFork !== undefined) && (
        <span className="msg-actions">
          {canEdit === true && (
            <IconButton
              label="编辑"
              icon={<PencilIcon />}
              testid="msg-edit"
              onClick={() => onEditStart?.(message.id)}
            />
          )}
          {canRegenerate === true && (
            <IconButton
              label="重新生成"
              icon={<RefreshIcon />}
              testid="msg-regenerate"
              onClick={() => onRegenerate?.()}
            />
          )}
          {onFork !== undefined && (
            <IconButton
              label={canFork ? "从此处 fork" : "运行结束后可 fork"}
              icon={<ForkIcon />}
              testid="msg-fork"
              disabled={!canFork}
              onClick={() => onFork(message.id)}
            />
          )}
        </span>
      )}
    </div>
  )
})

/** First text render's text of a rendered message ("" when absent). */
export function firstRenderedText(m: RenderedMessage): string {
  const first = m.blocks.find((b) => b.kind === "text")
  return first !== undefined && first.kind === "text" ? first.text : ""
}

/** 组员来信折叠条：agent 一侧的窄条，摘要是发件人列表，展开看原文。 */
function TeamMailView({ mail }: { mail: ReturnType<typeof parseTeamMail> }) {
  if (mail === null) return <></>
  const senders = [...new Set(mail.entries.map((e) => e.from))].join("、")
  return (
    <details className="msg-team-mail" data-testid="msg-team-mail">
      <summary>
        📥 {mail.entries.length === 1 ? `收到来自 ${senders} 的来信` : `收到 ${mail.entries.length} 条来信（${senders}）`}
      </summary>
      {mail.entries.map((e, i) => (
        <div key={i} className="mail-entry">
          <div className="mail-from">【来自 {e.from}】</div>
          <pre className="mail-text">{e.text}</pre>
        </div>
      ))}
    </details>
  )
}

/** Single-line preview: collapse whitespace, cap at 80 chars (full args open on click). */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed
}

function BlockView({ block, markdown, onOpenAudit, onUiAction, uiPicks, toolPairing }: { block: RenderedBlock; markdown: boolean; onOpenAudit?: (sessionId: string) => void; onUiAction?: (callId: string, action: UiCardAction) => void; uiPicks?: Map<string, UiCardAction>; toolPairing?: ToolPairing }) {
  switch (block.kind) {
    case "text":
      return markdown ? (
        <div className="blk-text md" data-testid="blk-text">
          <MarkdownText text={block.text} />
        </div>
      ) : (
        <p className="blk-text" data-testid="blk-text">{block.text}</p>
      )
    case "thinking":
      return (
        <details className="blk-thinking" data-testid="blk-thinking">
          <summary>Thinking</summary>
          <pre>{block.text === "" ? "…" : block.text}</pre>
        </details>
      )
    case "note":
      return <span className="blk-note" data-testid="blk-note">[note] {block.text}</span>
    case "tool_call": {
      // Registry card first (bash status, fs diff/write — renders from the
      // call side with its cross-message paired result); a renderer that
      // can't build from these args returns undefined → the plain row stays.
      const card = TOOL_CARDS[block.name]?.call
      if (card !== undefined) {
        const built = card({ call: block, result: toolPairing?.resultOf.get(block.callId) ?? null, onOpenAudit })
        if (built !== undefined) return built
      }
      // Collapsed by default: the summary line is the tool name plus a
      // one-line args preview; the full argsJson opens on click (clamped —
      // a whole-file write must not swallow the chat pane).
      return (
        <details className="blk-tool-call" data-testid="blk-tool-call">
          <summary>
            ⚡ {block.name} <code>{oneLine(block.argsJson)}</code>
          </summary>
          <code className="blk-tool-call-args">{block.argsJson}</code>
        </details>
      )
    }
    case "tool_result": {
      // Result blocks carry no tool name — resolve it from the paired call
      // side (another message). A call-side registry card already shows this
      // result → no double row; a result-side card (todo/cron/subagent —
      // the call args add nothing) renders instead of the plain row.
      const name = toolPairing?.nameOf.get(block.callId)
      if (name !== undefined && TOOL_CARDS[name]?.call !== undefined) return null
      const resultCard = name !== undefined ? TOOL_CARDS[name]?.result : undefined
      if (resultCard !== undefined) {
        const built = resultCard({ result: block, onOpenAudit })
        if (built !== undefined && built !== null) return built
      }
      // A UI Card rides `data`: render the interactive component instead of
      // the plain collapse row. Anything unparsable keeps the fallback view.
      if (block.status === "ok" && isUiCard(block.data)) {
        return (
          <div className="blk-ui-card" data-testid="blk-ui-card">
            <UiCardView
              card={block.data}
              onAction={onUiAction !== undefined ? (action) => onUiAction(block.callId, action) : undefined}
              picked={uiPicks?.get(block.callId) ?? null}
            />
          </div>
        )
      }
      return (
        <details className="blk-tool-result" data-testid="blk-tool-result">
          <summary>
            {block.status === "ok" ? "↳ ok" : "↳ error"} · {Math.round(block.durationMs)}ms ·{" "}
            {oneLine(block.output)}
          </summary>
          <pre>{block.output}</pre>
        </details>
      )
    }
    case "attachment":
      return <span className="blk-attachment" data-testid="blk-attachment">[attachment: {block.mimeType}]</span>
  }
}

/** Whitespace-collapsed, first-80-chars summary for a tool result card. */

