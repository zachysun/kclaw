import type { StopReason, Usage } from "../protocol/messages.js"

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
}

export interface ProviderToolCall {
  callId: string
  name: string
  argsJson: string
}

export type ProviderMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ProviderToolCall[] }
  | { role: "tool"; toolCallId: string; content: string }

export interface LlmRequest {
  model: string
  system: string
  messages: ProviderMessage[]
  tools: ToolDefinition[]
  maxTokens?: number
}

export type LlmStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_started"; index: number; callId: string; name: string }
  | { type: "tool_call_delta"; index: number; delta: string }
  | { type: "message_done"; stopReason: StopReason; usage: Usage }

export interface LlmClient {
  stream(req: LlmRequest): AsyncIterable<LlmStreamEvent>
}
