/**
 * The first-run wizard through the daemon (spec A16): a fresh home's daemon
 * starts without a provider, the wizard probes and saves through it, and a
 * message goes through right after — no daemon restart. Only the terminal
 * prompts are scripted (they need a TTY); the daemon, its HTTP routes, the
 * connection test and the provider calls are all real, the provider being a
 * local mock OpenAI endpoint.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { execa } from "execa"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { KclawClient } from "../src/client.js"
import { ensureDaemon } from "../src/daemon-ctl.js"
import { runWizard } from "../src/wizard.js"

/** Scripted answers, consumed in order per prompt kind. */
const answers: { select: string[]; text: string[]; password: string[] } = { select: [], text: [], password: [] }

vi.mock("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  cancel: () => {},
  log: { error: () => {} },
  spinner: () => ({ start: () => {}, stop: () => {} }),
  isCancel: () => false,
  select: async () => answers.select.shift(),
  text: async () => answers.text.shift(),
  password: async () => answers.password.shift(),
  confirm: async () => false,
}))

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js")
const PROVIDER_ENV = ["KCLAW_LLM_BASE_URL", "KCLAW_LLM_API_KEY", "KCLAW_LLM_MODEL"] as const

let mockUrl = ""
let mockServer: Server | undefined
/** Model names the mock was asked for: the probe and the real run both land here. */
const models: string[] = []
const homes: string[] = []
const savedEnv = new Map<string, string | undefined>()

beforeAll(async () => {
  // The daemon inherits this process's env: no provider may come from it.
  for (const name of PROVIDER_ENV) {
    savedEnv.set(name, process.env[name])
    delete process.env[name]
  }
  mockServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; stream?: boolean }
      models.push(body.model ?? "")
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "h" }, finish_reason: "length" }] }))
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const delta of [{ content: "配置" }, { content: "生效" }]) res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`)
      res.end("data: [DONE]\n\n")
    })
  })
  await new Promise<void>((resolve) => mockServer!.listen(0, "127.0.0.1", () => resolve()))
  mockUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`
})

afterAll(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const h of homes) {
    if (!existsSync(join(h, "daemon.json"))) continue
    try {
      process.kill((JSON.parse(readFileSync(join(h, "daemon.json"), "utf8")) as { pid: number }).pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 300))
  await new Promise<void>((r) => mockServer?.close(() => r()))
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

/** A fresh home whose daemon is up without any provider. */
async function freshDaemon(): Promise<{ home: string; client: KclawClient }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kclaw-wizard-home-")))
  homes.push(home)
  await ensureDaemon(home)
  const client = await KclawClient.connect(home)
  expect(((await client.request("GET", "/providers")) as { configured: boolean }).configured).toBe(false)
  return { home, client }
}

/** Answers for the custom template: base URL, key, model. */
function scriptCustom(model: string): void {
  answers.select.push("custom")
  answers.text.push(mockUrl, model)
  answers.password.push("wizard-key")
}

/** One `kclaw run` against the home, with no provider in its env either. */
async function runOnce(home: string): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of PROVIDER_ENV) delete env[name]
  return execa(process.execPath, [CLI, "--home", home, "run", "打个招呼"], { env, extendEnv: false, stdin: "ignore", reject: false, timeout: 20_000 })
}

describe("first-run wizard through the daemon", { timeout: 30_000 }, () => {
  it("probes and saves through the running daemon; the next message uses the new provider without a restart", async () => {
    const { home, client } = await freshDaemon()
    const pid = (JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { pid: number }).pid
    scriptCustom("wizard-model")
    expect(await runWizard(client)).toBe("configured")
    const snapshot = (await client.request("GET", "/providers")) as {
      configured: boolean
      default: string
      entries: Record<string, { baseUrl: string; model: string; apiKey: string }>
    }
    expect(snapshot.configured).toBe(true)
    expect(snapshot.default).toBe("custom")
    expect(snapshot.entries.custom).toMatchObject({ baseUrl: mockUrl, model: "wizard-model" })
    expect(snapshot.entries.custom!.apiKey).not.toBe("wizard-key") // masked on the way out

    const res = await runOnce(home)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("配置生效")
    expect(models.filter((m) => m === "wizard-model").length).toBeGreaterThanOrEqual(2) // the probe, then the run
    expect((JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { pid: number }).pid).toBe(pid)
  })

  it("an entry of the same name already there is overwritten and made the default", async () => {
    const { home, client } = await freshDaemon()
    await client.request("POST", "/providers", { name: "custom", entry: { format: "openai", baseUrl: "http://127.0.0.1:1", apiKey: "", model: "stale" } })
    scriptCustom("second-model")
    expect(await runWizard(client)).toBe("configured")
    const snapshot = (await client.request("GET", "/providers")) as { default: string; entries: Record<string, { baseUrl: string; model: string }> }
    expect(snapshot.default).toBe("custom")
    expect(snapshot.entries.custom).toMatchObject({ baseUrl: mockUrl, model: "second-model" })
    const res = await runOnce(home)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("配置生效")
  })
})
