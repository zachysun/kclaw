/**
 * `kclaw run` end to end (spec Testing Decisions, seam 2): execa drives the
 * BUILT dist/index.js against a REAL daemon whose provider is a local mock
 * OpenAI SSE server. stdin is always explicit — `input` for piped content,
 * "ignore" otherwise — because run reads a non-TTY stdin to EOF.
 *
 * The mock is this suite's own (chat.test.ts keeps another): the scripted
 * turns differ per suite (truncation, the fs_read round on an attachment
 * path), and neither suite has to know the other's trigger words.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest"
import { execa } from "execa"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { KclawClient, openSubscribed, type WsHandle } from "../src/client.js"

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SERVER_ROOT = join(CLI_ROOT, "..", "server")
const CLI = join(CLI_ROOT, "dist", "index.js")

// --- mock OpenAI SSE provider ---------------------------------------------------

function chunk(delta: Record<string, unknown>, finish?: string, usage?: Record<string, number>) {
  return {
    choices: [{ delta, ...(finish === undefined ? {} : { finish_reason: finish }) }],
    ...(usage === undefined ? {} : { usage }),
  }
}

const TEXT_TURN = [chunk({ content: "你好，" }), chunk({ content: "世界" }), chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 2 })]
const SECOND_TURN = [chunk({ content: "第二棒" }), chunk({ content: "已接棒" }), chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 2 })]
const TRUNCATED_TURN = [chunk({ content: "半句" }), chunk({}, "length", { prompt_tokens: 3, completion_tokens: 1 })]
const FINAL_TURN = [chunk({ content: "工具结果已收到" }), chunk({}, "stop", { prompt_tokens: 4, completion_tokens: 2 })]
const EXTRACT_TURN = [chunk({ content: '{"actions":[]}' }), chunk({}, "stop", { prompt_tokens: 2, completion_tokens: 1 })]
const toolTurn = (name: string, args: Record<string, unknown>) => [
  chunk({ tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } }] }),
  chunk({}, "tool_calls", { prompt_tokens: 3, completion_tokens: 1 }),
]

interface SeenRequest {
  model?: string
  messages: Array<{ role?: string; content?: unknown }>
}
/** Bodies the mock saw, for request-level assertions. */
const requests: SeenRequest[] = []
/** SSE responses held open (a user message containing 挂起) until /release or the daemon aborts. */
const held: ServerResponse[] = []

function lastUserText(messages: SeenRequest["messages"]): string {
  const last = [...messages].reverse().find((m) => m.role === "user")
  return typeof last?.content === "string" ? last.content : ""
}

/** The user content the daemon sent for the run whose message starts with `text`. */
function sentUserContent(text: string): string {
  const found = requests.map((r) => lastUserText(r.messages)).find((c) => c.startsWith(text))
  if (found === undefined) throw new Error(`no request carried a user message starting with ${text}`)
  return found
}

/**
 * The daemon's own background calls — memory extraction (it replays earlier
 * conversation, trigger words included) and session titles — are answered
 * at once and never held.
 */
function backgroundTurn(body: SeenRequest): Array<Record<string, unknown>> | undefined {
  const system = body.messages[0]?.role === "system" && typeof body.messages[0].content === "string" ? body.messages[0].content : ""
  if (system.includes("只输出 JSON")) return EXTRACT_TURN
  if (lastUserText(body.messages).includes("30字")) return TEXT_TURN
  return undefined
}

function turnFor(body: SeenRequest): Array<Record<string, unknown>> {
  const messages = body.messages
  if (messages.some((m) => m.role === "tool")) return FINAL_TURN
  const content = lastUserText(messages)
  const attachmentPath = /路径 (.+?)，可用 fs_read 读取/.exec(content)?.[1]
  if (content.includes("读附件") && attachmentPath !== undefined) return toolTurn("fs_read", { path: attachmentPath })
  if (content.includes("截断")) return TRUNCATED_TURN
  if (content.includes("第二棒")) return SECOND_TURN
  if (content.includes("执行")) return toolTurn("bash", { command: "echo ok" })
  return TEXT_TURN
}

function startMockLlm(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/release") {
      req.resume()
      req.on("end", () => {
        for (const h of held.splice(0)) {
          for (const c of TEXT_TURN) h.write(`data: ${JSON.stringify(c)}\n\n`)
          h.end("data: [DONE]\n\n")
        }
        res.end("{}")
      })
      return
    }
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; messages?: SeenRequest["messages"] }
      const seen: SeenRequest = { model: body.model, messages: body.messages ?? [] }
      requests.push(seen)
      res.writeHead(200, { "content-type": "text/event-stream" })
      const background = backgroundTurn(seen)
      if (background === undefined && lastUserText(seen.messages).includes("挂起")) {
        held.push(res)
        res.on("close", () => {
          const i = held.indexOf(res)
          if (i >= 0) held.splice(i, 1)
        })
        return
      }
      for (const c of background ?? turnFor(seen)) res.write(`data: ${JSON.stringify(c)}\n\n`)
      res.end("data: [DONE]\n\n")
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))
  })
}

async function release(): Promise<void> {
  await fetch(`${mockUrl}/release`, { method: "POST" })
}

// --- fixtures ------------------------------------------------------------------------

/** Temp dirs swept in afterAll (homes get their daemon stopped first). */
const temps: string[] = []
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

const home = tempDir("kclaw-run-home-")
// Sandbox off: bash then asks for confirmation (the card scenario); an
// installed skill gives `/deploy-flow` something to match.
writeFileSync(join(home, "config.json"), JSON.stringify({ sandbox: { enabled: false, writeRoots: [] } }))
mkdirSync(join(home, "skills", "deploy-flow"), { recursive: true })
writeFileSync(join(home, "skills", "deploy-flow", "SKILL.md"), "---\ndescription: 部署\n---\n\n正文\n")
const project = tempDir("kclaw-run-project-")

let mockUrl = ""
let mockServer: Server | undefined

/** The full child env (execa extendEnv off): provider env vars only when asked for. */
function cliEnv(withProvider = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.KCLAW_LLM_BASE_URL
  delete env.KCLAW_LLM_API_KEY
  delete env.KCLAW_LLM_MODEL
  return withProvider
    ? { ...env, KCLAW_LLM_BASE_URL: mockUrl, KCLAW_LLM_API_KEY: "run-test-key", KCLAW_LLM_MODEL: "run-test-model" }
    : env
}

function kclaw(args: string[], opts: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execa(process.execPath, [CLI, ...args], {
    env: opts.env ?? cliEnv(),
    extendEnv: false,
    cwd: opts.cwd ?? project,
    ...(opts.input !== undefined ? { input: opts.input } : { stdin: "ignore" as const }),
    reject: false,
    timeout: 20_000,
  })
}

function run(args: string[], opts: { input?: string; cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {}) {
  return kclaw(["--home", opts.home ?? home, "run", ...args], opts)
}

function clientFor(h = home): KclawClient {
  const { port } = JSON.parse(readFileSync(join(h, "daemon.json"), "utf8")) as { port: number }
  return new KclawClient(`http://127.0.0.1:${port}`, readFileSync(join(h, "token"), "utf8").trim())
}

async function until(what: string, ms: number, cond: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function queueLength(sessionId: string): Promise<number> {
  return ((await clientFor().request("GET", `/sessions/${sessionId}/queue`)) as unknown[]).length
}

async function userTexts(sessionId: string): Promise<string[]> {
  const messages = (await clientFor().request("GET", `/sessions/${sessionId}/messages`)) as Array<{
    role: string
    blocks: Array<{ type: string; text?: string }>
  }>
  return messages.filter((m) => m.role === "user").flatMap((m) => m.blocks.filter((b) => b.type === "text").map((b) => b.text ?? ""))
}

/** A session whose run holds the mock open (an active run to queue behind). */
async function busySession(): Promise<string> {
  const client = clientFor()
  const { id } = (await client.request("POST", "/sessions", { workdir: project })) as { id: string }
  const ws = await openSubscribed(client, id)
  sockets.push(ws)
  ws.send({ type: "send_message", sessionId: id, text: "挂起一下", disposition: "wait" })
  await until("the held model call", 10_000, () => held.length > 0)
  return id
}
const sockets: WsHandle[] = []

beforeAll(async () => {
  if (!existsSync(join(CLI_ROOT, "dist", "run-cmd.js"))) {
    execFileSync(join(CLI_ROOT, "node_modules", ".bin", "tsc"), ["-p", join(CLI_ROOT, "tsconfig.json")], { stdio: "pipe" })
  }
  if (!existsSync(join(SERVER_ROOT, "dist", "daemon.js"))) {
    execFileSync(join(SERVER_ROOT, "node_modules", ".bin", "tsc"), ["-p", join(SERVER_ROOT, "tsconfig.json")], { stdio: "pipe" })
  }
  const mock = await startMockLlm()
  mockUrl = mock.url
  mockServer = mock.server
  const started = await kclaw(["--home", home, "daemon", "start"])
  expect(started.exitCode).toBe(0)
}, 120_000)

afterEach(async () => {
  await release()
  for (const ws of sockets.splice(0)) ws.close()
})

afterAll(async () => {
  for (const dir of temps) {
    if (!existsSync(join(dir, "daemon.json"))) continue
    try {
      process.kill((JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")) as { pid: number }).pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 300))
  for (const h of held.splice(0)) h.destroy()
  await new Promise<void>((r) => (mockServer === undefined ? r() : mockServer.close(() => r())))
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

// --- scenarios ------------------------------------------------------------------------

/** Each scenario spawns processes against a live daemon. */
const E2E = { timeout: 30_000 }

describe("output formats", E2E, () => {
  it("text: the answer on stdout, nothing on stderr, exit 0", async () => {
    const res = await run(["打个招呼"])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("你好，世界")
    expect(res.stderr).toBe("")
  })

  it("json: one object with ids, the text, stopReason, usage and duration", async () => {
    const res = await run(["--output-format", "json", "打个招呼"])
    expect(res.exitCode).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({
      sessionId: expect.stringMatching(/^ses_/),
      messageId: expect.stringMatching(/^msg_/),
      text: "你好，世界",
      stopReason: "end_turn",
      usage: expect.objectContaining({ inputTokens: 3, outputTokens: 2 }),
      durationMs: expect.any(Number),
    })
  })

  it("stream-json: the ack first, then this run's events up to its run.completed", async () => {
    const res = await run(["--output-format", "stream-json", "打个招呼"])
    expect(res.exitCode).toBe(0)
    const frames = res.stdout.split("\n").map((l) => JSON.parse(l) as { type: string; runId?: string; messageId?: string; payload?: { message?: { id?: string } } })
    expect(frames[0]!.type).toBe("send_message_ack")
    const created = frames.find((f) => f.type === "message.created" && f.payload?.message?.id === frames[0]!.messageId)
    expect(created?.runId).toMatch(/^run_/)
    expect(frames.at(-1)).toMatchObject({ type: "run.completed", runId: created!.runId })
  })
})

describe("stdin", E2E, () => {
  it("pipe + prompt: the pipe is a stdin.txt attachment; its @ and / lines are not mentions or skills", async () => {
    const res = await run(["--output-format", "json", "总结一下"], { input: "@Component\n/deploy-flow 上线\n" })
    expect(res.exitCode).toBe(0)
    const content = sentUserContent("总结一下")
    expect(content).toContain("[附件 stdin.txt]\n@Component\n/deploy-flow 上线")
    expect(content).not.toContain("引用的文件不存在")
    expect(content).not.toContain("是在调用技能")
    expect(await userTexts(JSON.parse(res.stdout).sessionId)).toEqual(["总结一下"])

    // Control: the same tokens in the prompt itself are recognized.
    const direct = await run(["对照 /deploy-flow 与 @Component"])
    expect(direct.exitCode).toBe(0)
    const directContent = sentUserContent("对照 /deploy-flow")
    expect(directContent).toContain("是在调用技能 deploy-flow")
    expect(directContent).toContain("引用的文件不存在")
  })

  it("pipe without arguments, or with `-`: the pipe is the prompt", async () => {
    const bare = await run([], { input: "打个招呼" })
    expect(bare.exitCode).toBe(0)
    expect(bare.stdout).toBe("你好，世界")
    const dash = await run(["-"], { input: "打个招呼" })
    expect(dash.exitCode).toBe(0)
    expect(dash.stdout).toBe("你好，世界")
  })

  it("a pipe over 64 KiB goes to the model as a path it can read with fs_read", async () => {
    const big = `HEAD_MARKER\n${"x".repeat(70 * 1024)}\n`
    const res = await run(["--output-format", "json", "读附件"], { input: big })
    expect(res.exitCode).toBe(0)
    expect(JSON.parse(res.stdout).text).toBe("工具结果已收到")
    expect(sentUserContent("读附件")).toMatch(/\[附件 stdin\.txt（text\/plain，仅元数据）已保存，路径 .+stdin\.txt，可用 fs_read 读取\]/)
    const toolRound = requests.find((r) => r.messages.some((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("HEAD_MARKER")))
    expect(toolRound).toBeDefined()
  })
})

describe("sessions and flags", E2E, () => {
  it("--cwd sets a new session's workdir; --continue picks the latest session of that directory", async () => {
    const dir = tempDir("kclaw-run-cwd-")
    const first = await run(["--cwd", dir, "--output-format", "json", "打个招呼"])
    expect(first.exitCode).toBe(0)
    const sessionId = JSON.parse(first.stdout).sessionId as string
    expect(((await clientFor().request("GET", `/sessions/${sessionId}`)) as { workdir?: string }).workdir).toBe(dir)

    const fromCwd = await run(["--continue", "--output-format", "json", "打个招呼"], { cwd: dir })
    expect(JSON.parse(fromCwd.stdout).sessionId).toBe(sessionId)
    const fromFlag = await run(["--continue", "--cwd", dir, "--output-format", "json", "打个招呼"])
    expect(JSON.parse(fromFlag.stdout).sessionId).toBe(sessionId)

    const empty = await run(["--continue", "--output-format", "json", "打个招呼"], { cwd: tempDir("kclaw-run-empty-") })
    expect(empty.exitCode).toBe(1)
    expect(empty.stderr).toContain("没有可以接续的会话")
    expect(JSON.parse(empty.stdout).error.code).toBe("no_session_to_continue")
  })

  it("--fork runs on a new session holding the source's history; a missing source exits 1", async () => {
    const base = JSON.parse((await run(["--output-format", "json", "原始问题"])).stdout) as { sessionId: string }
    const forked = await run(["--fork", base.sessionId, "--output-format", "json", "接着问"])
    expect(forked.exitCode).toBe(0)
    const forkedId = JSON.parse(forked.stdout).sessionId as string
    expect(forkedId).not.toBe(base.sessionId)
    expect(await userTexts(forkedId)).toEqual(["原始问题", "接着问"])
    expect(await userTexts(base.sessionId)).toEqual(["原始问题"])

    const missing = await run(["--fork", "ses_nope", "--output-format", "json", "接着问"])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain("无法从会话 ses_nope 分出新会话")
    const obj = JSON.parse(missing.stdout)
    expect(obj.error.code).toBe("fork_failed")
    expect(obj.sessionId).toBeUndefined()
  })

  it("--attach uploads files after the piped content; a missing file is a usage error before any session exists", async () => {
    writeFileSync(join(project, "notes.md"), "附件里的内容 ATTACH_MARK")
    const res = await run(["--attach", "notes.md", "看附件"], { input: "PIPE_MARK" })
    expect(res.exitCode).toBe(0)
    const content = sentUserContent("看附件")
    expect(content).toContain("[附件 notes.md]\n附件里的内容 ATTACH_MARK")
    expect(content.indexOf("[附件 stdin.txt]")).toBeLessThan(content.indexOf("[附件 notes.md]"))

    const before = ((await clientFor().request("GET", "/sessions")) as unknown[]).length
    const missing = await run(["--attach", "nope.md", "看附件"])
    expect(missing.exitCode).toBe(2)
    expect(missing.stderr).toContain("附件不存在：nope.md")
    expect(missing.stdout).toBe("")
    expect(((await clientFor().request("GET", "/sessions")) as unknown[]).length).toBe(before)
  })

  it("--model and --mode go into the session; an unknown provider entry is a usage error", async () => {
    await clientFor().request("POST", "/providers", { name: "alt", entry: { format: "openai", baseUrl: mockUrl, apiKey: "alt-key", model: "alt-model" } })
    const res = await run(["--model", "alt", "--mode", "readonly", "--output-format", "json", "换个模型"])
    expect(res.exitCode).toBe(0)
    const meta = (await clientFor().request("GET", `/sessions/${JSON.parse(res.stdout).sessionId}`)) as { model?: string; mode?: string }
    expect(meta).toMatchObject({ model: "alt", mode: "readonly" })
    expect(requests.find((r) => lastUserText(r.messages).startsWith("换个模型"))?.model).toBe("alt-model")

    const unknown = await run(["--model", "nope", "--output-format", "json", "换个模型"])
    expect(unknown.exitCode).toBe(2)
    expect(unknown.stderr).toContain("没有名为 nope 的 provider 条目")
    expect(unknown.stdout).toBe("")
  })

  it("usage errors exit 2 with nothing on stdout", async () => {
    const cases: Array<{ args: string[]; input?: string; says: string }> = [
      { args: ["--yes", "--no", "x"], says: "--yes 与 --no 不能同时给出" },
      { args: ["--session", "ses_x", "--continue", "x"], says: "只能给出一个" },
      { args: ["--cwd", project, "--session", "ses_x", "x"], says: "--cwd 只用于新建会话与 --continue" },
      { args: ["--cwd", join(project, "no-such-dir"), "x"], says: "--cwd 不是已存在的目录" },
      { args: ["--output-format", "xml", "x"], says: "Allowed choices are text, json, stream-json" },
      { args: ["--output-format", "json", "-", "more"], input: "x", says: "后面不能再跟其他参数" },
      { args: [], input: " \n", says: "提示词为空" },
    ]
    for (const c of cases) {
      const res = await run(c.args, c.input !== undefined ? { input: c.input } : {})
      expect({ args: c.args, exitCode: res.exitCode, stdout: res.stdout }).toEqual({ args: c.args, exitCode: 2, stdout: "" })
      expect(res.stderr).toContain(c.says)
    }
  })

  it("--session with an unknown id exits 1", async () => {
    const res = await run(["--session", "ses_unknown", "--output-format", "json", "x"])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("会话不存在：ses_unknown")
    expect(JSON.parse(res.stdout).error.code).toBe("session_not_found")
  })
})

describe("stopping and exit codes", E2E, () => {
  it("on a busy session the prompt waits its turn and only its own result is output", async () => {
    const sessionId = await busySession()
    const child = run(["--session", sessionId, "--output-format", "json", "第二棒"])
    await until("the run's message queued", 10_000, async () => (await queueLength(sessionId)) === 1)
    await release()
    const res = await child
    expect(res.exitCode).toBe(0)
    expect(JSON.parse(res.stdout).text).toBe("第二棒已接棒")
  })

  it("Ctrl+C while queued withdraws only its own message; the running run is untouched", async () => {
    const sessionId = await busySession()
    const child = run(["--session", sessionId, "第二棒"])
    await until("the run's message queued", 10_000, async () => (await queueLength(sessionId)) === 1)
    child.kill("SIGINT")
    const res = await child
    expect(res.exitCode).toBe(130)
    expect(res.stderr).toContain("已停止本次运行：收到 SIGINT")
    expect(await queueLength(sessionId)).toBe(0)
    expect(held).toHaveLength(1) // the session's own run still holds its model call
    expect(await userTexts(sessionId)).toEqual(["挂起一下"])
  })

  it("SIGTERM stops the daemon-side run and exits 143", async () => {
    const child = run(["--output-format", "json", "挂起一下"])
    await until("the held model call", 10_000, () => held.length > 0)
    child.kill("SIGTERM")
    const res = await child
    expect(res.exitCode).toBe(143)
    expect(JSON.parse(res.stdout)).toMatchObject({ stopReason: "aborted", error: { code: "interrupted" } })
    await until("the daemon aborted the model call", 5_000, () => held.length === 0)
  })

  it("stdout's reader going away stops the daemon-side run and exits 141", async () => {
    const child = spawn(process.execPath, [CLI, "--home", home, "run", "--output-format", "stream-json", "挂起一下"], {
      cwd: project,
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.destroy()
    let stderr = ""
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString()
    })
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)))
    expect(code).toBe(141)
    expect(stderr).toContain("stdout 的下游管道已关闭")
    // Had the run kept going it would be holding its model call by now.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(held).toHaveLength(0)
  })

  it("stopped from another client: exit 1, the reason on stderr", async () => {
    const child = run(["--output-format", "stream-json", "挂起一下"])
    let firstLine = ""
    child.stdout!.on("data", (c: Buffer) => {
      firstLine ||= c.toString().split("\n")[0]!
    })
    await until("the held model call", 10_000, () => held.length > 0 && firstLine !== "")
    const sessionId = (JSON.parse(firstLine) as { sessionId: string }).sessionId
    const ws = await openSubscribed(clientFor(), sessionId)
    sockets.push(ws)
    ws.send({ type: "run.cancel", sessionId })
    const res = await child
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("运行未正常结束：被其他客户端停止")
    expect(JSON.parse(res.stdout.split("\n").at(-1)!)).toMatchObject({ type: "run.completed", payload: { stopReason: "aborted" } })
  })

  it("a reply cut off by the output limit exits 1", async () => {
    const res = await run(["请截断"])
    expect(res.exitCode).toBe(1)
    expect(res.stdout).toBe("半句")
    expect(res.stderr).toContain("最后一条回复被输出上限截断")
  })

  it("confirmations: rejected by default with one warning, approved once with --yes", async () => {
    const denied = await run(["请执行 echo ok"])
    expect(denied.exitCode).toBe(0)
    expect(denied.stdout).toContain("已自动拒绝（未指定 --yes）")
    expect(denied.stderr.split("未指定 --yes：本次运行确认一律拒绝")).toHaveLength(2)

    const approved = await run(["--yes", "请执行 echo ok"])
    expect(approved.exitCode).toBe(0)
    expect(approved.stdout).toContain("[--yes] 已自动允许（仅本次）")
    expect(approved.stdout).toContain("↳ ok")
    expect(approved.stderr).toBe("")
  })
})

describe("session list", E2E, () => {
  it("a display-width table, or the GET /sessions array with --json", async () => {
    const all = (await clientFor().request("GET", "/sessions")) as Array<{ id: string }>
    const table = await kclaw(["--home", home, "session", "list"])
    expect(table.exitCode).toBe(0)
    const lines = table.stdout.split("\n")
    expect(lines[0]).toMatch(/^id\s+title\s+workdir\s+updatedAt$/)
    expect(lines.slice(1).map((l) => l.split(" ")[0])).toEqual(all.map((s) => s.id))

    const json = await kclaw(["--home", home, "session", "list", "--json"])
    expect(json.exitCode).toBe(0)
    expect((JSON.parse(json.stdout) as Array<{ id: string }>).map((s) => s.id)).toEqual(all.map((s) => s.id))
  })
})

describe("no provider configured", E2E, () => {
  it("the daemon still starts; run exits 1 pointing at kclaw chat, piped chat prints the same guidance", async () => {
    const fresh = tempDir("kclaw-run-fresh-")
    const env = cliEnv(false)
    const res = await run(["--output-format", "json", "打个招呼"], { home: fresh, env })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain("尚未配置模型 provider")
    expect(JSON.parse(res.stdout)).toEqual({ text: "", durationMs: 0, error: { code: "provider_not_configured", message: expect.stringContaining("kclaw chat") } })
    expect(existsSync(join(fresh, "daemon.json"))).toBe(true)
    expect(((await clientFor(fresh).request("GET", "/providers")) as { configured: boolean }).configured).toBe(false)

    const chat = await kclaw(["--home", fresh], { env, input: "你好\n/exit\n" })
    expect(chat.exitCode).toBe(0)
    expect(chat.stdout).toContain("尚未配置模型 provider")
  })
})
