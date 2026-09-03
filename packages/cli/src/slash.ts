/**
 * Slash-command registry: the REPL's typed command
 * table. `dispatch` splits a line into `{ command, args }` (or null for plain
 * input); the chat loop consults the registry instead of hard-coding each
 * command. Names/usages/descriptions come from the shared core table so the
 * WebUI stays in sync. `/exit` is intentionally NOT registered here — it
 * stays loop control in chat.ts (`parsed.command === "exit"` breaks the input
 * loop).
 */
import { isCancel, select } from "@clack/prompts"
import { parseSlashInput, slashCompletions, SLASH_COMMANDS, type SlashCommandMeta } from "@kclaw/core/commands"
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
  /** Send a plain user message (custom slash commands expand templates into this). */
  send(text: string): void
  /** Switch the session's send-disposition mode (kept as chat-loop state). */
  setDisposition?(d: "steer" | "wait"): void
  /**
   * Send a ws `queue.cancel`: a messageId withdraws that queued entry, "all"
   * sends the frame WITHOUT messageId (clear every queued message).
   */
  queueCancel(target: string | "all"): Promise<void>
  /**
   * Interrupt-send a message: one `send_message` carrying the `interrupt`
   * disposition (the daemon drops the active run and queues this at the
   * head). The `/interrupt` command (Task 9) expands into this.
   */
  sendInterrupt(text: string): void
  /** Convenience read of GET /queue (numbered listing / queued-count checks). */
  queueSnapshot?(): Promise<Array<{ messageId: string; disposition: string; text: string }>>
  /** Directory of custom slash commands (`<home>/commands`, *.md). */
  commandsDir?: string
}

/** A reference to an uploaded attachment (mirrors the daemon's shape). */
export interface AttachmentRef {
  path: string
  name: string
  size: number
  mimeType: string
}

export interface SlashCommand extends SlashCommandMeta {
  run(args: string, ctx: SlashCtx): Promise<void>
}

/** Look up a builtin's shared metadata (names/usages/descriptions live in core). */
function meta(name: string): SlashCommandMeta {
  const found = SLASH_COMMANDS.find((c) => c.name === name)
  if (found === undefined) throw new Error(`unknown builtin slash command: ${name}`)
  return found
}

/**
 * Parse a `/command args` line into its parts, delegating to the shared core
 * parser (identical semantics since the table moved there). Non-`/` input
 * (plain messages) returns null. The registry is accepted for API symmetry
 * with the loop but is not consulted here — parsing never needs to know
 * which commands exist.
 */
export function dispatch(input: string, _registry: Map<string, SlashCommand>): { command: string; args: string } | null {
  return parseSlashInput(input)
}

/**
 * readline completer for Tab: complete the command word (before the first
 * space) from the shared builtin table. Returns full-line candidates plus the
 * original line, readline's expected shape — a unique hit completes the line,
 * several hits complete their common prefix and list them. Custom
 * `~/commands/*.md` commands are not suggested; /help remains their index.
 */
export function slashCompleter(line: string): [string[], string] {
  return [slashCompletions(line, "cli").map((c) => `/${c.name}`), line]
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

import { readFileSync, readdirSync } from "node:fs"
import { basename, extname, join } from "node:path"

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
    ...meta("new"),
    async run(args, ctx) {
      const title = args.trim()
      await createSessionAndSwitch(ctx, title === "" ? undefined : title)
    },
  })

  registry.set("clear", {
    ...meta("clear"),
    async run(_args, ctx) {
      await createSessionAndSwitch(ctx)
    },
  })

  registry.set("sessions", {
    ...meta("sessions"),
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
    ...meta("model"),
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

  registry.set("readonly", {
    ...meta("readonly"),
    async run(args, ctx) {
      const arg = args.trim()
      const current = (await ctx.client.request("GET", `/sessions/${ctx.sessionId}`)) as { readonly?: boolean }
      const target = arg === "on" ? true : arg === "off" ? false : !(current.readonly === true)
      await ctx.client.request("POST", `/sessions/${ctx.sessionId}/readonly`, { readonly: target })
      ctx.print(target ? "已开启只读模式（写与 exec 将被拒绝）" : "已关闭只读模式")
    },
  })

  registry.set("attach", {
    ...meta("attach"),
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

  registry.set("compact", {
    ...meta("compact"),
    async run(args, ctx) {
      try {
        const res = (await ctx.client.request(
          "POST",
          `/sessions/${ctx.sessionId}/compact`,
          args === "" ? {} : { focus: args },
        )) as { message?: string }
        ctx.print(res.message ?? "已压缩")
      } catch (e) {
        ctx.print(`压缩失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  })

  // 本会话发送处置的模式行（/steer /wait 切换后打印的说明文字）。
  const dispositionLine = {
    steer: "引导（steer）：运行中发送的消息会注入当前 run",
    wait: "等待（wait）：运行中发送的消息排队，当前 run 结束后执行",
  } as const
  registry.set("steer", {
    ...meta("steer"),
    async run(_args, ctx) {
      try {
        await ctx.client.request("POST", `/sessions/${encodeURIComponent(ctx.sessionId)}/disposition`, { disposition: "steer" })
      } catch (e) {
        // 防护（/compact 先例）：daemon 短暂不可达不让一次命令杀死 REPL；
        // 失败时不切本地模式（setDisposition 不可达），回车直发维持旧处置。
        ctx.print(`切换处置失败: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      ctx.setDisposition?.("steer")
      ctx.print(`本会话处置模式：${dispositionLine.steer}`)
    },
  })
  registry.set("wait", {
    ...meta("wait"),
    async run(_args, ctx) {
      try {
        await ctx.client.request("POST", `/sessions/${encodeURIComponent(ctx.sessionId)}/disposition`, { disposition: "wait" })
      } catch (e) {
        ctx.print(`切换处置失败: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      ctx.setDisposition?.("wait")
      ctx.print(`本会话处置模式：${dispositionLine.wait}`)
    },
  })

  registry.set("interrupt", {
    ...meta("interrupt"),
    async run(args, ctx) {
      const text = args.trim()
      if (text === "") {
        // 无参形式不需要：纯中断有 Ctrl+C（spec §7.2，一次性动作不是模式）。
        ctx.print("用法：/interrupt <消息> —— 掐掉当前 run，这条消息下一个执行（纯中断用 Ctrl+C）")
        return
      }
      ctx.sendInterrupt(text)
    },
  })

  registry.set("queue", {
    ...meta("queue"),
    async run(args, ctx) {
      // 防护（/compact 先例）：列出与取消都先读快照，读取失败打印失败行即返回
      // （cancel 走 ws queueCancel，自带 ack/错误帧处理，无需在此兜底）。
      let list: Array<{ messageId: string; disposition: string; text: string }>
      try {
        list = (await ctx.client.request("GET", `/sessions/${encodeURIComponent(ctx.sessionId)}/queue`)) as Array<{ messageId: string; disposition: string; text: string }>
      } catch (e) {
        ctx.print(`读取队列失败: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      const cancelMatch = /^cancel\s+(\d+|all)$/.exec(args.trim())
      if (cancelMatch !== null) {
        const target = cancelMatch[1]!
        if (target === "all") { await ctx.queueCancel("all"); ctx.print("已请求清空队列"); return }
        const entry = list[Number(target) - 1]
        if (entry === undefined) { ctx.print("没有这个序号"); return }
        await ctx.queueCancel(entry.messageId)
        ctx.print("已取消")
        return
      }
      if (list.length === 0) { ctx.print("（队列为空）"); return }
      ctx.print(list.map((e, i) => `${i + 1}. ${e.disposition} ${e.text}`).join("\n"))
    },
  })

  registry.set("memory", {
    ...meta("memory"),
    async run(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      try {
        // /memory save — 手动触发当前项目的手动写入（spec 4.2 手动行）。
        // 当前项目 = CLI 启动目录（会话建在该目录，workdir 与 cwd 一致）。
        if (parts[0] === "save") {
          await ctx.client.request("POST", "/memory/trigger-manual", { workdir: process.cwd() })
          ctx.print("已触发手动写入（当前项目，处理自上次以来的新消息）")
          return
        }
        if (parts.length === 0) {
          const projects = (await ctx.client.request("GET", "/memory/projects")) as Array<{ id: string; threads: number; lastActivity: string }>
          ctx.print(projects.length === 0 ? "（还没有项目记忆）" : projects.map((p) => `${p.id} · ${p.threads} 线 · 最近 ${p.lastActivity}`).join("\n"))
          return
        }
        const [projectId, topic] = parts
        if (topic === undefined) {
          const res = (await ctx.client.request("GET", `/memory/projects/${encodeURIComponent(projectId!)}`)) as { threads: Array<{ topic: string; title: string; status: string; updated: string }> }
          ctx.print(res.threads.length === 0 ? "（该项目还没有主题线）" : res.threads.map((t) => `${t.topic} · ${t.title} · ${t.status} · ${t.updated}`).join("\n"))
          return
        }
        const res = (await ctx.client.request("GET", `/memory/threads/${encodeURIComponent(projectId!)}/${encodeURIComponent(topic)}`)) as { content: string }
        ctx.print(res.content)
      } catch (err) {
        ctx.print(`查看记忆失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })

  registry.set("skill", {
    ...meta("skill"),
    async run(args, ctx) {
      const name = args.trim()
      try {
        // 项目级技能的生效范围跟会话工作目录：先取本会话 meta 的 workdir，
        // 再让 /skills 路由按"全局 + 项目"同源规则扫描。
        const session = (await ctx.client.request("GET", `/sessions/${ctx.sessionId}`)) as { workdir?: string }
        const workdir =
          typeof session.workdir === "string" && session.workdir !== ""
            ? `?workdir=${encodeURIComponent(session.workdir)}`
            : ""
        if (name === "") {
          const rows = (await ctx.client.request("GET", `/skills${workdir}`)) as Array<{
            name: string
            description: string
            visibility: string
            origin: string
          }>
          if (rows.length === 0) {
            ctx.print("（还没有技能。把技能目录放进 ~/.kclaw/skills/ 或工作区 .kclaw/skills/）")
            return
          }
          ctx.print(
            rows
              .map((r) => {
                const origin = r.origin === "project" ? "项目" : "全局"
                const vis = r.visibility === "user-only" ? " · 仅用户" : ""
                return `${r.name} · ${origin}${vis} · ${r.description}`
              })
              .join("\n"),
          )
          return
        }
        const res = (await ctx.client.request("GET", `/skills/${encodeURIComponent(name)}${workdir}`)) as { content: string }
        ctx.print(res.content)
      } catch (err) {
        ctx.print(`查看技能失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })

  registry.set("help", {
    ...meta("help"),
    async run(_args, ctx) {
      for (const cmd of registry.values()) {
        ctx.print(`${cmd.name} ${cmd.usage} — ${cmd.description}`)
      }
    },
  })

  // Custom commands: <commandsDir>/*.md — filename = command name, body is a
  // prompt template with {{args}} expanded at dispatch. Builtin names win:
  // a collision logs a warning and the file is skipped.
  if (ctx.commandsDir !== undefined) {
    let files: string[] = []
    try {
      files = readdirSync(ctx.commandsDir).filter((f) => f.endsWith(".md"))
    } catch {
      // no commands dir — nothing to load
    }
    for (const f of files) {
      const name = f.slice(0, -3)
      if (registry.has(name)) {
        ctx.print(`自定义命令 ${name} 与内置命令重名，已忽略`)
        continue
      }
      const template = readFileSync(join(ctx.commandsDir, f), "utf8").trim()
      registry.set(name, {
        name,
        usage: `/${name} [参数]`,
        description: "自定义命令",
        surfaces: ["cli"],
        async run(args, c) {
          c.send(template.replace(/\{\{args\}\}/g, args).trim())
        },
      })
    }
  }

  return registry
}
