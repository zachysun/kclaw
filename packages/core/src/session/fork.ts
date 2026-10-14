import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import { newId } from "../protocol/ids.js"
import { isMessageEvent, isRunEndedEvent } from "./events.js"
import type { SessionEvent } from "../protocol/session-events.js"
import type { SessionMeta, SessionStore } from "./store.js"

/**
 * Session fork — branch a conversation at any message into a new, fully
 * independent session. The copy strategy follows the storage shape: each
 * session is a directory with an append-only events.jsonl and a rebuildable
 * meta projection, so forking is "copy the event prefix into a fresh stream
 * and replay the projection". Compaction records, the frozen system-prompt
 * baseline, model/mode/workdir and the goal snapshot all come back through
 * the replay with zero extra transfer logic; the first run's request prefix
 * is byte-identical to the source's (provider prefix caches still hit).
 *
 * 归属防重（deepseek 的 inheritedEventCount 等价物，逐项）：
 * - 记忆提取：新会话的 interval/follow 水位经 seedWatermarks 播种到 fork 点，
 *   之后只扫 fork 之后的新消息。
 * - 全文检索：新会话经 markSearchBackfilled 只标记已回填、不写入复制段——
 *   同一内容只在原会话命中一次，fork 之后的新消息照常增量索引。
 * - 用量：usage 是 run/chore 完成时写入独立 UsageStore 的副作用，不扫事件
 *   流汇总；复制段里的 run.ended 只是审计记录，天然不重复计量。
 * - 总线：复制段经 writeEventsRaw 直写，不产生 session.appended 帧；新会话
 *   的直播从 session.forked 这帧开始。
 *
 * 原会话一字节不动：不新增事件、不推 updatedAt，删除互不级联；fork 之 fork
 * 允许（血缘只记直接来源）。
 */
export interface ForkDeps {
  store: SessionStore
  /** <home>/attachments：给了才把引用到的附件拷进新会话目录并改写块内路径。 */
  attachmentsDir?: string
  /** 记忆水位播种（MemorySystem 门面转发 WriteLedger.advanceAll）。 */
  seedWatermarks?: (sessionId: string, messageId: string) => void
  /** 搜索索引只标记不写入（HistorySearchIndex.markBackfilled）。 */
  markSearchBackfilled?: (sessionId: string) => void
}

/** 所点消息不在源会话事件流里（消息被重试截掉、客户端传了过期 id 等）；宿主据此映射 400。 */
export class ForkPointNotFoundError extends Error {}

/** 从 sourceId 会话的 messageId 消息处（含）fork；缺省 messageId = 最新状态。 */
export function forkSession(deps: ForkDeps, opts: { sourceId: string; messageId?: string }): SessionMeta {
  const { store } = deps
  const source = store.meta(opts.sourceId)
  if (source === undefined || source.deleted === true) throw new Error(`session not found: ${opts.sourceId}`)
  // v1 非目标（spec §4.4）：subagent 会话是模型自主的短命执行单元，不是用户
  // 可分叉的对话线；子会话对用户只读，fork 出的会话却要进列表收消息。
  if (source.parentSessionId !== undefined) throw new Error("subagent 会话不支持 fork")

  const events = store.readEvents(opts.sourceId)
  const cut = resolveCutIndex(events, opts.messageId)
  const range = events.slice(0, cut + 1)
  const lastCopiedMessageId = [...range].reverse().find(isMessageEvent)?.id

  const id = newId("ses")
  try {
    // 附件先拷文件并就地改写解析后的事件对象，复制段写盘时已带新路径；
    // 任何一步失败，连同新会话目录一起清理（不留半成品）。
    if (deps.attachmentsDir !== undefined) copyAttachments(deps.attachmentsDir, opts.sourceId, id, range)
    store.writeEventsRaw(id, range)
    store.appendEvent(id, {
      type: "session.forked",
      at: new Date().toISOString(),
      sourceSessionId: opts.sourceId,
      // 缺省 messageId 或复制段内无消息（空会话全量复制）时省略。
      ...(opts.messageId !== undefined || lastCopiedMessageId !== undefined
        ? { sourceMessageId: opts.messageId ?? lastCopiedMessageId }
        : {}),
      title: forkTitle(store, opts.sourceId),
    })
    const meta = store.rebuildMeta(id)
    if (meta === undefined) throw new Error(`fork: projection rebuild produced no meta for ${id}`)
    if (lastCopiedMessageId !== undefined) deps.seedWatermarks?.(id, lastCopiedMessageId)
    deps.markSearchBackfilled?.(id)
    return meta
  } catch (err) {
    store.purge(id)
    // 附件目录与 sessions 目录分属两棵树（<home>/attachments/<id>），purge 只
    // 管后者；拷贝中途失败已建出的附件半成品目录在这里补删。
    if (deps.attachmentsDir !== undefined) rmSync(join(deps.attachmentsDir, id), { recursive: true, force: true })
    throw err
  }
}

/**
 * 切点归一化：语义点是用户所点的消息，实际切到该消息所属 run 的结束处
 * （run.ended，含）——复制段不会截断在工具配对中间，悬空 toolCall 从根上
 * 不存在（codex ForkBoundary/deepseek 合成闭合器同判，kclaw 不需要合成
 * 闭合器：切点向外扩而不是向内截）。流里找不到该消息 → 抛错；该 run 没有
 * run.ended（daemon 中途崩溃的残流）→ 切到流末尾。
 */
function resolveCutIndex(events: SessionEvent[], messageId: string | undefined): number {
  if (messageId === undefined) return events.length - 1
  const clicked = events.findIndex((e) => isMessageEvent(e) && e.id === messageId)
  if (clicked < 0) throw new ForkPointNotFoundError(`fork 点不存在：${messageId}`)
  for (let i = clicked + 1; i < events.length; i++) {
    if (isRunEndedEvent(events[i]!)) return i
  }
  return events.length - 1
}

/** fork 会话标题："<原标题> · fork"，同源第二次起带序号（已删除的 fork 也计数，序号不回退）。 */
function forkTitle(store: SessionStore, sourceId: string): string {
  const base = store.meta(sourceId)?.title ?? ""
  const nth = store.allMetas().filter((m) => m.forkedFrom?.sessionId === sourceId).length + 1
  return nth === 1 ? `${base} · fork` : `${base} · fork ${nth}`
}

/**
 * 附件归属拷贝：引用到的文件从源会话目录拷进新会话目录（文件名不变，att id
 * 本就全局唯一），并把消息块内的绝对路径改写到新位置。AttachmentRef/块内
 * source.path 都指向 <attachmentsDir>/<sessionId>/<att>__<name>（上传路由
 * 返回绝对路径）；不在源会话附件目录下的 file 引用原样保留。只拷引用到的，
 * 量级有界；fork 的生命周期因此与原会话完全独立（原会话 purge 不伤 fork）。
 */
function copyAttachments(attachmentsDir: string, sourceId: string, forkId: string, range: SessionEvent[]): void {
  const sourceDir = join(attachmentsDir, sourceId)
  const forkDir = join(attachmentsDir, forkId)
  for (const event of range) {
    if (!isMessageEvent(event)) continue
    for (const block of event.blocks) {
      if (block.type !== "attachment" || block.source.type !== "file") continue
      const rel = relative(sourceDir, block.source.path)
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue
      const target = join(forkDir, rel)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(block.source.path, target)
      block.source.path = target
    }
  }
}
