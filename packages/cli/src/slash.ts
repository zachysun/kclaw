/**
 * Slash-command registry: the REPL's typed command
 * table. `dispatch` splits a line into `{ command, args }` (or null for plain
 * input); the chat loop consults the registry instead of hard-coding each
 * command. `/exit` is intentionally NOT registered here — it stays loop
 * control in chat.ts (`parsed.command === "exit"` breaks the input loop).
 */
import { isCancel, select } from "@clack/prompts"
import type { KclawClient } from "./client.js"

/** Everything a registered command may reach at run time (a view over the chat loop's live state). */
export interface SlashCtx {
  client: KclawClient
  sessionId: string
  switchSession(id: string): Promise<void>
  exit(): void
  print(text: string): void
  /** Pause the readline interface so @clack owns the terminal (sessions select). */
  pauseInput(): void
  /** Resume the readline interface after an @clack prompt. */
  resumeInput(): void
  /**
   * Attachments uploaded for the NEXT message: send_message carries them
   * (as `attachments`) and the send path clears the array.
   */
  pendingAttachments: AttachmentRef[]
}

/** A reference to an uploaded attachment (mirrors the daemon's shape). */
export interface AttachmentRef {
  path: string
  name: string
  size: number
  mimeType: string
}

export interface SlashCommand {
  name: string
  usage: string
  description: string
  run(args: string, ctx: SlashCtx): Promise<void>
}

/**
 * Parse a `/command args` line into its parts. Non-`/` input (plain messages)
 * returns null; the leading slash is dropped and args are trimmed. The
 * registry is accepted for API symmetry with the loop but is not consulted
 * here — parsing never needs to know which commands exist.
 */
export function dispatch(input: string, _registry: Map<string, SlashCommand>): { command: string; args: string } | null {
  if (!input.startsWith("/")) return null
  const rest = input.slice(1)
  const space = rest.indexOf(" ")
  if (space === -1) return { command: rest, args: "" }
  return { command: rest.slice(0, space), args: rest.slice(space + 1).trim() }
}

/**
 * Run a parsed command against the registry, or print the unknown-command
 * hint when it is not registered. Returns true when a command ran (a hit),
 * false when the command was unknown (a miss) — kept here, not inline in
 * chat.ts, so the miss path is unit-testable.
 */
export async function runOrHint(
  parsed: { command: string; args: string },
  registry: Map<string, SlashCommand>,
  ctx: SlashCtx,
): Promise<boolean> {
  const cmd = registry.get(parsed.command)
  if (cmd !== undefined) {
    await cmd.run(parsed.args, ctx)
    return true
  }
  ctx.print("没有这个命令，/help 看看")
  return false
}

import { readFileSync } from "node:fs"
import { basename, extname } from "node:path"

/** Guess a content type from a filename for the upload (coarse but enough). */
function mimeForFile(name: string): string {
  const ext = extname(name).toLowerCase()
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) return "image/" + ext.slice(1)
  if (ext === ".pdf") return "application/pdf"
  if (ext === ".md" || ext === ".markdown") return "text/markdown"
  if ([".txt", ".json", ".csv", ".yaml", ".yml", ".log", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".sh"].includes(ext)) return "text/plain"
  return "application/octet-stream"
}

/** One session row as served by GET /sessions (SessionStore meta shape). */
interface SessionRow {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/**
 * Build the command registry. `ctx` is threaded through so the loop can pass
 * the SAME live context to `run` at dispatch time (commands receive it as the
 * `run(args, ctx)` argument — see chat.ts).
 */
export function createRegistry(ctx: SlashCtx): Map<string, SlashCommand> {
  const registry = new Map<string, SlashCommand>()

  /**
   * Shared "create a session → switch to it" step for `/new` and `/clear`:
   * POST /sessions (with a title when one is given), then `switchSession`
   * (which unsubscribes the old session and subscribes the new one — see
   * chat.ts) and confirm. The body always carries `workdir` (the REPL's
   * process cwd), binding the session to the terminal's working directory;
   * `/new [标题]` additionally supplies the title.
   */
  async function createSessionAndSwitch(ctx: SlashCtx, title?: string): Promise<void> {
    const meta = (await ctx.client.request(
      "POST",
      "/sessions",
      title === undefined ? { workdir: process.cwd() } : { title, workdir: process.cwd() },
    )) as SessionRow
    await ctx.switchSession(meta.id)
    ctx.print(`已切换到新会话 ${ctx.sessionId}`)
  }

  registry.set("new", {
    name: "new",
    usage: "/new [标题]",
    description: "新建会话并切换过去",
    async run(args, ctx) {
      const title = args.trim()
      await createSessionAndSwitch(ctx, title === "" ? undefined : title)
    },
  })

  registry.set("clear", {
    name: "clear",
    usage: "/clear",
    description: "新建会话（不带标题）",
    async run(_args, ctx) {
      await createSessionAndSwitch(ctx)
    },
  })

  registry.set("sessions", {
    name: "sessions",
    usage: "/sessions",
    description: "选择会话并切换",
    async run(_args, ctx) {
      const list = await ctx.client.request("GET", "/sessions")
      const rows = Array.isArray(list) ? (list as SessionRow[]) : []
      if (rows.length === 0) {
        ctx.print("（还没有会话）")
        return
      }
      // @clack owns the terminal while the select is up; the readline
      // interface sits paused underneath (same pattern as chat.ts confirmation).
      ctx.pauseInput()
      try {
        const chosen = await select({
          message: "选择会话",
          options: rows.map((s) => ({ value: s.id, label: s.title })),
        })
        if (isCancel(chosen)) return
        await ctx.switchSession(chosen as string)
      } finally {
        ctx.resumeInput()
      }
    },
  })

  registry.set("model", {
    name: "model",
    usage: "/model [名字]",
    description: "切换本会话的模型（无参数列出可用模型与当前值；/model default 恢复默认）",
    async run(args, ctx) {
      const config = (await ctx.client.request("GET", "/config")) as { providers?: { entries?: Record<string, unknown>; default?: string } }
      const entries = Object.keys(config.providers?.entries ?? {})
      const meta = (await ctx.client.request("GET", `/sessions/${ctx.sessionId}`)) as { model?: string }
      const name = args.trim()
      if (name === "") {
        ctx.print(`可用模型: ${entries.length === 0 ? "(无)" : entries.join(", ")}`)
        ctx.print(`当前模型: ${meta.model ?? config.providers?.default ?? "(默认)"}`)
        return
      }
      const target = name === "default" ? "" : name
      try {
        await ctx.client.request("POST", `/sessions/${ctx.sessionId}/model`, { model: target })
        ctx.print(target === "" ? "已恢复默认模型" : `已切换模型: ${target}`)
      } catch (err) {
        ctx.print(`切换失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })

  registry.set("attach", {
    name: "attach",
    usage: "/attach <path>",
    description: "上传附件，随下一条消息发送（无参数时列出待发附件）",
    async run(args, ctx) {
      if (args.trim() === "") {
        if (ctx.pendingAttachments.length === 0) {
          ctx.print("没有待发附件。/attach <path> 上传一个文件，它会随下一条消息发送。")
          return
        }
        for (const a of ctx.pendingAttachments) {
          ctx.print(`待发附件: ${a.name}（${a.size} 字节）`)
        }
        return
      }
      try {
        const body = readFileSync(args)
        const name = basename(args)
        const { file } = await ctx.client.uploadAttachment(ctx.sessionId, name, body, mimeForFile(name))
        ctx.pendingAttachments.push({ path: file.path, name: file.name, size: file.size, mimeType: mimeForFile(name) })
        ctx.print(`已添加附件: ${file.name}（${file.size} 字节），将随下一条消息发送`)
      } catch (err) {
        ctx.print(`附件上传失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })

  registry.set("help", {
    name: "help",
    usage: "/help",
    description: "列出所有命令",
    async run(_args, ctx) {
      for (const cmd of registry.values()) {
        ctx.print(`${cmd.name} ${cmd.usage} — ${cmd.description}`)
      }
    },
  })

  return registry
}
