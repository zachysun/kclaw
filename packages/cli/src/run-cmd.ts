/**
 * `kclaw run`: one prompt in, this run's output on stdout, an exit code by
 * outcome (spec A1–A15). The order of work:
 *
 * 1. Flag checks, `--cwd` and `--attach` validation, then the prompt from
 *    arguments or stdin (run-input.ts) — every mistake here is a usage error
 *    (exit 2) and happens before the daemon is touched.
 * 2. Connect (starting the daemon when none runs), refuse an unconfigured
 *    provider (A8) and an unknown `--model` before any session is created.
 * 3. Pick the session: new (workdir = the run's directory), `--session`,
 *    `--continue` or `--fork`; then `--model` / `--mode` into its meta.
 * 4. Upload the piped content first, then each `--attach` file.
 * 5. Subscribe, install the signal and EPIPE handlers, send with
 *    disposition wait, and let run-lifecycle.ts decide which frames are mine
 *    until the terminal one.
 *
 * Failures after step 1 exit 1 with a stderr line; the json format still
 * prints its object with an `error` (sessionId/messageId omitted while not
 * known yet). A connection lost mid-run is a failure: unlike chat, a one-shot
 * run never reconnects or resends — the script decides whether to retry.
 */
import { readFileSync, realpathSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import { MAX_ATTACHMENT_BYTES } from "@kclaw/core"
import type { AttachmentRef, PermissionMode } from "@kclaw/core"
import { HttpRequestError } from "@kclaw/core/client-http"
import { KclawClient, openSubscribed } from "./client.js"
import type { WsHandle } from "./client.js"
import { configureColor, type ColorMode } from "./color.js"
import { mimeForFile } from "./mime.js"
import { readRunPrompt } from "./run-input.js"
import { startRun, stepRun } from "./run-lifecycle.js"
import type { CardPolicy, RunEffect, RunInput, RunSignal, RunState, RunStep } from "./run-lifecycle.js"
import { createRunOutput, type OutputFormat } from "./run-output.js"
import { UsageError } from "./usage-error.js"

export interface RunCommandOptions {
  home: string
  /** The `[prompt...]` arguments. */
  args: string[]
  session?: string
  continue: boolean
  fork?: string
  cwd?: string
  attach: string[]
  model?: string
  mode?: PermissionMode
  format: OutputFormat
  color: ColorMode
  yes: boolean
  no: boolean
  think: boolean
}

/** A failure before the message was sent: exit 1, `code` goes to the json object's error. */
class RunSetupError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "RunSetupError"
    this.code = code
  }
}

const RUN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const satisfies readonly RunSignal[]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A file named by --attach, checked before anything is sent. */
interface AttachFile {
  path: string
  name: string
}

/** --cwd: resolved against the process cwd, symlinks resolved (so --continue matches the stored workdir), an existing directory. */
function resolveRunDir(dir: string): string {
  let real: string
  try {
    real = realpathSync(resolve(dir))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") throw new UsageError(`--cwd 不是已存在的目录：${dir}`)
    throw error
  }
  if (!statSync(real).isDirectory()) throw new UsageError(`--cwd 不是目录：${dir}`)
  return real
}

/** --attach: relative to the process cwd (shell habit, not --cwd); a regular, non-empty file within the upload cap. */
function checkAttachFile(file: string): AttachFile {
  const path = resolve(file)
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) throw new UsageError(`附件不是普通文件：${file}`)
    size = st.size
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") throw new UsageError(`附件不存在：${file}`)
    throw error
  }
  if (size === 0) throw new UsageError(`附件是空文件：${file}`)
  if (size > MAX_ATTACHMENT_BYTES) throw new UsageError(`附件超过 20MB 上限：${file}（${size} 字节）`)
  return { path, name: basename(path) }
}

function checkFlags(opts: RunCommandOptions): void {
  if (opts.yes && opts.no) throw new UsageError("--yes 与 --no 不能同时给出")
  const picked = [
    opts.session !== undefined ? "--session" : undefined,
    opts.continue ? "--continue" : undefined,
    opts.fork !== undefined ? "--fork" : undefined,
  ].filter((flag) => flag !== undefined)
  if (picked.length > 1) throw new UsageError(`${picked.join("、")} 只能给出一个`)
  if (opts.cwd !== undefined && (opts.session !== undefined || opts.fork !== undefined)) {
    throw new UsageError("--cwd 只用于新建会话与 --continue：--session、--fork 使用已有会话自己的工作目录")
  }
  if (opts.model === "") throw new UsageError("--model 不能为空")
}

/** One daemon request at the setup boundary: any failure becomes an exit-1 failure that names the request. */
async function daemonRequest(client: KclawClient, method: string, path: string, body?: unknown): Promise<unknown> {
  try {
    return await client.request(method, path, body)
  } catch (error) {
    throw new RunSetupError("daemon_request_failed", `${method} ${path} 失败：${messageOf(error)}`)
  }
}

async function selectSession(client: KclawClient, opts: RunCommandOptions, runDir: string): Promise<string> {
  if (opts.session !== undefined || opts.continue) {
    const list = (await daemonRequest(client, "GET", "/sessions")) as Array<{ id: string; workdir?: string }>
    if (opts.session !== undefined) {
      if (!list.some((s) => s.id === opts.session)) throw new RunSetupError("session_not_found", `会话不存在：${opts.session}`)
      return opts.session
    }
    const match = list.find((s) => s.workdir === runDir)
    if (match === undefined) throw new RunSetupError("no_session_to_continue", `${runDir} 下没有可以接续的会话`)
    return match.id
  }
  if (opts.fork !== undefined) {
    try {
      return ((await client.request("POST", `/sessions/${encodeURIComponent(opts.fork)}/fork`, {})) as { id: string }).id
    } catch (error) {
      throw new RunSetupError("fork_failed", `无法从会话 ${opts.fork} 分出新会话：${messageOf(error)}`)
    }
  }
  return ((await daemonRequest(client, "POST", "/sessions", { workdir: runDir })) as { id: string }).id
}

/** --model / --mode into the session meta; the daemon's 400 is a usage error. */
async function setSessionMeta(client: KclawClient, sessionId: string, field: "model" | "mode", value: string): Promise<void> {
  try {
    await client.request("POST", `/sessions/${encodeURIComponent(sessionId)}/${field}`, { [field]: value })
  } catch (error) {
    if (error instanceof HttpRequestError && error.status === 400) throw new UsageError(`--${field} 被 daemon 拒绝：${error.message}`)
    throw new RunSetupError("daemon_request_failed", `设置会话的 ${field} 失败：${messageOf(error)}`)
  }
}

async function upload(client: KclawClient, sessionId: string, name: string, mimeType: string, read: () => Buffer): Promise<AttachmentRef> {
  try {
    const { file } = await client.uploadAttachment(sessionId, name, read(), mimeType)
    return { path: file.path, name: file.name, size: file.size, mimeType }
  } catch (error) {
    throw new RunSetupError("upload_failed", `附件 ${name} 上传失败：${messageOf(error)}`)
  }
}

/**
 * Run the command; resolves the exit code. Usage errors print the message
 * (and the usage, when asked) on stderr only.
 */
export async function runCommand(opts: RunCommandOptions, io: { help(): string }): Promise<number> {
  configureColor(opts.format === "text" ? opts.color : "never")
  const policy: CardPolicy = opts.yes ? "yes" : opts.no ? "no" : "default"
  const output = createRunOutput({
    format: opts.format,
    policy,
    showThinking: opts.think,
    write: (chunk) => process.stdout.write(chunk),
  })
  let sessionId: string | undefined
  try {
    checkFlags(opts)
    const runDir = opts.cwd === undefined ? process.cwd() : resolveRunDir(opts.cwd)
    const attachFiles = opts.attach.map(checkAttachFile)
    const prompt = await readRunPrompt(opts.args, process.stdin.isTTY === true, () => process.stdin)

    let client: KclawClient
    try {
      client = await KclawClient.connect(opts.home)
    } catch (error) {
      throw new RunSetupError("daemon_unavailable", `连不上 daemon：${messageOf(error)}`)
    }
    const providers = (await daemonRequest(client, "GET", "/providers")) as { configured?: boolean; entries?: Record<string, unknown> }
    if (providers.configured === false) {
      throw new RunSetupError("provider_not_configured", "尚未配置模型 provider：先在终端运行 kclaw chat 完成配置，或在 WebUI 的 Model 页添加")
    }
    if (opts.model !== undefined && providers.entries !== undefined && !Object.hasOwn(providers.entries, opts.model)) {
      const names = Object.keys(providers.entries)
      throw new UsageError(`没有名为 ${opts.model} 的 provider 条目（可用：${names.length === 0 ? "无" : names.join("、")}）`)
    }

    sessionId = await selectSession(client, opts, runDir)
    if (opts.model !== undefined) await setSessionMeta(client, sessionId, "model", opts.model)
    if (opts.mode !== undefined) await setSessionMeta(client, sessionId, "mode", opts.mode)

    const attachments: AttachmentRef[] = []
    const pipe = prompt.pipe
    if (pipe !== undefined) attachments.push(await upload(client, sessionId, pipe.filename, pipe.mimeType, () => pipe.body))
    for (const file of attachFiles) {
      attachments.push(await upload(client, sessionId, file.name, mimeForFile(file.name), () => readFileSync(file.path)))
    }

    let ws: WsHandle
    try {
      ws = await openSubscribed(client, sessionId)
    } catch (error) {
      throw new RunSetupError("daemon_unavailable", `订阅会话失败：${messageOf(error)}`)
    }
    return await drive({ ws, sessionId, text: prompt.text, attachments, policy, output })
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`)
      if (error.showHelp) process.stderr.write(io.help())
      return 2
    }
    if (error instanceof RunSetupError) {
      process.stderr.write(`${error.message}\n`)
      output.finish({ ...(sessionId !== undefined ? { sessionId } : {}), durationMs: 0, failure: { code: error.code, message: error.message } })
      return 1
    }
    throw error
  }
}

/** Steps 5: send, follow the lifecycle, stop only my own run on a signal. */
function drive(ctx: {
  ws: WsHandle
  sessionId: string
  text: string
  attachments: AttachmentRef[]
  policy: CardPolicy
  output: ReturnType<typeof createRunOutput>
}): Promise<number> {
  const { ws, output } = ctx
  return new Promise<number>((resolveExit) => {
    let state: RunState
    const sentAt = Date.now()

    const onSignal = new Map(RUN_SIGNALS.map((name) => [name, () => feed({ type: "signal", name })] as const))
    // EPIPE: stdout's reader went away (`kclaw run … | head -1`). Any other
    // stdout error is unexpected and is rethrown as such.
    const onStdoutError = (error: NodeJS.ErrnoException): void => {
      if (error.code !== "EPIPE") throw error
      feed({ type: "signal", name: "EPIPE" })
    }

    const exit = (fx: Extract<RunEffect, { type: "exit" }>): void => {
      if (fx.forced === true) process.exit(fx.code) // second signal: leave now, the output is abandoned
      for (const [name, handler] of onSignal) process.off(name, handler)
      if (!state.stdoutClosed) {
        output.finish({
          sessionId: ctx.sessionId,
          ...(state.mine !== undefined ? { messageId: state.mine } : {}),
          durationMs: Date.now() - sentAt,
          ...(fx.failure !== undefined ? { failure: fx.failure } : {}),
        })
      }
      ws.close()
      resolveExit(fx.code)
    }

    const apply = (step: RunStep): void => {
      state = step.state
      for (const fx of step.effects) {
        switch (fx.type) {
          case "send":
            ws.send(fx.frame)
            break
          case "output":
            output.frame(fx.frame)
            break
          case "warn":
            process.stderr.write(`${fx.text}\n`)
            break
          case "exit":
            exit(fx)
            break
        }
      }
    }
    const feed = (input: RunInput): void => apply(stepRun(state, input))

    // Handlers first, then the send: a signal between send and ack is held
    // by the lifecycle until the ack names my message.
    for (const [name, handler] of onSignal) process.on(name, handler)
    process.stdout.on("error", onStdoutError)
    apply(startRun({ sessionId: ctx.sessionId, text: ctx.text, attachments: ctx.attachments, policy: ctx.policy }))

    void (async () => {
      for await (const frame of ws.frames) feed({ type: "frame", frame })
      feed({ type: "closed" }) // a no-op once the run has ended (the close is ours)
    })()
  })
}
