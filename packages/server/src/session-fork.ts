import { forkSession, type HistorySearchIndex, type MemorySystem, type SessionMeta, type SessionStore } from "@kclaw/core"
import type { RunManager } from "./run.js"

/**
 * Session fork host — the daemon-side assembly of the core fork primitive
 * (session/fork.ts): idle gating (the fork copies history, so it must not
 * race a live run/queue/compaction), memory-watermark seeding, search-index
 * marking and the attachments dir. The HTTP route stays a thin translator
 * over the discriminated outcome (no error-message matching).
 */
export interface SessionForkHost {
  fork(sourceId: string, messageId?: string): ForkOutcome
}

export type ForkOutcome = { ok: true; meta: SessionMeta } | { ok: false; status: 400 | 404 | 409 | 500; error: string }

export function createSessionForkHost(deps: {
  sessions: SessionStore
  /** 只需要 isIdle 一个方法（测试塞探针，chore-usage 的 UsageSink 同款收窄）。 */
  run: Pick<RunManager, "isIdle">
  /** 记忆水位播种；未组装记忆系统时跳过（fork 照常，只是首次提取会扫全量历史）。 */
  memory?: MemorySystem
  /** 搜索索引只标记不写入；未组装时跳过（复制段会被回填重复索引）。 */
  historyIndex?: HistorySearchIndex
  /** <home>/attachments；未配置时跳过附件拷贝。 */
  attachmentsDir?: string
  /** workdir 缺省时的回落工作区（daemon 的 config.workspace），播种定位项目用。 */
  workspaceFallback?: string
}): SessionForkHost {
  return {
    fork(sourceId, messageId) {
      const meta = deps.sessions.meta(sourceId)
      if (meta === undefined || meta.deleted === true) return { ok: false, status: 404, error: "session not found" }
      // v1 非目标（spec §4.4）：subagent 会话只读，不是用户可分叉的对话线。
      if (meta.parentSessionId !== undefined) return { ok: false, status: 400, error: "subagent 会话不支持 fork" }
      if (!deps.run.isIdle(sourceId)) return { ok: false, status: 409, error: "运行结束后可 fork" }
      try {
        const workdir = meta.workdir ?? deps.workspaceFallback
        const forked = forkSession(
          {
            store: deps.sessions,
            ...(deps.attachmentsDir !== undefined ? { attachmentsDir: deps.attachmentsDir } : {}),
            ...(deps.memory !== undefined && workdir !== undefined
              ? { seedWatermarks: (sid: string, mid: string) => deps.memory!.seedWatermarksForFork(workdir, sid, mid) }
              : {}),
            ...(deps.historyIndex !== undefined
              ? { markSearchBackfilled: (sid: string) => deps.historyIndex!.markBackfilled(sid) }
              : {}),
          },
          { sourceId, ...(messageId !== undefined && messageId !== "" ? { messageId } : {}) },
        )
        return { ok: true, meta: forked }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (message.startsWith("fork 点不存在")) return { ok: false, status: 400, error: message }
        return { ok: false, status: 500, error: message }
      }
    },
  }
}
