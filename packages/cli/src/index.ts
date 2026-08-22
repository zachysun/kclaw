#!/usr/bin/env node
/**
 * kclaw CLI entry (P3 Task 10+11). The shebang above is preserved verbatim by
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
  process.stdout.write(
    `running (pid ${status.info.pid}, port ${status.info.port}, uptime ${status.uptimeSec}s)\n`,
  )
}

async function jobsListAction(home: string): Promise<void> {
  const client = await KclawClient.connect(home)
  const list: unknown = await client.request("GET", "/jobs")
  const jobs = Array.isArray(list) ? (list as Job[]) : []
  process.stdout.write(`${renderJobsTable(jobs)}\n`)
}

/** Shared by the default (bare `kclaw`) action and the explicit `chat` subcommand. */
async function chatAction(home: string, options: Record<string, unknown>): Promise<void> {
  // First-run gate (P4 Task 8): no provider configured anywhere → run the
  // setup wizard in a TTY (abort = leave silently, nothing written), or
  // print one line of guidance when stdin/stdout is not interactive.
  const status = detectProviderStatus(home)
  if (status === "missing") {
    if (process.stdout.isTTY) {
      const r = await runWizard(home)
      if (r === "aborted") return
    } else {
      process.stdout.write("no llm provider configured — run `kclaw chat` in a terminal to run the setup wizard, see README\n")
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
  .description("CLI for the kclaw daemon")
  .version(readVersion())
  .option("--home <dir>", "kclaw home directory", defaultHome())
  // Chat options live on the program so BOTH invocations parse them:
  // `kclaw --session X` (default action) and `kclaw chat --session X`
  // (optsWithGlobals merges program options into the subcommand).
  .option("--session <id>", "chat: resume this session instead of creating one")
  .option("--think", "chat: stream thinking deltas (dim)")
  .addOption(new Option("--yes", "chat: auto-approve confirmations (tests & scripting)").hideHelp())
  .addOption(new Option("--no", "chat: auto-deny confirmations (tests & scripting)").hideHelp())
  .action(run(chatAction))

program
  .command("chat")
  .description("interactive chat (the default when no subcommand is given)")
  .action(run(chatAction))

const daemon = program.command("daemon").description("daemon lifecycle")
daemon.command("start").description("ensure the daemon is running (spawn it when it is not)").action(run(startAction))
daemon.command("stop").description("stop the daemon (SIGTERM, then clean the pidfile)").action(run(stopAction))
daemon.command("status").description("report whether the daemon is running, and where").action(run(statusAction))

program.command("status").description("alias of 'daemon status'").action(run(statusAction))

program
  .command("web")
  .description("open the WebUI in your browser (starts the daemon if needed)")
  .action(run(webAction))

program
  .command("jobs")
  .description("scheduled jobs")
  .command("list")
  .description("list jobs (auto-starts the daemon when it is not running)")
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
  // Node version gate (spec error-handling table, "低版本 Node" row): the CLI
  // needs the runtime features of Node >= 22 — bail before parsing so a stale
  // runtime never gets as far as a confusing syntax/API error.
  const [major] = process.versions.node.split(".").map(Number)
  if (major < 22) {
    console.error(`kclaw requires Node >= 22 (you are on ${process.versions.node})`)
    process.exit(1)
  }
  await program.parseAsync(process.argv)
}
