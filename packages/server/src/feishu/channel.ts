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
import type { FeishuConfig, PendingApproval, PendingSender } from "./config.js"
import {
  FEISHU_STATE_FILE,
  PENDING_SENDERS_CAP,
  loadFeishuState,
  normalizePendingSenders,
  saveFeishuState,
} from "./config.js"
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
  /** Non-allowlisted senders seen so far (newest first), for the admin page. */
  pendingSenders(): PendingSender[]
  /** Remove one pending sender (e.g. after it was allowlisted). */
  clearPendingSender(openId: string): void
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
  /** confirmationId → our approval card; persisted so clicks survive restarts. */
  const pending = new Map<string, PendingApproval>()
  /** Non-allowlisted senders (open_id → count/lastSeen); persisted for the admin page. */
  const rejected = new Map<string, { count: number; lastSeen: number }>()
  let started = false

  const persist = (): void => {
    try {
      const approvals: Record<string, PendingApproval> = {}
      for (const [id, entry] of pending) approvals[id] = entry
      saveFeishuState(deps.home, {
        bindings: Object.fromEntries(bindings),
        pendingSenders: pendingSenders(),
        ...(Object.keys(approvals).length > 0 ? { pendingApprovals: approvals } : {}),
      })
    } catch (err) {
      log(`feishu: ${statePath} 写入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const pendingSenders = (): PendingSender[] =>
    normalizePendingSenders([...rejected].map(([openId, r]) => ({ openId, count: r.count, lastSeen: r.lastSeen })))

  /**
   * The sender learns nothing (still no reply of any kind); only our own
   * records grow, so the admin page can allowlist with one click. The cap
   * applies to memory and file alike (newest entries win).
   */
  const recordRejectedSender = (openId: string): void => {
    const prev = rejected.get(openId)
    rejected.set(openId, { count: (prev?.count ?? 0) + 1, lastSeen: Date.now() })
    if (rejected.size > PENDING_SENDERS_CAP) {
      const oldest = [...rejected].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      for (const [id] of oldest.slice(0, rejected.size - PENDING_SENDERS_CAP)) rejected.delete(id)
    }
    persist()
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
          .then((cardId) => {
            pending.set(confirmationId, { cardId, openId })
            persist()
          })
          .catch(() => undefined)
        return
      }
      case "confirmation.resolved": {
        // 我们自己的裁决在按钮处理器里已就地更新并移除 pending；走到这里的是
        // 别处（cli/web/超时）的裁决——把还挂着的卡片标记为已失效。
        const entry = pending.get(e.payload.confirmationId)
        if (entry === undefined) return
        pending.delete(e.payload.confirmationId)
        persist()
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
    // 停止后迟到的回调不再触碰内存表——否则会用旧通道的绑定覆盖
    // 新通道刚写入的状态文件
    if (!started) return
    if (!config.allowlist.includes(m.openId)) {
      log(`feishu: 忽略非白名单发件人 ${m.openId}`)
      recordRejectedSender(m.openId)
      return
    }
    void transport.reactTyping(m.messageId).catch(() => undefined)

    let sessionId = bindings.get(m.openId)
    // 与 start() 的加载判断一致：软删（回收站）的会话同样作废重绑，
    // 否则消息会跑进一个随时可能被清理扫描硬删的目录
    if (sessionId === undefined || sessions.meta(sessionId) === undefined || sessions.meta(sessionId)!.deleted) {
      sessionId = bindSession(m.openId)
    }

    const text = m.text.trim()
    if (text === "/help") {
      void transport.sendCard(m.openId, { kind: "help" }).catch(() => undefined)
      return
    }
    if (/^\/stop$/i.test(text)) {
      const r = run.stopAndClear(sessionId)
      const dropped = r.dropped > 0 ? `，丢弃排队消息 ${r.dropped} 条` : ""
      const line = r.aborted ? `已停止当前回复${dropped}。` : dropped !== "" ? `当前没有进行中的回复${dropped}。` : "当前没有进行中的回复。"
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
    if (!started) return
    if (!config.allowlist.includes(a.openId)) {
      recordRejectedSender(a.openId)
      return
    }
    const m = /^(confirm|reject):(.+)$/.exec(a.value)
    if (m === null) return
    const [, verb, confirmationId] = m
    const entry = pending.get(confirmationId)
    if (entry === undefined || entry.openId !== a.openId) return
    const decision = verb === "confirm" ? "once" : "reject"
    const ok = run.broker.resolve(confirmationId, decision, "feishu")
    pending.delete(confirmationId)
    persist()
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
    // Rejected senders outlive restarts so the admin page keeps its list.
    for (const p of state.pendingSenders) rejected.set(p.openId, { count: p.count, lastSeen: p.lastSeen })
    // Approval cards too: after a hot restart a click resolves through the
    // broker if the confirmation is still alive, or lands as invalid.
    for (const [confirmationId, entry] of Object.entries(state.pendingApprovals ?? {})) {
      pending.set(confirmationId, entry)
    }
    bus.connect(socket)
    await transport.start({ onMessage, onCardAction })
  }

  const stop = async (): Promise<void> => {
    if (!started) return
    started = false
    bus.unsubscribe(socket)
    // 重启不能把在飞的镜像卡冻在半截：趁传输还活着，逐张补一个诚实的
    // 终稿。run 本身还在 daemon 里继续，断掉的只是这张镜像卡。
    const note = "（通道重启，本轮中断；完整回复可在 WebUI 查看）"
    for (const [, view] of views) {
      const send = view.streamCardId !== undefined
        ? transport.finishStream(view.streamCardId, note)
        : view.thinkingCardId !== undefined
          ? transport.updateCard(view.thinkingCardId, { kind: "complete", markdown: note })
          : undefined
      send?.catch(() => undefined)
    }
    views.clear()
    persist()
    await transport.stop()
  }

  const onBackgroundSettled = (info: BackgroundSettlement): void => {
    pushSummary(
      info.ok ? `后台子代理「${info.who}」已完成` : `后台子代理「${info.who}」未正常完成`,
      info.excerpt === "" ? `会话 ${info.childId}` : info.excerpt,
    )
  }

  return {
    start,
    stop,
    onBackgroundSettled,
    pendingSenders,
    clearPendingSender: (openId) => {
      if (!rejected.delete(openId)) return
      persist()
    },
  }
}
