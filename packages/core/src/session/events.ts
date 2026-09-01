import type { Message } from "../protocol/messages.js"
import type { SessionMeta } from "./store.js"

export interface SessionCreatedEvent { type: "session.created"; at: string; title: string; workdir?: string; jobId?: string }
export interface SessionRenamedEvent { type: "session.renamed"; at: string; title: string }
export interface SessionDeletedEvent { type: "session.deleted"; at: string }
export interface SessionRestoredEvent { type: "session.restored"; at: string }
export interface SessionSetEvent { type: "session.set"; at: string; model?: string | null; readonly?: boolean | null; disposition?: "steer" | "wait" | "interrupt" | null }
export type MessageEvent = { type: "message" } & Message
export interface CompactionEvent { type: "compaction"; at: string; trigger: "manual" | "in-run" | "auto"; emergency?: true; focus?: string; from: string | null; upto: string; messages: number; segmentSummary: string; top: string }
export interface MemoryEvent {
  type: "memory"; at: string
  trigger: "immediate" | "manual" | "interval" | "follow" | "admin"
  kind: "episode" | "cognition"
  op: "append" | "update" | "new-thread" | "rewrite" | "create" | "overwrite" | "delete" | "inactivate"
  topic?: string; file?: string; scope?: string; source?: string
}

export type SessionEvent = SessionCreatedEvent | SessionRenamedEvent | SessionDeletedEvent | SessionRestoredEvent | SessionSetEvent | MessageEvent | CompactionEvent | MemoryEvent

export function isMessageEvent(e: SessionEvent): e is MessageEvent { return e.type === "message" }
export function isCompactionEvent(e: SessionEvent): e is CompactionEvent { return e.type === "compaction" }
export function isMemoryEvent(e: SessionEvent): e is MemoryEvent { return e.type === "memory" }

export function applyEvent(meta: SessionMeta, event: SessionEvent): SessionMeta {
  const next = { ...meta }
  switch (event.type) {
    case "session.created": {
      next.title = event.title
      next.createdAt = event.at
      next.updatedAt = event.at
      if (event.workdir !== undefined) next.workdir = event.workdir
      if (event.jobId !== undefined) next.jobId = event.jobId
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
      if (event.readonly !== undefined) {
        if (event.readonly === null) delete next.readonly
        else next.readonly = event.readonly
      }
      if (event.disposition !== undefined) {
        if (event.disposition === null) delete next.dispositionOverride
        else next.dispositionOverride = event.disposition
      }
      next.updatedAt = event.at
      break
    }
    case "message": next.updatedAt = event.createdAt; break
    case "compaction": {
      const segments = [...(next.compaction?.segments ?? []), { upto: event.upto, summary: event.segmentSummary }]
      next.compaction = { segments, top: event.top, upto: event.upto }
      next.updatedAt = event.at
      break
    }
    case "memory": break // 不更新任何投影字段（含 updatedAt）
  }
  return next
}
