import { newId } from "./ids.js"
import type { Block } from "./blocks.js"

export type Role = "user" | "assistant" | "tool"

export type StopReason =
  | "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
  | "content_filter" | "aborted" | "error"

export interface Usage { inputTokens: number; outputTokens: number }

export interface Message {
  id: string
  sessionId: string
  role: Role
  blocks: Block[]
  createdAt: string // ISO-8601
}

export interface AssistantMessage extends Message {
  role: "assistant"
  model: string
  usage: Usage
  stopReason: StopReason
}

/** Why a tool call was allowed to run. */
export type GrantedBy = "safe" | "whitelist" | "session_grant" | "confirmed" | "accept_edits" | "learned"

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
