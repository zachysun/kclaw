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
import { parseSlashInput } from "@kclaw/core/commands"
import { ApiError, type ApiClient } from "../api.js"
import { WsAuthError, type WsClient } from "../ws.js"
import {
  adoptQueuedId,
  applyEvent,
  appendOptimisticUser,
  initChat,
  mergeMessages,
  mergeQueue,
  type AgentEvent,
  type ChatState,
  type Message,
} from "./model.js"
import { runWebCommand } from "./commands.js"
import { ChatView, type Disposition, type PendingAttachment } from "./ChatView.js"

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

function errorFrameMessage(frame: unknown): string | null {
  const message = (frame as { message?: unknown }).message
  return typeof message === "string" ? message : null
}

export function ChatPanel({ sessionId, api, ws, createWs, initialMessages, sessionModel, onSessionRenamed, onCreateSession, onOpenSessions }: ChatPanelProps) {
  const [view, setViewState] = useState<ChatState>(() => initChat(initialMessages))
  const [notice, setNotice] = useState<string | null>(null)
  // 发送处置（spec §6）：三选的当前选择，显式带在每条 send_message 上。
  const [disposition, setDisposition] = useState<Disposition>("steer")
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

    const refreshMessages = async (): Promise<boolean> => {
      // 全量消息 + 队列快照并行拉取（spec §7.1 重连纠偏），两个方向彼此独立：
      // 队列拉取失败不阻塞消息合并（事件流会继续纠偏）；消息拉取失败照样合并
      // 队列——排队气泡的重建不依赖消息基线。
      const [messagesResult, queueResult] = await Promise.allSettled([
        api.get<Message[]>(`/sessions/${encodeURIComponent(sessionId)}/messages`),
        api.get<Array<{ messageId: string; disposition: string; text: string }>>(
          `/sessions/${encodeURIComponent(sessionId)}/queue`,
        ),
      ])
      if (cancelled) return false
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
      return ok
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
                const title = (frame.payload as { title?: unknown }).title
                if (typeof title === "string") onSessionRenamed?.(sessionId, title)
              }
              updateView((v) => applyEvent(v, frame))
            } else if ((frame as { type?: string }).type === "send_message_ack"
              && (frame as { queued?: unknown }).queued === true) {
              const messageId = (frame as { messageId?: unknown }).messageId
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
        let ok = false
        try {
          const next = createWs()
          client = next
          clientRef.current = next
          subscribe(next)
          ok = await refreshMessages()
        } catch (err) {
          if (cancelled) return
          setNotice(authNotice(err, "重连失败"))
          ok = false
        }
        if (cancelled) return
        // A failed refresh already surfaced its own notice — only a successful
        // reconnect clears it.
        if (!ok) continue
        attempts = 0
        setNotice("已重连")
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

  useEffect(() => {
    let cancelled = false
    api
      .get<{ providers?: { entries?: Record<string, unknown> } }>("/config")
      .then((cfg) => {
        if (!cancelled) setModels(Object.keys(cfg.providers?.entries ?? {}))
      })
      .catch(() => {
        // selector just stays empty on failure
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const handleSwitchModel = useCallback((name: string) => {
    api
      .post(`/sessions/${encodeURIComponent(sessionId)}/model`, { model: name })
      .then(() => setCurrentModel(name === "" ? undefined : name))
      .catch((err: unknown) => setNotice(`模型切换失败: ${err instanceof Error ? err.message : String(err)}`))
  }, [api, sessionId])

  // 初始发送处置（spec §6，与 CLI chat 同源）：会话 meta 的 dispositionOverride
  // 优先，其次配置默认，最后 steer。刚连上的 daemon 不可达（旧版本无该路由/字段）
  // 时静默维持 steer。
  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.get<{ dispositionOverride?: unknown }>(`/sessions/${encodeURIComponent(sessionId)}`),
      api.get<{ sessions?: { defaultDisposition?: unknown } }>("/config"),
    ])
      .then(([meta, cfg]) => {
        if (cancelled) return
        const override = meta.dispositionOverride
        if (override === "steer" || override === "wait" || override === "interrupt") {
          setDisposition(override)
          return
        }
        const fallback = cfg.sessions?.defaultDisposition
        setDisposition(fallback === "wait" || fallback === "interrupt" ? fallback : "steer")
      })
      .catch(() => {
        // 已是 steer —— 失败容忍（spec §7.1 默认选中回退）。
      })
    return () => {
      cancelled = true
    }
  }, [api, sessionId])

  const handleSend = useCallback((text: string) => {
    // Slash commands intercept before the ws send path (the same point where
    // the CLI chat loop intercepts) — they never reach the model.
    const parsed = parseSlashInput(text)
    if (parsed !== null) {
      void runWebCommand(parsed, {
        api,
        sessionId,
        notify: setNotice,
        createSession: onCreateSession,
        openSessions: onOpenSessions,
        switchModel: handleSwitchModel,
        models,
        currentModel,
      })
      return
    }
    try {
      const attachments = [...pendingAttachments]
      clientRef.current.send({
        type: "send_message",
        sessionId,
        text,
        disposition,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      setPendingAttachments([])
      // Optimistic echo: the bubble is visible the instant the message leaves
      // the composer — the server echo can lag seconds behind a pre-run
      // compaction. message.created later replaces the local twin by text.
      updateView((v) => appendOptimisticUser(v, text))
      // 排队可见性由事件驱动（spec §7.1）：ack{queued:true} 收养服务端 id，
      // message.queued 打上排队角标，banner 数排队条目——不再用本地启发式提示。
    } catch {
      setNotice("连接不可用，请稍后重试")
    }
  }, [sessionId, pendingAttachments, api, onCreateSession, onOpenSessions, handleSwitchModel, models, currentModel, updateView, disposition])

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

  const handleResolveConfirmation = useCallback((confirmationId: string, approved: boolean) => {
    try {
      // client:"web" names this client so the daemon records web provenance on
      // the resolution and in the audit trail (the CLI omits it → "cli").
      clientRef.current.send({ type: "confirmation.resolve", confirmationId, approved, client: "web" })
    } catch {
      setNotice("连接不可用，请稍后重试")
    }
  }, [])

  /** Cancel queued messages (spec §5.6): one id, or all still-queued when omitted. */
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

  /** 三选切换（spec §6）：本地立即生效（后续发送显式带上），同时写会话级覆盖（与 CLI /steer 同一存储）。 */
  const handleSetDisposition = useCallback((d: Disposition) => {
    setDisposition(d)
    api
      .post(`/sessions/${encodeURIComponent(sessionId)}/disposition`, { disposition: d })
      .catch((err: unknown) => setNotice(`处置切换失败: ${err instanceof Error ? err.message : String(err)}`))
  }, [api, sessionId])

  const clearNotice = useCallback((): void => setNotice(null), [])

  return (
    <div className="chat-panel">
      <div className="chat-panel-inner" data-testid="chat-panel" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
        <ChatView
          view={view}
          onSend={handleSend}
          onResolveConfirmation={handleResolveConfirmation}
          pendingAttachments={pendingAttachments}
          onRemoveAttachment={handleRemoveAttachment}
          models={models}
          sessionModel={currentModel}
          onSwitchModel={handleSwitchModel}
          notice={notice}
          onDraftChange={clearNotice}
          disposition={disposition}
          onSetDisposition={handleSetDisposition}
          onCancelQueued={handleCancelQueued}
          onCancelAllQueued={() => handleCancelQueued()}
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
