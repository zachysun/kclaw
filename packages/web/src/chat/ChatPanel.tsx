/**
 * ChatPanel — the chat assembly: owns the ws subscription + event loop, feeds
 * every frame through the model reducer, and renders the ChatView. Reconnect
 * follows the shared reconnect protocol (拉全量消息 + 只订阅新事件，不回放): on an unexpected
 * close the panel builds a fresh client via `createWs`, re-pulls the full
 * message list (merged into the live view, see model.mergeMessages) plus the
 * send-queue snapshot (merged via model.mergeQueue — 重建排队气泡), and
 * re-subscribes — the merged state then streams only NEW events.
 *
 * Auth: a close with the daemon's auth-failure code (4001) or an API 401 shows
 * a notice and stops (the App drops back to the token form on API 401; the ws
 * path has no token-refresh flow, so it asks for a reload).
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { parseSlashInput, skillCommandMeta } from "@kclaw/core/commands"
import { isPermissionMode, type PermissionMode } from "@kclaw/core/permission-modes"
import type { ConfirmationDecision } from "@kclaw/core/protocol"
import { ApiError, type ApiClient } from "../api.js"
import { WsAuthError, type WsClient } from "../ws.js"
import {
  adoptQueuedId,
  applyEvent,
  appendOptimisticUser,
  appendPendingQueueRow,
  collectPendingSends,
  dropLocalPending,
  initChat,
  mergeMessages,
  mergeQueue,
  undeliveredPendingSends,
  type AgentEvent,
  type ChatState,
  type MemoryWrittenInfo,
  type Message,
  type PendingSend,
} from "./model.js"
import { useSilentFetch } from "../daemon-clients.js"
import { runWebCommand } from "./commands.js"
import { ChatView, type CompactionRecordView, type Disposition, type PendingAttachment } from "./ChatView.js"

export interface ChatPanelProps {
  sessionId: string
  api: ApiClient
  /** The authenticated ws client for the session (created by the App). */
  ws: WsClient
  /** Rebuild a fresh authenticated client after an unexpected close (reconnect). */
  createWs: () => WsClient
  /** Full message list for the session (the App fetches it on session select). */
  initialMessages: Message[]
  /** Session meta model override (undefined → daemon default). */
  sessionModel?: string
  /**
   * The daemon renamed this session (autoname); escapes to the owner so the
   * sidebar list shows the new title without a reload. Reference must be
   * stable across renders (it keys the ws effect like ws/createWs).
   */
  onSessionRenamed?: (sessionId: string, title: string) => void
  /** Create a session (title optional) and switch to it — the /new and /clear commands. */
  onCreateSession: (title?: string) => Promise<void>
  /** Reveal the session list — the /sessions command (the drawer on mobile). */
  onOpenSessions: () => void
  /** 当前会话的工作目录（/memory save 手动写入的目标项目；缺省由 daemon 回退 config.workspace）。 */
  workdir?: string
  /** memory.written 通知条点击 → 跳转记忆页对应文件；不传则通知条保持纯文本。 */
  onOpenMemoryWritten?: (info: MemoryWrittenInfo) => void
  /** Open a subagent's audit view (the spawn row's link). */
  onOpenAudit?: (sessionId: string) => void
}

/** Max consecutive failed reconnects before giving up with a notice. */
const MAX_RECONNECT_ATTEMPTS = 3

/** A ws frame carrying an agent event (payload present) vs. command acks / error frames. */
function isAgentEvent(frame: unknown): frame is AgentEvent {
  return (
    typeof frame === "object" && frame !== null &&
    typeof (frame as { type?: unknown }).type === "string" &&
    "payload" in frame
  )
}

/** The daemon's queued-send ack (send_message with queued:true). */
function isQueuedSendAck(frame: unknown): frame is { type: "send_message_ack"; messageId: unknown; queued: unknown } {
  return (
    typeof frame === "object" && frame !== null &&
    (frame as { type?: unknown }).type === "send_message_ack"
  )
}

function errorFrameMessage(frame: unknown): string | null {
  const message = (frame as { message?: unknown }).message
  return typeof message === "string" ? message : null
}

export function ChatPanel({ sessionId, api, ws, createWs, initialMessages, sessionModel, onSessionRenamed, onCreateSession, onOpenSessions, workdir, onOpenMemoryWritten, onOpenAudit }: ChatPanelProps) {
  const [view, setViewState] = useState<ChatState>(() => initChat(initialMessages))
  const [notice, setNotice] = useState<string | null>(null)
  // 已装用户可见技能：出现在斜杠菜单的动态命令（/技能名），会话切换重拉
  // （项目级技能跟会话工作目录）。拉取失败静默——菜单少几条不碍聊天。
  const [skillRows, setSkillRows] = useState<Array<{ name: string; description: string; origin: string; visibility: string }>>([])
  // 通知条的可点击动作（memory.written 跳转）：与 notice 同生命周期，输入即清。
  const [noticeAction, setNoticeAction] = useState<(() => void) | null>(null)
  // 发送处置：三选的当前选择，显式带在每条 send_message 上。
  const [disposition, setDisposition] = useState<Disposition>("steer")
  // 一次性 interrupt 的复位基准：点「中断」
  // 不写会话级覆盖，这条发完切回该档——中断是瞬时意图，不做成模式（与 CLI
  // /interrupt 对齐，避免跨客户端"来一条、断一条"）。
  const baseDispositionRef = useRef<Disposition>("steer")
  const clientRef = useRef<WsClient>(ws)
  clientRef.current = ws
  // The authoritative view for event-loop transforms. updateView computes the
  // next state SYNCHRONOUSLY (so a throwing reducer surfaces to the caller's
  // try/catch instead of dying during React's render) and keeps this ref in
  // sync, avoiding stale-state reads when frames arrive in bursts.
  const viewRef = useRef<ChatState>(view)

  const updateView = useCallback((fn: (v: ChatState) => ChatState): void => {
    const next = fn(viewRef.current)
    viewRef.current = next
    setViewState(next)
  }, [])

  // Re-init when the session changes; a REFRESHED message base for the SAME
  // session (App re-pulls on every selection) merges into the live view instead
  // of resetting it — the live stream may already be ahead of the fetch, and
  // reset would drop those bubbles.
  const sessionRef = useRef(sessionId)
  useEffect(() => {
    if (sessionRef.current === sessionId) {
      updateView((v) => ({ ...v, messages: mergeMessages(v.messages, initialMessages) }))
    } else {
      sessionRef.current = sessionId
      updateView(() => initChat(initialMessages))
    }
  }, [sessionId, initialMessages, updateView])

  useEffect(() => {
    let cancelled = false
    let client = ws

    const subscribe = (c: WsClient): void => {
      try {
        // Safe on a CONNECTING socket: createWsClient buffers until open.
        c.send({ type: "subscribe", sessionId })
      } catch {
        // Last-resort guard (a closed socket drops silently instead).
      }
    }

    const refreshMessages = async (): Promise<{ ok: boolean; resent: number }> => {
      // 断线期间未确认的发送先抓快照（issue #8 补发）：mergeQueue 会按服务端
      // 快照整体重建队列行——未送达消息的 local- 行不留痕迹，素材必须在重建
      // 之前抓。
      let pendingBefore: PendingSend[] = []
      updateView((v) => {
        pendingBefore = collectPendingSends(v)
        return v
      })
      // 全量消息 + 队列快照并行拉取（重连纠偏），两个方向彼此独立：
      // 队列拉取失败不阻塞消息合并（事件流会继续纠偏）；消息拉取失败照样合并
      // 队列——排队气泡的重建不依赖消息基线。
      const [messagesResult, queueResult] = await Promise.allSettled([
        api.get<Message[]>(`/sessions/${encodeURIComponent(sessionId)}/messages`),
        api.get<Array<{ messageId: string; disposition: string; text: string }>>(
          `/sessions/${encodeURIComponent(sessionId)}/queue`,
        ),
      ])
      if (cancelled) return { ok: false, resent: 0 }
      let ok = false
      if (messagesResult.status === "fulfilled") {
        updateView((v) => ({ ...v, messages: mergeMessages(v.messages, messagesResult.value) }))
        ok = true
      } else {
        setNotice(authNotice(messagesResult.reason, "无法同步消息"))
      }
      if (queueResult.status === "fulfilled") {
        updateView((v) => mergeQueue(v, queueResult.value))
      }
      if (!ok) return { ok: false, resent: 0 }
      // 对齐之后仍无踪迹的快照项 = 从未到达 daemon（CLI 重发规则的同一窗口）：
      // 清掉残留的乐观行，按原处置逐条补发——补发走新 client 的发送缓冲，
      // 鉴权帧仍然最先。已对上的消息绝不重发（防服务端双跑）。
      const undelivered = undeliveredPendingSends(pendingBefore, viewRef.current)
      if (undelivered.length > 0) {
        updateView((v) => dropLocalPending(v, undelivered.map((s) => s.text)))
        for (const s of undelivered) sendMessageRaw(s.text, s.disposition, [])
      }
      return { ok: true, resent: undelivered.length }
    }

    // 跨客户端行补文本：message.queued 载荷不带文本——别的客户端（CLI、另一
    // 浏览器）排队的消息在本端落地为空文本行，拉一次队列快照把 text 补上。
    // in-flight 防抖；失败静默（下次纠偏路径再补）。
    let resyncingQueue = false
    const refreshQueueText = async (): Promise<void> => {
      if (resyncingQueue) return
      resyncingQueue = true
      try {
        const entries = await api.get<Array<{ messageId: string; disposition: string; text: string }>>(
          `/sessions/${encodeURIComponent(sessionId)}/queue`,
        )
        if (!cancelled) updateView((v) => mergeQueue(v, entries))
      } catch {
        // 事件流与下次重连纠偏兜底
      } finally {
        resyncingQueue = false
      }
    }

    /** Consume frames until the socket closes; resolves with why it ended. */
    const eventLoop = async (c: WsClient): Promise<"closed" | "auth" | "error"> => {
      try {
        for await (const frame of c.frames) {
          if (cancelled) return "closed"
          try {
            if (isAgentEvent(frame)) {
              // session.renamed is list-level metadata, not chat content: it
              // bypasses the reducer and escapes to the owner directly.
              if (frame.type === "session.renamed") {
                const title = frame.payload.title
                if (typeof title === "string") onSessionRenamed?.(sessionId, title)
              }
              // memory.written 是跨视图的落盘反馈（写入通知）：不进
              // reducer，走 ChatView 的一次性 notice（输入即清，见 onDraftChange）；
              // 通知条可点击跳转记忆页对应文件，点击动作由 owner 提供。
              if (frame.type === "memory.written") {
                const info = frame.payload
                if (typeof info.path === "string") {
                  setNotice(`已写入记忆: ${info.path}`)
                  // 注意：setState 把函数当 updater 执行，这里必须返回函数而非直接
                  // 传 `() => onOpenMemoryWritten(info)`（那样 state 会被算成返回值 undefined）。
                  setNoticeAction(onOpenMemoryWritten === undefined ? null : () => () => onOpenMemoryWritten(info))
                }
              }
              updateView((v) => applyEvent(v, frame))
              // 空文本行 = 跨客户端排队的消息（本端无发送上下文）→ 拉快照补文本
              if (viewRef.current.queue.some((e) => e.text === "")) void refreshQueueText()
            } else if (isQueuedSendAck(frame) && frame.queued === true) {
              const messageId = frame.messageId
              if (typeof messageId === "string") updateView((v) => adoptQueuedId(v, messageId))
            } else {
              const message = errorFrameMessage(frame)
              if (message !== null) {
                updateView((v) => ({ ...v, error: message }))
              }
            }
          } catch (err) {
            // A single malformed frame must not kill the loop (that would look
            // like a socket failure and trigger reconnect churn): log it and
            // keep streaming.
            console.error("kclaw chat: failed to apply frame", frame, err)
          }
        }
        return "closed"
      } catch (err) {
        return err instanceof WsAuthError ? "auth" : "error"
      }
    }

    const run = async (): Promise<void> => {
      // Consecutive failed reconnects are bounded so a dead daemon cannot spin
      // the client factory forever; a successful reconnect resets the budget.
      let attempts = 0
      while (!cancelled) {
        subscribe(client)
        const outcome = await eventLoop(client)
        if (cancelled) return
        if (outcome === "auth") {
          setNotice("认证已失效，请刷新页面重新输入 token")
          return
        }
        // Unexpected close / iterator failure → reconnect (bounded).
        attempts += 1
        if (attempts > MAX_RECONNECT_ATTEMPTS) {
          setNotice("重连失败，请刷新页面")
          return
        }
        setNotice(outcome === "error" ? "连接异常，正在重连…" : "连接已断开，正在重连…")
        let res = { ok: false, resent: 0 }
        try {
          const next = createWs()
          client = next
          clientRef.current = next
          subscribe(next)
          res = await refreshMessages()
        } catch (err) {
          if (cancelled) return
          setNotice(authNotice(err, "重连失败"))
        }
        if (cancelled) return
        // A failed refresh already surfaced its own notice — only a successful
        // reconnect clears it.
        if (!res.ok) continue
        attempts = 0
        setNotice(res.resent > 0 ? `已重连，补发 ${res.resent} 条断线期间未送达的消息` : "已重连")
      }
    }

    void run()

    return () => {
      cancelled = true
      client.close()
    }
  }, [sessionId, api, ws, createWs, onSessionRenamed])

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [models, setModels] = useState<string[]>([])
  const [currentModel, setCurrentModel] = useState<string | undefined>(sessionModel)

  useSilentFetch(
    () => api.get<{ providers?: { entries?: Record<string, unknown> } }>("/config"),
    (cfg) => setModels(Object.keys(cfg.providers?.entries ?? {})),
    [api],
  )

  const handleSwitchModel = useCallback((name: string) => {
    api
      .post(`/sessions/${encodeURIComponent(sessionId)}/model`, { model: name })
      .then(() => setCurrentModel(name === "" ? undefined : name))
      .catch((err: unknown) => setNotice(`模型切换失败: ${err instanceof Error ? err.message : String(err)}`))
  }, [api, sessionId])

  // Initial send disposition (same source as CLI chat): the session meta's
  // dispositionOverride wins, then the config default, then steer. An
  // unreachable daemon (old versions lack this route/field) silently keeps
  // steer. The same response also syncs the session's permission mode
  // (missing mode field → default).
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default")
  // Child sessions (meta.parentSessionId set) are read-only: the composer is
  // replaced by a hint. Reset on session switch so a failed meta pull never
  // carries the previous session's verdict over.
  const [childSession, setChildSession] = useState(false)
  useEffect(() => setChildSession(false), [sessionId])
  useSilentFetch(
    () =>
      Promise.all([
        api.get<{ dispositionOverride?: unknown; mode?: unknown; parentSessionId?: unknown }>(`/sessions/${encodeURIComponent(sessionId)}`),
        api.get<{ sessions?: { defaultDisposition?: unknown } }>("/config"),
      ]),
    ([meta, cfg]) => {
      setChildSession(typeof meta.parentSessionId === "string" && meta.parentSessionId !== "")
      // 会话级覆盖只可能是 steer/wait（interrupt 已不再写 sticky，见
      // handleSetDisposition；历史遗留的 "interrupt" 覆盖按 steer 回退）。
      const override = meta.dispositionOverride
      if (override === "steer" || override === "wait") {
        baseDispositionRef.current = override
        setDisposition(override)
      } else {
        const fallback = cfg.sessions?.defaultDisposition
        const base = fallback === "wait" ? "wait" : "steer"
        baseDispositionRef.current = base
        setDisposition(base)
      }
      setPermissionMode(isPermissionMode(meta.mode) ? meta.mode : "default")
    },
    [api, sessionId],
  )

  /** Always-on mode selector: applies locally now (next run picks it up), POST failure rolls back. */
  const handleSwitchMode = useCallback(
    (m: PermissionMode) => {
      const previous = permissionMode
      setPermissionMode(m)
      api
        .post(`/sessions/${encodeURIComponent(sessionId)}/mode`, { mode: m })
        .catch((err: unknown) => {
          setPermissionMode(previous)
          setNotice(`权限模式切换失败: ${err instanceof Error ? err.message : String(err)}`)
        })
    },
    [api, sessionId, permissionMode],
  )

  // 压缩审计：会话选中时与消息并行拉一次 GET
  // /sessions/:id/compactions（参考 AuditView 的 api 用法）。失败静默——
  // 折叠条只是增强显示，compactions 保持 null 就不渲染审计条。
  const [compactions, setCompactions] = useState<CompactionRecordView[] | null>(null)
  useSilentFetch(
    () => {
      setCompactions(null)
      return api.get<unknown>(`/sessions/${encodeURIComponent(sessionId)}/compactions`)
    },
    (raw) => setCompactions(Array.isArray(raw) ? raw.flatMap(toCompactionRecordView) : []),
    [api, sessionId],
  )

  // 已装用户可见技能清单：斜杠菜单的动态命令数据源（会话切换重拉，失败静默）。
  useSilentFetch(
    () => {
      const q = workdir ? `?workdir=${encodeURIComponent(workdir)}` : ""
      return api.get<Array<{ name: string; description: string; origin: string; visibility: string }>>(`/skills${q}`)
    },
    (rows) => {
      if (Array.isArray(rows)) setSkillRows(rows)
    },
    [api, workdir],
  )

  /**
   * The raw send path shared by handleSend and the post-reconnect resend
   * (issue #8): one send_message frame plus the optimistic echo (queued row
   * when busy, pending bubble when idle) — and nothing else: no slash
   * parsing, no attachment/disposition state changes.
   */
  const sendMessageRaw = useCallback((text: string, sendDisposition: Disposition, attachments: PendingAttachment[]) => {
    clientRef.current.send({
      type: "send_message",
      sessionId,
      text,
      disposition: sendDisposition,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    updateView((v) =>
      v.runState === "running" || v.compacting === true
        ? appendPendingQueueRow(v, text, sendDisposition)
        : appendOptimisticUser(v, text))
  }, [sessionId, updateView])

  const handleSend = useCallback((text: string) => {
    // Slash commands intercept before the ws send path (the same point where
    // the CLI chat loop intercepts) — they never reach the model. 动态技能
    // 命令（/技能名）除外：原样进入发送路径——daemon 检测到点名后做隐式
    // 包装（Master 2026-09-03），气泡与轨迹保持用户输入的原文。
    const parsed = parseSlashInput(text)
    const skillNames = new Set(skillRows.map((r) => r.name))
    if (parsed !== null && !skillNames.has(parsed.command)) {
      void runWebCommand(parsed, {
        api,
        sessionId,
        workdir: workdir ?? "",
        notify: setNotice,
        createSession: onCreateSession,
        openSessions: onOpenSessions,
        switchModel: handleSwitchModel,
        setMode: (m) => setPermissionMode(m),
        models,
        currentModel,
      })
      return
    }
    try {
      const attachments = [...pendingAttachments]
      sendMessageRaw(text, disposition, attachments)
      setPendingAttachments([])
      // 一次性 interrupt：这条带 interrupt
      // 发出后即切回基础处置，三选不停在「中断」档——否则 sticky 到所有客户端，
      // 后续任何普通消息都会先掐 run（"来一条、断一条"）。
      if (disposition === "interrupt") {
        setDisposition(baseDispositionRef.current)
      }
    } catch {
      setNotice("连接不可用，请稍后重试")
    }
  }, [sessionId, pendingAttachments, api, onCreateSession, onOpenSessions, handleSwitchModel, models, currentModel, updateView, disposition, skillRows, sendMessageRaw])

  /** Upload dropped files and queue them for the next message. */
  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    if (event.dataTransfer === null) return
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    for (const file of files) {
      api.upload(sessionId, file)
        .then((f) => setPendingAttachments((prev) => [...prev, { path: f.path, name: f.name, size: f.size, mimeType: file.type || "application/octet-stream" }]))
        .catch((err: unknown) => setNotice(`附件上传失败: ${err instanceof Error ? err.message : String(err)}`))
    }
  }, [api, sessionId])

  const handleRemoveAttachment = useCallback((index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleResolveConfirmation = useCallback((confirmationId: string, decision: ConfirmationDecision) => {
    try {
      // client:"web" names this client so the daemon records web provenance on
      // the resolution and in the audit trail (the CLI omits it → "cli").
      // decision "project"/"global" also persists a narrowed allow rule.
      clientRef.current.send({ type: "confirmation.resolve", confirmationId, decision, client: "web" })
    } catch {
      setNotice("连接不可用，请稍后重试")
    }
  }, [])

  const handleAnswerQuestion = useCallback((questionId: string, answers: string[][]) => {
    try {
      clientRef.current.send({ type: "question.resolve", questionId, answers, client: "web" })
    } catch {
      setNotice("连接不可用，请稍后重试")
    }
  }, [])

  /** Cancel queued messages: one id, or all still-queued when omitted. */
  const handleCancelQueued = useCallback((messageId?: string) => {
    try {
      clientRef.current.send({
        type: "queue.cancel",
        sessionId,
        // 不带 messageId = 清空全部可取消条目——帧上不能出现该键。
        ...(messageId !== undefined ? { messageId } : {}),
      })
    } catch {
      setNotice("连接不可用，请稍后重试")
    }
  }, [sessionId])

  /** 取消在飞的自动压缩（v3 compaction.cancel 帧）：服务端中止摘要器并以 result:"cancelled" 的 completed 收尾。 */
  const handleCancelCompaction = useCallback(() => {
    try {
      clientRef.current.send({ type: "compaction.cancel", sessionId })
    } catch {
      setNotice("连接不可用，请稍后重试")
    }
  }, [sessionId])

  /** 三选切换：steer/wait 本地立即生效并写会话级覆盖（与 CLI /steer
   *  同一存储）；interrupt 是一次性——本地选中仅用于这一次发送、不写覆盖，
   *  发出后由 handleSend 切回基础处置。 */
  const handleSetDisposition = useCallback((d: Disposition) => {
    if (d === "interrupt") {
      setDisposition("interrupt")
      return
    }
    baseDispositionRef.current = d
    setDisposition(d)
    api
      .post(`/sessions/${encodeURIComponent(sessionId)}/disposition`, { disposition: d })
      .catch((err: unknown) => setNotice(`处置切换失败: ${err instanceof Error ? err.message : String(err)}`))
  }, [api, sessionId])

  const clearNotice = useCallback((): void => {
    setNotice(null)
    setNoticeAction(null)
  }, [])

  return (
    <div className="chat-panel">
      <div className="chat-panel-inner" data-testid="chat-panel" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
        <ChatView
          view={view}
          onSend={handleSend}
          onResolveConfirmation={handleResolveConfirmation}
          onAnswerQuestion={handleAnswerQuestion}
          pendingAttachments={pendingAttachments}
          onRemoveAttachment={handleRemoveAttachment}
          models={models}
          sessionModel={currentModel}
          onSwitchModel={handleSwitchModel}
          mode={permissionMode}
          onSwitchMode={handleSwitchMode}
          notice={notice}
          noticeAction={noticeAction}
          onDraftChange={clearNotice}
          disposition={disposition}
          onSetDisposition={handleSetDisposition}
          onCancelQueued={handleCancelQueued}
          onCancelAllQueued={() => handleCancelQueued()}
          onOpenAudit={onOpenAudit}
          readOnly={childSession}
          onCancelCompaction={handleCancelCompaction}
          compactions={compactions}
          extraCommands={skillRows.map((r) => skillCommandMeta(r.name, r.description, "web"))}
        />
      </div>
    </div>
  )
}

/** 401 / ws-auth → auth message; otherwise the fallback. */
function authNotice(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 401) return "认证已失效，请刷新页面重新输入 token"
  if (err instanceof WsAuthError) return "认证已失效，请刷新页面重新输入 token"
  return fallback
}

/**
 * 挑出一条审计记录的 UI 字段（CompactionRecordView 轻量镜像）。非对象或
 * 字段不全的行直接丢弃（返回空数组供 flatMap）。
 */
function toCompactionRecordView(entry: unknown): CompactionRecordView[] {
  if (typeof entry !== "object" || entry === null) return []
  const { upto, segmentSummary, trigger, emergency } = entry as Record<string, unknown>
  if (typeof upto !== "string" || typeof segmentSummary !== "string" || typeof trigger !== "string") return []
  return [{ upto, segmentSummary, trigger, ...(emergency === true ? { emergency: true } : {}) }]
}
