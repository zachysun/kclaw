#!/usr/bin/env node
/**
 * kclaw CLI entry. The shebang above is preserved verbatim by
 * tsc (verified: it is emitted as line 1 of dist/index.js), so the compiled
 * `bin` target is directly executable — no post-build step.
 *
 * Commands: `daemon start|stop|status` (lifecycle via daemon-ctl; `status`
 * is also aliased at the top level), `jobs list` (auto-connecting client →
 * padded-text table, no table dep), and the interactive `chat` REPL — which
 * is also the DEFAULT: bare `kclaw` (optionally `--session <id>`, `--think`,
 * hidden `--yes`/`--no` for tests & scripting) drops straight into a chat
 * session. `--home <dir>` is a program-level option (default
 * KCLAW_HOME ?? ~/.kclaw); exit codes: 0 ok, 1 failure with the message on
 * stderr.
 *
 * Library surface: KclawClient / runChat are re-exported for programmatic
 * use; argv is only parsed when this module is the executed entry (guard at
 * bottom), so importing "@kclaw/cli" stays side-effect free.
 */
import { readFileSync, realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { Command, Option } from "commander"
import type { Job } from "@kclaw/core"
import { mcpGroupLabel } from "@kclaw/core/commands"
import type { McpServerStatus } from "@kclaw/core/protocol"
import { KclawClient } from "./client.js"
import { runChat } from "./chat.js"
import { daemonStatus, defaultHome, ensureDaemon, stopDaemon } from "./daemon-ctl.js"
import { detectProviderStatus } from "./provider-check.js"
import { runWizard } from "./wizard.js"
import { webAction } from "./web-cmd.js"

export { KclawClient } from "./client.js"
export { runChat } from "./chat.js"

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

/** A job row's printable columns (the header doubles as the empty-state output). */
function jobRow(job: Job): Record<"name" | "cron" | "enabled" | "nextRunAt" | "lastStatus", string> {
  return {
    name: job.name,
    cron: job.cron,
    enabled: String(job.enabled),
    nextRunAt: job.nextRunAt,
    lastStatus: job.lastStatus ?? "-",
  }
}

/** Plain string-padded table: header + rows, columns aligned, two-space gutters. */
function renderJobsTable(jobs: Job[]): string {
  const header: Record<"name" | "cron" | "enabled" | "nextRunAt" | "lastStatus", string> = {
    name: "name",
    cron: "cron",
    enabled: "enabled",
    nextRunAt: "nextRunAt",
    lastStatus: "lastStatus",
  }
  const keys = Object.keys(header) as Array<keyof typeof header>
  const rows = jobs.map(jobRow)
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

async function jobsListAction(home: string): Promise<void> {
  const client = await KclawClient.connect(home)
  const list: unknown = await client.request("GET", "/jobs")
  const jobs = Array.isArray(list) ? (list as Job[]) : []
  process.stdout.write(`${renderJobsTable(jobs)}\n`)
}

/** `kclaw mcp [list]`: grouped lines per configured MCP server (group header, then name/state/tool count). */
async function mcpAction(home: string): Promise<void> {
  const client = await KclawClient.connect(home)
  const body = (await client.request("GET", "/mcp")) as {
    groups?: Array<{ id: string; servers: Array<Pick<McpServerStatus, "name" | "state" | "group" | "tools" | "lastError">> }>
  }
  const groups = body.groups ?? []
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
  // First-run gate: no provider configured anywhere → run the
  // setup wizard in a TTY (abort = leave silently, nothing written), or
  // print one line of guidance when stdin/stdout is not interactive.
  const status = detectProviderStatus(home)
  if (status === "missing") {
    if (process.stdout.isTTY) {
      const r = await runWizard(home)
      if (r === "aborted") return
    } else {
      process.stdout.write("尚未配置模型 provider：请在终端运行 `kclaw chat` 完成配置向导，详见 README\n")
      return
    }
  }
  await runChat({
    home,
    session: typeof options.session === "string" ? options.session : undefined,
    showThinking: options.think === true,
    yes: options.yes === true,
    no: options.no === true,
  })
}

const program = new Command()
program
  .name("kclaw")
  .description("kclaw daemon 的命令行工具")
  .version(readVersion())
  .option("--home <dir>", "kclaw 主目录", defaultHome())
  // Chat options live on the program so BOTH invocations parse them:
  // `kclaw --session X` (default action) and `kclaw chat --session X`
  // (optsWithGlobals merges program options into the subcommand).
  .option("--session <id>", "chat：恢复指定会话而不是新建")
  .option("--think", "chat：流式显示思考过程（暗色）")
  .addOption(new Option("--yes", "chat：自动批准确认（测试与脚本用）").hideHelp())
  .addOption(new Option("--no", "chat：自动拒绝确认（测试与脚本用）").hideHelp())
  .action(run(chatAction))

program
  .command("chat")
  .description("交互式对话（不带子命令时的默认行为）")
  .action(run(chatAction))

const daemon = program.command("daemon").description("daemon 生命周期管理")
daemon.command("start").description("确保 daemon 在运行（没在运行就拉起）").action(run(startAction))
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
  .description("在浏览器打开 WebUI（daemon 没在运行会先拉起）")
  .action(run(webAction))

program
  .command("jobs")
  .description("定时任务")
  .command("list")
  .description("列出任务（daemon 没在运行会自动拉起）")
  .action(run(jobsListAction))

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
  await program.parseAsync(process.argv)
}
