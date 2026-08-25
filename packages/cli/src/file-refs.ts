/**
 * @path file references in chat input: tokens are resolved against the
 * current working directory, must live inside the session's workdir
 * (realpath-verified), and expand to inline text (small text files) or a
 * read-on-demand note (large/non-text). Anything out of bounds or missing
 * fails the whole message with an error instead of being sent.
 */
import { readFileSync, statSync } from "node:fs"
import { extname, resolve } from "node:path"
import { realpathWithin } from "@kclaw/core"

/** Cap for inlining a referenced file (chars / bytes). */
const INLINE_MAX_CHARS = 8 * 1024
const INLINE_MAX_BYTES = 64 * 1024
const TEXT_EXT = /\.(md|txt|json|csv|yaml|yml|xml|log|ts|js|tsx|jsx|py|go|rs|sh|toml|ini|env)$/i

/** Result of expanding @tokens: the rewritten message, or a hard error. */
export type FileRefResult = { text: string } | { error: string }

/** Expand every `@path` token in `text`. */
export function expandFileRefs(text: string, cwd: string, workdir: string): FileRefResult {
  const root = realpathWithin(workdir)
  let out = text
  const tokens = text.match(/@([^\s@]+)/g) ?? []
  for (const token of tokens) {
    const raw = token.slice(1)
    const abs = resolve(cwd, raw)
    const resolved = realpathWithin(abs)
    if (resolved !== root && !resolved.startsWith(root + "/")) {
      return { error: `路径越界（不在会话工作区内）: ${raw}` }
    }
    let size = 0
    let isText = false
    try {
      const st = statSync(resolved)
      if (!st.isFile()) return { error: `不是文件: ${raw}` }
      size = st.size
      isText = TEXT_EXT.test(raw) || extname(raw) === ""
    } catch {
      return { error: `文件不存在: ${raw}` }
    }
    if (isText && size <= INLINE_MAX_BYTES) {
      let content = readFileSync(resolved, "utf8")
      if (content.length > INLINE_MAX_CHARS) content = `${content.slice(0, INLINE_MAX_CHARS)}\n…[已截断]`
      out = out.replace(token, " ").replace(/\s{2,}/g, " ").trim()
      out = `${out}\n[来自 @${raw}]\n${content}`
    } else {
      out = out.replace(token, " ").replace(/\s{2,}/g, " ").trim()
      out = `${out}\n[文件 @${raw}（${size} 字节）已引用，可用 fs_read 读取 ${resolved}]`
    }
  }
  return { text: out }
}
