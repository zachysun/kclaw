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
process.stdout.write(`${JSON.stringify({ port: daemon.port })}\n`)

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
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
