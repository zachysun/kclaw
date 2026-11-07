/**
 * The TUI's data fetches (all daemon HTTP, same endpoints the WebUI uses):
 * session meta for the status line and terminal title, the message list for
 * the Ctrl+O transcript snapshot and the input history (spec B3/B8), and the
 * workspace file list for the @ menu (spec B5). All best-effort at their
 * call sites — a dead daemon degrades the UI, it never breaks the chat.
 */
import type { Message } from "@kclaw/core"
import type { KclawClient } from "../client.js"
import type { TranscriptEntry } from "./store.js"

export interface SessionMetaLite {
  title?: string
  model?: string
  workdir?: string
}

export async function fetchSessionMeta(client: KclawClient, sessionId: string): Promise<SessionMetaLite> {
  return (await client.request("GET", `/sessions/${encodeURIComponent(sessionId)}`)) as SessionMetaLite
}

export async function fetchMessages(client: KclawClient, sessionId: string): Promise<Message[]> {
  const list = (await client.request("GET", `/sessions/${encodeURIComponent(sessionId)}/messages`)) as unknown
  return Array.isArray(list) ? (list as Message[]) : []
}

export async function fetchWorkspaceFiles(client: KclawClient, workdir: string | undefined): Promise<string[]> {
  const query = workdir !== undefined && workdir !== "" ? `?workdir=${encodeURIComponent(workdir)}` : ""
  const result = (await client.request("GET", `/fs/files${query}`)) as { files?: unknown }
  return Array.isArray(result.files) ? (result.files as string[]) : []
}

const noteText = (text: string): string => `[note] ${text}`
const attachmentLabel = (block: { name?: string; source?: { type?: string; path?: string } }): string => {
  const name = typeof block.name === "string" && block.name !== "" ? block.name : block.source?.path
  return `附件 ${name ?? "（未命名）"}`
}

/**
 * Flatten the message list into transcript entries: user text/notes as-is,
 * assistant text and thinking verbatim, tool calls paired with their results
 * by callId across the following tool-role message (the wire layout: the
 * assistant message carries tool_call blocks, the next role:"tool" message
 * carries the tool_result blocks). Note blocks render as `[note] …` system
 * lines — the same text the live note.emitted path prints.
 */
export function messagesToTranscript(messages: readonly Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let id = 1
  const openCalls = new Map<string, number>() // callId → tool entry index awaiting its result
  // 联合类型上的分布式 Omit（直接 Omit 会塌缩成公共键）
  type NewEntry = TranscriptEntry extends infer T ? (T extends TranscriptEntry ? Omit<T, "id"> : never) : never
  const push = (entry: NewEntry): void => {
    entries.push({ id: id++, ...entry } as TranscriptEntry)
  }
  const textOf = (blocks: readonly { type: string; text?: string }[]): string =>
    blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("")

  for (const message of messages) {
    if (message.role === "user") {
      for (const block of message.blocks) {
        if (block.type === "note") push({ kind: "system", text: noteText(block.text) })
        else if (block.type === "attachment") push({ kind: "system", text: attachmentLabel(block) })
        else if (block.type === "text") {
          const text = block.text
          if (text.trim() !== "") push({ kind: "user", text })
        }
      }
    } else if (message.role === "assistant") {
      for (const block of message.blocks) {
        if (block.type === "text" && block.text.trim() !== "") push({ kind: "assistant-text", text: block.text })
        else if (block.type === "thinking" && block.text.trim() !== "") push({ kind: "thinking", text: block.text })
        else if (block.type === "tool_call") {
          openCalls.set(block.callId, entries.length)
          push({ kind: "tool", name: block.name, argsJson: JSON.stringify(block.args ?? {}), status: undefined, durationMs: undefined, output: undefined })
        }
      }
    } else {
      for (const block of message.blocks) {
        if (block.type !== "tool_result") continue
        const idx = openCalls.get(block.callId)
        const entry = idx !== undefined ? entries[idx] : undefined
        if (entry !== undefined && entry.kind === "tool") {
          entries[idx!] = { ...entry, status: block.status, durationMs: block.durationMs, output: block.output }
          openCalls.delete(block.callId)
        } else {
          push({ kind: "tool", name: "未知工具", argsJson: "", status: block.status, durationMs: block.durationMs, output: block.output })
        }
      }
    }
  }
  return entries
}
