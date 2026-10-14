import { forkSession, ForkPointNotFoundError, type HistorySearchIndex, type MemorySystem, type SessionMeta, type SessionStore } from "@kclaw/core"
import type { RunManager } from "./run.js"

/**
 * Session fork host — the daemon-side assembly of the core fork primitive
 * (session/fork.ts): idle gating (the fork copies history, so it must not
 * race a live run/queue/compaction), memory-watermark seeding, search-index
 * marking and the attachments dir. The HTTP route stays a thin translator
 * over the discriminated outcome; the only core error mapped by identity is
 * ForkPointNotFoundError → 400 (anything else is a 500 with a generic body —
 * internal error text may carry filesystem paths and must not reach clients).
 */
export interface SessionForkHost {
  fork(sourceId: string, messageId?: string): ForkOutcome
}

export type ForkOutcome = { ok: true; meta: SessionMeta } | { ok: false; status: 400 | 404 | 409 | 500; error: string }

export function createSessionForkHost(deps: {
  sessions: SessionStore
  /** 只需要 isIdle 一个方法（测试塞探针，chore-usage 的 UsageSink 同款单方法裁剪）。 */
  run: Pick<RunManager, "isIdle">
  /** 记忆提取进度播种；未组装记忆系统时跳过（fork 照常，只是首次提取会扫全量历史）。 */
  memory?: MemorySystem
  /** 搜索索引只标记不写入；未组装时跳过（复制段会被回填重复索引）。 */
  historyIndex?: HistorySearchIndex
  /** <home>/attachments；未配置时跳过附件拷贝。 */
  attachmentsDir?: string
  /** workdir 没有时的回退工作区（daemon 的 config.workspace），播种定位项目用。 */
  workspaceFallback?: string
}): SessionForkHost {
  return {
    fork(sourceId, messageId) {
      // 预检与 core forkSession 内部校验是有意重复：host 这层把已知拒绝翻译成
      // 准确的状态码（core 只抛无类型 Error，不知道 HTTP）；core 重复校验是
      // 对直接调用方（测试、未来 CLI 调用）保权威。两层文案保持一致。
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
        if (e instanceof ForkPointNotFoundError) return { ok: false, status: 400, error: e.message }
        // 未知错误（磁盘、附件拷贝等）：细节进 daemon 日志，接口只回通用文案，
        // 避免 Error.message 里的绝对路径等本机信息漏给客户端。
        console.error("[session-fork] fork failed:", e)
        return { ok: false, status: 500, error: "fork 失败：内部错误" }
      }
    },
  }
}
