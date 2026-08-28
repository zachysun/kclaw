/**
 * Daemon web hosting + build chain: launchDaemon auto-detects the
 * built web UI at `<repo>/packages/web/dist` and serves it — the shell
 * document and `/assets/*` bundles load before the client holds a token, while
 * every API route stays bearer-protected — and an explicit-but-nonexistent
 * webDist degrades to the API-only daemon (no hosting, `GET /` is 401).
 *
 * The web build is the seam of the chain: a fresh clone has no packages/web/
 * dist (gitignored), so this suite builds it once in beforeAll when the shell
 * document is missing (root `pnpm build` / `pnpm test` both cover the web
 * package).
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, resolvePaths } from "@kclaw/core"
import type { KclawConfig, LlmClient, LlmStreamEvent } from "@kclaw/core"
import { launchDaemon } from "../src/daemon.js"
import type { Daemon } from "../src/daemon.js"

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const WEB_ROOT = join(SERVER_ROOT, "..", "web")
const WEB_DIST_INDEX = join(WEB_ROOT, "dist", "index.html")

// --- fixtures ---------------------------------------------------------------

/** Temp homes to sweep in afterEach. */
const homes: string[] = []
/** Daemons still running at afterEach time (tests stop their own; safety net). */
const daemons: Daemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined)
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

beforeAll(() => {
  // Build the web UI once when its dist is missing (fresh clones have none).
  // `pnpm -C packages/web build` runs the package's own build script
  // (tsc --noEmit && vite build) exactly as the root build chain does.
  if (!existsSync(WEB_DIST_INDEX)) {
    execFileSync("pnpm", ["-C", WEB_ROOT, "build"], { stdio: "pipe" })
  }
}, 180_000)

/** Empty-stream LlmClient (daemon.test.ts pattern): runs never reach the wire. */
function scriptClient(script: LlmStreamEvent[][] = []): LlmClient {
  let i = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield* script[Math.min(i++, script.length - 1)]!
    },
  }
}

/** Fresh temp home registered for afterEach cleanup. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kclaw-web-serving-home-"))
  homes.push(home)
  return home
}

/** Defaults plus a mock provider entry (daemon.test.ts pattern). */
function makeConfig(home: string): KclawConfig {
  const config = loadConfig(resolvePaths(home))
  config.workspace = mkdtempSync(join(tmpdir(), "kclaw-web-serving-ws-"))
  homes.push(config.workspace)
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  return config
}

// --- smoke tests -------------------------------------------------------------

describe("launchDaemon web hosting", () => {
  it(
    "serves the built web UI by default: shell + /assets/* need no token, API routes stay protected",
    async () => {
      // The default webDist resolution points at <repo>/packages/web/dist;
      // beforeAll built it when it was missing.
      expect(existsSync(WEB_DIST_INDEX)).toBe(true)

      const home = makeHome()
      const daemon = await launchDaemon({ home, config: makeConfig(home), llmFactory: scriptClient })
      daemons.push(daemon)

      // GET / (no token): the shell document loads before the client has a token
      const shell = await fetch(`http://127.0.0.1:${daemon.port}/`)
      expect(shell.status).toBe(200)
      expect(await shell.text()).toContain('<div id="root">')

      // GET an /assets/*.js bundle (no token): part of the pre-token shell
      const asset = readdirSync(join(WEB_ROOT, "dist", "assets")).find((f) => f.endsWith(".js"))
      expect(asset).toBeDefined()
      const bundle = await fetch(`http://127.0.0.1:${daemon.port}/assets/${asset}`)
      expect(bundle.status).toBe(200)
      expect((await bundle.text()).length).toBeGreaterThan(0)

      // API routes stay bearer-protected even with the shell served
      const sessions = await fetch(`http://127.0.0.1:${daemon.port}/sessions`)
      expect(sessions.status).toBe(401)

      await daemon.stop()
    },
    30_000,
  )

  it("serves PWA static files without a token: manifest, service worker, icons", async () => {
    const home = makeHome()
    const daemon = await launchDaemon({ home, config: makeConfig(home), llmFactory: scriptClient })
    daemons.push(daemon)

    // The PWA needs these files before the client holds a token: the manifest
    // (install info), the service worker (offline shell) and its icons.
    for (const path of ["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png"]) {
      const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`)
      expect(res.status).toBe(200)
      expect((await res.text()).length).toBeGreaterThan(0)
    }

    // /favicon.ico has no file on disk (the browser requests it by default);
    // it must not be 401 — reaching the static handler proves the auth gate
    // let it through (a 404 from the static server is fine).
    const favicon = await fetch(`http://127.0.0.1:${daemon.port}/favicon.ico`)
    expect(favicon.status).not.toBe(401)

    await daemon.stop()
  })

  it("an explicit webDist that does not exist disables hosting: GET / is 401 (no token)", async () => {
    const home = makeHome()
    const daemon = await launchDaemon({
      home,
      config: makeConfig(home),
      llmFactory: scriptClient,
      webDist: join(home, "no-such-dist"),
    })
    daemons.push(daemon)

    const root = await fetch(`http://127.0.0.1:${daemon.port}/`)
    expect(root.status).toBe(401)

    await daemon.stop()
  })
})
