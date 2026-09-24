import type { AssistantMessage, Message } from "../protocol/messages.js"
import { isBlockType } from "../protocol/blocks.js"
import { SPILL_LOCATOR_PREFIX } from "../tools/spill.js"

const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/** Rough token estimate: CJK 0.75/char, everything else 0.25/char. */
export function estimateTokens(text: string): number {
  let units = 0
  for (const ch of text) units += CJK.test(ch) ? 0.75 : 0.25
  return Math.ceil(units)
}

/**
 * Coarse render of one message for size estimation: every text-bearing
 * block's text plus tool args/results. Precision only needs to be
 * trigger-grade.
 */
function messageText(m: Message): string {
  const parts: string[] = []
  for (const b of m.blocks as Array<{ type: string; text?: string; output?: string; argsJson?: string }>) {
    if (typeof b.text === "string") parts.push(b.text)
    if (typeof b.output === "string") parts.push(b.output)
    if (typeof b.argsJson === "string") parts.push(b.argsJson)
  }
  return parts.join(" ")
}

/**
 * Estimated size of "send the active history plus this turn's user text".
 * Anchors on the last assistant message's real usage.inputTokens (the last
 * actually-sent request size, system prompt and tool defs included — biased
 * LARGE, which only compacts earlier: the safe direction); messages after
 * it are estimated per message. `overheadTokens` (assembled system prompt +
 * tool schemas) covers the anchor-LESS view — fresh session or the first
 * request after a compaction, where no assistant message carries the real
 * per-request overhead; with an anchor it is already inside the reported
 * inputTokens, so passing it there would double-count.
 */
export function estimateContextTokens(active: Message[], extraText?: string, overheadTokens?: number): number {
  let anchorIdx = -1
  for (let i = active.length - 1; i >= 0; i--) {
    const m = active[i]!
    // usage 为 0 的 assistant 是被中断的流（无 message_done）——当锚点会把
    // 估算砍到近零，偏小是危险方向（水位线晚触发）。跳过它找更早的真实
    // 请求；找不到则走无锚点路径。
    if (m.role === "assistant" && (m as AssistantMessage).usage.inputTokens > 0) { anchorIdx = i; break }
  }
  // anchorIdx only ever points at an assistant message, and assistant
  // messages always carry usage — the downcast is safe.
  const base = anchorIdx >= 0 ? (active[anchorIdx] as AssistantMessage).usage.inputTokens : 0
  let sum = 0
  for (let i = anchorIdx + 1; i < active.length; i++) sum += estimateTokens(messageText(active[i]!))
  if (extraText !== undefined) sum += estimateTokens(extraText)
  if (anchorIdx < 0 && overheadTokens !== undefined) sum += overheadTokens
  return base + sum
}

/**
 * Per-message estimate WITHOUT the request anchor. For spans that have never
 * been sent as a full request on their own (e.g. the kept tail after a
 * compaction): anchoring there would be wrong — an assistant's inputTokens
 * counts everything from the session start, not just the tail.
 */
export function estimateSpanTokens(messages: Message[]): number {
  let sum = 0
  for (const m of messages) sum += estimateTokens(messageText(m))
  return sum
}

/** One compacted segment: covers history up to (including) message `upto`. */
export interface CompactionSegment { upto: string; summary: string }

/** compaction state persisted on SessionMeta. */
export interface CompactionState { segments: CompactionSegment[]; top: string; upto: string }

/** 当前生效的压缩视图：upto 之前的原文不再发送，top 是总摘要（脉络项内容）。 */
export interface ActiveSummary { upto: string; top: string }

/** One compaction event in a session's event stream. */
export interface CompactionRecord {
  at: string // ISO-8601
  trigger: "auto" | "in-run" | "manual"
  /** 超限紧急压缩（审计标记）；仅自动压缩可能携带。 */
  emergency?: true
  focus?: string
  from: string | null // first message id of the compacted span; null = session start
  upto: string
  messages: number
  segmentSummary: string
  top: string
  /** 压缩前活跃段上下文 token：锚定最后一次真实请求的 inputTokens（含
   *  system/工具定义），锚点后消息逐条估算。会话尚无任何回复时无锚点，
   *  固定开销按调用方传入的估算计（空闲手动压缩传系统提示词基线估算，
   *  不含工具 schema；会话从未运行过则两端口径一同缺失）。 */
  tokensBefore?: number
  /** 压缩后等效上下文 token：保留尾逐条估算 + system/工具定义开销估算 +
   *  总摘要 token（优先生成调用的真实 outputTokens，缺失回退文本估算）+
   *  注入模板常量。 */
  tokensAfter?: number
}

/**
 * Decide the retention boundary. Walks NEWEST→oldest until the
 * accumulated estimate reaches budget×targetRatio — the walk marks the kept
 * part — then backs the start up to the nearest user message so both sides
 * are whole turns (tool calls never split from their results). `keepFrom` 0
 * or no user message at all → undefined (do not compact).
 */
export function chooseBoundary(
  active: Message[],
  opts: { budget: number; targetRatio: number },
): { keepFrom: number } | undefined {
  const target = opts.budget * opts.targetRatio
  let acc = 0
  let stop = 0
  for (let i = active.length - 1; i >= 0; i--) {
    acc += estimateTokens(messageText(active[i]!))
    stop = i
    if (acc >= target) break
  }
  // Accumulator never reached target: the whole history is under target.
  if (acc < target) return undefined
  for (let i = stop; i >= 0; i--) {
    if (active[i]!.role !== "user") continue
    return i === 0 ? undefined : { keepFrom: i }
  }
  return undefined
}

/**
 * 超限急救的强制分界：预算细判在锚点缺失时不可信——急救通常发生
 * 在压缩后的首请求或单轮工具输出暴涨时，active 里可能没有 assistant 锚点，
 * system 与工具定义的固定开销全漏计，估算会明显偏低，chooseBoundary 据此可能
 * 找不到边界。急救不看预算，直接退守最小可行上下文：只保留最近一轮用户轮次
 * （最后一条 user 消息及其之后的整轮），更早的全部压掉。返回 keepFrom；整个
 * active 只有一轮（无早于最后一条 user 消息的内容）时返回 undefined。
 */
export function emergencyBoundary(active: Message[]): number | undefined {
  for (let i = active.length - 1; i >= 0; i--) {
    if (active[i]!.role !== "user") continue
    return i === 0 ? undefined : i
  }
  return undefined
}

/**
 * Map persisted segments back to their original messages.
 * Segment i spans (previous upto | firstFromExclusive | history start) to
 * its own upto. A stale upto yields an empty message list — callers skip it.
 */
export function segmentRanges(
  history: Message[],
  segments: Array<{ upto: string }>,
  firstFromExclusive?: string,
): Array<{ upto: string; messages: Message[] }> {
  const out: Array<{ upto: string; messages: Message[] }> = []
  let startExclusive: string | undefined = firstFromExclusive
  for (const seg of segments) {
    const from = startExclusive === undefined ? -1 : history.findIndex((m) => m.id === startExclusive)
    const to = history.findIndex((m) => m.id === seg.upto)
    out.push({
      upto: seg.upto,
      messages: to > from ? history.slice(from + 1, to + 1) : [],
    })
    startExclusive = seg.upto
  }
  return out
}

const SEGMENT_LINE_MAX = 2_000
const TOOL_ARGS_MAX = 120
const TOOL_RESULT_MAX = 300
/** 错误输出额外保留的尾部窗口：失败的原因几乎总在输出的末尾。 */
const TOOL_RESULT_TAIL_MAX = 200

/**
 * Extract spill locator lines ([完整输出已存盘: …]) from a rendered span's
 * tool results, deduplicated in order. The compactor appends these to the
 * segment/top summaries STRUCTURALLY — the pointer to the full copy is
 * code-guaranteed to survive, not left to the summarizer's discretion.
 */
export function extractSpillLocators(messages: Message[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    for (const b of m.blocks) {
      if (!isBlockType("tool_result", b)) continue
      for (const line of b.output.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.startsWith(SPILL_LOCATOR_PREFIX) && trimmed.endsWith("]") && !out.includes(trimmed)) {
          out.push(trimmed)
        }
      }
    }
  }
  return out
}

/**
 * Compaction/extraction input rendering: one line per
 * message; tool activity condensed (call `→ name(args)`, result `⇐ head`).
 * Error-status results keep head AND tail slices — the actual failure reason
 * almost always sits at the tail. Spill locator lines survive verbatim even
 * when the surrounding output truncates, so the pointer to the full copy
 * reaches the summary model.
 */
export function renderSegment(messages: Message[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const parts: string[] = []
    for (const b of m.blocks) {
      if (isBlockType("text", b)) parts.push(b.text)
      else if (isBlockType("note", b)) parts.push(b.text)
      else if (isBlockType("tool_call", b)) {
        const args = b.argsJson.length > TOOL_ARGS_MAX ? `${b.argsJson.slice(0, TOOL_ARGS_MAX)}…` : b.argsJson
        parts.push(`→ ${b.name}(${args})`)
      } else if (isBlockType("tool_result", b)) {
        // Spill locator lines live at the END of a truncated output — pull
        // them out before slicing so the pointer never gets cut.
        const locatorIdx = b.output.lastIndexOf(`\n${SPILL_LOCATOR_PREFIX}`)
        const hasLocator = locatorIdx >= 0 && b.output.slice(locatorIdx).trimEnd().endsWith("]")
        const body = hasLocator ? b.output.slice(0, locatorIdx) : b.output
        const locator = hasLocator ? "\n" + b.output.slice(locatorIdx + 1).trim() : ""
        if (b.status === "error" && body.length > TOOL_RESULT_MAX + TOOL_RESULT_TAIL_MAX) {
          const tail = body.slice(-TOOL_RESULT_TAIL_MAX)
          parts.push(`⇐ [错误] ${body.slice(0, TOOL_RESULT_MAX)}…[中略]…${tail}${locator}`)
        } else {
          const prefix = b.status === "error" ? "[错误] " : ""
          const head = body.length > TOOL_RESULT_MAX ? `${body.slice(0, TOOL_RESULT_MAX)}…` : body
          parts.push(`⇐ ${prefix}${head}${locator}`)
        }
      }
    }
    const body = parts.join(" ").trim()
    let line = `${m.role}: ${body === "" ? "<tool use>" : body}`
    if (line.length > SEGMENT_LINE_MAX) line = line.slice(0, SEGMENT_LINE_MAX)
    lines.push(line)
  }
  return lines.join("\n")
}
