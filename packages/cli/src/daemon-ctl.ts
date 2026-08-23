/**
 * Daemon control: the CLI's side of the daemon lifecycle —
 * `ensureDaemon` (probe, stale-pidfile liveness, detached respawn, health
 * poll), `stopDaemon` (SIGTERM + refused-poll + pidfile sweep) and
 * `daemonStatus` (health + daemon.json facts).
 *
 * The respawn target is the server bin script, resolved by walking up from
 * THIS module to the enclosing `packages/` directory (see
 * {@link resolveServerBin}). Assumption, documented per the brief: the CLI
 * runs from a repo checkout (`packages/cli` next to `packages/server`), which
 * is exactly where tests run it from (`node <repo>/packages/cli/dist/...`).
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** The daemon only ever binds loopback (127.0.0.1). */
const HOST = "127.0.0.1"

/** Budget for a respawned/stopping daemon to change observable state. */
const POLL_TIMEOUT_MS = 5_000

/** Cadence of every poll loop below. */
const POLL_INTERVAL_MS = 250

/** Per-attempt health probe timeout — a wedged port must not stall the CLI. */
const PROBE_TIMEOUT_MS = 1_000

/** daemon.json shape, as written by the server on ready. */
export interface DaemonInfo {
  port: number
  pid: number
  startedAt: string
}

/** Result of {@link ensureDaemon}: the live daemon plus how we got there. */
export interface EnsureResult {
  info: DaemonInfo
  /** True when this call spawned the daemon process; false when it was already healthy. */
  spawned: boolean
}

/** Default kclaw home: KCLAW_HOME env, else ~/.kclaw (mirrors resolvePaths). */
export function defaultHome(): string {
  return process.env.KCLAW_HOME ?? join(homedir(), ".kclaw")
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  // pid must be a POSITIVE integer: pid 0 would make
  // process.kill(0, …) signal the CLI's whole process group. A non-positive
  // pid is treated like a malformed file — stale, respawn/stop-safe.
  return Number.isInteger(v.port) && Number.isInteger(v.pid) && (v.pid as number) > 0 && typeof v.startedAt === "string"
}

/**
 * Read `<home>/daemon.json`; undefined when absent or malformed (the caller
 * treats a malformed file like a missing one — respawn overwrites it).
 */
export function readDaemonJson(home: string): DaemonInfo | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"))
    return isDaemonInfo(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** GET /health on the daemon port (the one unauthenticated route); false on any failure. */
export async function probeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${port}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Resolve the server bin script (`packages/server/bin/kclaw-server.mjs`) by
 * walking up from this module: the first ancestor `A` where
 * `A/server/bin/kclaw-server.mjs` exists is the `packages/` dir. Works from
 * src/ (vitest) and dist/ (built CLI) alike, and survives the package being
 * moved within the repo's packages/ dir.
 */
export function resolveServerBin(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, "server", "bin", "kclaw-server.mjs")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(
        `kclaw-server bin not found above ${dir} — the CLI expects a repo checkout with packages/server next to packages/cli`,
      )
    }
    dir = parent
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll until daemon.json holds a port whose /health answers (re-read every
 * iteration: a respawning daemon overwrites the file only when ready).
 * Undefined on timeout.
 */
async function waitForHealthy(home: string, timeoutMs = POLL_TIMEOUT_MS): Promise<DaemonInfo | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = readDaemonJson(home)
    if (info !== undefined && (await probeHealth(info.port))) return info
    await sleep(POLL_INTERVAL_MS)
  }
  return undefined
}

/** True when `pid` belongs to some live process (signal 0 never delivers). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/** Detached respawn: the child outlives the CLI (stdio ignored, unref'd). */
function spawnDaemon(home: string): void {
  const child = spawn(process.execPath, [resolveServerBin(), "--home", home], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, KCLAW_HOME: home },
  })
  child.unref()
}

/**
 * Make sure a healthy daemon serves `home`, spawning one when needed.
 *
 * Order of events: healthy daemon.json → return it. daemon.json present but
 * unhealthy → liveness-check its pid; ESRCH (dead daemon, e.g. SIGKILL or
 * crash left the pidfile behind) is overwrite-safe, so log the stale hint and
 * respawn — the new launch rewrites daemon.json. A live pid that stays
 * unhealthy for the whole poll is NOT double-spawned against: it either
 * comes healthy (return) or the call fails with a hint.
 */
export async function ensureDaemon(home: string): Promise<EnsureResult> {
  const existing = readDaemonJson(home)
  if (existing !== undefined && (await probeHealth(existing.port))) {
    return { info: existing, spawned: false }
  }

  if (existing !== undefined && pidAlive(existing.pid)) {
    // Alive but not answering: a daemon still booting (another invocation)
    // or a wedged one. Give it the poll budget before giving up — spawning a
    // second daemon against a live pid would orphan the first.
    const recovered = await waitForHealthy(home)
    if (recovered !== undefined) return { info: recovered, spawned: false }
    throw new Error(
      `daemon pid ${existing.pid} is alive but not answering on port ${existing.port}; ` +
        `kill it (kill ${existing.pid}) or remove ${join(home, "daemon.json")}, then retry`,
    )
  }

  if (existing !== undefined) {
    // ESRCH above: dead daemon, stale pidfile — respawn is overwrite-safe.
    process.stderr.write("stale daemon.json, respawning\n")
  }

  spawnDaemon(home)
  const info = await waitForHealthy(home)
  if (info === undefined) {
    throw new Error(
      `daemon did not become healthy within ${POLL_TIMEOUT_MS}ms — try 'kclaw daemon status' ` +
        `and check that packages/server is built (pnpm -C packages/server build)`,
    )
  }
  return { info, spawned: true }
}

/** Outcome of {@link stopDaemon}: the exact user-facing line. */
export type StopResult = "stopped" | "daemon not running"

/**
 * Stop the daemon in `home`: SIGTERM the pid from daemon.json (the bin's
 * handler runs daemon.stop()), poll until the port refuses connections, then
 * remove daemon.json if the process died without doing so (SIGKILL path).
 * No daemon.json (or an invalid/non-positive pid in it) → "daemon not
 * running" (still exit 0).
 *
 * Final probe: when the poll budget is exhausted and /health STILL
 * answers, the daemon ignored or outlived the SIGTERM — stop() throws (the
 * CLI prints the message on stderr and exits 1) and daemon.json is KEPT as
 * the pointer to the still-live process. Deleting it would orphan a
 * responding daemon no future `kclaw` command could find or stop.
 */
export async function stopDaemon(home: string): Promise<StopResult> {
  const info = readDaemonJson(home)
  if (info === undefined) return "daemon not running"

  try {
    process.kill(info.pid, "SIGTERM")
  } catch (error) {
    // Already dead (crashed earlier, pidfile left behind): fall through to
    // the refused-poll + pidfile sweep, which makes this stop idempotent.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline && (await probeHealth(info.port))) {
    await sleep(POLL_INTERVAL_MS)
  }

  if (await probeHealth(info.port)) {
    throw new Error(`stop failed: daemon still responding on port ${info.port} (pid ${info.pid})`)
  }

  rmSync(join(home, "daemon.json"), { force: true })
  return "stopped"
}

/** Outcome of {@link daemonStatus}: facts only, printing is the command's job. */
export interface DaemonStatusResult {
  running: boolean
  /** Present when running: the daemon.json facts. */
  info?: DaemonInfo
  /** Present when running: whole seconds since daemon.json `startedAt`. */
  uptimeSec?: number
}

/**
 * Is a daemon serving `home`? Healthy daemon.json → running with port, pid
 * and uptime; anything else (no file, stale file, dead port) → not running.
 */
export async function daemonStatus(home: string): Promise<DaemonStatusResult> {
  const info = readDaemonJson(home)
  if (info === undefined || !(await probeHealth(info.port))) return { running: false }
  const startedAtMs = Date.parse(info.startedAt)
  const uptimeSec = Number.isNaN(startedAtMs)
    ? 0
    : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
  return { running: true, info, uptimeSec }
}
