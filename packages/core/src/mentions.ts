/**
 * File mentions in a user message (`@path`): the composer completion helpers,
 * the raw-text mention extractor and the model-facing implicit wrap. Pure
 * data and pure functions — no Node APIs — so the browser build can import
 * them through the `@kclaw/core/mentions` subpath without pulling in the
 * Node-bound main entry.
 *
 * Boundary philosophy matches skill mentions: an `@` whose preceding
 * character is ASCII alphanumeric does not trigger (email addresses stay
 * out), unspaced Chinese text does.
 */

/**
 * A token extracted from a user message with its workspace resolution:
 * ok = an existing file inside the workspace, missing = the path does not
 * resolve to a file (deleted, never existed, or a directory). Tokens that
 * escape the workspace never reach this list — they stay plain text.
 */
export interface MentionResolution {
  token: string
  status: "ok" | "missing"
}

/** Candidate cap for the mention drawer — DOM size and visual scanning. */
export const FILE_MENTION_CAP = 50

/**
 * Prefix candidates for the composer: the LAST whitespace-delimited chunk of
 * the input must start with `@` (so a draft like "看 @src" suggests right
 * where the user is typing — an `@` mid-word like an email address or a
 * chunk that already ended returns an empty list). Candidates filter
 * case-insensitively by substring on the relative path, ranked in three
 * tiers — filename prefix hit, then filename substring hit, then path-only
 * hit — ties shallow path first, then lexicographically. The drawer list
 * itself decides how to
 * present unselectable entries (e.g. paths containing whitespace); this
 * function only ranks and caps.
 */
export function fileMentionCompletions(input: string, files: readonly string[]): string[] {
  const chunk = input.split(/\s/).pop() ?? ""
  if (!chunk.startsWith("@")) return []
  const q = chunk.slice(1).toLowerCase()
  const nameOf = (file: string): string => {
    const idx = file.lastIndexOf("/")
    return idx === -1 ? file : file.slice(idx + 1)
  }
  const rank = (file: string): number => {
    const name = nameOf(file).toLowerCase()
    if (name.startsWith(q)) return 0
    if (name.includes(q)) return 1
    return 2
  }
  const depthOf = (file: string): number => {
    let depth = 0
    for (const ch of file) if (ch === "/") depth++
    return depth
  }
  return files
    .filter((file) => file.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || depthOf(a) - depthOf(b) || a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, FILE_MENTION_CAP)
}

/**
 * Completion applied to the draft: replaces the trailing in-progress mention
 * token (the chunk fileMentionCompletions matched — callers use this only
 * while the menu is open, so the draft ends with it by construction) with
 * the chosen path plus a trailing space. Completing "看 @sr" with
 * `src/a.ts` yields "看 @src/a.ts " instead of clobbering the sentence.
 */
export function replaceTrailingMentionToken(draft: string, file: string): string {
  return draft.replace(/@[^\s]*$/, () => `@${file} `)
}

/**
 * File mention tokens in a user message, at ANY position: every `@token`
 * whose preceding character is not ASCII alphanumeric (this keeps email
 * addresses out while letting unspaced Chinese text like "看看@src/x.ts"
 * through) runs from the `@` to the next whitespace. Duplicates collapse;
 * scan order is preserved. Pure syntax — existence and workspace-boundary
 * checks happen at run assembly, where the workspace is known.
 */
export function extractFileMentions(text: string): string[] {
  const tokens: string[] = []
  for (const m of text.matchAll(/(?<![A-Za-z0-9])@([^\s]+)/g)) {
    const token = m[1]!
    if (!tokens.includes(token)) tokens.push(token)
  }
  return tokens
}

/**
 * The model-facing copy for mentioned files: the user's message VERBATIM plus
 * trailing lines telling the model to load each mentioned file via the
 * fs_read tool (missing entries get their own note telling the model to say
 * so instead of attempting a read). This is the implicit wrap applied at the
 * daemon boundary — persistence, the event stream and the chat bubble all
 * keep the raw input; only the provider request sees this text.
 * undefined = nothing to wrap, send the message as-is.
 */
export function wrapFileMentions(text: string, resolutions: readonly MentionResolution[]): string | undefined {
  if (resolutions.length === 0) return undefined
  const ok = resolutions.filter((r) => r.status === "ok")
  const missing = resolutions.filter((r) => r.status === "missing")
  const refs = (entries: readonly MentionResolution[]): string => entries.map((r) => `「@${r.token}」`).join("")
  const lines: string[] = []
  if (ok.length === 1) {
    lines.push(`（本条消息中的「@${ok[0]!.token}」是在引用项目文件：请用 fs_read 工具读取该文件的完整内容，再结合它处理本条消息。）`)
  } else if (ok.length > 1) {
    lines.push(`（本条消息中的${refs(ok)}是在引用项目文件：请用 fs_read 工具依次读取这些文件的完整内容，再结合它们处理本条消息。）`)
  }
  if (missing.length > 0) {
    lines.push(`（其中${refs(missing)}引用的文件不存在或已删除：请向用户说明，不要尝试读取。）`)
  }
  if (lines.length === 0) return undefined
  return `${text}\n\n${lines.join("\n")}`
}
