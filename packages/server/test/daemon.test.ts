/**
 * Daemon lifecycle tests: launchDaemon assembling the whole
 * daemon — token, stores (+ memory startup reconcile), app, listener,
 * daemon.json pidfile, scheduler tick — and stop() tearing it back down.
 *
 * The default llmFactory resolution (config entry wins, KCLAW_LLM_* env
 * falls back) is exercised without HTTP, and the bin/kclaw-server.mjs entry
 * is exercised for real in a spawned process (SIGTERM → clean exit 0).
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest"
import { spawn, execFileSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, resolvePaths } from "@kclaw/core"
import type { KclawConfig, LlmClient, LlmStreamEvent } from "@kclaw/core"
import { DEFAULT_STOP_TIMEOUT_MS, defaultLlmFactory, launchDaemon, withStopTimeout } from "../src/daemon.js"
import type { Daemon } from "../src/daemon.js"

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = join(SERVER_ROOT, "bin", "kclaw-server.mjs")
const DIST_INDEX = join(SERVER_ROOT, "dist", "index.js")

// --- fixtures ---------------------------------------------------------------

/** Temp homes to sweep in afterEach. */
const homes: string[] = []
/** Daemons still running at afterEach time (tests stop their own; safety net). */
const daemons: Daemon[] = []
/** Spawned bin processes to kill in afterEach (safety net). */
const children: ChildProcess[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined)
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** Scripted LlmClient: one array of stream events per llm call, last one repeats. */
function scriptClient(script: LlmStreamEvent[][]): LlmClient {
  let i = 0
  return {
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield* script[Math.min(i++, script.length - 1)]!
    },
  }
}

/** Fresh temp home registered for afterEach cleanup. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kclaw-daemon-home-"))
  homes.push(home)
  return home
}

/** Grab a free TCP port from the OS and release it (same pattern as the onRetry test). */
async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
  const port = (srv.address() as AddressInfo).port
  // Bounded release: a transiently wedged close must not park the test. The
  // handle is unref'd so a stuck close can neither hang the suite nor hold
  // the worker alive; the port is ours to hand out either way.
  await Promise.race([
    new Promise<void>((resolve) => srv.close(() => resolve)),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
  ])
  srv.unref()
  return port
}

/** Wait for a spawned child to exit, collecting stderr. */
function waitExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = ""
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("exit", (code) => resolve({ code, stderr }))
    child.once("error", reject)
  })
}

/** Defaults plus a mock provider entry (run.test.ts pattern). */
function makeConfig(home: string): KclawConfig {
  const config = loadConfig(resolvePaths(home))
  config.workspace = mkdtempSync(join(tmpdir(), "kclaw-daemon-ws-"))
  homes.push(config.workspace)
  config.providers = {
    default: "mock",
    entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "mock-model" } },
  }
  return config
}

/** Launch with the mock script client; registers the daemon for cleanup. */
async function launchMock(
  home: string,
  config: KclawConfig,
  opts: { port?: number; schedulerIntervalMs?: number } = {},
): Promise<Daemon> {
  const daemon = await launchDaemon({ home, config, llmFactory: () => scriptClient([]), ...opts })
  daemons.push(daemon)
  return daemon
}

/** Set env vars for the duration of `fn`, restoring the originals after. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// --- launch / stop lifecycle -------------------------------------------------

describe("launchDaemon", () => {
  it("serves /health over real HTTP and writes daemon.json with port+pid", async () => {
    const home = makeHome()
    const daemon = await launchMock(home, makeConfig(home))

    const health = await fetch(`http://127.0.0.1:${daemon.port}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })

    // the Daemon token is the app token: /status answers with it, 401s without
    const status = await fetch(`http://127.0.0.1:${daemon.port}/status`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    })
    expect(status.status).toBe(200)
    const anon = await fetch(`http://127.0.0.1:${daemon.port}/status`)
    expect(anon.status).toBe(401)

    expect(daemon.pid).toBe(process.pid)
    const pidfile = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as {
      port: number
      pid: number
      startedAt: string
    }
    expect(pidfile.port).toBe(daemon.port)
    expect(pidfile.pid).toBe(process.pid)
    expect(typeof pidfile.startedAt).toBe("string")
  })

  it("reuses the token file across launches in the same home (and keeps it after stop)", async () => {
    const home = makeHome()
    const first = await launchMock(home, makeConfig(home))
    const token = first.token
    await first.stop()

    const second = await launchMock(home, makeConfig(home))
    expect(second.token).toBe(token)
    await second.stop()

    // stop() deletes daemon.json but NEVER the token file
    expect(existsSync(join(home, "token"))).toBe(true)
  })

  it("assembles the memory system at startup", async () => {
    const home = makeHome()
    const paths = resolvePaths(home)
    const daemon = await launchMock(home, makeConfig(home))
    // MemorySystem 构造即建布局目录。
    expect(existsSync(join(paths.memoryDir, "global"))).toBe(true)
    expect(existsSync(join(paths.memoryDir, "projects"))).toBe(true)
    expect(existsSync(join(paths.memoryDir, "global", "vectors.db"))).toBe(true)
  })

  it("stop() removes daemon.json, is idempotent, and the port refuses connections", async () => {
    const home = makeHome()
    const daemon = await launchMock(home, makeConfig(home))
    const port = daemon.port

    await daemon.stop()
    expect(existsSync(join(home, "daemon.json"))).toBe(false)

    await expect(daemon.stop()).resolves.toBeUndefined()

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  })
})

// --- daemon slot exclusivity ---------------------------------------------------

describe("daemon slot exclusivity", () => {
  it("a second launch on a live daemon's home is refused", async () => {
    const home = makeHome()
    const d1 = await launchMock(home, makeConfig(home))

    // same home while d1 is alive: the second launcher must refuse instead
    // of silently overwriting the pidfile and orphaning d1
    await expect(launchMock(home, makeConfig(home))).rejects.toThrow(/already running/)

    await d1.stop()
  })

  it("after a clean stop the home is launchable again", async () => {
    const home = makeHome()
    const d1 = await launchMock(home, makeConfig(home))
    await d1.stop()

    const d2 = await launchMock(home, makeConfig(home))
    expect(d2.port).toBeGreaterThan(0)
    await d2.stop()
  })

  it("a stale daemon.json (dead pid) is reclaimed, not fatal", async () => {
    const home = makeHome()
    writeFileSync(
      join(home, "daemon.json"),
      JSON.stringify({ port: 1, pid: 999_999_999, startedAt: new Date().toISOString() }),
    )

    const daemon = await launchMock(home, makeConfig(home))
    await daemon.stop()
  })
})

// --- fixed port ------------------------------------------------------------------

describe("fixed port", () => {
  it("config.server.port pins the listen port and daemon.json records it", async () => {
    const home = makeHome()
    const config = makeConfig(home)
    config.server = { port: await freePort() }
    const daemon = await launchMock(home, config)
    expect(daemon.port).toBe(config.server.port)
    expect((await fetch(`http://127.0.0.1:${daemon.port}/health`)).status).toBe(200)
    const pidfile = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { port: number }
    expect(pidfile.port).toBe(config.server.port)
    await daemon.stop()
  })

  it("an explicit opts.port wins over config.server.port", async () => {
    const home = makeHome()
    const config = makeConfig(home)
    config.server = { port: await freePort() }
    const override = await freePort()
    const daemon = await launchMock(home, config, { port: override })
    expect(daemon.port).toBe(override)
    await daemon.stop()
  })

  it("a pinned port already in use fails loudly and releases the claimed slot", async () => {
    const home = makeHome()
    const config = makeConfig(home)
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
    const port = (blocker.address() as AddressInfo).port
    try {
      config.server = { port }
      await expect(launchMock(home, config)).rejects.toThrow(/port \d+ is already in use/)
      // the placeholder pidfile is released: the next launch must not trip
      // over a live-but-deaf pid left behind by our failed attempt
      expect(existsSync(join(home, "daemon.json"))).toBe(false)
    } finally {
      blocker.close()
    }
  })
})

// --- default llmFactory resolution --------------------------------------------

describe("default llmFactory", () => {
  it("resolves from a config provider entry", async () => {
    const home = makeHome()
    await withEnv(
      { KCLAW_LLM_BASE_URL: undefined, KCLAW_LLM_API_KEY: undefined, KCLAW_LLM_MODEL: undefined },
      async () => {
        const daemon = await launchDaemon({ home, config: makeConfig(home) })
        daemons.push(daemon) // construction succeeded — no throw
      },
    )
  })

  it("falls back to KCLAW_LLM_* env when the config has no provider", async () => {
    const home = makeHome()
    await withEnv(
      {
        KCLAW_LLM_BASE_URL: "http://127.0.0.1:1",
        KCLAW_LLM_API_KEY: "env-key",
        KCLAW_LLM_MODEL: "env-model",
      },
      async () => {
        const config = loadConfig(resolvePaths(home)) // defaults: empty providers
        const daemon = await launchDaemon({ home, config })
        daemons.push(daemon)
      },
    )
  })

  it("throws 'no llm provider configured' when config and env are both empty", async () => {
    const home = makeHome()
    await withEnv(
      { KCLAW_LLM_BASE_URL: undefined, KCLAW_LLM_API_KEY: undefined, KCLAW_LLM_MODEL: undefined },
      async () => {
        const config = loadConfig(resolvePaths(home)) // defaults: empty providers
        await expect(launchDaemon({ home, config })).rejects.toThrow(
          "no llm provider configured: set providers in config.json or KCLAW_LLM_BASE_URL env",
        )
      },
    )
  })

  it("throws when the provider resolves but no model is configured anywhere", async () => {
    const home = makeHome()
    await withEnv({ KCLAW_LLM_MODEL: undefined }, async () => {
      const config = loadConfig(resolvePaths(home))
      config.providers = {
        default: "mock",
        entries: { mock: { baseUrl: "http://127.0.0.1:1", apiKey: "test-key", model: "" } },
      }
      await expect(launchDaemon({ home, config })).rejects.toThrow(/no llm model configured/)
    })
  })

  it("threads onRetry into the retry wrapper: transient 503s surface before the stream succeeds", async () => {
    // local OpenAI-compat endpoint: 503 twice, then one minimal SSE turn
    let hits = 0
    const server = createServer((_req, res) => {
      if (++hits <= 2) {
        res.writeHead(503)
        res.end("unavailable")
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n' +
          "data: [DONE]\n\n",
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const home = makeHome()
      const config = loadConfig(resolvePaths(home))
      config.providers = {
        default: "mock",
        entries: { mock: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "test-key", model: "mock-model" } },
      }

      const retries: Array<{ attempt: number; error: unknown }> = []
      const client = defaultLlmFactory(config, (info) => retries.push(info))
      const out: LlmStreamEvent[] = []
      for await (const ev of client.stream({ model: "mock-model", system: "", messages: [], tools: [] })) {
        out.push(ev)
      }

      // both failed attempts notified the sink before the third succeeded
      expect(retries.map((r) => r.attempt)).toEqual([1, 2])
      expect(String((retries[0]!.error as Error).message)).toContain("503")
      expect(out).toEqual([
        { type: "text_delta", delta: "ok" },
        { type: "message_done", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } },
      ])
    } finally {
      server.close()
    }
  }, 10_000)
})

// --- bounded stop ----------------------------------------------------------------

describe("bounded stop", () => {
  it("withStopTimeout passes a step through when it settles in time", async () => {
    await expect(withStopTimeout(Promise.resolve("ok"), 60_000, "test step")).resolves.toBe("ok")
    const late = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 30))
    await expect(withStopTimeout(late, 60_000, "test step")).resolves.toBe("slow")
  })

  it("withStopTimeout rejects with 'daemon stop timed out' when the step hangs", async () => {
    const never = new Promise<string>(() => {}) // a stop step that never settles
    await expect(withStopTimeout(never, 50, "test step")).rejects.toThrow(
      /daemon stop timed out: test step/,
    )
  })

  it("a late rejection of the losing step is not an unhandled rejection", async () => {
    // if the abandoned step eventually FAILS, the error must already have a
    // handler — otherwise the process would report an unhandled rejection
    // long after stop() already surfaced the timeout
    let reject!: (err: Error) => void
    const late = new Promise<void>((_resolve, rej) => {
      reject = rej
    })
    await expect(withStopTimeout(late, 20, "late step")).rejects.toThrow(/daemon stop timed out/)
    reject(new Error("late failure")) // swallowed by the helper
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  it("stop() rejects promptly when app.close hangs and KEEPS daemon.json", async () => {
    const home = makeHome()
    const daemon = await launchDaemon({
      home,
      config: makeConfig(home),
      llmFactory: () => scriptClient([]),
      stopTimeoutMs: 50,
    })
    daemons.push(daemon)
    expect(existsSync(join(home, "daemon.json"))).toBe(true)

    // Hold one ACTIVE connection: a half-sent request never completes, so
    // server.close() inside app.close() waits forever — an "unstoppable
    // daemon" shape, reproduced without needing a hung provider stream.
    // (The settle wait matters: a socket whose bytes the server has not yet
    // parsed counts as idle, and Node's close() destroys idle connections.)
    const sock = createConnection({ port: daemon.port, host: "127.0.0.1" }, () => {
      sock.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n") // no final CRLF
    })
    sock.on("error", () => undefined) // the server may reset it during teardown

    try {
      await new Promise((resolve) => setTimeout(resolve, 100)) // request now in flight
      const started = Date.now()
      await expect(daemon.stop()).rejects.toThrow(/daemon stop timed out/)
      expect(Date.now() - started).toBeLessThan(2_000) // bounded by 50ms, not 60s
      // honest state: the process (and its listener) is still alive, so the
      // pidfile stays for the CLI's stale-pid detection
      expect(existsSync(join(home, "daemon.json"))).toBe(true)
    } finally {
      sock.destroy() // release the server: the abandoned app.close() settles
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })

  it("stop() still completes cleanly (and removes daemon.json) when nothing hangs", async () => {
    const home = makeHome()
    const daemon = await launchDaemon({
      home,
      config: makeConfig(home),
      llmFactory: () => scriptClient([]),
      stopTimeoutMs: 50, // a tight deadline must not break a healthy teardown
    })
    daemons.push(daemon)
    await expect(daemon.stop()).resolves.toBeUndefined()
    expect(existsSync(join(home, "daemon.json"))).toBe(false)
  })

  it("threads providers.timeoutMs into the provider client (config plumbing)", async () => {
    // accepts the request but never responds: the REAL fetch aborts on the
    // client's AbortSignal.timeout, which the client reports as the
    // classified `llm http timeout` message (then withRetry exhausts)
    const server = createServer(() => {
      /* never respond */
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const home = makeHome()
      const config = loadConfig(resolvePaths(home))
      config.providers = {
        default: "mock",
        entries: { mock: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "test-key", model: "mock-model" } },
        timeoutMs: 50,
      }
      const client = defaultLlmFactory(config)
      await expect(async () => {
        for await (const _ of client.stream({ model: "mock-model", system: "", messages: [], tools: [] })) void _
      }).rejects.toThrow(/^llm http timeout after 50ms/)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  }, 10_000)

  it("exposes the 60s default stop deadline", () => {
    expect(DEFAULT_STOP_TIMEOUT_MS).toBe(60_000)
  })
})

// --- bin entry (spawned process) ----------------------------------------------

describe("bin/kclaw-server.mjs", () => {
  beforeAll(async () => {
    // bin imports ../dist/index.js: make sure the build exists (fresh clones
    // have no dist/ — it is gitignored). Rebuild only when something is missing.
    const distDaemon = join(SERVER_ROOT, "dist", "daemon.js")
    if (!existsSync(DIST_INDEX) || !existsSync(distDaemon)) {
      execFileSync(join(SERVER_ROOT, "node_modules", ".bin", "tsc"), ["-p", join(SERVER_ROOT, "tsconfig.json")], {
        stdio: "pipe",
      })
    }
  }, 120_000)

  /** Spawn the bin with the env a default home needs (LLM via KCLAW_LLM_*). */
  function spawnBin(args: string[]): ChildProcess {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        KCLAW_LLM_BASE_URL: "http://127.0.0.1:1", // client construction never connects
        KCLAW_LLM_API_KEY: "bin-key",
        KCLAW_LLM_MODEL: "bin-model",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    children.push(child)
    return child
  }

  it(
    "binds a --port pinned port and reports exactly it on readiness",
    async () => {
      const home = makeHome()
      const port = await freePort()
      const child = spawnBin(["--home", home, "--port", String(port)])

      const readyLine = await new Promise<string>((resolve, reject) => {
        let buf = ""
        const timer = setTimeout(() => reject(new Error("bin did not report readiness")), 15_000)
        child.stdout!.setEncoding("utf8")
        child.stdout!.on("data", (chunk: string) => {
          buf += chunk
          const nl = buf.indexOf("\n")
          if (nl !== -1) {
            clearTimeout(timer)
            resolve(buf.slice(0, nl))
          }
        })
        child.once("exit", (code) => reject(new Error(`bin exited early (code ${code})`)))
        child.once("error", reject)
      })

      expect((JSON.parse(readyLine) as { port: number }).port).toBe(port)

      const code = await new Promise<number | null>((resolve) => {
        child.once("exit", (c) => resolve(c))
        child.kill("SIGTERM")
      })
      expect(code).toBe(0)
    },
    30_000,
  )

  it("exits 1 with a one-line stderr on a non-integer --port", async () => {
    const { code, stderr } = await waitExit(spawnBin(["--home", makeHome(), "--port", "abc"]))
    expect(code).toBe(1)
    expect(stderr).toContain('invalid --port "abc"')
  })

  it("exits 1 with a friendly line when the --port port is already in use", async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
    const port = (blocker.address() as AddressInfo).port
    try {
      const { code, stderr } = await waitExit(spawnBin(["--home", makeHome(), "--port", String(port)]))
      expect(code).toBe(1)
      expect(stderr).toContain("already in use")
      expect(stderr).not.toContain("at ") // one line, not a stack trace
    } finally {
      blocker.close()
    }
  })

  it(
    "prints {port} on ready and exits 0 on SIGTERM",
    async () => {
      const home = makeHome()
      const child = spawn(process.execPath, [BIN, "--home", home], {
        env: {
          ...process.env,
          KCLAW_LLM_BASE_URL: "http://127.0.0.1:1", // client construction never connects
          KCLAW_LLM_API_KEY: "bin-key",
          KCLAW_LLM_MODEL: "bin-model",
        },
        stdio: ["ignore", "pipe", "pipe"],
      })
      children.push(child)
      let stderr = ""
      child.stderr!.setEncoding("utf8")
      child.stderr!.on("data", (chunk: string) => {
        stderr += chunk
      })

      // wait for the ready line on stdout
      const readyLine = await new Promise<string>((resolve, reject) => {
        let buf = ""
        const timer = setTimeout(
          () => reject(new Error(`bin did not report readiness (stderr: ${stderr})`)),
          15_000,
        )
        child.stdout!.setEncoding("utf8")
        child.stdout!.on("data", (chunk: string) => {
          buf += chunk
          const nl = buf.indexOf("\n")
          if (nl !== -1) {
            clearTimeout(timer)
            resolve(buf.slice(0, nl))
          }
        })
        child.once("exit", (code) =>
          reject(new Error(`bin exited early (code ${code}); stderr: ${stderr}`)),
        )
        child.once("error", reject)
      })

      const ready = JSON.parse(readyLine) as { port: number }
      expect(Number.isInteger(ready.port)).toBe(true)
      expect(ready.port).toBeGreaterThan(0)

      // SIGTERM → stop() → exit 0 (listener attached before the kill)
      const code = await new Promise<number | null>((resolve) => {
        child.once("exit", (c) => resolve(c))
        child.kill("SIGTERM")
      })
      expect(code).toBe(0)
      // the child ran its shutdown: daemon.json is cleaned up too
      expect(existsSync(join(home, "daemon.json"))).toBe(false)
    },
    30_000,
  )
})
