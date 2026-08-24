import type { IdPrefix } from "./ids.js"
import { newId } from "./ids.js"

export type BlockId = string

export interface TextBlock { id: BlockId; type: "text"; text: string }
export interface ThinkingBlock { id: BlockId; type: "thinking"; text: string }

export interface ToolCallBlock {
  id: BlockId
  type: "tool_call"
  callId: string
  name: string
  args: unknown
  argsJson: string
}

export type ToolStatus = "ok" | "error"

export interface ToolResultBlock {
  id: BlockId
  type: "tool_result"
  callId: string
  status: ToolStatus
  output: string
  data?: unknown
  durationMs: number
}

export type NoteKind = "system" | "job" | "memory" | "timeout" | "denied" | "compact"

export interface NoteBlock { id: BlockId; type: "note"; kind: NoteKind; text: string }

export type AttachmentSource =
  | { type: "base64"; data: string }
  | { type: "url"; url: string }
  | { type: "file"; path: string }

export interface AttachmentBlock {
  id: BlockId
  type: "attachment"
  mimeType: string
  text?: string
  source: AttachmentSource
}

export type Block =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | NoteBlock
  | AttachmentBlock

export type BlockType = Block["type"]

const blockTypes: ReadonlySet<string> = new Set([
  "text", "thinking", "tool_call", "tool_result", "note", "attachment",
])

export function isBlockType<T extends BlockType>(t: T, v: unknown): v is Extract<Block, { type: T }> {
  return typeof v === "object" && v !== null && (v as { type?: string }).type === t && blockTypes.has(t)
}

export function newBlockId(): BlockId {
  return newId("blk")
}
