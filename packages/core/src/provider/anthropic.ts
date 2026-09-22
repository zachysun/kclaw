import type { ContentPart, LlmClient, LlmRequest, LlmStreamEvent } from "./types.js"
import type { StopReason, Usage } from "../protocol/messages.js"
import type { ProviderApiFormat } from "../storage/config.js"
import { DEFAULT_LLM_TIMEOUT_MS, llmHttpError, rethrowClassified, sseDataLines } from "./openai-compat.js"

/** Value of the mandatory anthropic-version header on every Messages API call. */
export const ANTHROPIC_VERSION = "2023-06-01"

/**
 * The Messages API requires max_tokens; when the entry declares no maxOutput
 * the request carries this default instead of the provider picking one.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192

/**
 * Anthropic base URLs conventionally exclude the version segment (the
 * official base is https://api.anthropic.com), but users pasting a proxy
 * base often already include /v1 — accept both: a trailing /v1 is kept and
 * the path appended, otherwise /v1 is inserted. Shared with the models-list
 * probe (probe.ts).
 */
export function anthropicEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, "")
  return base.endsWith("/v1") ? `${base}${path}` : `${base}/v1${path}`
}

/**
 * Per-format request policy, shared by the streaming clients AND the probes
 * so an auth-semantics change lands exactly once (the dual-header fix had to
 * touch three hand-kept copies before this existed).
 */

/**
 * Auth headers for one format: Bearer for OpenAI-compatible bases;
 * anthropic-version plus x-api-key + Bearer for Anthropic bases — the
 * official API prefers x-api-key when both are present, while some
 * Anthropic-compatible gateways only read Bearer on their models route. An
 * empty apiKey sends no auth header (local runtimes). content-type is NOT
 * included; callers add it per request shape.
 */
export function formatAuthHeaders(format: ProviderApiFormat, apiKey: string): Record<string, string> {
  if (format === "anthropic") {
    return {
      "anthropic-version": ANTHROPIC_VERSION,
      ...(apiKey === "" ? {} : { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` }),
    }
  }
  return apiKey === "" ? {} : { authorization: `Bearer ${apiKey}` }
}

/**
 * Endpoint URL for one format: Anthropic bases get the /v1 tolerance
 * (anthropicEndpoint), OpenAI-compatible bases concatenate the path.
 */
export function formatEndpoint(format: ProviderApiFormat, baseUrl: string, path: string): string {
  return format === "anthropic" ? anthropicEndpoint(baseUrl, path) : `${baseUrl.replace(/\/$/, "")}${path}`
}

function toContentBlock(part: ContentPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text }
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url)
  if (data !== null) {
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }
  }
  return { type: "image", source: { type: "url", url: part.image_url.url } }
}

interface AnthropicOutMessage {
  role: "user" | "assistant"
  content: Array<Record<string, unknown>>
}

/**
 * Map the internal request to a Messages API payload: system-role messages
 * fold into the top-level `system`, tool results merge into one user message
 * (the API takes tool_result blocks inside user turns), and empty assistant
 * turns are dropped (the API rejects empty content).
 */
function toAnthropicPayload(req: LlmRequest): Record<string, unknown> {
  const systemParts = [req.system]
  const messages: AnthropicOutMessage[] = []
  const pushToolResult = (toolUseId: string, content: string): void => {
    const last = messages[messages.length - 1]
    const block = { type: "tool_result", tool_use_id: toolUseId, content }
    if (last !== undefined && last.role === "user" && last.content.length > 0
      && last.content.every((b) => b.type === "tool_result")) {
      last.content.push(block)
    } else {
      messages.push({ role: "user", content: [block] })
    }
  }
  for (const m of req.messages) {
    if (m.role === "system") { systemParts.push(m.content); continue }
    if (m.role === "user") {
      messages.push({
        role: "user",
        content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map(toContentBlock),
      })
    } else if (m.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = []
      if (m.content !== null && m.content !== "") blocks.push({ type: "text", text: m.content })
      for (const t of m.toolCalls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(t.argsJson) } catch { input = {} }
        blocks.push({ type: "tool_use", id: t.callId, name: t.name, input })
      }
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks })
    } else {
      pushToolResult(m.toolCallId, m.content)
    }
  }
  return {
    model: req.model,
    system: systemParts.join("\n\n"),
    messages,
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream: true,
  }
}

interface AnthropicSseEvent {
  type?: string
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  index?: number
  content_block?: { type?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  tool_use: "tool_use",
  stop_sequence: "stop_sequence",
  refusal: "content_filter",
}

function normalizeStop(raw: string | null | undefined): StopReason {
  if (raw == null) return "end_turn"
  return STOP_REASONS[raw] ?? "end_turn"
}

/**
 * Streaming client for the Anthropic Messages wire format (x-api-key +
 * anthropic-version headers, content-block streaming). The same key is also
 * sent as Authorization: Bearer — Anthropic-compatible gateways differ in
 * which header they read, and the official API prefers x-api-key when both
 * are present. Same timeout/retry contract as the OpenAI-compatible client:
 * the abort fires at timeoutMs and any post-abort failure is reclassified as
 * the `llm http timeout` message.
 */
export function createAnthropicClient(opts: {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): LlmClient {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  return {
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      const signal = AbortSignal.timeout(timeoutMs)
      let res: Response
      try {
        res = await doFetch(anthropicEndpoint(opts.baseUrl, "/messages"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...formatAuthHeaders("anthropic", opts.apiKey),
          },
          body: JSON.stringify(toAnthropicPayload(req)),
          signal,
        })
      } catch (err) {
        rethrowClassified(err, signal, timeoutMs)
      }
      if (!res.ok || res.body === null) {
        let text = ""
        try {
          text = await res.text()
        } catch (err) {
          if (signal.aborted) throw new Error(`llm http timeout after ${timeoutMs}ms`)
          void err
        }
        throw llmHttpError(res.status, text)
      }
      let usage: Usage = { inputTokens: 0, outputTokens: 0 }
      let finish: string | null = null
      try {
        for await (const line of sseDataLines(res.body)) {
          const ev = JSON.parse(line) as AnthropicSseEvent
          if (ev.type === "message_start") {
            usage = {
              inputTokens: ev.message?.usage?.input_tokens ?? 0,
              outputTokens: ev.message?.usage?.output_tokens ?? 0,
            }
          } else if (ev.type === "content_block_start") {
            if (ev.content_block?.type === "tool_use") {
              yield {
                type: "tool_call_started",
                index: ev.index ?? 0,
                callId: ev.content_block.id ?? `call_idx_${ev.index ?? 0}`,
                name: ev.content_block.name ?? "",
              }
            }
          } else if (ev.type === "content_block_delta") {
            const d = ev.delta
            if (d?.type === "text_delta" && d.text != null && d.text !== "") yield { type: "text_delta", delta: d.text }
            else if (d?.type === "thinking_delta" && d.thinking != null && d.thinking !== "") yield { type: "thinking_delta", delta: d.thinking }
            else if (d?.type === "input_json_delta" && d.partial_json != null && d.partial_json !== "") {
              yield { type: "tool_call_delta", index: ev.index ?? 0, delta: d.partial_json }
            }
          } else if (ev.type === "message_delta") {
            if (ev.delta?.stop_reason != null) finish = ev.delta.stop_reason
            if (ev.usage?.output_tokens != null) usage = { ...usage, outputTokens: ev.usage.output_tokens }
          } else if (ev.type === "message_stop") {
            break
          } else if (ev.type === "error") {
            throw new Error(`llm anthropic ${ev.error?.type ?? "error"}: ${ev.error?.message ?? "unknown error"}`)
          }
        }
      } catch (err) {
        rethrowClassified(err, signal, timeoutMs)
      }
      yield { type: "message_done", stopReason: normalizeStop(finish), usage }
    },
  }
}
