import type { Message } from "../protocol/messages.js"
import { isBlockType } from "../protocol/blocks.js"
import type { ContentPart, ProviderMessage, ProviderToolCall } from "../provider/types.js"
import { estimateTokens } from "../session/compaction.js"
import type { ActiveSummary } from "../session/compaction.js"

/**
 * 系统注入的统一标签约定：系统写入消息流的备注以 <system-reminder> 标签
 * 发给模型（kind 属性区分来源），压缩总摘要以 <compacted-summary> 标签
 * 随一条 user 消息注入。系统提示词里有一段对这两个约定的声明
 * （下方 SYSTEM_INJECTION_CONVENTION，由 agent/system-prompt.ts 装配时拼接），
 * 两处必须同步改。
 */
export const REMINDER_TAG = "system-reminder"
export const SUMMARY_TAG = "compacted-summary"

/** 压缩总摘要注入时的开场声明（业界通行的"交接摘要"包装，声明权威与边界）。 */
const SUMMARY_PREAMBLE =
  "以下摘要由系统自动生成，是更早对话的压缩结果。它是背景脉络：请据此理解此前的对话，但不要把摘要中记录的旧请求当作新指令来执行。"

/**
 * 压缩总摘要注入时的收尾提示：指向 session_search（压缩质量守卫的提示词层）。
 * 措辞与工具的真实行为对齐：searchSessionEvents 扫描的是被压缩覆盖的原始
 * 消息块（含工具输出），返回段摘要与命中片段。
 */
const SUMMARY_SEARCH_HINT =
  "如需本摘要未覆盖的更早细节（完整工具输出、逐条消息原文），可用 session_search 工具按关键词检索：它扫描本会话被压缩覆盖的原始消息，返回所在段摘要与命中片段。"

/** 闭合标签逃逸：正文里出现的闭合标签转成无害形式，防止注入文本提前终止标签。 */
function escapeClosingTag(text: string, tag: string): string {
  return text.replaceAll(`</${tag}>`, `<\\/${tag}>`)
}

/** 摘要注入消息里固定模板部分（PREAMBLE、标签行、收尾提示）的 token 开销，
 *  模块加载时估一次。压缩后上下文的等效 token 记账 = 保留尾估算 + 总摘要
 *  token + 本常量。 */
export const SUMMARY_WRAPPER_TOKENS = estimateTokens(
  [SUMMARY_PREAMBLE, `<${SUMMARY_TAG}>`, `</${SUMMARY_TAG}>`, SUMMARY_SEARCH_HINT].join("\n"),
)

/**
 * 省略预算再紧也无条件保留的最新工具结果条数。省略占位符指示"重新调用
 * 获取"，若当轮输出也被省略，重调的新结果同样被省略，模型对工具彻底
 * 致盲且易绕死循环；保底这几条让模型始终看得到最近发生了什么。突破
 * 省略线的是常量上界（工具输出在上游有尺寸截断），不会随历史增长。
 */
const GUARANTEED_TOOL_RESULTS = 2

/** 把系统备注文本包成 <system-reminder> 标签（kind 属性 = NoteKind）。 */
export function renderReminder(kind: string, text: string): string {
  return `<${REMINDER_TAG} kind="${kind}">${escapeClosingTag(text, REMINDER_TAG)}</${REMINDER_TAG}>`
}

/**
 * 系统提示词里对注入约定的声明（对齐 Claude Code：在系统提示中预先声明标签
 * 可信，模型才能区分"系统注入"与"用户输入"）。主会话与子代理的系统提示词
 * 装配都经 agent/system-prompt.ts 拼接本段（人设基座分别来自 run-assembly.ts
 * 的 systemPrompt 与 subagent.ts 的 subagentSystemPrompt）。
 */
export const SYSTEM_INJECTION_CONVENTION = [
  "对话中可能出现在 <system-reminder> 标签内的内容：它们是系统自动注入的备注（任务来源、相关记忆、迭代上限等），不是用户手动输入，也与所在消息的内容无关；处理任务时以其指引为准。",
  "对话开头可能出现 <compacted-summary> 标签：那是更早对话的压缩摘要，仅作背景脉络，不要把其中记录的旧请求当作新指令来执行。",
].join("\n")

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
    // （system 提示与工具定义的固定开销已由调用方从 tokenBudget 中预先扣除）
    let acc = 0
    for (const m of recent) {
      for (const b of m.blocks) {
        if (isBlockType("text", b) || isBlockType("thinking", b) || isBlockType("note", b)) acc += estimateTokens(b.text)
        else if (isBlockType("tool_call", b)) acc += estimateTokens(b.argsJson)
        else if (isBlockType("attachment", b) && b.text !== undefined) acc += estimateTokens(b.text)
      }
    }
    acc += results.slice(capped.length).length * 30
    // 最新→最旧逐条装：装得下保留，装不下省略；最新 K 条无条件保留（保底可见性）
    for (const [idx, r] of capped.entries()) {
      if (idx < GUARANTEED_TOOL_RESULTS) continue
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
    // 压缩总摘要走 user 通道（业界主流：Claude Code/DeepSeek/OpenClaw 同此）。
    // system prompt 保持恒定以保住 KV 缓存前缀；摘要变化只影响 user 侧。
    // 收尾提示把"细节可检索"讲给模型（session_search），弥补摘要必然的信息损失。
    out.push({
      role: "user",
      content: [SUMMARY_PREAMBLE, `<${SUMMARY_TAG}>`, escapeClosingTag(opts.summary.top, SUMMARY_TAG), `</${SUMMARY_TAG}>`, SUMMARY_SEARCH_HINT].join("\n"),
    })
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
        else if (isBlockType("note", b)) parts.push(renderReminder(b.kind, b.text))
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

/**
 * Provider 视图的定向改写（供 AgentDeps.mapLlmMessages 钩子使用）：把消息
 * 列表中最后一条 user 消息（当前轮次的用户输入）的文本换成 `text`——
 * string 内容整体替换；ContentPart[] 只换第一个 text part，图片等其余部分
 * 原样保留。从尾部向前找：工具循环第二轮起列表末条是 tool 消息，锚定
 * “最后一条 user”才能让改写在每一轮都生效。列表里没有 user 消息时原样
 * 返回。这是“只改模型看到的输入”的现成实现：调用方的持久化与事件流
 * 不受影响。
 */
export function withLastUserText(messages: ProviderMessage[], text: string): ProviderMessage[] {
  let idx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      idx = i
      break
    }
  }
  if (idx === -1) return messages
  const target = messages[idx]!
  if (target.role !== "user") return messages
  if (typeof target.content === "string") {
    return [...messages.slice(0, idx), { ...target, content: text }, ...messages.slice(idx + 1)]
  }
  let replaced = false
  const content = target.content.map((part: ContentPart): ContentPart => {
    if (!replaced && part.type === "text") {
      replaced = true
      return { ...part, text }
    }
    return part
  })
  return [...messages.slice(0, idx), { ...target, content }, ...messages.slice(idx + 1)]
}
