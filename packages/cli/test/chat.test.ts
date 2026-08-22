/**
 * Chat REPL integration tests (P3 Task 11): execa drives the BUILT
 * `dist/index.js` as a child process against a REAL daemon (auto-started by
 * the CLI itself), whose LLM provider is a local mock OpenAI SSE server — a
 * tiny node:http listener answering POST /chat/completions with
 * `data: {...}\n\n` sequences. KCLAW_LLM_BASE_URL hands the daemon the mock
 * (daemon-ctl passes the CLI's env through to the spawned daemon).
 *
 * stdin choreography is kept deterministic: execa's `input` pre-writes every
 * line (message then `/exit`) — the REPL consumes lines strictly in order,
 * one run at a time, so buffered input can never overtake a rendering run.
 * Confirmations never touch stdin: hidden `--yes`/`--no` flags auto-answer
 * them (the scripting seam the CLI ships, not a test hack).
 *
 * Scenarios: A plain text (bare `kclaw`, the default command), B tool call +
 * auto-approved confirmation, B-deny auto-denied confirmation, C resume via
 * `--session` with JSONL verification over HTTP, plus the unknown-session
 * error exit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execa } from "execa"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { KclawClient } from "../src/client.js"
import { resolveSessionId } from "../src/chat.js"

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SERVER_ROOT = join(CLI_ROOT, "..", "server")
const CLI = join(CLI_ROOT, "dist", "index.js")

/** ULID charset (Crockford base32) — session ids look like ses_01ABC... */
const SESSION_ID_RE = /ses_[0-9A-HJKMNP-TV-Z]+/

// --- mock OpenAI SSE provider --------------------------------------------------

/** One OpenAI chat.completions streaming chunk (only the fields the client reads). */
function chunk(delta: Record<string, unknown>, finish?: string, usage?: Record<string, number>) {
  return {
    choices: [{ delta, ...(finish === undefined ? {} : { finish_reason: finish }) }],
    ...(usage === undefined ? {} : { usage }),
  }
}

/** The plain-text turn: two deltas then finish stop. */
const TEXT_TURN = [
  chunk({ content: "你好，" }),
  chunk({ content: "世界" }),
  chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 2 }),
]

/** The tool turn: one exec tool_call then finish tool_calls. */
const TOOL_TURN = [
  chunk({
    tool_calls: [
      {
        index: 0,
        id: "call_mock_1",
        function: { name: "exec", arguments: JSON.stringify({ command: "echo ok" }) },
      },
    ],
  }),
  chunk({}, "tool_calls", { prompt_tokens: 3, completion_tokens: 1 }),
]

/** The after-tool turn (any request whose history contains a tool role message). */
const FINAL_TURN = [
  chunk({ content: "echo 输出已确认" }),
  chunk({}, "stop", { prompt_tokens: 4, completion_tokens: 2 }),
]

/** The memory_save turn (scenario E): a safe tool call, no confirmation. */
const MEMORY_SAVE_TURN = [
  chunk({
    tool_calls: [
      {
        index: 0,
        id: "call_mock_mem",
        function: { name: "memory_save", arguments: JSON.stringify({ text: "用户住在上海" }) },
      },
    ],
  }),
  chunk({}, "tool_calls", { prompt_tokens: 3, completion_tokens: 1 }),
]

/** Bodies the mock saw, for request-level assertions. */
const mockRequests: Array<{ messages: Array<Record<string, unknown>> }> = []

/**
 * Script the response from the request body: a history containing a tool
 * message is the post-tool round (final text); a user message asking to 执行
 * triggers the tool call; anything else is plain text.
 */
function turnFor(body: { messages?: Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  const messages = body.messages ?? []
  if (messages.some((m) => m.role === "tool")) return FINAL_TURN
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  const content = typeof lastUser?.content === "string" ? lastUser.content : ""
  if (content.includes("记住")) return MEMORY_SAVE_TURN
  if (content.includes("执行")) return TOOL_TURN
  return TEXT_TURN
}

/** Start the mock provider on an ephemeral loopback port. */
function startMockLlm(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      let body: { messages?: Array<Record<string, unknown>> } = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body
      } catch {
        // unparseable body → empty history → plain text turn
      }
      mockRequests.push({ messages: body.messages ?? [] })
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const c of turnFor(body)) res.write(`data: ${JSON.stringify(c)}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

// --- fixtures --------------------------------------------------------------------

let mockUrl = ""
const mockServers: Server[] = []

/** Temp homes to sweep in afterAll; homes[0] is the shared scenario home. */
const homes: string[] = [mkdtempSync(join(tmpdir(), "kclaw-chat-home-"))]
const home = homes[0]!

/** Run the built CLI (bare or with args) against a home + the mock provider. */
function runChatCli(args: string[], input: string, cwdHome: string = home) {
  return execa(process.execPath, [CLI, "--home", cwdHome, ...args], {
    env: {
      ...process.env,
      KCLAW_LLM_BASE_URL: mockUrl,
      KCLAW_LLM_API_KEY: "chat-test-key",
      KCLAW_LLM_MODEL: "chat-test-model",
    },
    input,
    reject: false,
    timeout: 15_000,
  })
}

/** A direct client onto the shared home's daemon (JSONL assertions). */
function clientForHome(): KclawClient {
  const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { port: number }
  const token = readFileSync(join(home, "token"), "utf8").trim()
  return new KclawClient(`http://127.0.0.1:${info.port}`, token)
}

beforeAll(async () => {
  // Build both packages first (cli.test.ts reuse-if-present pattern): the
  // tests run dist/index.js, and the CLI spawns the server's dist bin.
  if (!existsSync(CLI) || !existsSync(join(CLI_ROOT, "dist", "chat.js"))) {
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
  const mock = await startMockLlm()
  mockUrl = mock.url
  mockServers.push(mock.server)
}, 120_000)

afterAll(async () => {
  for (const server of mockServers.splice(0)) await new Promise<void>((r) => server.close(() => r()))
  for (const h of homes.splice(0)) {
    if (existsSync(join(h, "daemon.json"))) {
      try {
        const { pid } = JSON.parse(readFileSync(join(h, "daemon.json"), "utf8")) as { pid: number }
        process.kill(pid, "SIGTERM")
      } catch {
        // already gone — the sweep below still removes the home
      }
    }
    rmSync(h, { recursive: true, force: true })
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
})

// --- scenarios --------------------------------------------------------------------

describe("kclaw chat (built CLI + real daemon + mock SSE provider)", () => {
  it(
    "scenario A: bare kclaw (default command) streams the joined text and /exit exits cleanly",
    async () => {
      const res = await runChatCli([], "打个招呼\n/exit\n")
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toContain("你好，世界")
      expect(SESSION_ID_RE.test(res.stdout)).toBe(true) // the header carries the session id
      // P4 T1: the daemon now announces the user message lifecycle
      // (message.created/completed) on the wire; the REPL must render NONE of
      // it — readline already owns the typed line, and piped stdin echoes
      // nothing, so the user's text must appear exactly zero times.
      expect(res.stdout.includes("打个招呼")).toBe(false)
    },
    15_000,
  )

  it(
    "scenario B: tool call with --yes auto-approves the confirmation, runs exec, then answers",
    async () => {
      const res = await runChatCli(["chat", "--yes"], "请执行 echo ok\n/exit\n")
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toContain("⚡ exec")
      expect(res.stdout).toContain('{"command":"echo ok"}')
      expect(res.stdout).toContain("[--yes] 已自动允许")
      expect(res.stdout).toContain("↳ ok (") // tool_result.completed status line
      expect(res.stdout).toContain("echo 输出已确认") // the post-tool final text
    },
    15_000,
  )

  it(
    "scenario B-deny: --no auto-denies the confirmation → error tool_result + denial note",
    async () => {
      const res = await runChatCli(["chat", "--no"], "请执行 echo ok\n/exit\n")
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toContain("⚡ exec")
      expect(res.stdout).toContain("↳ error (")
      expect(res.stdout).toContain("用户拒绝了该操作") // error result output + [note] line
    },
    15_000,
  )

  it(
    "scenario C: --session resumes the same session; both turns land in its JSONL",
    async () => {
      const first = await runChatCli(["chat"], "第一句话\n/exit\n")
      expect(first.exitCode).toBe(0)
      const sid = SESSION_ID_RE.exec(first.stdout)?.[0]
      expect(sid, `no session id in header: ${first.stdout}`).toBeTruthy()

      const second = await runChatCli(["chat", "--session", sid!], "第二句话\n/exit\n")
      expect(second.exitCode).toBe(0)
      expect(second.stdout).toContain(sid!) // header shows the SAME session
      expect(second.stdout).toContain("你好，世界") // and it still answers

      const client = clientForHome()
      const messages = (await client.request("GET", `/sessions/${sid}/messages`)) as Array<{
        role: string
        blocks: Array<{ type: string; text?: string }>
      }>
      const userTexts = messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.blocks.filter((b) => b.type === "text").map((b) => b.text ?? ""))
      expect(userTexts).toContain("第一句话")
      expect(userTexts).toContain("第二句话")
    },
    15_000,
  )

  it(
    "scenario D: daemon SIGKILL while idle → send drops on the dead socket → reconnect + RESEND (message not lost)",
    async () => {
      // Own home so the shared daemon (other scenarios) is untouched.
      const dHome = mkdtempSync(join(tmpdir(), "kclaw-chat-home-d-"))
      homes.push(dHome)

      const subprocess = execa(process.execPath, [CLI, "--home", dHome], {
        env: {
          ...process.env,
          KCLAW_LLM_BASE_URL: mockUrl,
          KCLAW_LLM_API_KEY: "chat-test-key",
          KCLAW_LLM_MODEL: "chat-test-model",
        },
        reject: false,
        timeout: 30_000,
      })
      let seen = ""
      subprocess.stdout!.on("data", (d: Buffer) => {
        seen += d.toString("utf8")
      })

      // Wait for the header: daemon spawned, session created, ws subscribed.
      const headerDeadline = Date.now() + 15_000
      while (!/session ses_/.test(seen)) {
        if (Date.now() > headerDeadline) throw new Error(`chat never printed its header: ${seen}`)
        await new Promise((r) => setTimeout(r, 100))
      }

      // Kill the daemon HARD while the REPL sits IDLE. SIGKILL (not SIGTERM)
      // makes "nothing can have processed a message we have not sent yet"
      // deterministic — the CLI's ws dies with the process.
      const { pid } = JSON.parse(readFileSync(join(dHome, "daemon.json"), "utf8")) as { pid: number }
      process.kill(pid, "SIGKILL")

      // Now send: the frame drops on the dead socket; the CLI must notice
      // (closed frames loop, zero frames observed), respawn + resubscribe,
      // RESEND the same text, and render the run to completion.
      subprocess.stdin!.write("打个招呼\n/exit\n")
      subprocess.stdin!.end()

      const res = await subprocess
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain("[reconnected]")
      expect(res.stdout).toContain("你好，世界") // the RESENT message ran
    },
    30_000,
  )

  it(
    "scenario E: injected memory notes render once; user message events never double-echo (P4 T1)",
    async () => {
      // Line 1 asks the model to save a memory (safe tool, auto-allowed);
      // line 2's user message then gets that memory injected as a note
      // block — the daemon announces it as note.emitted between the user
      // message's created/completed, and the CLI renders it exactly once.
      // (A job note is unreachable from the CLI: send_message never carries
      // one — the memory note is the reachable user-note path.)
      const res = await runChatCli(["chat"], "记住用户住在上海\n上海\n/exit\n")
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toBe("")
      expect(res.stdout).toContain("⚡ memory_save") // the save round ran

      // the note is announced ONCE on the wire and rendered ONCE
      expect(res.stdout.split("[note] 相关记忆").length - 1).toBe(1)
      expect(res.stdout).toContain("[note] 相关记忆: 用户住在上海")

      // no double echo of either typed line: the FULL first line never
      // appears (the tool args carry the model's argument text
      // "用户住在上海", not the typed sentence), and "上海" exactly twice
      // (tool args + note line) — a rendered user message event would add
      // another bare occurrence of the second line.
      expect(res.stdout.split("记住用户住在上海").length - 1).toBe(0)
      expect(res.stdout.split("上海").length - 1).toBe(2)
    },
    15_000,
  )

  it(
    "--session with an unknown id exits 1 with 'session not found'",
    async () => {
      const res = await runChatCli(["chat", "--session", "ses_does_not_exist"], "hi\n/exit\n")
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain("session not found")
    },
    15_000,
  )
})

describe("resolveSessionId (unit)", () => {
  it("新建会话携带 process.cwd 作为 workdir", async () => {
    // mock client 捕获 POST body
    let body: unknown
    const client = {
      request: async (_m: string, _p: string, b?: unknown) => {
        body = b
        return { id: "s1" }
      },
    } as never
    await resolveSessionId(client, undefined)
    expect(body).toEqual({ workdir: process.cwd() })
  })
})
