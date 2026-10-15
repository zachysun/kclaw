import { newId } from "./ids.js"
import type { Block } from "./blocks.js"

export type Role = "user" | "assistant" | "tool"

export type StopReason =
  | "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
  | "content_filter" | "aborted" | "error"

/**
 * Token usage of one LLM call. `inputTokens` is the TOTAL input: on Anthropic
 * it sums non-cached + cache-read + cache-write; on OpenAI-compatible
 * endpoints prompt_tokens already is that total. The cache fields are
 * OPTIONAL and absent = UNKNOWN (an endpoint that reports no cache metrics),
 * never 0 — readers must not collapse the two.
 */
export interface Usage {
  inputTokens: number
  outputTokens: number
  /** Tokens served from the prompt cache (Anthropic cache_read_input_tokens / OpenAI cached_tokens). */
  cacheReadTokens?: number
  /** Tokens written to the prompt cache (Anthropic cache_creation_input_tokens; OpenAI has no write metric). */
  cacheWriteTokens?: number
}

/**
 * Field-level usage merge, used wherever per-call usages fold into one run
 * total: numeric fields sum; a cache field absent from ANY input poisons the
 * result's field to undefined (unknown — never a partial sum, never 0, so a
 * run across mixed cache-reporting endpoints never displays a fake hit rate).
 * The inputTokens identity (non-cached + cache-read + cache-write) stays the
 * callers' invariant (docs/core/provider.md).
 */
export function mergeUsage(...usages: Array<Usage | undefined>): Usage {
  let inputTokens = 0
  let outputTokens = 0
  let readSum = 0
  let readSeen = false
  let readPoisoned = false
  let writeSum = 0
  let writeSeen = false
  let writePoisoned = false
  for (const u of usages) {
    if (u === undefined) continue
    inputTokens += u.inputTokens
    outputTokens += u.outputTokens
    if (u.cacheReadTokens === undefined) readPoisoned = true
    else { readSum += u.cacheReadTokens; readSeen = true }
    if (u.cacheWriteTokens === undefined) writePoisoned = true
    else { writeSum += u.cacheWriteTokens; writeSeen = true }
  }
  const cacheReadTokens = readPoisoned || !readSeen ? undefined : readSum
  const cacheWriteTokens = writePoisoned || !writeSeen ? undefined : writeSum
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  }
}

export interface Message {
  id: string
  sessionId: string
  role: Role
  blocks: Block[]
  createdAt: string // ISO-8601
  /**
   * 用户消息专用：该消息首发送时经隐式包装（技能指名 / @文件指示）后的最终
   * 文本。组装 provider 视图时按此值原样重放——技能目录与被引用文件内容
   * 随时间变化，现算包装会让同一条历史在不同 run 组装出不同字节，缓存前缀
   * 从该消息起断裂。显示层（气泡/事件流）与 blocks.text 始终保持原文。
   */
  llmText?: string
}

export interface AssistantMessage extends Message {
  role: "assistant"
  model: string
  usage: Usage
  stopReason: StopReason
  /** Wall-clock LLM generation time in ms (measured at stream completion); present only on successful completions, so historical messages may lack it. */
  latencyMs?: number
}

/** Why a tool call was allowed to run. */
export type GrantedBy = "safe" | "whitelist" | "session_grant" | "confirmed" | "accept_edits" | "learned" | "sandboxed" | "trusted"

export interface ToolMessage extends Message {
  role: "tool"
  /** callId → granted reason, for calls the gate allowed to run. */
  grantedBy?: Record<string, GrantedBy>
}

export function newMessage(sessionId: string, role: Role, blocks: Block[]): Message {
  return { id: newId("msg"), sessionId, role, blocks, createdAt: new Date().toISOString() }
}

export function newToolMessage(sessionId: string, blocks: Block[], grantedBy?: Record<string, GrantedBy>): ToolMessage {
  const m = newMessage(sessionId, "tool", blocks)
  const t: ToolMessage = { ...m, role: "tool" }
  if (grantedBy !== undefined) t.grantedBy = grantedBy
  return t
}

export function newAssistantMessage(
  sessionId: string, model: string, blocks: Block[],
  usage: Usage = { inputTokens: 0, outputTokens: 0 },
  stopReason: StopReason = "end_turn",
): AssistantMessage {
  return { ...newMessage(sessionId, "assistant", blocks), role: "assistant", model, usage, stopReason }
}
