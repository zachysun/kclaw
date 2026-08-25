/**
 * ChatPanel — the chat assembly: owns the ws subscription + event loop, feeds
 * every frame through the model reducer, and renders the ChatView. Reconnect
 * follows the shared reconnect protocol (拉全量消息 + 只订阅新事件，不回放): on an unexpected
 * close the panel builds a fresh client via `createWs`, re-pulls the full
 * message list (merged into the live view, see model.mergeMessages), and
 * re-subscribes — the merged state then streams only NEW events.
 *
 * Auth: a close with the daemon's auth-failure code (4001) or an API 401 shows
 * a notice and stops (the App drops back to the token form on API 401; the ws
 * path has no token-refresh flow, so it asks for a reload).
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError, type ApiClient } from "../api.js"
import { WsAuthError, type WsClient } from "../ws.js"
import {
  applyEvent,
  initChat,
  mergeMessages,
  type AgentEvent,
  type ChatState,
  type Message,
} from "./model.js"
import { ChatView, type PendingAttachment } from "./ChatView.js"

export interface ChatPanelProps {
  sessionId: string
  api: ApiClient
  /** The authenticated ws client for the session (created by the App). */
  ws: WsClient
  /** Rebuild a fresh authenticated client after an unexpected close (reconnect). */
  createWs: () => WsClient
  /** Full message list for the session (the App fetches it on session select). */
  initialMessages: Message[]
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

export function ChatPanel({ sessionId, api, ws, createWs, initialMessages }: ChatPanelProps) {
  const [view, setViewState] = useState<ChatState>(() => initChat(initialMessages))
  const [notice, setNotice] = useState<string | null>(null)
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

  // Re-init when the session (or its message list) changes — T6 swaps both.
  useEffect(() => {
    updateView(() => initChat(initialMessages))
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
      try {
        const messages = await api.get<Message[]>(`/sessions/${encodeURIComponent(sessionId)}/messages`)
        if (cancelled) return false
        updateView((v) => ({ ...v, messages: mergeMessages(v.messages, messages) }))
        return true
      } catch (err) {
        if (!cancelled) setNotice(authNotice(err, "无法同步消息"))
        return false
      }
    }

    /** Consume frames until the socket closes; resolves with why it ended. */
    const eventLoop = async (c: WsClient): Promise<"closed" | "auth" | "error"> => {
      try {
        for await (const frame of c.frames) {
          if (cancelled) return "closed"
          try {
            if (isAgentEvent(frame)) {
              updateView((v) => applyEvent(v, frame))
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
  }, [sessionId, api, ws, createWs])

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])

  const handleSend = useCallback((text: string) => {
    try {
      const attachments = [...pendingAttachments]
      clientRef.current.send({
        type: "send_message",
        sessionId,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      setPendingAttachments([])
    } catch {
      setNotice("连接不可用，请稍后重试")
    }
  }, [sessionId, pendingAttachments])

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

  return (
    <div className="chat-panel">
      {notice !== null && (
        <div className="chat-notice" data-testid="chat-notice" role="status">
          {notice}
        </div>
      )}
      <div className="chat-panel-inner" data-testid="chat-panel" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
        <ChatView
          view={view}
          onSend={handleSend}
          onResolveConfirmation={handleResolveConfirmation}
          pendingAttachments={pendingAttachments}
          onRemoveAttachment={handleRemoveAttachment}
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
