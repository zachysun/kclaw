import type { AgentEvent } from "../protocol/events.js"
import { makeEvent } from "../protocol/events.js"
import type { LlmClient } from "../provider/types.js"
import type { SessionStore } from "./store.js"

export interface AutonameDeps {
  sessions: SessionStore
  llm: LlmClient
  model: string
  titleFor?: (firstText: string) => Promise<string>
  /** Optional event sink: a successful rename is announced as session.renamed. */
  emit?: (e: AgentEvent) => void
}

export function scheduleAutoname(deps: AutonameDeps, sessionId: string, firstText: string): Promise<void> {
  const meta = deps.sessions.meta(sessionId)
  // 只有标题还是默认"新会话"才命名（手动改过的会话不覆盖）
  if (meta === undefined || meta.title !== "新会话") return Promise.resolve()
  return (async () => {
    try {
      const title = await (deps.titleFor ?? ((t: string) => defaultTitle(deps.llm, deps.model, t)))(firstText)
      const t = title.trim().slice(0, 30)
      if (t === "") return
      // 写回前重读 meta：生成标题期间用户可能已手动改名，此时不覆盖
      const current = deps.sessions.meta(sessionId)
      if (current === undefined || current.title !== "新会话") return
      deps.sessions.updateMeta(sessionId, { title: t })
      deps.emit?.(makeEvent("session.renamed", { title: t }, { sessionId }))
    } catch {
      // 失败静默，保持无标题
    }
  })()
}

export async function defaultTitle(llm: LlmClient, model: string, firstText: string): Promise<string> {
  let out = ""
  for await (const ev of llm.stream({
    model,
    system: "你是标题生成助手，只输出一个不超过30字的会话标题。",
    messages: [{ role: "user", content: `给这段对话起一个不超过30字的标题：\n${firstText}` }],
    tools: [],
  })) {
    if (ev.type === "text_delta") out += ev.delta
  }
  return out.trim()
}
