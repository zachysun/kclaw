#!/usr/bin/env node
/**
 * kclaw-server bin entry: launch the daemon from the built dist and hold
 * until terminated. Home resolution: `--home <dir>` (or `--home=<dir>`) wins,
 * otherwise KCLAW_HOME / ~/.kclaw inside resolvePaths. The llm client is the
 * daemon default (config provider, KCLAW_LLM_* env fallback) — no injection
 * seam here by design.
 *
 * On readiness prints `{"port":<port>}` (one JSON line, stdout) — the CLI
 * and tests wait for exactly that. SIGTERM/SIGINT run daemon.stop():
 * exit 0 on a clean stop, or (bounded stop) log to stderr and exit
 * 1 when a stop step misses its deadline — daemon.json is kept behind by the
 * daemon, since the process is still alive.
 */
import { launchDaemon } from "../dist/index.js"

/** --home <dir> or --home=<dir> from argv; undefined when absent. */
function homeFromArgv(argv) {
  const flag = argv.indexOf("--home")
  if (flag !== -1 && argv[flag + 1] !== undefined) return argv[flag + 1]
  for (const arg of argv) {
    if (arg.startsWith("--home=")) return arg.slice("--home=".length)
  }
  return undefined
}

const daemon = await launchDaemon({ home: homeFromArgv(process.argv) })

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  try {
    await daemon.stop()
    process.exit(0)
  } catch (err) {
    // Bounded stop: a teardown step missed its deadline. Fail
    // loudly instead of exit 0 — a "successfully stopped" exit code would
    // lie about a daemon that is still running.
    process.stderr.write(`kclaw-server stop failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
// Last-resort net: a stray rejection (a late reply to a dead socket, a
// crashed promise nobody awaited) must not take the resident daemon down —
// Node's default on unhandledRejection is process exit. Log and live.
process.on("unhandledRejection", (err) => {
  process.stderr.write(`kclaw-server unhandled rejection: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
})
// Register the signal handlers BEFORE the ready line: a client may kill the
// daemon as soon as it reads readiness, and a SIGTERM landing after launch
// but before these lines are registered would take the default action
// (hard-kill, no clean stop, no daemon.json cleanup).
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())

process.stdout.write(`${JSON.stringify({ port: daemon.port })}\n`)
