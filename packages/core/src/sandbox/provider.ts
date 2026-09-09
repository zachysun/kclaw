/**
 * Exec sandbox provider: the OS-level sandbox that wraps the `exec` tool's
 * child process. This is the ONE new concept the permission sandbox feature
 * introduces; everything else is a parameter on existing entry points.
 *
 * Responsibilities: platform availability probing + spawn wrapping. The
 * provider carries NO business judgment — whether a sandboxed exec auto-passes
 * the permission gate is decided in permissions/engine.ts from
 * `sandboxAvailable`, which the run assembly derives from `provider.available`
 * (single source, so a "sandboxed" allowance can never be issued while exec
 * runs bare).
 *
 * Platform layout (see docs/superpowers/exec-sandbox-spec.md):
 * - macOS: sandbox-exec + an SBPL profile — workspace/tmp writable, home
 *   readable except ~/.kclaw masked read-denied (credential isolation).
 *   First-match rule order matters (an allow list then a deny fallback).
 * - Linux: bubblewrap, no setuid — whole root ro-bind, ~/.kclaw tmpfs-masked,
 *   /tmp + workspace writable, `--die-with-parent --new-session` so the exec
 *   tool's process-group kill and the timeout reach the whole tree. Network
 *   stays OPEN by default (v1 decision); `sandbox.network: "deny"` opts into
 *   isolation (`deny network-outbound/inbound` on Seatbelt, `--unshare-net`
 *   for bwrap) — web tools are unaffected (they run in the daemon, not the
 *   exec child).
 * - Linux fallback chain: bwrap → unavailable (manual confirmation).
 *   Landlock fallback is a follow-up: pure Node cannot issue the
 *   landlock_create_ruleset syscall, and no mature CLI wrapper exists.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { realpathWithin } from "../permissions/engine.js"
import type { SandboxConfig } from "../storage/config.js"

/** The spawn surface the exec tool consumes (minimal by design). */
export interface ExecSandbox {
  readonly available: boolean
  /** Why the sandbox is unavailable; undefined while available. */
  readonly unavailableReason?: string
  /** Spawn `command` (a shell command line) inside the sandbox. */
  spawn(command: string, opts: { cwd: string }): ChildProcess
}

/** Locate an executable on PATH (used for bwrap probing). */
export function findOnPath(name: string): string | undefined {
  try {
    const r = spawnSync("which", [name], { encoding: "utf8" })
    if (r.status === 0 && r.stdout.trim() !== "") return r.stdout.trim().split("\n")[0]!
  } catch {
    // which itself missing — treat as not found
  }
  return undefined
}

/** Realpath form of a path (the sandbox layouts must match literally). */
const realpathOf = (p: string): string => realpathWithin(resolve(p))

/**
 * macOS SBPL profile. Rule order is first-match-wins: specific allows come
 * before the write/read denials so the workspace/tmp roots actually stay
 * writable, and the ~/.kclaw read-denial comes before the broad read allow.
 * Paths must be realpath form (Seatbelt matches literally; /tmp is really
 * /private/tmp — a lexical /tmp rule is bypassable via the symlink).
 *
 * network: "allow" keeps `(allow network*)`. "deny" swaps it for outbound +
 * inbound denies — a bare `(deny network*)` is TOO BROAD on Seatbelt (the
 * wildcard also matches internal ops the shell needs to even start, observed
 * empirically: process exec broke), while outbound+inbound precisely blocks
 * connect()/accept() and leaves the process usable.
 */
export function seatbeltProfile(o: {
  workspace: string
  home: string
  writeRoots: string[]
  tmpDirs: string[]
  network?: "allow" | "deny"
}): string {
  const ws = realpathOf(o.workspace)
  const home = realpathOf(o.home)
  const write = [ws, ...o.tmpDirs.map(realpathOf), ...o.writeRoots.map(realpathOf)]
  const writeClause = write.map((p) => `(subpath "${p}")`).join(" ")
  const network = o.network ?? "allow"
  return [
    "(version 1)",
    '(import "system.sb")',
    "(allow process*)",
    ...(network === "deny" ? ["(deny network-outbound)", "(deny network-inbound)"] : ["(allow network*)"]),
    `(deny file-read* (subpath "${join(home, ".kclaw")}"))`,
    "(allow file-read*)",
    `(allow file-write* ${writeClause})`,
    "(deny file-write*)",
    "",
  ].join("\n")
}

/**
 * Linux bubblewrap argv (leading non-flag = the command to run inside).
 * Whole root ro-bind, then tmpfs/bind overrides — a later mount of the same
 * path shadows an earlier one, so the writable spots win. network: "deny"
 * adds `--unshare-net` (own network namespace, loopback down). --new-session
 * makes bwrap the session leader, so the exec tool's `kill(-pid)` (its own
 * new process group) still reaps the whole tree, and --die-with-parent covers
 * a SIGKILL'd bwrap's descendants.
 */
export function bwrapArgs(o: {
  workspace: string
  home: string
  writeRoots: string[]
  command: string
  network?: "allow" | "deny"
}): string[] {
  const ws = realpathOf(o.workspace)
  const home = realpathOf(o.home)
  const args = [
    "--die-with-parent",
    "--new-session",
    ...(o.network === "deny" ? ["--unshare-net"] : []),
    "--ro-bind", "/", "/",
    "--tmpfs", join(home, ".kclaw"),
    "--tmpfs", "/tmp",
    "--tmpfs", "/var/tmp",
    "--bind", ws, ws,
  ]
  for (const root of o.writeRoots) {
    const r = realpathOf(root)
    args.push("--bind", r, r)
  }
  args.push("--chdir", ws, "/bin/sh", "-c", o.command)
  return args
}

/** Quick real-world probe that bwrap can actually run (userns available). */
function bwrapWorks(bwrap: string): boolean {
  try {
    const r = spawnSync(bwrap, ["--die-with-parent", "true"], { timeout: 5_000 })
    return r.status === 0
  } catch {
    return false
  }
}

const SEATBELT_BIN = "/usr/bin/sandbox-exec"

/**
 * Build the exec sandbox for this process. Availability is probed once per
 * call (the run assembly calls this once per run; the probe is cheap). `which`
 * is injectable for tests; the real default probes PATH via `which`.
 */
export function createExecSandbox(
  cfg: SandboxConfig,
  o: {
    workspace?: string
    home?: string
    tmpDirs?: string[]
    which?: (name: string) => string | undefined
  } = {},
): ExecSandbox {
  if (!cfg.enabled) {
    return unavailable("sandbox disabled in config (sandbox.enabled: false)")
  }
  const home = o.home ?? homedir()
  const tmpDirs = o.tmpDirs ?? [tmpdir(), "/private/tmp"]
  const network = cfg.network ?? "allow"
  const which = o.which ?? findOnPath
  // The exec tool always spawns with cwd = workspace, so that is the layout's
  // workspace when the caller did not pin one.
  const workspaceFor = (cwd: string): string => o.workspace ?? cwd

  if (process.platform === "darwin") {
    if (!existsSync(SEATBELT_BIN)) {
      return unavailable("sandbox-exec not found (expected at /usr/bin/sandbox-exec)")
    }
    return {
      available: true,
      spawn(command, opts) {
        const profile = seatbeltProfile({ workspace: workspaceFor(opts.cwd), home, writeRoots: cfg.writeRoots, tmpDirs, network })
        return spawn(SEATBELT_BIN, ["-p", profile, "/bin/sh", "-c", command], {
          cwd: opts.cwd,
          // Own process group so the exec tool's timeout kill(-pid) reaches
          // the sandbox and everything it spawned (sandbox-exec execs the
          // shell in place, same pid/group).
          detached: true,
        })
      },
    }
  }

  if (process.platform === "linux") {
    const bwrap = which("bwrap")
    if (bwrap === undefined) {
      return unavailable("bwrap not found on PATH (Landlock fallback pending)")
    }
    if (!bwrapWorks(bwrap)) {
      return unavailable(`bwrap present but unusable (${bwrap}): user namespaces unavailable; falling back to manual confirmation`)
    }
    return {
      available: true,
      spawn(command, opts) {
        const args = bwrapArgs({ workspace: workspaceFor(opts.cwd), home, writeRoots: cfg.writeRoots, command, network })
        return spawn(bwrap, args, { cwd: opts.cwd, detached: true })
      },
    }
  }

  return unavailable(`no exec sandbox for platform ${process.platform}`)
}

function unavailable(reason: string): ExecSandbox {
  return {
    available: false,
    unavailableReason: reason,
    spawn() {
      throw new Error(`exec sandbox unavailable: ${reason}`)
    },
  }
}
