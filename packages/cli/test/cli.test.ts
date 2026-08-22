/**
 * CLI smoke tests (P3 Task 10): drive the BUILT `dist/index.js` as a real
 * child process (execa) against temp homes, exactly like a user invoking the
 * `kclaw` bin. The daemon it spawns is the real server bin — the KCLAW_LLM_*
 * env holds dummies so launch never needs a reachable provider (client
 * construction only, server daemon.test.ts pattern).
 *
 * Layout: one shared home for start/status/idempotent-start/jobs-list (one
 * daemon, kept alive across those assertions); a second home for the stop
 * lifecycle; a third for the stale-pidfile respawn. afterAll SIGTERMs
 * anything still holding a daemon.json.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execa } from "execa"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { KclawClient } from "../src/client.js"
import { readDaemonJson } from "../src/daemon-ctl.js"

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SERVER_ROOT = join(CLI_ROOT, "..", "server")
const CLI = join(CLI_ROOT, "dist", "index.js")

// --- fixtures ---------------------------------------------------------------

/** Temp homes to sweep in afterAll. */
const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kclaw-cli-home-"))
  homes.push(home)
  return home
}

/** Run the built CLI with a temp home; never throws on non-zero exit. */
function runCli(args: string[], home: string) {
  return execa(process.execPath, [CLI, "--home", home, ...args], {
    env: {
      ...process.env,
      KCLAW_LLM_BASE_URL: "http://127.0.0.1:1", // client construction never connects
      KCLAW_LLM_API_KEY: "cli-test-key",
      KCLAW_LLM_MODEL: "cli-test-model",
    },
    reject: false,
    timeout: 20_000,
  })
}

/** `port N` from a start/status output line. */
function portFrom(output: string): number {
  const match = /port (\d+)/.exec(output)
  expect(match, `no port in output: ${output}`).not.toBeNull()
  return Number(match![1])
}

function daemonJson(home: string): { port: number; pid: number; startedAt: string } {
  return JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as {
    port: number
    pid: number
    startedAt: string
  }
}

beforeAll(() => {
  // The tests run the built CLI; the CLI runs the server bin, which imports
  // the server's dist. Build both (skip when fresh — the daemon.test.ts
  // reuse-if-present pattern).
  if (!existsSync(CLI) || !existsSync(join(CLI_ROOT, "dist", "daemon-ctl.js"))) {
    execFileSync(join(CLI_ROOT, "node_modules", ".bin", "tsc"), ["-p", join(CLI_ROOT, "tsconfig.json")], {
      stdio: "pipe",
    })
  }
  const serverDist = join(SERVER_ROOT, "dist", "index.js")
  if (!existsSync(serverDist) || !existsSync(join(SERVER_ROOT, "dist", "daemon.js"))) {
    execFileSync(join(SERVER_ROOT, "node_modules", ".bin", "tsc"), ["-p", join(SERVER_ROOT, "tsconfig.json")], {
      stdio: "pipe",
    })
  }
}, 120_000)

afterAll(async () => {
  for (const home of homes.splice(0)) {
    if (existsSync(join(home, "daemon.json"))) {
      const { pid } = daemonJson(home)
      // pid guard (I4, same rule as readDaemonJson): never kill(0) — that
      // would signal this worker's whole process group.
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM")
        } catch {
          // Already gone — the sweep below still removes the home.
        }
      }
    }
    rmSync(home, { recursive: true, force: true })
  }
  // Give the SIGTERMed daemons a beat to exit before the worker tears down.
  await new Promise((resolve) => setTimeout(resolve, 300))
})

// --- lifecycle on one shared daemon -------------------------------------------

describe("kclaw daemon lifecycle (built CLI)", () => {
  it(
    "daemon start spawns the daemon and prints its port",
    async () => {
      const home = makeHome()
      const res = await runCli(["daemon", "start"], home)
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toBe("")

      const port = portFrom(res.stdout)
      expect(port).toBeGreaterThan(0)
      expect(res.stdout).toContain("daemon started")
      expect(daemonJson(home).port).toBe(port)
    },
    30_000,
  )

  it(
    "daemon status reports running with the same port (and the top-level alias matches)",
    async () => {
      const home = homes[0]!
      const res = await runCli(["daemon", "status"], home)
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain("running")
      expect(portFrom(res.stdout)).toBe(daemonJson(home).port)

      const alias = await runCli(["status"], home)
      expect(alias.exitCode).toBe(0)
      expect(alias.stdout).toBe(res.stdout)
    },
    30_000,
  )

  it(
    "a second daemon start is idempotent: same port, already-running wording, exit 0",
    async () => {
      const home = homes[0]!
      const res = await runCli(["daemon", "start"], home)
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toContain("already running")
      expect(portFrom(res.stdout)).toBe(daemonJson(home).port)
    },
    30_000,
  )

  it(
    "jobs list prints the padded header when there are no jobs",
    async () => {
      const home = homes[0]!
      const res = await runCli(["jobs", "list"], home)
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toContain("name")
      expect(res.stdout).toContain("cron")
      expect(res.stdout).toContain("nextRunAt")
      expect(res.stdout).toContain("lastStatus")
      expect(res.stdout.split("\n").filter((line) => line !== "")).toHaveLength(1) // header only, no rows
    },
    30_000,
  )

  it(
    "--version prints the package version",
    async () => {
      const res = await runCli(["--version"], homes[0]!)
      expect(res.exitCode).toBe(0)
      const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8")) as { version: string }
      expect(res.stdout.trim()).toBe(pkg.version)
    },
    10_000,
  )

  it(
    "KclawClient.ws authenticates on the first frame and yields parsed ack frames",
    async () => {
      const home = homes[0]!
      const { port } = daemonJson(home)
      const token = readFileSync(join(home, "token"), "utf8").trim()
      const client = new KclawClient(`http://127.0.0.1:${port}`, token)

      const conn = await client.ws()
      try {
        conn.send({ type: "subscribe", sessionId: "ses_cli_smoke" })
        const ack = await Promise.race([
          conn.frames[Symbol.asyncIterator]().next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no ws frame in 5s")), 5_000)),
        ])
        expect(ack.value).toEqual({ type: "subscribed", sessionId: "ses_cli_smoke" })
      } finally {
        conn.close()
      }
    },
    15_000,
  )

  it(
    "jobs list renders one padded row per job (created via the client's POST)",
    async () => {
      const home = homes[0]!
      const { port } = daemonJson(home)
      const token = readFileSync(join(home, "token"), "utf8").trim()
      const client = new KclawClient(`http://127.0.0.1:${port}`, token)
      const created = (await client.request("POST", "/jobs", {
        name: "daily-digest",
        cron: "0 9 * * *",
        prompt: "summarize yesterday",
      })) as { id: string }
      expect(typeof created.id).toBe("string")

      const res = await runCli(["jobs", "list"], home)
      expect(res.exitCode).toBe(0)
      const lines = res.stdout.split("\n").filter((line) => line !== "")
      expect(lines).toHaveLength(2) // header + the one row
      expect(lines[0]).toContain("nextRunAt")
      expect(lines[1]).toContain("daily-digest")
      expect(lines[1]).toContain("0 9 * * *")
      expect(lines[1]).toContain("true")
      expect(lines[1]).toContain("-") // lastStatus placeholder
    },
    30_000,
  )

  it(
    "KclawClient.request throws the server's body.error on non-2xx",
    async () => {
      const { port } = daemonJson(homes[0]!)
      const bad = new KclawClient(`http://127.0.0.1:${port}`, "wrong-token")
      await expect(bad.request("GET", "/jobs")).rejects.toThrow("unauthorized")
    },
    15_000,
  )
})

// --- stop lifecycle (own home) -------------------------------------------------

describe("kclaw daemon stop", () => {
  it(
    "stop prints stopped; status then reports not running; a second stop is a no-op",
    async () => {
      const home = makeHome()
      const start = await runCli(["daemon", "start"], home)
      expect(start.exitCode).toBe(0)
      const port = portFrom(start.stdout)

      const stop = await runCli(["daemon", "stop"], home)
      expect(stop.exitCode).toBe(0)
      expect(stop.stdout).toContain("stopped")
      expect(existsSync(join(home, "daemon.json"))).toBe(false)

      const status = await runCli(["daemon", "status"], home)
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain("not running")

      const again = await runCli(["daemon", "stop"], home)
      expect(again.exitCode).toBe(0)
      expect(again.stdout).toContain("daemon not running")
      expect(port).toBeGreaterThan(0)
    },
    30_000,
  )
})

// --- stale pidfile respawn (own home) -------------------------------------------

describe("stale daemon.json", () => {
  it(
    "a dead pid in daemon.json is detected, logged, and the daemon respawns fresh",
    async () => {
      const home = makeHome()

      // A port that was just serving and no longer is: start + stop a real
      // daemon, then plant a daemon.json pointing at that closed port with a
      // pid that has already exited.
      const first = await runCli(["daemon", "start"], home)
      expect(first.exitCode).toBe(0)
      const deadPort = portFrom(first.stdout)
      await runCli(["daemon", "stop"], home)

      const dead = spawnSync(process.execPath, ["-e", ""])
      expect(dead.status).toBe(0)
      const deadPid = dead.pid as number

      writeFileSync(
        join(home, "daemon.json"),
        `${JSON.stringify({ port: deadPort, pid: deadPid, startedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      )

      const res = await runCli(["daemon", "start"], home)
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toContain("stale daemon.json")

      const revived = daemonJson(home)
      expect(revived.pid).not.toBe(deadPid)
      expect(revived.port).toBe(portFrom(res.stdout))

      const status = await runCli(["daemon", "status"], home)
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain("running")
    },
    30_000,
  )
})

// --- invalid pid guard (I4) -------------------------------------------------------

describe("non-positive pid in daemon.json (I4)", () => {
  it("readDaemonJson treats pid 0 as invalid (stale), not as a daemon record", async () => {
    const home = makeHome()
    writeFileSync(
      join(home, "daemon.json"),
      `${JSON.stringify({ port: 1234, pid: 0, startedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    )
    expect(readDaemonJson(home)).toBeUndefined()
  })

  it(
    "stop on a pid-0 daemon.json reports 'daemon not running' without signaling the process group",
    async () => {
      const home = makeHome()
      writeFileSync(
        join(home, "daemon.json"),
        `${JSON.stringify({ port: 1234, pid: 0, startedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      )

      const res = await runCli(["daemon", "stop"], home)
      // pid 0 never reached process.kill — this test (and the whole suite's
      // process group) surviving to assert exit 0 IS the no-kill(0) proof
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain("daemon not running")

      const status = await runCli(["daemon", "status"], home)
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain("not running")
    },
    30_000,
  )
})

// --- stop failure against a stubborn daemon (I4) ----------------------------------

describe("stop failure: daemon still responding (I4)", () => {
  it(
    "exit 1, stderr 'stop failed: daemon still responding on port N (pid M)', daemon.json kept",
    async () => {
      const home = makeHome()

      // A stubborn stand-in: serves /health, swallows SIGTERM.
      const stub = spawn(process.execPath, ["-e", [
        "const http = require('node:http')",
        "const server = http.createServer((req, res) => {",
        "  res.writeHead(200, { 'content-type': 'application/json' })",
        "  res.end('{\"ok\":true}')",
        "})",
        "server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)))",
        "process.on('SIGTERM', () => { /* stubborn: keep serving */ })",
      ].join("\n")])
      try {
        const port = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("stub never became ready")), 10_000)
          stub.stdout!.setEncoding("utf8")
          stub.stdout!.on("data", (chunk: string) => {
            clearTimeout(timer)
            resolve(Number(chunk.trim()))
          })
          stub.once("error", reject)
        })
        expect(port).toBeGreaterThan(0)

        writeFileSync(
          join(home, "daemon.json"),
          `${JSON.stringify({ port, pid: stub.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
          "utf8",
        )

        const res = await runCli(["daemon", "stop"], home)
        expect(res.exitCode).toBe(1)
        expect(res.stderr).toContain(
          `stop failed: daemon still responding on port ${port} (pid ${stub.pid})`,
        )
        // the pidfile is KEPT: it still points at the live process
        expect(existsSync(join(home, "daemon.json"))).toBe(true)
        expect(daemonJson(home).pid).toBe(stub.pid)
      } finally {
        stub.kill("SIGKILL")
      }
    },
    30_000,
  )
})
