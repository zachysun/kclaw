/**
 * The `kclaw web` command (v3 Phase 4 Task 9): ensure the daemon, read the
 * bearer token from `<home>/token`, and hand it to the web shell via the
 * `?token=` query — the SPA's bootstrapToken() saves it to localStorage and
 * strips the query, so the user lands in the WebUI with no token left in the
 * address bar (the "token gate" fix this task exists for).
 *
 * Pure helpers (buildWebUrl / openCommandFor) are unit-tested in
 * test/web-cmd.test.ts; webAction is exercised by the manual smoke because it
 * spawns a real browser.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { ensureDaemon } from "./daemon-ctl.js"

/**
 * Build the WebUI URL with the token handshake query. The port is the
 * daemon.json port (loopback-only per spec §4); the token is URL-encoded so a
 * token with reserved characters still round-trips through URLSearchParams.
 */
export function buildWebUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
}

/**
 * Best-effort browser opener for the platform: macOS `open`, Linux
 * `xdg-open`, anything else (win32 included) null — the caller then just
 * prints the URL for the user to open by hand.
 */
export function openCommandFor(platform: NodeJS.Platform): "open" | "xdg-open" | null {
  if (platform === "darwin") return "open"
  if (platform === "linux") return "xdg-open"
  return null
}

/**
 * Ensure the daemon is up, then open the WebUI in the user's browser with the
 * token already in hand. The spawned opener is detached and unref'd (same
 * pattern as the daemon respawn): the CLI must not wait on the browser, and
 * the browser must outlive the CLI. The "opening" line deliberately omits the
 * token — the URL the user can see/share is the bare one.
 */
export async function webAction(home: string): Promise<void> {
  const { info, spawned } = await ensureDaemon(home)
  if (spawned) process.stdout.write("daemon started\n")
  const token = readFileSync(join(home, "token"), "utf8").trim()
  const url = buildWebUrl(info.port, token)
  const cmd = openCommandFor(process.platform)
  if (cmd) {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref()
    process.stdout.write(`opening ${url.split("?")[0]} in your browser\n`)
  } else {
    process.stdout.write(`open ${url}\n`)
  }
}
