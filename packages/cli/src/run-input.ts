/**
 * Where `kclaw run` takes its prompt from (spec A2, codex semantics) — four
 * stdin states:
 *
 * - stdin is a TTY: never read. A prompt argument is required; without one
 *   the command shows its usage and exits 2 (clig: display help immediately
 *   and quit — never sit waiting for input nobody is going to type).
 * - pipe + prompt argument: the argument is the instruction, the piped
 *   content is context and rides as an attachment (`stdin.txt`, or
 *   `stdin.bin` when it contains a NUL byte; an empty pipe adds none). The
 *   message text keeps only the argument: the daemon looks for `@path` and
 *   `/skill` in message text, never in attachments, and a large pipe stays
 *   out of the context window and the session history.
 * - pipe + `-` as the only argument: the whole pipe is the prompt.
 * - pipe, no argument: same as `-`.
 *
 * Limits: 10 MiB as a prompt, the daemon's upload cap as an attachment.
 */
import { MAX_ATTACHMENT_BYTES } from "@kclaw/core"
import { UsageError } from "./usage-error.js"

/** Cap when the piped content is the prompt itself. */
export const MAX_STDIN_PROMPT_BYTES = 10 * 1024 * 1024

/** The piped content as an upload. */
export interface PipeAttachment {
  filename: "stdin.txt" | "stdin.bin"
  mimeType: "text/plain" | "application/octet-stream"
  body: Buffer
}

export interface RunPrompt {
  /** The message text. */
  text: string
  /** Piped context (a prompt argument was given and the pipe was not empty). */
  pipe?: PipeAttachment
}

/**
 * `stdin` is a thunk so a TTY run never touches the stream; it is iterated to
 * EOF only when the pipe is needed.
 */
export async function readRunPrompt(
  args: readonly string[],
  stdinIsTTY: boolean,
  stdin: () => AsyncIterable<Buffer | string>,
): Promise<RunPrompt> {
  if (stdinIsTTY) {
    if (args.length === 0) throw new UsageError("缺少提示词", { showHelp: true })
    if (args[0] === "-") throw new UsageError("stdin 是终端：`-`（读取整个 stdin 作为提示词）只能用于管道输入")
    return { text: argText(args) }
  }
  if (args.length === 0 || args[0] === "-") {
    if (args.length > 1) throw new UsageError("`-` 表示整个 stdin 就是提示词，后面不能再跟其他参数")
    const text = (await readCapped(stdin(), MAX_STDIN_PROMPT_BYTES, "作为提示词的 stdin 超过 10 MiB 上限")).toString("utf8")
    if (text.trim() === "") throw new UsageError("提示词为空：stdin 没有内容")
    return { text }
  }
  const text = argText(args)
  const body = await readCapped(stdin(), MAX_ATTACHMENT_BYTES, "管道内容超过附件上限 20MB")
  if (body.length === 0) return { text }
  return {
    text,
    pipe: body.includes(0)
      ? { filename: "stdin.bin", mimeType: "application/octet-stream", body }
      : { filename: "stdin.txt", mimeType: "text/plain", body },
  }
}

/** Prompt arguments joined with spaces; blank is a usage error. */
function argText(args: readonly string[]): string {
  const text = args.join(" ")
  if (text.trim() === "") throw new UsageError("提示词为空")
  return text
}

/** Read to EOF; past `limit` bytes stop reading (the iterator's return closes the stream) and fail as a usage error. */
async function readCapped(source: AsyncIterable<Buffer | string>, limit: number, tooLarge: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of source) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    size += buf.length
    if (size > limit) throw new UsageError(tooLarge)
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}
