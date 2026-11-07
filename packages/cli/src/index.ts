#!/usr/bin/env node
/**
 * kclaw CLI entry. The shebang above is preserved verbatim by
 * tsc (verified: it is emitted as line 1 of dist/index.js), so the compiled
 * `bin` target is directly executable — no post-build step.
 *
 * Commands: `daemon start|stop|status` (lifecycle via daemon-ctl; `status`
 * is also aliased at the top level), `cron list` (auto-connecting client →
 * padded-text table, no table dep), `session list|verify`, the one-shot
 * `run` (prompt or stdin in, the run's output on stdout, exit code by
 * outcome), and the interactive `chat` REPL — which is also the DEFAULT:
 * bare `kclaw` (optionally `--session <id>`, `--think`, `--yes`/`--no`)
 * drops straight into a chat session. `--home <dir>` is a program-level
 * option (default KCLAW_HOME ?? ~/.kclaw); exit codes: 0 ok, 1 failure with
 * the message on stderr, 2 usage error.
 *
 * Library surface: KclawClient is re-exported for programmatic use; chat and
 * wizard load LAZILY (dynamic import) — they pull in @clack, and configureColor
 * must set the colour libraries' env vars before any of them loads (C1).
 * argv is only parsed when this module is the executed entry (guard at
 * bottom), so importing "@kclaw/cli" stays side-effect free.
 */
import { readFileSync, realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { Command, CommanderError, Option } from "commander"
import type { Cron } from "@kclaw/core"
import { isPermissionMode, PERMISSION_MODES } from "@kclaw/core"
import { mcpGroupLabel } from "@kclaw/core/commands"
import type { McpSnapshotResponse } from "@kclaw/core/protocol"
import { KclawClient } from "./client.js"
import { COLOR_MODES, configureColor, type ColorMode } from "./color.js"
import { daemonStatus, defaultHome, ensureDaemon, stopDaemon } from "./daemon-ctl.js"
import { runCommand } from "./run-cmd.js"
import { OUTPUT_FORMATS } from "./run-output.js"
import { renderSessionTable, type SessionRow } from "./session-list.js"
import { webAction } from "./web-cmd.js"

export { KclawClient } from "./client.js"

/**
 * Read the CLI version from package.json at runtime. `../package.json`
 * resolves from src/ (vitest) and dist/ (built bin) alike — server app.ts
 * pattern.
 */
function readVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8")
  const version = (JSON.parse(raw) as { version?: string }).version
  return version ?? "0.0.0"
}

/**
 * Wrap an action: resolve `--home` from the (sub)command's merged options,
 * pass the full merged options through (chat needs --session/--think/…), and
 * turn any throw into a stderr line + exit code 1.
 */
function run(action: (home: string, options: Record<string, unknown>) => Promise<void>) {
  return async (...args: unknown[]): Promise<void> => {
    const options = (args[args.length - 1] as Command).optsWithGlobals() as Record<string, unknown>
    try {
      await action(String(options.home), options)
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  }
}

/** A cron row's printable columns (the header doubles as the empty-state output). */
function jobRow(cron: Cron): Record<"name" | "cron" | "enabled" | "nextRunAt" | "lastStatus", string> {
  return {
    name: cron.name,
    cron: cron.cron,
    enabled: String(cron.enabled),
    nextRunAt: cron.nextRunAt,
    lastStatus: cron.lastStatus ?? "-",
  }
}

/** Plain string-padded table: header + rows, columns aligned, two-space gutters. */
function renderCronTable(crons: Cron[]): string {
  const header: Record<"name" | "cron" | "enabled" | "nextRunAt" | "lastStatus", string> = {
    name: "name",
    cron: "cron",
    enabled: "enabled",
    nextRunAt: "nextRunAt",
    lastStatus: "lastStatus",
  }
  const keys = Object.keys(header) as Array<keyof typeof header>
  const rows = crons.map(jobRow)
  const widths = keys.map((key) =>
    Math.max(header[key].length, ...rows.map((row) => row[key].length)),
  )
  const line = (cells: Record<string, string>): string =>
    keys.map((key, i) => cells[key]!.padEnd(widths[i]!)).join("  ").trimEnd()
  return [line(header), ...rows.map(line)].join("\n")
}

async function startAction(home: string): Promise<void> {
  const { info, spawned } = await ensureDaemon(home)
  process.stdout.write(
    `${spawned ? "daemon started" : "daemon already running"} (pid ${info.pid}, port ${info.port})\n`,
  )
}

async function stopAction(home: string): Promise<void> {
  process.stdout.write(`${await stopDaemon(home)}\n`) // "stopped" | "daemon not running"
}

/** Shared by `daemon status` and the top-level `status` alias. */
async function statusAction(home: string): Promise<void> {
  const status = await daemonStatus(home)
  if (!status.running || status.info === undefined) {
    process.stdout.write("not running\n")
    return
  }
  const daemonVersion =
    status.daemonVersion !== undefined ? `, v${status.daemonVersion}` : ""
  process.stdout.write(
    `running (pid ${status.info.pid}, port ${status.info.port}${daemonVersion}, uptime ${status.uptimeSec}s)\n`,
  )
  // The daemon serves a build snapshot; a mismatch means it was not built
  // from this checkout (or predates the latest build) — the classic "fixed
  // but still broken" trap.
  if (status.daemonVersion !== undefined && status.daemonVersion !== readVersion()) {
    process.stdout.write(
      `daemon（v${status.daemonVersion}）与 CLI（v${readVersion()}）版本不一致：` +
        `两者不是同一次构建的产物，重新 pnpm build 并重启 daemon 以吃到最新代码\n`,
    )
  }
}

async function cronListAction(home: string): Promise<void> {
  const client = await KclawClient.connect(home)
  const list: unknown = await client.request("GET", "/cron")
  const crons = Array.isArray(list) ? (list as Cron[]) : []
  process.stdout.write(`${renderCronTable(crons)}\n`)
}

/** `kclaw mcp [list]`: grouped lines per configured MCP server (group header, then name/state/tool count). */
async function mcpAction(home: string): Promise<void> {
  const client = await KclawClient.connect(home)
  const body = (await client.request("GET", "/mcp")) as McpSnapshotResponse
  const groups = body.groups
  if (groups.every((g) => g.servers.length === 0)) {
    process.stdout.write("未配置 MCP server（全局 mcp.json 与各项目 .kclaw/mcp.json 均为空）\n")
    return
  }
  for (const g of groups) {
    if (g.servers.length === 0) continue
    process.stdout.write(`【${mcpGroupLabel(g.id)}】\n`)
    for (const s of g.servers) {
      const error = s.lastError === undefined ? "" : ` 错误: ${s.lastError}`
      process.stdout.write(`  ${s.name}  ${s.state}  ${s.tools.length} 个工具${error}\n`)
    }
  }
}

/** Shared by the default (bare `kclaw`) action and the explicit `chat` subcommand. */
async function chatAction(home: string, options: Record<string, unknown>): Promise<void> {
  // Colour first (C1): the verdict reaches picocolors/chalk through the env,
  // and both libraries judge when they load — before chat/wizard are imported.
  configureColor("auto")
  const client = await KclawClient.connect(home)
  // First-run gate, judged BY the daemon (A16): `configured === false` only
  // (an old daemon without the field keeps the previous behaviour). TTY runs
  // the wizard through the daemon; non-interactive runs get one line of
  // guidance.
  const providers = (await client.request("GET", "/providers")) as { configured?: boolean }
  if (providers.configured === false) {
    if (process.stdout.isTTY) {
      const { runWizard } = await import("./wizard.js")
      if ((await runWizard(client)) === "aborted") return
    } else {
      process.stdout.write("尚未配置模型 provider：请在终端运行 `kclaw chat` 完成配置流程\n")
      return
    }
  }
  const { runChat } = await import("./chat.js")
  await runChat({
    home,
    session: typeof options.session === "string" ? options.session : undefined,
    showThinking: options.think === true,
    yes: options.yes === true,
    no: options.no === true,
  })
}

/** Validate a --color value straight from argv (choices also guard at parse time). */
function parseColorMode(value: unknown): ColorMode {
  return value === "always" || value === "never" ? value : "auto"
}

/**
 * `kclaw run [prompt...]`: everything — usage errors included — resolves to
 * an exit code inside runCommand; only unexpected errors escape (stack on
 * stderr, exit 1).
 */
async function runAction(prompt: string[], _options: unknown, command: Command): Promise<void> {
  const options = command.optsWithGlobals() as Record<string, unknown>
  process.exitCode = await runCommand(
    {
      home: String(options.home),
      args: prompt,
      session: typeof options.session === "string" ? options.session : undefined,
      continue: options.continue === true,
      fork: typeof options.fork === "string" ? options.fork : undefined,
      cwd: typeof options.cwd === "string" ? options.cwd : undefined,
      attach: Array.isArray(options.attach) ? (options.attach as string[]) : [],
      model: typeof options.model === "string" ? options.model : undefined,
      mode: isPermissionMode(options.mode) ? options.mode : undefined,
      format: OUTPUT_FORMATS.find((f) => f === options.outputFormat) ?? "text",
      color: parseColorMode(options.color),
      yes: options.yes === true,
      no: options.no === true,
      think: options.think === true,
    },
    { help: () => command.helpInformation() },
  )
}

/** `kclaw session list [--json]`. */
async function sessionListAction(home: string, options: Record<string, unknown>): Promise<void> {
  const client = await KclawClient.connect(home)
  const rows = (await client.request("GET", "/sessions")) as SessionRow[]
  process.stdout.write(`${options.json === true ? JSON.stringify(rows) : renderSessionTable(rows)}\n`)
}

const program = new Command()
// Before any subcommand is created: commander copies the exit override into
// subcommands at creation time.
program.exitOverride()
program
  .name("kclaw")
  .description("kclaw daemon 的命令行工具")
  .version(readVersion())
  .option("--home <dir>", "kclaw 主目录", defaultHome())
  // Shared surface options (program level so every invocation parses them:
  // `kclaw --session X` (default action), `kclaw chat --session X` and
  // `kclaw run --session X` — optsWithGlobals merges program options into
  // subcommands; a same-named option on run would lose its value to these).
  .option("--session <id>", "恢复指定会话")
  .option("--think", "流式显示思考过程（暗色）")
  .addOption(new Option("--yes", "自动批准确认"))
  .addOption(new Option("--no", "自动拒绝确认"))
  .action(run(chatAction))

program
  .command("chat")
  .description("交互式对话（不带子命令时的默认行为）")
  .action(run(chatAction))

program
  .command("run")
  .description("一次性运行：发送提示词（参数或 stdin），把本次 run 的输出写到 stdout 后退出")
  .argument("[prompt...]", "提示词；管道模式下 `-` 表示整个 stdin 是提示词")
  .option("--continue", "接续当前工作目录最近更新的会话")
  .option("--fork <id>", "从指定会话分出新会话执行")
  .option("--cwd <dir>", "本次运行的工作目录（默认当前目录）")
  .option("--attach <file>", "附加文件（可重复给出）", collectAttach)
  .option("--model <name>", "会话使用的 provider 条目名（写进会话，之后每轮都用它）")
  .addOption(new Option("--mode <mode>", "会话权限模式（写进会话）").choices([...PERMISSION_MODES]))
  .addOption(new Option("--output-format <format>", "输出格式（默认 text）").choices([...OUTPUT_FORMATS]))
  .addOption(new Option("--color <mode>", "颜色输出（默认 auto：按终端判定；json 两档始终无颜色）").choices([...COLOR_MODES]))
  .configureHelp({ showGlobalOptions: true })
  .action(runAction)

/** --attach accumulator: commander passes the previously collected array. */
function collectAttach(value: string, previous: string[] | undefined): string[] {
  return previous === undefined ? [value] : [...previous, value]
}

const daemon = program.command("daemon").description("daemon 生命周期管理")
daemon.command("start").description("确保 daemon 在运行（没在运行就启动）").action(run(startAction))
daemon.command("stop").description("停止 daemon（先 SIGTERM，再清理 pid 文件）").action(run(stopAction))
daemon.command("status").description("查看 daemon 是否在运行及运行位置").action(run(statusAction))

program.command("status").description("等价于 daemon status").action(run(statusAction))

program
  .command("mcp")
  .description("列出已配置的 MCP server 与各自的工具数量（别名：kclaw mcp list）")
  .argument("[list]", "打印 server 列表（唯一的子命令）")
  .action(run(mcpAction))

program
  .command("web")
  .description("在浏览器打开 WebUI（daemon 没在运行会先启动）")
  .action(run(webAction))

program
  .command("cron")
  .description("定时任务")
  .command("list")
  .description("列出任务（daemon 没在运行会自动启动）")
  .action(run(cronListAction))

/** `kclaw session verify --id <id>` / `--all`：哈希链校验，退出码 0/1 可脚本化。 */
async function sessionVerifyAction(home: string, options: Record<string, unknown>): Promise<void> {
  const client = await KclawClient.connect(home)
  const all = options.all === true
  const idArg = typeof options.id === "string" ? options.id : undefined
  if (!all && idArg === undefined) {
    process.stderr.write("用法：kclaw session verify --id <会话id> 或 kclaw session verify --all\n")
    process.exitCode = 2
    return
  }
  const ids: string[] = all
    ? ((await client.request("GET", "/sessions")) as { id: string }[]).map((s) => s.id)
    : [idArg!]
  let failed = false
  for (const id of ids) {
    const r = (await client.request("GET", `/sessions/${encodeURIComponent(id)}/verify`)) as {
      status: string; checked: number; verifiedFrom?: number; brokenAt?: number; suspect?: number; reason?: string
    }
    let line: string
    switch (r.status) {
      case "ok":
        line = `✓ ${id}  链完整（${r.checked} 条）`
        break
      case "partial":
        line = `✓ ${id}  前 ${r.verifiedFrom! - 1} 条无链（功能上线前写入），自第 ${r.verifiedFrom} 条起链完整（${r.checked} 条）`
        break
      case "not-chained":
        line = `· ${id}  未起链（功能上线前写入的会话）`
        break
      case "torn-tail":
        line = `· ${id}  末行不完整（崩溃痕迹，下次追加自动修复）`
        break
      default:
        failed = true
        line = `✗ ${id}  ${r.reason ?? "链断裂"}`
        if (r.brokenAt !== undefined) line += `（断裂位置：第 ${r.brokenAt} 行）`
        break
    }
    process.stdout.write(`${line}\n`)
  }
  if (failed) process.exitCode = 1
}

const sessionCmd = program.command("session").description("会话")
sessionCmd
  .command("list")
  .description("列出会话（最近更新在前）")
  .option("--json", "输出 JSON 数组（GET /sessions 直通）")
  .action(run(sessionListAction))
sessionCmd
  .command("verify")
  .description("校验会话事件流的哈希链（防篡改完整性检查）")
  .option("--id <id>", "要校验的会话 id")
  .option("--all", "校验全部会话")
  .action(run(sessionVerifyAction))

// Only parse argv when this module is the executed entry (direct
// `node dist/index.js` or via a bin symlink — realpathSync resolves the
// symlink the same way the ESM loader does), never on library import.
const entry = process.argv[1]
const invokedAsMain =
  entry !== undefined &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(realpathSync(entry)).href
    } catch {
      return false
    }
  })()

if (invokedAsMain) {
  // Node version gate (the "低版本 Node" failure mode): the CLI
  // needs the runtime features of Node >= 22 — bail before parsing so a stale
  // runtime never gets as far as a confusing syntax/API error.
  const [major] = process.versions.node.split(".").map(Number)
  if (major < 22) {
    console.error(`kclaw 需要 Node >= 22（当前版本 ${process.versions.node}）`)
    process.exit(1)
  }
  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    // exitOverride: commander usage problems arrive here as CommanderError —
    // its message is already on stderr. Help/version display exits 0; every
    // parse failure is a usage error and leaves through exit code 2 (A6).
    if (error instanceof CommanderError) process.exit(error.exitCode === 0 ? 0 : 2)
    throw error
  }
}
