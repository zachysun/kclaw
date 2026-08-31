/**
 * The slash-command table BOTH frontends read: one list of builtin names,
 * usages and descriptions with per-surface visibility, plus the shared
 * `/cmd args` parser and the completion helper. Pure data and pure functions
 * — no Node APIs — so the browser build can import it through the
 * `@kclaw/core/commands` subpath without pulling in the Node-bound main entry.
 */

/** A frontend that lists and dispatches slash commands. */
export type SlashSurface = "cli" | "web"

export interface SlashCommandMeta {
  name: string
  usage: string
  description: string
  /** Which frontends list and dispatch this command. */
  surfaces: readonly SlashSurface[]
}

/**
 * Builtin commands in display order. `/exit` is loop control in the CLI chat
 * loop (chat.ts breaks on it — it is NOT a registry command), but it is still
 * listed here so Tab completion can suggest it. `attach` stays terminal-only:
 * it uploads a file from the local filesystem, which has no meaning in the
 * browser (the WebUI attaches via drag-and-drop instead). The disposition
 * commands (`steer`/`wait`/`interrupt`/`queue`) are equally cli-only: the Web
 * frontend drives the send disposition through its three-way button and the
 * queue panel instead of typed commands.
 */
export const SLASH_COMMANDS: readonly SlashCommandMeta[] = [
  { name: "new", usage: "/new [标题]", description: "新建会话并切换过去", surfaces: ["cli", "web"] },
  { name: "clear", usage: "/clear", description: "新建会话（不带标题）", surfaces: ["cli", "web"] },
  { name: "sessions", usage: "/sessions", description: "选择会话并切换", surfaces: ["cli", "web"] },
  { name: "model", usage: "/model [名字]", description: "切换本会话的模型（无参数列出可用模型与当前值；/model default 恢复默认）", surfaces: ["cli", "web"] },
  { name: "readonly", usage: "/readonly [on|off]", description: "切换本会话只读模式（写与 exec 将被拒绝）", surfaces: ["cli", "web"] },
  { name: "attach", usage: "/attach <path>", description: "上传附件，随下一条消息发送（无参数时列出待发附件）", surfaces: ["cli"] },
  { name: "compact", usage: "/compact [重点说明]", description: "手动压缩当前会话的早期对话（可指定摘要重点保留什么）", surfaces: ["cli", "web"] },
  { name: "steer", usage: "/steer", description: "本会话发送处置切换为引导（steer）：运行中发送的消息注入当前 run", surfaces: ["cli"] },
  { name: "wait", usage: "/wait", description: "本会话发送处置切换为等待（wait）：运行中发送的消息排队，当前 run 结束后执行", surfaces: ["cli"] },
  { name: "interrupt", usage: "/interrupt <消息>", description: "掐掉当前 run，并把这条消息插到队列最前（一次性动作，不是模式）", surfaces: ["cli"] },
  { name: "queue", usage: "/queue [cancel <n|all>]", description: "查看当前会话的排队消息；cancel 按序号或 all 取消", surfaces: ["cli"] },
  { name: "help", usage: "/help", description: "列出所有命令", surfaces: ["cli", "web"] },
  { name: "memory", usage: "/memory [save|项目 [线]]", description: "记忆：save 手动触发当前项目写入；列项目/主题线/线原文", surfaces: ["cli", "web"] },
  { name: "exit", usage: "/exit", description: "退出终端程序", surfaces: ["cli"] },
]

export interface ParsedSlash {
  command: string
  args: string
}

/** Parse `/command args`; non-slash input (plain messages) returns null. */
export function parseSlashInput(input: string): ParsedSlash | null {
  if (!input.startsWith("/")) return null
  const rest = input.slice(1)
  const space = rest.indexOf(" ")
  if (space === -1) return { command: rest, args: "" }
  return { command: rest.slice(0, space), args: rest.slice(space + 1).trim() }
}

/**
 * Prefix candidates for the composer: the whole input must still be a command
 * word (`/` + a prefix with no space typed yet), matched against the surface's
 * commands in display order. Anything else — plain text, a command with args
 * already started — returns an empty list.
 */
export function slashCompletions(input: string, surface: SlashSurface): SlashCommandMeta[] {
  if (!input.startsWith("/")) return []
  const word = input.slice(1)
  if (word.includes(" ")) return []
  return SLASH_COMMANDS.filter((c) => c.surfaces.includes(surface) && c.name.startsWith(word))
}
