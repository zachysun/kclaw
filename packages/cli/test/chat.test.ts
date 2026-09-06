/**
 * Chat REPL integration tests: execa drives the BUILT
 * `dist/index.js` as a child process against a REAL daemon (auto-started by
 * the CLI itself), whose LLM provider is a local mock OpenAI SSE server — a
 * tiny node:http listener answering POST /chat/completions with
 * `data: {...}\n\n` sequences. KCLAW_LLM_BASE_URL hands the daemon the mock
 * (daemon-ctl passes the CLI's env through to the spawned daemon).
 *
 * stdin choreography is kept deterministic: execa's `input` pre-writes every
 * line (message then `/exit`) — since the frame pump landed, typed lines are
 * dispatched WHILE a run renders (that is what makes /interrupt usable), so a
 * scenario that needs its lines to run as SEQUENTIAL turns either waits one
 * run out before writing the next line or uses two invocations on the same
 * session (scenario C's pattern). Confirmations never touch stdin: hidden
 * `--yes`/`--no` flags auto-answer them (the scripting seam the CLI ships,
 * not a test hack).
 *
 * Scenarios: A plain text (bare `kclaw`, the default command), B tool call +
 * auto-approved confirmation, B-deny auto-denied confirmation, C resume via
 * `--session` with JSONL verification over HTTP, D reconnect-resend, E memory
 * note rendering across two sequential invocations, plus the queued-wait,
 * /interrupt, unknown-session and Ctrl+C escalation scenarios.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { execa } from "execa"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { KclawClient } from "../src/client.js"
import type { WsFrame } from "../src/client.js"
import { renderRun, resolveSessionId } from "../src/chat.js"

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

/**
 * The queued follow-up turn: DISTINCT output ("第二棒已接棒"), so a test can
 * assert the QUEUED message's own run was rendered. With both turns answering
 * identically, a renderRun-terminal regression (any run.completed resolving)
 * would still pass: the busy run's streamed text satisfies the assertion
 * before the queued run even starts.
 */
const SECOND_TURN = [
  chunk({ content: "第二棒" }),
  chunk({ content: "已接棒" }),
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

/**
 * The memory extraction call (fired by memory_save's immediate trigger):
 * the pipeline asks for a JSON actions array. A scripted action persists an
 * episode ("用户住在上海"), which the SECOND run then injects as a
 * `相关经历（<title>）: <text>` note — without this the memory_save tool would
 * have nothing to write and scenario E's note-rendering assertion would fail.
 */
const EXTRACT_TURN = [
  chunk({ content: '{"actions":[{"op":"new-thread","file":"shanghai","title":"用户在上海","content":"用户住在上海"}]}' }),
  chunk({}, "stop", { prompt_tokens: 2, completion_tokens: 3 }),
]

/** Bodies the mock saw, for request-level assertions. */
const mockRequests: Array<{ messages: Array<Record<string, unknown>> }> = []

/**
 * The LLM gate: when a turn's user message contains 挂起 the mock holds the
 * SSE open (no chunks, no [DONE]) until the daemon aborts the request — a
 * deterministic "busy run" for the Ctrl+C escalation scenario. `open` flips
 * true when the held request arrives, false when the daemon aborts it.
 * POST /release completes every currently-held SSE with the plain TEXT_TURN —
 * the out-of-band "放行第一条" the queued/interrupt scenarios need (a queued
 * follow-up message cannot release the run it waits behind).
 */
const gate = { open: false }
const held: ServerResponse[] = []

/**
 * Script the response from the request body: a history containing a tool
 * message is the post-tool round (final text); a user message asking to 执行
 * triggers the tool call; anything else is plain text.
 */
function turnFor(body: { messages?: Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  const messages = body.messages ?? []
  // memory 提取请求（memory_save 即时触发）：system 落在 messages[0]（toApiMessages
  // 把 req.system 放最前），内容是管线的提取提示（只输出 JSON actions）。先于内容匹配
  // 判定——该请求的 user content 是 renderSegment 的整段对话，按旧规则会误命中
  // "记住" 分支而返回工具调用流。
  const systemContent = messages[0]?.role === "system" && typeof messages[0]?.content === "string" ? messages[0].content : ""
  if (systemContent.includes("只输出 JSON")) return EXTRACT_TURN
  if (messages.some((m) => m.role === "tool")) return FINAL_TURN
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  const content = typeof lastUser?.content === "string" ? lastUser.content : ""
  if (content.includes("第二棒")) return SECOND_TURN
  if (content.includes("记住")) return MEMORY_SAVE_TURN
  if (content.includes("执行")) return TOOL_TURN
  return TEXT_TURN
}

/** Start the mock provider on an ephemeral loopback port. */
function startMockLlm(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    // Test control channel: complete every held SSE with TEXT_TURN (放行).
    if (req.method === "POST" && req.url === "/release") {
      req.on("data", () => {})
      req.on("end", () => {
        const releasing = held.splice(0)
        for (const heldRes of releasing) {
          for (const c of TEXT_TURN) heldRes.write(`data: ${JSON.stringify(c)}\n\n`)
          heldRes.write("data: [DONE]\n\n")
          heldRes.end()
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ released: releasing.length }))
      })
      return
    }
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
      // Gate turn: hold the SSE open until the daemon aborts the request.
      // (The abort is observed on the RESPONSE stream: req's own "close"
      // fires as soon as the request body is consumed, not on abort.) Title
      // generation is exempt from the gate: it fires while the message is
      // still being created — the RUN's own LLM call is what must be held so
      // the session has an active run when the test submits queued messages.
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")
      const content = typeof lastUser?.content === "string" ? lastUser.content : ""
      if (content.includes("挂起") && !content.includes("30字")) {
        gate.open = true
        held.push(res)
        res.on("close", () => {
          gate.open = false
          const idx = held.indexOf(res)
          if (idx >= 0) held.splice(idx, 1)
        })
        res.writeHead(200, { "content-type": "text/event-stream" })
        return
      }
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

/** Poll a condition to truth within `ms` (interactive scenarios, like the header wait below). */
async function until(what: string, ms: number, cond: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
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
      // The daemon now announces the user message lifecycle
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

      // Then for the input prompt: startup is still in flight after the
      // header (initial-disposition HTTP calls, the second ws connection —
      // which has no reconnect protection). A SIGKILL landing inside that
      // window makes the CLI exit 1 before its reconnect path exists; on a
      // slow CI runner the header→prompt gap is wide enough to hit regularly.
      // The prompt is the deterministic "startup fully done" signal.
      const promptDeadline = Date.now() + 15_000
      while (!seen.includes("> ")) {
        if (Date.now() > promptDeadline) throw new Error(`chat never reached its prompt: ${seen}`)
        await new Promise((r) => setTimeout(r, 50))
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
    "scenario E: injected memory notes render once; user message events never double-echo",
    async () => {
      // Own home (⇒ own daemon + memory dir): the shared daemon's interval
      // memory trigger internalizes other scenarios' sessions, and the mock
      // answers every extraction with the same canned episode — extra notes
      // would be injected into this scenario's second run.
      const eHome = mkdtempSync(join(tmpdir(), "kclaw-chat-home-e-"))
      homes.push(eHome)

      // Invocation 1 asks the model to save a memory (safe tool, auto-allowed).
      // Invocation 2 (same session, scenario C's sequential-turn pattern) then
      // sends a message whose run gets that memory injected as a note block —
      // the daemon announces it as note.emitted between the message's
      // created/completed, and the CLI renders it exactly once. Two
      // invocations keep the second message in its OWN run: one input stream
      // would dispatch the second line while the first run still renders
      // (frame-pump behaviour) and the daemon would steer-inject it instead —
      // an injected message deliberately skips the memory hook.
      const first = await runChatCli(["chat"], "记住用户住在上海\n/exit\n", eHome)
      expect(first.exitCode).toBe(0)
      expect(first.stderr).toBe("")
      expect(first.stdout).toContain("⚡ memory_save") // the save round ran

      const sid = SESSION_ID_RE.exec(first.stdout)?.[0]
      expect(sid, `no session id in header: ${first.stdout}`).toBeTruthy()
      const second = await runChatCli(["chat", "--session", sid!], "上海\n/exit\n", eHome)
      expect(second.exitCode).toBe(0)
      expect(second.stderr).toBe("")

      // the note is announced ONCE on the wire and rendered ONCE
      const stdout = first.stdout + second.stdout
      expect(stdout.split("[note] 相关经历").length - 1).toBe(1)
      expect(stdout).toContain("[note] 相关经历（用户在上海）: 用户住在上海")

      // no double echo of either typed line: the FULL first line never
      // appears (the tool args carry the model's argument text
      // "用户住在上海", not the typed sentence), and "上海" exactly three
      // times (tool args + note title "用户在上海" + note text "用户住在上海")
      // — a rendered user message event would add another bare occurrence
      // of the second line.
      expect(stdout.split("记住用户住在上海").length - 1).toBe(0)
      expect(stdout.split("上海").length - 1).toBe(3)
    },
    30_000,
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

  it(
    "Ctrl+C escalates: cancel run → clear queue → exit 130",
    async () => {
      // Own home so the shared daemon (other scenarios) is untouched.
      const dHome = mkdtempSync(join(tmpdir(), "kclaw-chat-home-sigint-"))
      homes.push(dHome)
      gate.open = false

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
      const sid = SESSION_ID_RE.exec(seen)![0]!

      // An observer/driver ws on the same daemon: sends the queued messages
      // and records the wire-level effects of the three SIGINT stages.
      const info = JSON.parse(readFileSync(join(dHome, "daemon.json"), "utf8")) as { port: number }
      const token = readFileSync(join(dHome, "token"), "utf8").trim()
      const client = new KclawClient(`http://127.0.0.1:${info.port}`, token)
      const ws = await client.ws()
      ws.send({ type: "subscribe", sessionId: sid })
      const events: Array<Record<string, unknown>> = []
      const pump = (async () => {
        for await (const f of ws.frames) events.push(f)
      })()
      await until("subscribed ack", 5_000, () => events.some((f) => f.type === "subscribed"))

      // Stage 0: a busy run — the gate holds the LLM turn open.
      subprocess.stdin!.write("请挂起\n")
      await until("gate-held run to start", 10_000, () => gate.open)

      // Two wait-disposition messages queue behind the busy run (acked queued).
      ws.send({ type: "send_message", sessionId: sid, text: "排队一请挂起", disposition: "wait" })
      ws.send({ type: "send_message", sessionId: sid, text: "排队二请挂起", disposition: "wait" })
      await until(
        "two queued send_message_acks",
        10_000,
        () => events.filter((f) => f.type === "send_message_ack" && f.queued === true).length === 2,
      )

      // SIGINT #1 → run.cancel; the CLI hints at the queued backlog.
      subprocess.kill("SIGINT")
      await until("run-cancel hint", 10_000, () => seen.includes("已请求取消当前 run"))
      await until("queued-count hint", 10_000, () => seen.includes("条排队消息，再按一次 Ctrl+C 清空"))

      // Let the daemon's driver dequeue entry 1 (its run gates again), leaving
      // exactly entry 2 queued — SIGINT #2 then deterministically clears it.
      const queueLen = async (): Promise<number> => {
        const list = (await client.request("GET", `/sessions/${sid}/queue`)) as unknown[]
        return Array.isArray(list) ? list.length : -1
      }
      await until("dequeued entry 1 (gate re-held, queue = 1)", 10_000, async () => gate.open && (await queueLen()) === 1)

      // SIGINT #2 → queue.cancel (no messageId); the backlog clears.
      subprocess.kill("SIGINT")
      await until("queue-cleared hint", 10_000, () => seen.includes("队列已清空，再按一次 Ctrl+C 退出"))
      await until("queue drained daemon-side", 10_000, async () => (await queueLen()) === 0)

      // SIGINT #3 → close and exit 130.
      subprocess.kill("SIGINT")
      const res = await subprocess
      expect(res.exitCode).toBe(130)

      // Wire-level effects, in order: the busy run ended aborted (run.cancel),
      // THEN the whole queue was cancelled (queue.cancel without messageId).
      const abortedIdx = events.findIndex(
        (f) => f.type === "run.completed" && (f.payload as { stopReason?: string } | undefined)?.stopReason === "aborted",
      )
      const cancelledIdx = events.findIndex((f) => f.type === "message.queue_cancelled" && (f.payload as { all?: boolean } | undefined)?.all === true)
      expect(abortedIdx).toBeGreaterThanOrEqual(0)
      expect(cancelledIdx).toBeGreaterThan(abortedIdx)
      // both stdin-era sends queued with the wait disposition (meta mirror)
      const queued = events.filter((f) => f.type === "message.queued")
      expect(queued).toHaveLength(2)
      expect(queued.every((f) => (f.payload as { disposition?: string } | undefined)?.disposition === "wait")).toBe(true)

      // Cleanup: this home's daemon still holds the second queued run's LLM
      // request open against the mock (its gate never releases). Kill it here
      // so the mock connection drops and afterAll's server.close() can drain —
      // the afterAll sweep still removes the home (its kill becomes a no-op).
      const { pid } = JSON.parse(readFileSync(join(dHome, "daemon.json"), "utf8")) as { pid: number }
      process.kill(pid, "SIGKILL")
      await until("held gate released", 5_000, () => !gate.open)

      ws.close()
      await pump.catch(() => {})
    },
    30_000,
  )

  it(
    "plain send while busy queues as wait; renderRun waits for MY run to complete",
    async () => {
      // Own home so the shared daemon (other scenarios) is untouched.
      const dHome = mkdtempSync(join(tmpdir(), "kclaw-chat-home-queued-"))
      homes.push(dHome)
      gate.open = false

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
      const sid = SESSION_ID_RE.exec(seen)![0]!

      // An observer ws on the same daemon watches the wire: the queued message
      // must ride out run.completed of the BUSY run and render its OWN run.
      const info = JSON.parse(readFileSync(join(dHome, "daemon.json"), "utf8")) as { port: number }
      const token = readFileSync(join(dHome, "token"), "utf8").trim()
      const client = new KclawClient(`http://127.0.0.1:${info.port}`, token)
      const ws = await client.ws()
      ws.send({ type: "subscribe", sessionId: sid })
      const events: Array<Record<string, unknown>> = []
      const pump = (async () => {
        for await (const f of ws.frames) events.push(f)
      })()
      await until("subscribed ack", 5_000, () => events.some((f) => f.type === "subscribed"))

      // Message 1: a busy run — the gate holds its LLM turn open.
      subprocess.stdin!.write("请挂起\n")
      await until("gate-held run to start", 10_000, () => gate.open)

      // /wait flips the mode; the plain line then queues behind the busy run;
      // /exit lets the REPL wait for the follow-up render before exiting.
      // The queued text carries the 第二棒 marker → SECOND_TURN's DISTINCT
      // output, so the final assertion can only be satisfied by the QUEUED
      // message's own run being rendered.
      subprocess.stdin!.write("/wait\n第二棒交给你\n/exit\n")
      subprocess.stdin!.end()

      // The plain send was answered with ack{queued:true} + message.queued.
      let queuedId = ""
      await until("message.queued (wait, position 0)", 10_000, () => {
        const q = events.find(
          (f) => f.type === "message.queued" && (f.payload as { disposition?: string } | undefined)?.disposition === "wait",
        )
        if (q === undefined) return false
        queuedId = (q.payload as { messageId: string }).messageId
        expect((q.payload as { position?: number }).position).toBe(0)
        return true
      })

      // 放行第一条：the busy run completes; the driver dequeues the queued
      // message and ITS OWN run starts with the SAME message id, then completes.
      const response = await fetch(`${mockUrl}/release`, { method: "POST" })
      expect(response.status).toBe(200)
      await until("queued → run.completed → run.started → created{queuedId} → run.completed", 20_000, () => {
        const idxQueued = events.findIndex((f) => f.type === "message.queued")
        const firstCompleted = events.findIndex((f, i) => i > idxQueued && f.type === "run.completed")
        const idxStarted = events.findIndex((f, i) => i > firstCompleted && f.type === "run.started")
        const idxCreated = events.findIndex(
          (f) => f.type === "message.created" && (f.payload as { message?: { id?: string } } | undefined)?.message?.id === queuedId,
        )
        const secondCompleted = events.findIndex((f, i) => i > Math.max(idxCreated, idxStarted) && f.type === "run.completed")
        return firstCompleted >= 0 && idxStarted > firstCompleted && idxCreated > idxStarted && secondCompleted > idxCreated
      })

      const res = await subprocess
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toBe("")
      expect(seen).toContain("已排队（第 1 位）") // the dim queued hint (position 0)
      expect(seen).toContain("你好，世界") // the busy run's output rendered through the takeover
      // THE regression assertion: the QUEUED message's own run rendered — its
      // output is unique to SECOND_TURN, so it can only appear if renderRun
      // rode out the busy run's run.completed (targetSeen gating) and kept
      // rendering until the queued run finished. If any run.completed
      // resolved the render, this text would never be printed by anyone.
      expect(seen).toContain("第二棒已接棒")

      ws.close()
      await pump.catch(() => {})
    },
    30_000,
  )

  it(
    "/interrupt aborts the active run and the message's own run renders to completion",
    async () => {
      // Own home so the shared daemon (other scenarios) is untouched.
      const dHome = mkdtempSync(join(tmpdir(), "kclaw-chat-home-interrupt-"))
      homes.push(dHome)
      gate.open = false

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
      const sid = SESSION_ID_RE.exec(seen)![0]!

      // An observer ws records the wire-level interrupt sequence.
      const info = JSON.parse(readFileSync(join(dHome, "daemon.json"), "utf8")) as { port: number }
      const token = readFileSync(join(dHome, "token"), "utf8").trim()
      const client = new KclawClient(`http://127.0.0.1:${info.port}`, token)
      const ws = await client.ws()
      ws.send({ type: "subscribe", sessionId: sid })
      const events: Array<Record<string, unknown>> = []
      const pump = (async () => {
        for await (const f of ws.frames) events.push(f)
      })()
      await until("subscribed ack", 5_000, () => events.some((f) => f.type === "subscribed"))

      // Busy run first (the gate holds its LLM turn), then /interrupt mid-run.
      subprocess.stdin!.write("请挂起\n")
      await until("gate-held run to start", 10_000, () => gate.open)
      subprocess.stdin!.write("/interrupt 换方向\n/exit\n")
      subprocess.stdin!.end()

      // The interrupt submit: ack + message.queued{disposition interrupt, position 0}.
      let interruptId = ""
      await until("message.queued (interrupt, position 0)", 10_000, () => {
        const q = events.find(
          (f) => f.type === "message.queued" && (f.payload as { disposition?: string } | undefined)?.disposition === "interrupt",
        )
        if (q === undefined) return false
        interruptId = (q.payload as { messageId: string }).messageId
        expect((q.payload as { position?: number }).position).toBe(0)
        return true
      })

      // The busy run ends aborted AFTER the interrupt submit landed...
      await until("busy run aborted", 10_000, () => {
        const idxQueued = events.findIndex(
          (f) => f.type === "message.queued" && (f.payload as { disposition?: string } | undefined)?.disposition === "interrupt",
        )
        return (
          events.findIndex(
            (f, i) => i > idxQueued && f.type === "run.completed" && (f.payload as { stopReason?: string } | undefined)?.stopReason === "aborted",
          ) > 0
        )
      })
      // ...and the interrupted message's OWN run renders to completion:
      // run.started → message.created{same id} → text → run.completed.
      await until("interrupt message's own run completed", 20_000, () => {
        const idxAborted = events.findIndex(
          (f) => f.type === "run.completed" && (f.payload as { stopReason?: string } | undefined)?.stopReason === "aborted",
        )
        const idxCreated = events.findIndex(
          (f) => f.type === "message.created" && (f.payload as { message?: { id?: string } } | undefined)?.message?.id === interruptId,
        )
        const idxCompleted = events.findIndex((f, i) => i > Math.max(idxAborted, idxCreated) && f.type === "run.completed")
        return idxAborted >= 0 && idxCreated > idxAborted && idxCompleted > idxCreated
      })

      const res = await subprocess
      expect(res.exitCode).toBe(0)
      expect(res.stderr).toBe("")
      expect(seen).toContain("已排队（第 1 位）") // the interrupt's dim queued hint (head of the queue)
      expect(seen).toContain("你好，世界") // the NEW run's output rendered by the REPL

      // Cleanup: the abort can leave the daemon's LLM retry request open
      // against the mock (the withRetry re-issue fires before the abort is
      // observed; its gate never releases on its own). Kill the daemon so the
      // mock connection drops and afterAll's server.close() can drain — the
      // afterAll sweep still removes the home (its kill becomes a no-op).
      const { pid } = JSON.parse(readFileSync(join(dHome, "daemon.json"), "utf8")) as { pid: number }
      process.kill(pid, "SIGKILL")
      await until("held gate released", 5_000, () => !gate.open)

      ws.close()
      await pump.catch(() => {})
    },
    30_000,
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

describe("renderRun (unit)", () => {
  /** Synthetic ChatCtx over a fake ws：泵"活着"、帧全部预置进 pendingFrames——renderRun 的 armNextFrame 会逐个同步取走。 */
  function unitCtx(pending: WsFrame[]): { ctx: Parameters<typeof renderRun>[0]; sent: WsFrame[] } {
    const sent: WsFrame[] = []
    const ctx = {
      home: undefined,
      client: {} as never,
      ws: { send: (f: WsFrame) => sent.push(f) } as never,
      sessionId: "ses_unit",
      rl: {} as never,
      showThinking: false,
      auto: "yes" as const,
      io: { atLineStart: true },
      pendingAttachments: [],
      disposition: "steer" as const,
      frameWaiters: [],
      pendingFrames: pending,
      renderEpoch: 1,
      pumpAlive: true,
      reconnecting: undefined,
    } as unknown as Parameters<typeof renderRun>[0]
    return { ctx, sent }
  }

  it("a stale buffered error frame never consumes a fresh render", async () => {
    // 空闲期间到达的命令错误帧（当时没有任何渲染在等帧）会被泵缓冲在
    // pendingFrames 里。随后一条消息的 renderRun 不得把它当作自己的第一帧——
    // 否则打印陈旧错误并直接返回：消息已发出，而它的 run 从未被渲染。
    // （集成层无法确定性构造此场景：daemon 只回 CLI 自己命令的错误帧，而
    // CLI 空闲期可错的命令都会被客户端守卫拦下——故在 renderRun 单元层钉住。）
    const staleError: WsFrame = { type: "error", message: "not found" }
    const runFrames: WsFrame[] = [
      { type: "send_message_ack", sessionId: "ses_unit", messageId: "msg_unit", queued: false },
      { id: "e1", ts: "t", type: "message.created", payload: { message: { id: "msg_unit" } } },
      { id: "e2", ts: "t", type: "text.delta", payload: { messageId: "msg_unit", blockId: "b1", delta: "新鲜输出" } },
      { id: "e3", ts: "t", type: "run.completed", payload: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } },
    ]
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
      return true
    })
    try {
      const { ctx, sent } = unitCtx([staleError, ...runFrames])
      await renderRun(ctx, "新消息")
      const out = writes.join("")
      expect(out).not.toContain("错误") // 不打印先于本渲染的陈旧错误
      expect(out).not.toContain("not found")
      expect(out).toContain("新鲜输出") // 本渲染正常渲染了自己的 run（不因旧帧提前终止）
      expect(sent).toHaveLength(1) // 消息发出且只发一次
      expect((sent[0] as { type?: string }).type).toBe("send_message")
    } finally {
      spy.mockRestore()
    }
  })
})
