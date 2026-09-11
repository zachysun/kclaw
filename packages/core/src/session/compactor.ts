/**
 * Compactor — the v2/v3 layered-compaction orchestration { 5.3/5.6/5.8).
 *
 * The PURE parts live in session/compaction.ts (estimateContextTokens,
 * chooseBoundary, emergencyBoundary, renderSegment); this class owns the line
 * that strings them together: two tool-less LLM summarizer calls, the
 * compaction.started/completed event pair, the audit append and the meta
 * write — plus the per-session cancellation state (flag + in-flight
 * controller) that lets the daemon suppress or abort auto-compaction for the
 * current run (the daemon's cancelCompaction forwards here).
 *
 * Relocated verbatim from server/src/run.ts (#compactV2 / #runAutoCompaction,
 * card ① engine relocation): prompts byte-identical, event order identical,
 * the "throw = compaction did not happen" contract identical.
 */
import type { AgentEvent, CompactionPhase } from "../protocol/events.js"
import { makeEvent } from "../protocol/events.js"
import type { Message } from "../protocol/messages.js"
import type { LlmClient } from "../provider/types.js"
import { collectStreamText } from "../provider/collect.js"
import type { KclawConfig } from "../storage/config.js"
import type { ActiveSummary, CompactionState } from "./compaction.js"
import { chooseBoundary, emergencyBoundary, estimateContextTokens, extractSpillLocators, renderSegment } from "./compaction.js"
import type { SessionStore } from "./store.js"

/**
 * Append spill locator lines to a summary, deduped against lines it already
 * carries (a merged top inherits the previous top's pointers). Returns the
 * text unchanged when there is nothing to append.
 */
function appendLocators(summary: string, locators: string[]): string {
  if (locators.length === 0) return summary
  const fresh = locators.filter((l) => !summary.includes(l))
  if (fresh.length === 0) return summary
  return `${summary}\n${fresh.join("\n")}`
}

/** Segment summarizer prompt. */
export const SEGMENT_SUMMARY_PROMPT =
  "你是对话摘要器。把给定的一段对话（可能包含工具调用与结果）压缩为不超过800字的中文摘要，使用以下固定五个二级标题的 markdown 结构：## 关键事实、## 用户偏好与约定、## 已做决定、## 未完成事项、## 文件与命令。\"文件与命令\"一栏只记路径或命令加一句话要点，不要复制文件内容。同一栏目内每条一行。摘要中的精确标识符——文件路径、命令、报错关键串、代码标识符、版本号、专有名词——必须逐字保留，不得意译或改写，后续检索全靠它们。直接输出摘要正文，不要任何前后缀。"

/** Top-summary merge prompt. */
export const MERGE_SUMMARY_PROMPT =
  "你是对话摘要归并器。输入是旧的总摘要和一个新的段摘要，两者都是同样五栏结构的 markdown。把它们归并为一份新的总摘要：保持同样的五个二级标题；同一栏目内合并去重；同一事项有先后版本时保留新版本，并注明被推翻的旧版本；总长不超过800字。归并时精确标识符（文件路径、命令、报错关键串、代码标识符、版本号、专有名词）必须逐字保留，不得改写。直接输出摘要正文，不要任何前后缀。"

export interface CompactorDeps {
  sessions: SessionStore
  /**
   * Event sink (the daemon passes its bus.emit): compaction.started /
   * compaction.completed land here. Throwing subscribers are the sink's
   * problem — the Compactor fires and forgets, same as the RunManager did.
   */
  emit: (e: AgentEvent) => void
}

export class Compactor {
  readonly #deps: CompactorDeps
  /**
   * 每会话压缩取消标记：cancel() 写入，压制本次运行内的
   * 全部自动压缩（中途/收尾）；每次 run 开头 clearCancelled——取消只作用于
   * 当时那次运行，新运行从干净状态恢复。
   */
  readonly #cancelled = new Set<string>()
  /** 每会话在飞的自动压缩 controller：cancel() 掐它；finally 清理。 */
  readonly #inFlight = new Map<string, AbortController>()

  constructor(deps: CompactorDeps) {
    this.#deps = deps
  }

  /**
   * 取消自动压缩：abort 在飞的压缩 controller（compact 的
   * 取消分支吞掉中止，发 completed result:"cancelled"），同时写取消标记——
   * 本次 run 内后续的中途/收尾压缩钩子据此直接跳过；标记在下一次 run 开头
   * 清除，新运行恢复正常压缩。返回：调用时刻是否存在在飞的压缩（false =
   * 没什么可掐，但标记仍写入，压制本次运行内尚未发生的自动压缩）。
   */
  cancel(sessionId: string): boolean {
    this.#cancelled.add(sessionId)
    const ctrl = this.#inFlight.get(sessionId)
    if (ctrl === undefined) return false
    ctrl.abort()
    return true
  }

  /** 取消标记是否压着该会话（自动压缩钩子开工前先问这个）。 */
  cancelled(sessionId: string): boolean {
    return this.#cancelled.has(sessionId)
  }

  /** 清除取消标记（每次 run 开头：取消只压制一次运行）。 */
  clearCancelled(sessionId: string): void {
    this.#cancelled.delete(sessionId)
  }

  /**
   * 自动压缩装配：中途钩子、超限钩子与收尾压缩共用。
   * 独立 AbortController 登记 #inFlight（cancel 掐它），并监听
   * run 的 signal——run 中止顺带掐压缩;finally 清理。取消标记或 run signal 已
   * 中止时不开工（三路统一入口,manual 路径不经此——emergency 因此永远不会与
   * manual 组合)。任何异常打一行 `kclaw compaction (phase) failed:` 后返回
   * null（钩子侧"压缩失败不补救",真失败的 started/completed 与第一行日志
   * 已由 compact 发出/记录）。压缩成功返回新视图 { upto, top },水位不够
   * 或无可压缩边界时 compact 返回 compacted:false → null。
   */
  async auto(
    sessionId: string,
    history: Message[],
    config: KclawConfig,
    llm: LlmClient,
    model: string,
    opts: { phase: CompactionPhase; signal?: AbortSignal; emergency?: boolean; overheadTokens?: number; budget?: number },
  ): Promise<ActiveSummary | null> {
    if (this.#cancelled.has(sessionId) || opts.signal?.aborted === true) return null
    const ctrl = new AbortController()
    this.#inFlight.set(sessionId, ctrl)
    const onAbort = (): void => { ctrl.abort() }
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const out = await this.compact(sessionId, history, "", config, llm, model, {
        phase: opts.phase,
        signal: ctrl.signal,
        ...(opts.emergency === true ? { emergency: true } : {}),
        ...(opts.overheadTokens === undefined ? {} : { overheadTokens: opts.overheadTokens }),
        ...(opts.budget === undefined ? {} : { budget: opts.budget }),
      })
      return out.compacted && out.upto !== undefined
        ? { upto: out.upto, top: out.summary ?? "" }
        : null
    } catch (err) {
      console.error(`kclaw compaction (${opts.phase}) failed:`, err)
      return null
    } finally {
      opts.signal?.removeEventListener("abort", onAbort)
      if (this.#inFlight.get(sessionId) === ctrl) this.#inFlight.delete(sessionId)
    }
  }

  /**
   * layered compaction. Trigger: estimate ≥ budget×ratio, or a
   * manual focus. Two tool-less LLM calls (segment summary, top merge), then
   * ONE meta write — no state lands unless both calls succeed, so a throw
   * anywhere equals "compaction did not happen" and the caller falls back to
   * the full history. The segment index write and the audit append are
   * best-effort (logged, never fatal).
   *
   * v3 additions: `phase` names the trigger stage (started/completed events
   * carry it; the audit trigger maps manual → "manual", phase "in-run" →
   * "in-run", else "auto"), `emergency` flags the over-limit rescue in the
   * audit record, and `signal` makes both summarizer calls abortable.
   * completed is GUARANTEED once started has fired: ok on success, "failed"
   * on a throw (rethrown to the caller — "throw = compaction did not
   * happen" — and logged here exactly once), "cancelled" when the signal
   * aborted (swallowed — the run is being torn down, not failing). Below the
   * water mark or without a boundary, NEITHER event fires (nothing began).
   */
  async compact(
    sessionId: string,
    history: Message[],
    userText: string,
    config: KclawConfig,
    runLlm: LlmClient,
    model: string,
    opts: { focus?: string; manual?: boolean; phase?: CompactionPhase; signal?: AbortSignal; emergency?: boolean; overheadTokens?: number; budget?: number } = {},
  ): Promise<{ summary?: string; upto?: string; segments: number; active: Message[]; compacted: boolean }> {
    const { sessions } = this.#deps
    const meta = sessions.meta(sessionId)
    const prev: CompactionState | undefined = meta?.compaction ??
      (meta?.compactedSummary !== undefined && meta.compactedUpto !== undefined
        ? { segments: [], top: meta.compactedSummary, upto: meta.compactedUpto }
        : undefined)
    const prevIdx = prev === undefined ? -1 : history.findIndex((m) => m.id === prev.upto)
    const active = prevIdx >= 0 ? history.slice(prevIdx + 1) : history

    // Per-run budget override (model contextWindow from resolveContextTokens);
    // falls back to the config cap, then the 128k default.
    const budget = opts.budget ?? config.sessions.contextTokens ?? 128_000
    const atRatio = config.sessions.compactAtRatio ?? 0.66
    const targetRatio = config.sessions.compactTargetRatio ?? 0.33
    const manual = opts.manual === true
    const emergency = opts.emergency === true
    // 急救豁免黄线细判：溢出发生时"已经爆了"就是事实——尤其压缩后
    // 首请求里 active 没有 assistant 锚点，system/工具定义开销全漏计，估算会明显
    // 偏低，按黄线拦截会静默放弃急救、run 直接以 error 收场。急救只跳过触发判断，
    // 后续流程（两次摘要调用、meta 写入、审计、事件）与普通压缩完全一致。
    if (!manual && !emergency && estimateContextTokens(active, userText, opts.overheadTokens) < budget * atRatio) {
      return { summary: prev?.top, upto: prev?.upto, segments: prev?.segments.length ?? 0, active, compacted: false }
    }

    let boundary = chooseBoundary(active, { budget, targetRatio })
    if (boundary === undefined && emergency) {
      // 预算细判不可信时 chooseBoundary 可能切不出边界——强制退守最小可行
      // 上下文：只保留最近一轮用户轮次（emergencyBoundary）。
      const forced = emergencyBoundary(active)
      if (forced !== undefined) boundary = { keepFrom: forced }
    }
    if (boundary === undefined) {
      return { summary: prev?.top, upto: prev?.upto, segments: prev?.segments.length ?? 0, active, compacted: false }
    }

    const phase = opts.phase ?? (manual ? "manual" : "post-run")

    // The compaction will really run (two LLM calls ahead): announce it so
    // subscribed clients can show a "正在压缩…" state. This fires BEFORE
    // run.started — the pre-run compaction is otherwise a silent multi-second
    // gap between send and the first run event. From here on a paired
    // completed is guaranteed, whatever happens next.
    this.#deps.emit(makeEvent("compaction.started", { phase }, { sessionId }))

    try {
      const seg = active.slice(0, boundary.keepFrom)
      const body = renderSegment(seg)
      const focusLine = opts.focus === undefined ? "" : `\n\n用户特别要求重点保留：${opts.focus}`
      const segmentSummary = await collectStreamText(runLlm, {
        model,
        system: SEGMENT_SUMMARY_PROMPT,
        messages: [{ role: "user", content: body + focusLine }],
        tools: [],
      }, { signal: opts.signal })
      // Spill pointers survive STRUCTURALLY: the segment summary and the top
      // summary carry the locator lines regardless of what the summarizer
      // wrote — after compaction the full copies stay reachable (fs_read),
      // and the pointer never depends on prompt discipline. Deduped against
      // what the previous top already carries.
      const locators = extractSpillLocators(seg)
      const summaryWithPointers = appendLocators(segmentSummary, locators)
      const mergeInput = prev === undefined ? summaryWithPointers : `${prev.top}\n\n新的段摘要：\n${summaryWithPointers}`
      const top = await collectStreamText(runLlm, {
        model,
        system: MERGE_SUMMARY_PROMPT,
        messages: [{ role: "user", content: mergeInput + focusLine }],
        tools: [],
      }, { signal: opts.signal })
      const topWithPointers = appendLocators(top, locators)

      const upto = seg[seg.length - 1]!.id
      const nextSegments = [...(prev?.segments ?? []), { upto, summary: summaryWithPointers }]
      try {
        sessions.appendCompaction(sessionId, {
          at: new Date().toISOString(),
          trigger: manual ? "manual" : phase === "in-run" ? "in-run" : "auto",
          ...(opts.emergency === true ? { emergency: true } : {}),
          ...(opts.focus === undefined ? {} : { focus: opts.focus }),
          // null = the span starts at session start (or the legacy upgrade
          // point) — only a continuation compaction has a real first id.
          from: prevIdx >= 0 ? seg[0]!.id : null,
          upto,
          messages: seg.length,
          segmentSummary: summaryWithPointers,
          top: topWithPointers,
        })
      } catch (err) {
        console.error(`kclaw compaction audit (${sessionId}) append failed:`, err)
      }
      this.#deps.emit(
        makeEvent("compaction.completed", { segments: nextSegments.length, kept: active.length - boundary.keepFrom, phase, result: "ok" }, { sessionId }),
      )
      return { summary: top, upto, segments: nextSegments.length, active: active.slice(boundary.keepFrom), compacted: true }
    } catch (err) {
      // An aborted signal turns any throw into "cancelled": the run is being
      // torn down, the summarizer call was cut mid-flight — report that (and
      // swallow: cancellation is not a failure). Everything else is a real
      // failure: announce it, log it ONCE here, and rethrow — the caller's
      // "throw = compaction did not happen" contract is unchanged.
      const cancelled = opts.signal?.aborted === true
      this.#deps.emit(
        makeEvent("compaction.completed", { segments: 0, kept: 0, phase, result: cancelled ? "cancelled" : "failed" }, { sessionId }),
      )
      if (cancelled) {
        return { summary: prev?.top, upto: prev?.upto, segments: prev?.segments.length ?? 0, active, compacted: false }
      }
      console.error("kclaw compaction failed:", err)
      throw err
    }
  }
}
