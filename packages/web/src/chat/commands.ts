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
import { isPermissionMode, PERMISSION_MODES, PERMISSION_MODE_CONFIRMATIONS } from "@kclaw/core/permission-modes"
import type { PermissionMode } from "@kclaw/core/permission-modes"
import { MCP_STATE_LABELS } from "@kclaw/core/commands"
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
  /**
   * Sync the mode selector after a /mode switch POST succeeded (the command
   * already POSTed — this only updates local state, no second request).
   */
  setMode?(m: PermissionMode): void
  models: string[]
  currentModel?: string
  /** 当前会话的工作目录（/memory save 触发手动写入的目标项目）。 */
  workdir: string
  /** Jump to the MCP management tab (the /mcp summary's clickable action). Absent → plain notice. */
  openMcp?(): void
  /**
   * Attach a click action to the notice currently being shown (the
   * memory.written jump precedent). Optional — the dispatcher degrades to a
   * plain notice when the panel does not support actions.
   */
  notifyAction?(action: () => void): void
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
    case "mode": {
      const arg = parsed.args.trim()
      try {
        if (arg === "") {
          const current = await ctx.api.get<{ mode?: string }>(`/sessions/${encodeURIComponent(ctx.sessionId)}`)
          ctx.notify(`当前权限模式: ${current.mode ?? "default"}（可选 ${PERMISSION_MODES.join(" / ")}）`)
          return true
        }
        if (!isPermissionMode(arg)) {
          ctx.notify(`未知模式: ${arg}（可选 ${PERMISSION_MODES.join(" / ")}）`)
          return true
        }
        await ctx.api.post(`/sessions/${encodeURIComponent(ctx.sessionId)}/mode`, { mode: arg })
        ctx.setMode?.(arg)
        ctx.notify(PERMISSION_MODE_CONFIRMATIONS[arg])
      } catch (err) {
        ctx.notify(`权限模式切换失败: ${err instanceof Error ? err.message : String(err)}`)
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
    case "memory": {
      // /memory save — 手动触发当前项目的手动写入；无参提示记忆页。
      const arg = parsed.args.trim()
      if (arg === "save") {
        try {
          await ctx.api.post("/memory/trigger-manual", { workdir: ctx.workdir })
          ctx.notify("已触发手动写入（当前会话工作目录，处理自上次以来的新消息）")
        } catch (err) {
          ctx.notify(`触发手动写入失败: ${err instanceof Error ? err.message : String(err)}`)
        }
        return true
      }
      ctx.notify("记忆管理请用顶部的「记忆」页")
      return true
    }
    case "skill": {
      // 无参直接在通知区列清单（贴触发点）；看正文引导到只读技能页。
      // 技能的"运行"没有命令也没有按钮：在对话里自然语言点名即可，
      // 模型经 skill_read 加载正文后照做——提示里带例子把这件事说明白。
      try {
        const q = ctx.workdir !== "" ? `?workdir=${encodeURIComponent(ctx.workdir)}` : ""
        const rows = await ctx.api.get<Array<{ name: string; description: string; origin: string; visibility: string; plugin?: string }>>(`/skills${q}`)
        if (rows.length === 0) {
          ctx.notify("还没有技能。把技能目录放进 ~/.kclaw/skills/（全局）或工作区 .kclaw/skills/（项目）")
          return true
        }
        const list = rows
          .map((r) => `${r.name}（${r.origin === "project" ? "项目" : "全局"}${r.plugin !== undefined ? ` · 来自插件 ${r.plugin}` : ""}${r.visibility === "user-only" ? " · 仅用户" : ""}）`)
          .join("、")
        ctx.notify(`已装技能：${list}。使用方式：在对话里直接说，例如「跑一下 ${rows[0]!.name}」，模型会加载该技能再执行；正文看顶部「技能」页`)
      } catch (err) {
        ctx.notify(`查看技能失败: ${err instanceof Error ? err.message : String(err)}`)
      }
      return true
    }
    case "mcp": {
      const name = parsed.args.trim()
      try {
        const { servers } = await ctx.api.get<{ servers: Array<{ name: string; state: string; tools: { name: string }[]; lastError?: string }> }>("/mcp")
        if (servers.length === 0) {
          ctx.notify("还没有接入任何 MCP 服务器（添加用顶部「MCP」页）")
          return true
        }
        if (name !== "") {
          const target = servers.find((s) => s.name === name)
          if (target === undefined) {
            ctx.notify(`未知 MCP 服务器: ${name}（现有 ${servers.map((s) => s.name).join("、")}）`)
            return true
          }
          ctx.notify(
            target.tools.length === 0
              ? `${name}（${MCP_STATE_LABELS[target.state] ?? target.state}）没有暴露工具`
              : `${name}（${MCP_STATE_LABELS[target.state] ?? target.state}）的工具：${target.tools.map((t) => t.name).join("、")}`,
          )
          return true
        }
        const connected = servers.filter((s) => s.state === "connected").length
        const failed = servers.filter((s) => s.state === "failed")
        const parts = [`MCP：${connected}/${servers.length} 已连接`]
        if (failed.length > 0) parts.push(`失败：${failed.map((f) => f.name).join("、")}`)
        parts.push("详情看顶部「MCP」页")
        ctx.notify(parts.join("，"))
        const openMcp = ctx.openMcp
        if (openMcp !== undefined) ctx.notifyAction?.(() => openMcp())
      } catch (err) {
        ctx.notify(`查看 MCP 状态失败: ${err instanceof Error ? err.message : String(err)}`)
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
