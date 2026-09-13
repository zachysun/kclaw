import type {
  CompactionEvent, MemoryEvent, MessageEvent, MessageTruncatedEvent, PermissionDecidedEvent, RunEndedEvent, RunStartedEvent,
  SandboxCheckedEvent, SessionCreatedEvent, SessionDeletedEvent,
  SessionRenamedEvent, SessionRestoredEvent, SessionSetEvent, SessionEvent, SystemEvent,
} from "../protocol/session-events.js"
import type { SessionMeta } from "./store.js"

// The event types live in protocol/session-events.ts (the browser-safe
// canon the web trail view imports); this module owns the runtime side —
// guards and the meta projection — and re-exports the types for the Node
// packages that historically imported them from here.
export type {
  CompactionEvent, MemoryEvent, MessageEvent, MessageTruncatedEvent, PermissionDecidedEvent, RunEndedEvent, RunStartedEvent,
  SandboxCheckedEvent, SessionCreatedEvent, SessionDeletedEvent,
  SessionEvent, SessionRenamedEvent, SessionRestoredEvent, SessionSetEvent, SystemEvent,
} from "../protocol/session-events.js"

export function isMessageEvent(e: SessionEvent): e is MessageEvent { return e.type === "message" }
export function isMessageTruncatedEvent(e: SessionEvent): e is MessageTruncatedEvent { return e.type === "message.truncated" }
export function isCompactionEvent(e: SessionEvent): e is CompactionEvent { return e.type === "compaction" }
export function isMemoryEvent(e: SessionEvent): e is MemoryEvent { return e.type === "memory" }
export function isSystemEvent(e: SessionEvent): e is SystemEvent { return e.type === "system" }
export function isSandboxCheckedEvent(e: SessionEvent): e is SandboxCheckedEvent { return e.type === "sandbox.checked" }
export function isRunStartedEvent(e: SessionEvent): e is RunStartedEvent { return e.type === "run.started" }
export function isRunEndedEvent(e: SessionEvent): e is RunEndedEvent { return e.type === "run.ended" }
export function isPermissionDecidedEvent(e: SessionEvent): e is PermissionDecidedEvent { return e.type === "permission.decided" }

export function applyEvent(meta: SessionMeta, event: SessionEvent): SessionMeta {
  const next = { ...meta }
  switch (event.type) {
    case "session.created": {
      next.title = event.title
      next.createdAt = event.at
      next.updatedAt = event.at
      if (event.workdir !== undefined) next.workdir = event.workdir
      if (event.jobId !== undefined) next.jobId = event.jobId
      if (event.parentSessionId !== undefined) next.parentSessionId = event.parentSessionId
      // 创建时固化的默认模式：旧事件流无 mode → 投影不设（gate 读时回落 default）。
      if (event.mode !== undefined) next.mode = event.mode
      break
    }
    case "session.renamed": next.title = event.title; next.updatedAt = event.at; break
    case "session.deleted": next.deleted = true; next.deletedAt = event.at; next.updatedAt = event.at; break
    case "session.restored": next.deleted = false; delete next.deletedAt; next.updatedAt = event.at; break
    case "session.set": {
      // undefined = 该字段不在本事件中（不动）；null = 显式清除（删键）。
      if (event.model !== undefined) {
        if (event.model === null) delete next.model
        else next.model = event.model
      }
      if (event.mode !== undefined) {
        if (event.mode === null) delete next.mode
        else next.mode = event.mode
      } else if (event.readonly !== undefined) {
        // Legacy boolean events from pre-mode streams: readonly maps onto the
        // mode axis (true → "readonly", false/null → fall back to default).
        if (event.readonly === true) next.mode = "readonly"
        else delete next.mode
      }
      if (event.disposition !== undefined) {
        if (event.disposition === null) delete next.dispositionOverride
        else next.dispositionOverride = event.disposition
      }
      next.updatedAt = event.at
      break
    }
    case "message": next.updatedAt = event.createdAt; break
    case "message.truncated": {
      // Truncation (edit & retry / regenerate) is a user-visible session
      // action and advances updatedAt. When the start id crosses the
      // compaction anchor (message ids are monotonic, so string compare is
      // creation order), part of the summarized history is discarded → the
      // compaction projection is cleared with it (the summary can no longer
      // stand in for hidden messages). A tail truncation — the regular path —
      // leaves compaction untouched: the early summary and the remaining
      // history both stay valid.
      const anchor = next.compactedUpto ?? next.compaction?.upto
      if (anchor !== undefined && event.fromMessageId <= anchor) {
        delete next.compactedSummary
        delete next.compactedUpto
        delete next.compaction
      }
      next.updatedAt = event.at
      break
    }
    case "compaction": {
      const segments = [...(next.compaction?.segments ?? []), { upto: event.upto, summary: event.segmentSummary }]
      next.compaction = { segments, top: event.top, upto: event.upto }
      // 压缩改写消息历史 = 请求前缀必然全量失效（缓存冷启动），正是重冻结
      // 边界：清除冻结基线，下一次 run 重新装配并经 system 事件固化新基线。
      delete next.systemBaseline
      next.updatedAt = event.at
      break
    }
    case "memory": break // 不更新任何投影字段（含 updatedAt）
    case "system":
      // 审计留痕即基线写入口：每次 run 的系统提示词全量事件按段 upsert 冻结
      // 基线（提示词缓存纪律）。两段独立比对——哪段文本变了就重冻结哪段，
      // 另一段基线原样保留（frozenAt 记录的是"这份文本成为基线的时刻"，
      // 不是"最后一次审计的时刻"；那去事件流里看）。legacy 单文本事件读作
      // stable 段。基线外字段与 updatedAt 一律不动。
      {
        const stableText = event.stable ?? event.text ?? ""
        const liveText = event.live ?? ""
        const baseline = next.systemBaseline ?? { stable: { text: "", frozenAt: event.at } }
        if (baseline.stable.text !== stableText) baseline.stable = { text: stableText, frozenAt: event.at }
        if (baseline.live?.text !== liveText) baseline.live = { text: liveText, frozenAt: event.at }
        next.systemBaseline = baseline
      }
      break
    case "sandbox.checked": break // 审计事件同样不进投影、不推进 updatedAt
    case "run.started":
    case "run.ended":
    case "permission.decided": break // 审计事件：只留痕，不动投影
    default: {
      const unhandled: never = event
      void unhandled
      break
    }
  }
  return next
}
