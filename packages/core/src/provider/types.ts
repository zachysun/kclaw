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

/** A multimodal content part inside a user message (images are data: URLs). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

export type ProviderMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; toolCalls?: ProviderToolCall[] }
  | { role: "tool"; toolCallId: string; content: string }

export interface LlmRequest {
  model: string
  system: string
  messages: ProviderMessage[]
  tools: ToolDefinition[]
  maxTokens?: number
  /**
   * Sampling temperature pass-through. Interactive runs leave it unset
   * (provider default); the goal judge (issue #47) pins 0 for stable
   * verdicts. Clients that cannot express it ignore the field.
   */
  temperature?: number
  /**
   * Prompt-cache routing hint. ABSENT = the request carries no cache markers
   * at all — the payload stays byte-identical to the pre-cache shape (one-shot
   * helper calls: compaction summaries, goal judge, autoname). Present, the
   * Anthropic adapter places its cache_control breakpoints and the
   * OpenAI-compatible adapter sends prompt_cache_key=key — unless the provider
   * entry opted out via config (promptCache:"off"; config wins over the field).
   */
  promptCache?: { key?: string }
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
