/**
 * The Feishu channel (#45): one private-chat DM per allowlisted open_id bound
 * to a persistent kclaw session. Inbound DMs go through the ordinary
 * RunManager.submit door (trigger "user", forced wait → strict send order);
 * commands (/new /stop /help) are intercepted before submit. Outbound, every
 * run of a BOUND session is mirrored as a card sequence — thinking →
 * streaming → complete — no matter which surface triggered it; job-terminal
 * broadcasts and background-subagent settlements push a summary card to the
 * primary user. Permission confirmations on a bound session surface as
 * Confirm/Reject approval cards resolving through the ordinary broker.
 *
 * Everything here runs against the FeishuTransport seam — the SDK itself is
 * behind real-transport.ts and carries no logic.
 */
import { join } from "node:path"
import type { AnyAgentEvent, EventBus, SessionStore } from "@kclaw/core"
import type { RunManager } from "../run.js"
import type { BackgroundSettlement } from "../subagent.js"
import type { FeishuConfig } from "./config.js"
import { FEISHU_STATE_FILE, loadFeishuState, saveFeishuState } from "./config.js"
import type { FeishuTransport, OutboundCard } from "./transport.js"
import { stripOutboundText } from "./strip.js"

export interface FeishuChannelDeps {
  transport: FeishuTransport
  config: FeishuConfig
  run: RunManager
  sessions: SessionStore
  bus: EventBus
  /** ~/.kclaw — hosts feishu-state.json (bindings). */
  home: string
  log?: (line: string) => void
}

export interface FeishuChannel {
  start(): Promise<void>
  stop(): Promise<void>
  /** Wired by the daemon to the subagent host's completion delivery. */
  onBackgroundSettled(info: BackgroundSettlement): void
}

/** Per-run mirror state on a bound session. */
interface RunView {
  state: "thinking" | "streaming"
  thinkingCardId?: string
  streamCardId?: string
  text: string
  /** Deltas that arrived before the streaming card id resolved (async send). */
  pendingDeltas: string[]
}

/** A confirmation card we sent and are still tracking. */
interface PendingApproval {
  cardId: string
  openId: string
}

const ARGS_PREVIEW_CHARS = 300

export function createFeishuChannel(deps: FeishuChannelDeps): FeishuChannel {
  const { transport, config, run, sessions, bus } = deps
  const log = deps.log ?? ((line: string) => console.error(line))
  const statePath = join(deps.home, FEISHU_STATE_FILE)

  /** open_id → bound session; the reverse map drives the event filter. */
  const bindings = new Map<string, string>()
  const bySession = new Map<string, string>()
  /** runId → mirror state. */
  const views = new Map<string, RunView>()
  /** confirmationId → our approval card. */
  const pending = new Map<string, PendingApproval>()
  let started = false

  const persist = (): void => {
    try {
      saveFeishuState(deps.home, { bindings: Object.fromEntries(bindings) })
    } catch (err) {
      log(`feishu: ${statePath} 写入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const bindSession = (openId: string): string => {
    const old = bindings.get(openId)
    if (old !== undefined) {
      bus.unsubscribe(old, socket)
      bySession.delete(old)
    }
    const meta = sessions.create(`飞书 · ${openId}`)
    bindings.set(openId, meta.id)
    bySession.set(meta.id, openId)
    bus.subscribe(meta.id, socket)
    persist()
    return meta.id
  }

  // --- outbound: card state machine -------------------------------------

  const primary = (): string | undefined =>
    config.primaryOpenId !== undefined && config.allowlist.includes(config.primaryOpenId)
      ? config.primaryOpenId
      : undefined

  const pushSummary = (title: string, body: string): void => {
    const to = primary()
    if (to === undefined) return
    void transport.sendCard(to, { kind: "summary", title, body }).catch((err) => {
      log(`feishu: 推送卡片发送失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const settleRunCard = (runId: string, view: RunView, failed: string | undefined): void => {
    views.delete(runId)
    const markdown = stripOutboundText(view.text)
    const final: OutboundCard = {
      kind: "complete",
      markdown: markdown === ""
        ? (failed !== undefined ? `本轮未正常结束：${failed}` : "（本轮没有文本输出）")
        : (failed !== undefined ? `${markdown}\n\n（本轮未正常结束：${failed}）` : markdown),
    }
    const pendingSend = view.streamCardId !== undefined
      ? transport.finishStream(view.streamCardId, final.markdown)
      : view.thinkingCardId !== undefined
        ? transport.updateCard(view.thinkingCardId, final)
        : undefined
    pendingSend?.catch((err) => {
      log(`feishu: 终稿卡片更新失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const onBoundEvent = (e: AnyAgentEvent): void => {
    const openId = bySession.get(e.sessionId!)
    if (openId === undefined) return
    const runId = e.runId
    switch (e.type) {
      case "run.started": {
        if (runId === undefined || views.has(runId)) return
        const view: RunView = { state: "thinking", text: "", pendingDeltas: [] }
        views.set(runId, view)
        const meta = sessions.meta(e.sessionId!)
        void transport
          .sendCard(openId, { kind: "thinking", sessionTitle: meta?.title ?? "会话" })
          .then((id) => { view.thinkingCardId = id })
          .catch(() => { /* 卡片失败不追尾：run 照常 */ })
        return
      }
      case "text.created": {
        if (runId === undefined) return
        const view = views.get(runId)
        if (view === undefined || view.state !== "thinking") return
        view.state = "streaming"
        void transport
          .startStream(openId, "")
          .then((id) => {
            view.streamCardId = id
            // 冲刷卡片 id 返回前到达的增量（流式事件的到达不等人）
            const backlog = view.pendingDeltas.splice(0)
            for (const d of backlog) void transport.appendStream(id, d).catch(() => undefined)
          })
          .catch(() => { view.streamCardId = undefined })
        return
      }
      case "text.delta": {
        if (runId === undefined) return
        const view = views.get(runId)
        if (view === undefined) return
        view.text += e.payload.delta
        if (view.streamCardId !== undefined) {
          void transport.appendStream(view.streamCardId, e.payload.delta).catch(() => undefined)
        } else if (view.state === "streaming") {
          view.pendingDeltas.push(e.payload.delta)
        }
        return
      }
      case "run.completed": {
        if (runId === undefined) return
        const view = views.get(runId)
        if (view === undefined) return
        const failed = e.payload.stopReason === "end_turn" ? undefined : `结束原因 ${e.payload.stopReason}`
        settleRunCard(runId, view, failed)
        return
      }
      case "run.failed": {
        if (runId === undefined) return
        const view = views.get(runId)
        if (view === undefined) return
        settleRunCard(runId, view, e.payload.error?.message)
        return
      }
      case "confirmation.requested": {
        const { confirmationId, toolCall, risk, noteText } = e.payload
        void transport
          .sendCard(openId, {
            kind: "approval",
            confirmationId,
            toolName: toolCall.name,
            argsPreview: toolCall.argsJson.length > ARGS_PREVIEW_CHARS
              ? `${toolCall.argsJson.slice(0, ARGS_PREVIEW_CHARS)}…`
              : toolCall.argsJson,
            risk,
            ...(noteText !== undefined ? { noteText } : {}),
          })
          .then((cardId) => { pending.set(confirmationId, { cardId, openId }) })
          .catch(() => undefined)
        return
      }
      case "confirmation.resolved": {
        // 我们自己的裁决在按钮处理器里已就地更新并移除 pending；走到这里的是
        // 别处（cli/web/超时）的裁决——把还挂着的卡片标记为已失效。
        const entry = pending.get(e.payload.confirmationId)
        if (entry === undefined) return
        pending.delete(e.payload.confirmationId)
        void transport.updateCard(entry.cardId, {
          kind: "approval-settled", confirmationId: e.payload.confirmationId, outcome: "invalid",
        }).catch(() => undefined)
        return
      }
      default:
        return
    }
  }

  // --- inbound: socket + handlers ---------------------------------------

  const socket = {
    send: (data: string): void => {
      let e: AnyAgentEvent
      try {
        e = JSON.parse(data) as AnyAgentEvent
      } catch {
        return
      }
      try {
        if (e.sessionId === undefined) {
          // 广播事件（job.*）：job 终态推送
          if (e.type === "job.completed") {
            pushSummary("定时任务完成", `任务 ${e.payload.jobId} 已结束（${e.payload.summary}）。`)
          } else if (e.type === "job.failed") {
            pushSummary("定时任务失败", `任务 ${e.payload.jobId} 失败：${e.payload.error.message}`)
          }
          return
        }
        onBoundEvent(e)
      } catch (err) {
        log(`feishu: 事件处理失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }

  const onMessage = (m: { openId: string; messageId: string; text: string }): void => {
    if (!config.allowlist.includes(m.openId)) {
      log(`feishu: 忽略非白名单发件人 ${m.openId}`)
      return
    }
    void transport.reactTyping(m.messageId).catch(() => undefined)

    let sessionId = bindings.get(m.openId)
    if (sessionId === undefined || sessions.meta(sessionId) === undefined) {
      sessionId = bindSession(m.openId)
    }

    const text = m.text.trim()
    if (text === "/help") {
      void transport.sendCard(m.openId, { kind: "help" }).catch(() => undefined)
      return
    }
    if (/^\/stop$/i.test(text)) {
      const r = run.stopAndClear(sessionId)
      const line = r.aborted
        ? `已停止当前回复${r.dropped > 0 ? `，丢弃排队消息 ${r.dropped} 条` : ""}。`
        : "当前没有进行中的回复。"
      void transport.replyText(m.openId, line).catch(() => undefined)
      return
    }
    if (/^\/new$/i.test(text)) {
      run.stopAndClear(sessionId)
      const fresh = bindSession(m.openId)
      const title = sessions.meta(fresh)?.title ?? "新会话"
      void transport
        .replyText(m.openId, `已开启新会话「${title}」。旧会话保留，可在 WebUI 查看。`)
        .catch(() => undefined)
      return
    }

    try {
      // 忙时固定 wait：飞书侧多条连发严格按发送顺序消化
      run.submit(sessionId, { userText: text, trigger: "user", disposition: "wait" })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      void transport.replyText(m.openId, `消息未受理：${reason}`).catch(() => undefined)
    }
  }

  const onCardAction = (a: { openId: string; value: string }): void => {
    if (!config.allowlist.includes(a.openId)) return
    const m = /^(confirm|reject):(.+)$/.exec(a.value)
    if (m === null) return
    const [, verb, confirmationId] = m
    const entry = pending.get(confirmationId)
    if (entry === undefined || entry.openId !== a.openId) return
    const decision = verb === "confirm" ? "once" : "reject"
    const ok = run.broker.resolve(confirmationId, decision, "feishu")
    pending.delete(confirmationId)
    const outcome = !ok ? "invalid" : verb === "confirm" ? "approved" : "rejected"
    void transport
      .updateCard(entry.cardId, { kind: "approval-settled", confirmationId, outcome })
      .catch(() => undefined)
  }

  // --- lifecycle ---------------------------------------------------------

  const start = async (): Promise<void> => {
    if (started) return
    started = true
    // Load persisted bindings; sessions deleted while the daemon was down drop out.
    const state = loadFeishuState(deps.home)
    for (const [openId, sessionId] of Object.entries(state.bindings)) {
      const meta = sessions.meta(sessionId)
      if (meta === undefined || meta.deleted) continue
      bindings.set(openId, sessionId)
      bySession.set(sessionId, openId)
      bus.subscribe(sessionId, socket)
    }
    bus.connect(socket)
    await transport.start({ onMessage, onCardAction })
  }

  const stop = async (): Promise<void> => {
    if (!started) return
    started = false
    bus.unsubscribe(socket)
    await transport.stop()
  }

  const onBackgroundSettled = (info: BackgroundSettlement): void => {
    pushSummary(
      info.ok ? `后台子代理「${info.who}」已完成` : `后台子代理「${info.who}」未正常完成`,
      info.excerpt === "" ? `会话 ${info.childId}` : info.excerpt,
    )
  }

  return { start, stop, onBackgroundSettled }
}
