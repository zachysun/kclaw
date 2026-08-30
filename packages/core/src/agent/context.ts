import type { Message } from "../protocol/messages.js"
import { isBlockType } from "../protocol/blocks.js"
import type { ContentPart, ProviderMessage, ProviderToolCall } from "../provider/types.js"
import { estimateTokens } from "../session/compaction.js"
import type { ActiveSummary } from "../session/compaction.js"

export function toProviderMessages(
  history: Message[],
  window: number,
  opts?: { toolResultKeep?: number; tokenBudget?: number; summary?: ActiveSummary },
): ProviderMessage[] {
  const recent = history.slice(-window)
  // A tool message whose paired assistant message fell outside the window is
  // unusable for OpenAI-compatible APIs — drop leading orphans.
  while (recent.length > 0 && recent[0].role === "tool") recent.shift()

  // ---- 工具结果收集（最新→最旧）----
  const results: Array<{ callId: string; output: string }> = []
  for (let i = recent.length - 1; i >= 0; i--) {
    for (const b of recent[i]!.blocks) {
      if (isBlockType("tool_result", b)) results.push({ callId: b.callId, output: b.output })
    }
  }
  // 循环从最新消息扫到最旧，收集结果天然已是最新在前（无需再 reverse）

  const evict = new Set<string>()
  const keep = opts?.toolResultKeep
  const capped = keep !== undefined ? results.slice(0, keep) : results
  for (const r of results.slice(capped.length)) evict.add(r.callId) // 条数上限（原语义，现为上限而非固定数）

  if (opts?.tokenBudget !== undefined && capped.length > 0) {
    // 基线 = 非工具结果内容的估算 + 每个被条数上限挤掉结果的占位行（约 30 token）
    // （system 提示与工具定义的固定开销不含在内：触发线本身已为其留了余量）
    let acc = 0
    for (const m of recent) {
      for (const b of m.blocks) {
        if (isBlockType("text", b) || isBlockType("thinking", b) || isBlockType("note", b)) acc += estimateTokens(b.text)
        else if (isBlockType("tool_call", b)) acc += estimateTokens(b.argsJson)
        else if (isBlockType("attachment", b) && b.text !== undefined) acc += estimateTokens(b.text)
      }
    }
    acc += results.slice(capped.length).length * 30
    // 最新→最旧逐条装：装得下保留，装不下（含它之后全部）省略
    for (const r of capped) {
      const t = estimateTokens(r.output)
      if (acc + t > opts.tokenBudget) evict.add(r.callId)
      else acc += t
    }
  }

  // callId → tool name/args for placeholder text
  const callMeta = new Map<string, { name: string; args: string }>()
  for (const m of recent) {
    if (m.role !== "assistant") continue
    for (const b of m.blocks) {
      if (isBlockType("tool_call", b)) callMeta.set(b.callId, { name: b.name, args: b.argsJson.slice(0, 60) })
    }
  }
  const out: ProviderMessage[] = []
  if (opts?.summary !== undefined) {
    out.push({ role: "system", content: `早期对话脉络：${opts.summary.top}` })
  }
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i]!
    if (m.role === "user" || m.role === "assistant") {
      const parts: string[] = []
      const images: ContentPart[] = []
      const toolCalls: ProviderToolCall[] = []
      // Defense in depth: an assistant tool_call whose tool message is NOT in
      // the window (e.g. dangling from an aborted stream) must not reach the
      // provider — unpaired tool_calls make OpenAI-compat APIs 400.
      const answered = new Set<string>()
      for (let j = i + 1; j < recent.length && recent[j]!.role === "tool"; j++) {
        for (const b of recent[j]!.blocks) {
          if (isBlockType("tool_result", b)) answered.add(b.callId)
        }
      }
      for (const b of m.blocks) {
        if (isBlockType("text", b)) parts.push(b.text)
        else if (isBlockType("note", b)) parts.push(`[system note] ${b.text}`)
        else if (isBlockType("attachment", b)) {
          const label = b.name ?? "附件"
          if (b.source.type === "base64" && b.mimeType.startsWith("image/")) {
            images.push({ type: "image_url", image_url: { url: `data:${b.mimeType};base64,${b.source.data}` } })
          } else if (b.text !== undefined) {
            parts.push(`[附件 ${label}]\n${b.text}`)
          } else {
            parts.push(`[附件 ${label}（${b.mimeType}，仅元数据）已保存，路径 ${"path" in b.source ? b.source.path : ""}，可用 fs_read 读取]`)
          }
        }
        else if (isBlockType("tool_call", b) && m.role === "assistant" && answered.has(b.callId)) {
          toolCalls.push({ callId: b.callId, name: b.name, argsJson: b.argsJson })
        }
      }
      if (m.role === "user") {
        if (images.length > 0) {
          const content: ContentPart[] = [{ type: "text", text: parts.join("\n") }, ...images]
          out.push({ role: "user", content })
        } else {
          out.push({ role: "user", content: parts.join("\n") })
        }
      } else {
        const content = parts.length ? parts.join("\n") : null
        // an assistant with neither content nor toolCalls has nothing usable
        if (content !== null || toolCalls.length > 0) {
          out.push({ role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) })
        }
      }
    } else {
      for (const b of m.blocks) {
        if (isBlockType("tool_result", b)) {
          const content = evict.has(b.callId)
            ? `[此工具输出已省略：${callMeta.get(b.callId)?.name ?? b.callId} ${callMeta.get(b.callId)?.args ?? ""}，可重新调用获取]${b.status === "error" ? "（该次调用失败）" : ""}`
            : b.status === "error" ? `[error] ${b.output}` : b.output
          out.push({ role: "tool", toolCallId: b.callId, content })
        }
      }
    }
  }
  return out
}
