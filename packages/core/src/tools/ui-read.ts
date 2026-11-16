// packages/core/src/tools/ui-read.ts
/**
 * ui_read: fetch back the UI Cards this session already produced. The DSL
 * never re-enters model context at render time (ui_render returns a short
 * receipt only), so after a compaction the model has no data behind a user
 * question like "表格第三行是什么" — this tool re-reads the session's
 * message projection and hands the original card JSON back on demand.
 *
 * Deferred exposure: zero resident cost (not in any request until promoted
 * via tool_search). Read-only over the session projection → safe + parallel,
 * the same class as session_search. Card detection goes through the shared
 * protocol sniff (isUiCardData), not a private kind list.
 */
import type { ToolExecutor } from "../agent/tools.js"
import type { Message } from "../protocol/messages.js"
import { isUiCardData, type UICard } from "../protocol/ui-cards.js"
import { def, makeTool, optString, str, ToolError, type ToolEntry } from "./shared.js"

/** Lazy per-run backing: the session's projected messages at call time. */
export type UiCardsFn = () => Message[]

/** How many cards the no-arg listing returns (most recent wins). */
const LIST_LIMIT = 10

interface CardEntry {
  callId: string
  card: UICard
  messageId: string
}

function collectCards(messages: Message[]): CardEntry[] {
  const out: CardEntry[] = []
  for (const m of messages) {
    if (m.role !== "tool") continue
    for (const b of m.blocks) {
      if (b.type !== "tool_result" || b.data === undefined) continue
      if (!isUiCardData(b.data)) continue
      out.push({ callId: b.callId, card: b.data, messageId: m.id })
    }
  }
  return out
}

function listLines(entries: CardEntry[]): string {
  return entries
    .slice(-LIST_LIMIT)
    .map((e) => {
      const title = "title" in e.card && typeof e.card.title === "string" && e.card.title !== "" ? ` ·《${e.card.title}》` : ""
      return `- ${e.callId} · ${e.card.kind}${title} · ${e.messageId}`
    })
    .join("\n")
}

export function createUiReadTools(cards?: UiCardsFn): { "ui_read": ToolExecutor & { name: "ui_read" } } {
  const ui_read = makeTool("ui_read", "safe", "parallel", async (args) => {
    const callId = optString(args, "callId")
    if (cards === undefined) return { status: "ok", output: "(无可读取的 UI 卡)" }
    const entries = collectCards(cards())
    if (entries.length === 0) return { status: "ok", output: "(本会话还没有 UI 卡)" }
    if (callId === undefined) {
      return {
        status: "ok",
        output: `本会话共 ${entries.length} 张 UI 卡，最近 ${Math.min(entries.length, LIST_LIMIT)} 张（用 callId 取回完整数据）：\n${listLines(entries)}`,
      }
    }
    const hit = entries.find((e) => e.callId === callId)
    if (hit === undefined) {
      throw new ToolError(`找不到 callId ${callId}。最近的卡：\n${listLines(entries)}`)
    }
    const title = "title" in hit.card && typeof hit.card.title === "string" && hit.card.title !== "" ? `《${hit.card.title}》` : ""
    return {
      status: "ok",
      output: `UI 卡 ${hit.callId}（${hit.card.kind}${title}，来自消息 ${hit.messageId}）：\n${JSON.stringify(hit.card)}`,
    }
  })
  return { ui_read }
}

/** The registry-facing bundle: executor + schema owned beside each other. */
export function createUiReadToolEntries(cards?: Parameters<typeof createUiReadTools>[0]): ToolEntry[] {
  return [
    {
      name: "ui_read",
      tool: createUiReadTools(cards).ui_read,
      def: def(
        "ui_read",
        "读取本会话已产出的 UI 卡：不带参数列出最近的卡片清单（callId/类型/标题），带 callId 返回该卡的完整组件描述 JSON。会话压缩后需要引用图表、表格等已渲染数据时用。",
        { callId: str("要取回的卡片 callId；先不带参数列出清单再挑") },
        [],
      ),
    },
  ]
}
