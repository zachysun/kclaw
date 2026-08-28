/**
 * WebUI slash-command dispatcher — the web half of the shared command table
 * (see @kclaw/core/commands). Runs before a composer submit reaches the ws
 * send path, mirroring where the CLI chat loop intercepts. Every command is a
 * thin client over the panel's existing actions: the REST api for
 * readonly/compact, and panel/owner callbacks for session creation, the
 * sidebar, and model switching. Like the CLI's commands, these never reject —
 * failures land in the notice area.
 *
 * `help` is intentionally inert here: the composer view intercepts it (it
 * renders the command panel itself), so this branch is a defensive no-op.
 */
import type { ParsedSlash } from "@kclaw/core/commands"
import type { ApiClient } from "../api.js"

export interface WebCommandCtx {
  api: Pick<ApiClient, "get" | "post">
  sessionId: string
  /** Show a command result or hint in the panel's notice area. */
  notify(text: string): void
  /** Create a session (title optional) and switch to it. */
  createSession(title?: string): Promise<void>
  /** Reveal the session list (the sidebar; the drawer on mobile). */
  openSessions(): void
  /** Switch the session model ("" restores the daemon default). */
  switchModel(name: string): void
  models: string[]
  currentModel?: string
}

/** Execute a parsed `/command`; false means the command is unknown. */
export async function runWebCommand(parsed: ParsedSlash, ctx: WebCommandCtx): Promise<boolean> {
  switch (parsed.command) {
    case "new":
    case "clear": {
      const arg = parsed.args.trim()
      const title = parsed.command === "new" && arg !== "" ? arg : undefined
      try {
        await ctx.createSession(title)
      } catch (err) {
        ctx.notify(`创建会话失败: ${err instanceof Error ? err.message : String(err)}`)
      }
      return true
    }
    case "sessions":
      ctx.openSessions()
      return true
    case "model": {
      const name = parsed.args.trim()
      if (name === "") {
        ctx.notify(
          `可用模型: ${ctx.models.length === 0 ? "(无)" : ctx.models.join(", ")}；当前模型: ${ctx.currentModel ?? "(默认)"}`,
        )
      } else {
        ctx.switchModel(name === "default" ? "" : name)
      }
      return true
    }
    case "readonly": {
      const arg = parsed.args.trim()
      try {
        const current = await ctx.api.get<{ readonly?: boolean }>(`/sessions/${encodeURIComponent(ctx.sessionId)}`)
        const target = arg === "on" ? true : arg === "off" ? false : !(current.readonly === true)
        await ctx.api.post(`/sessions/${encodeURIComponent(ctx.sessionId)}/readonly`, { readonly: target })
        ctx.notify(target ? "已开启只读模式（写与 exec 将被拒绝）" : "已关闭只读模式")
      } catch (err) {
        ctx.notify(`只读切换失败: ${err instanceof Error ? err.message : String(err)}`)
      }
      return true
    }
    case "compact": {
      try {
        const res = await ctx.api.post<{ message?: string }>(
          `/sessions/${encodeURIComponent(ctx.sessionId)}/compact`,
          parsed.args === "" ? {} : { focus: parsed.args },
        )
        ctx.notify(res.message ?? "已压缩")
      } catch (err) {
        ctx.notify(`压缩失败: ${err instanceof Error ? err.message : String(err)}`)
      }
      return true
    }
    case "help":
      return true
    default:
      ctx.notify("没有这个命令，/help 看看")
      return false
  }
}
