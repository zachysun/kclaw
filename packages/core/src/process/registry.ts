/**
 * Background process registry: the daemon-side bookkeeping for commands the
 * bash tool started with `run_in_background`.
 *
 * Lifecycle: `register()` records a spawned process group (the bash tool
 * spawns detached, so pid == pgid); the spawn branch's exit hook settles the
 * entry; settled processes become notices handed to `onNotice` so the daemon
 * can wake the owning session. Undelivered notices survive a daemon restart
 * via an append-only jsonl: a line is appended when a process settles and
 * removed after the notice was handed off. On boot, journaled groups are
 * probed — live pids are re-adopted as running entries, dead ones get their
 * notice delivered.
 *
 * Ownership: every entry carries the owning session id; the process_* tools
 * only see and manage entries of their own session. A per-session cap on
 * concurrently running entries keeps a runaway loop from fork-bombing the
 * daemon. The registry itself is in-memory only — processes are ephemeral;
 * only notices persist.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"

export interface ProcessEntry {
  id: string
  sessionId: string
  command: string
  pid: number
  /** Status: running until the exit event lands, then exited (code) or killed. */
  status: "running" | "exited" | "killed"
  exitCode: number | null
  /** Path the process's merged stdout+stderr streams into. */
  spillPath: string
  startedAt: string
  endedAt?: string
}

/** A settled process whose completion has not been delivered to its session yet. */
export interface PendingNotice {
  processId: string
  sessionId: string
  pid: number
  command: string
  exitCode: number | null
  killed: boolean
  spillPath: string
  startedAt: string
}

export interface ProcessRegistryOpts {
  /** Cap on concurrently running entries per session (default 8). */
  maxRunningPerSession?: number
  /**
   * process.started emitter (daemon wires the bus): fired synchronously when
   * a background process registers. The settled twins (completed/failed)
   * fire through onNotice's outcome — one emission point per lifecycle edge.
   */
  onRegister?: (entry: { id: string; sessionId: string; command: string }) => void
  /**
   * Undelivered-notice journal (<home>/process-notices.jsonl). Wired by the
   * daemon; absent = notices are fire-and-forget (bare engine tests).
   */
  noticesPath?: string
}

const DEFAULT_MAX_RUNNING = 8
const OUTPUT_POLL_MS = 200
const OUTPUT_MIN_TIMEOUT_MS = 1_000
const OUTPUT_MAX_TIMEOUT_MS = 600_000
/**
 * process_output 单次读取窗口：超出即截断，回复带 offset 续读标记。没有这个
 * 上限，读一个数 GB 的输出文件会整段分配进内存，结果原样进入会话历史与下
 * 一次请求。翻页语义由 nextOffset 承担（模型用 offset 继续读）。
 */
const OUTPUT_READ_CAP_BYTES = 256 * 1024

export class ProcessRegistry {
  readonly #entries = new Map<string, ProcessEntry>()
  readonly #maxRunning: number
  readonly #noticesPath: string | undefined
  #onNotice?: (notice: PendingNotice) => void | Promise<void>

  readonly #onRegister?: ProcessRegistryOpts["onRegister"]

  constructor(opts: ProcessRegistryOpts = {}) {
    this.#maxRunning = opts.maxRunningPerSession ?? DEFAULT_MAX_RUNNING
    this.#noticesPath = opts.noticesPath
    this.#onRegister = opts.onRegister
  }

  /** Daemon hook: called once per settled process, after the notice persisted. */
  onNotice(fn: (notice: PendingNotice) => void | Promise<void>): void {
    this.#onNotice = fn
  }

  runningCount(sessionId: string): number {
    let n = 0
    for (const e of this.#entries.values()) {
      if (e.sessionId === sessionId && e.status === "running") n++
    }
    return n
  }

  /**
   * Record a freshly spawned background process. Throws when the session is
   * at its running cap — the caller surfaces that as a tool error.
   */
  register(input: {
    id: string
    sessionId: string
    command: string
    pid: number
    spillPath: string
    /** Exit hook wired by the caller (the bash tool's spawn branch). */
    onExit: (settle: (exitCode: number | null, killed: boolean) => void) => void
  }): ProcessEntry {
    if (this.runningCount(input.sessionId) >= this.#maxRunning) {
      throw new Error(
        `后台进程数已达上限（${this.#maxRunning}），先用 process_kill 结束不再需要的进程`,
      )
    }
    const entry: ProcessEntry = {
      id: input.id,
      sessionId: input.sessionId,
      command: input.command,
      pid: input.pid,
      status: "running",
      exitCode: null,
      spillPath: input.spillPath,
      startedAt: new Date().toISOString(),
    }
    this.#entries.set(entry.id, entry)
    try {
      this.#onRegister?.({ id: entry.id, sessionId: entry.sessionId, command: entry.command })
    } catch {
      // observation must not fail the registration
    }
    // Register-time journal line: the pre-fix journal only recorded settled
    // processes, so a daemon crash/restart while a background command was
    // still running left it invisible — not listable, not killable, its
    // output file growing unattended. The running line (distinct `kind`)
    // lets adopt() re-adopt the live pid or deliver a synthetic completion
    // for a dead one. #deliver's rewrite removes it by processId at settle.
    if (this.#noticesPath !== undefined) {
      try {
        appendFileSync(this.#noticesPath, this.#runningJournalLine(entry), "utf8")
      } catch (e) {
        console.error("kclaw process notice journal append failed:", e)
      }
    }
    input.onExit((exitCode, killed) => this.#settle(entry, exitCode, killed))
    return entry
  }

  /** Journal line shape for a still-running group (register time). */
  #runningJournalLine(entry: ProcessEntry): string {
    return JSON.stringify({
      kind: "running",
      processId: entry.id,
      sessionId: entry.sessionId,
      pid: entry.pid,
      command: entry.command,
      spillPath: entry.spillPath,
      startedAt: entry.startedAt,
    }) + "\n"
  }

  #settle(entry: ProcessEntry, exitCode: number | null, killed: boolean): void {
    if (entry.status !== "running") return
    entry.status = killed ? "killed" : "exited"
    entry.exitCode = exitCode
    entry.endedAt = new Date().toISOString()
    const notice: PendingNotice = {
      processId: entry.id,
      sessionId: entry.sessionId,
      pid: entry.pid,
      command: entry.command,
      exitCode,
      killed,
      spillPath: entry.spillPath,
      startedAt: entry.startedAt,
    }
    void this.#deliver(notice)
  }

  /** Persist-then-handoff: the journal line is removed only after onNotice ran. */
  async #deliver(notice: PendingNotice): Promise<void> {
    if (this.#noticesPath !== undefined) {
      try {
        appendFileSync(this.#noticesPath, JSON.stringify(notice) + "\n", "utf8")
      } catch (e) {
        console.error("kclaw process notice journal append failed:", e)
      }
    }
    try {
      await this.#onNotice?.(notice)
    } catch (e) {
      // Handoff failure keeps the journal line: the next boot redelivers.
      console.error(`kclaw process notice delivery failed (${notice.processId}):`, e)
      return
    }
    if (this.#noticesPath !== undefined) this.#rewriteJournalWithout(notice.processId)
  }

  #rewriteJournalWithout(processId: string): void {
    if (this.#noticesPath === undefined) return
    try {
      if (!existsSync(this.#noticesPath)) return
      const lines = readFileSync(this.#noticesPath, "utf8").split("\n").filter((l) => l.trim() !== "")
      const kept = lines.filter((l) => {
        try {
          return (JSON.parse(l) as PendingNotice).processId !== processId
        } catch {
          return true // a torn line stays: never drop data we cannot parse
        }
      })
      if (kept.length === 0) unlinkSync(this.#noticesPath)
      else writeFileSync(this.#noticesPath, kept.join("\n") + "\n", "utf8")
    } catch (e) {
      console.error("kclaw process notice journal rewrite failed:", e)
    }
  }

  /**
   * Boot recovery: probe journaled process groups. Two journal line shapes:
   * register-time `kind:"running"` lines and settle-time plain notices.
   * Running + live pid → re-adopt as a running entry with a liveness PROBE
   * (no ChildProcess object exists to hang an exit event on, so a 2s interval
   * polls it; death settles the entry into the normal persist-then-handoff
   * path). The running line is KEPT so a second crash during the re-adopted
   * lifetime still recovers; #deliver's rewrite removes it at settle.
   * Running + dead pid → a synthetic completion notice is delivered now (same
   * shape the probe would have produced). Plain notices keep the original
   * semantics: live pid re-adopt (line dropped — the process already settled
   * once, only the notice was pending), dead pid deliver with re-append on
   * failure. Lines are deduped per processId (a settle appends the real
   * notice next to the running line; a failed handoff keeps both) — the real
   * notice wins because its exit info is accurate.
   */
  async adopt(): Promise<void> {
    if (this.#noticesPath === undefined || !existsSync(this.#noticesPath)) return
    let raw: string
    try {
      raw = readFileSync(this.#noticesPath, "utf8")
    } catch {
      return
    }
    const lines = raw.split("\n").filter((l) => l.trim() !== "")
    if (lines.length === 0) return
    interface JournalLine {
      kind?: "running"
      processId: string
      sessionId: string
      pid: number
      command: string
      exitCode?: number | null
      killed?: boolean
      spillPath: string
      startedAt: string
    }
    const chosen = new Map<string, { line: string; parsed: JournalLine; running: boolean }>()
    const losers: string[] = []
    for (const line of lines) {
      let parsed: JournalLine
      try {
        parsed = JSON.parse(line) as JournalLine
      } catch {
        this.#dropJournalLine(raw, line) // torn line: nothing to deliver, drop it
        continue
      }
      if (typeof parsed.processId !== "string" || typeof parsed.pid !== "number") {
        this.#dropJournalLine(raw, line) // not a journal line we can act on
        continue
      }
      const running = parsed.kind === "running"
      const prev = chosen.get(parsed.processId)
      // Real notice beats a running line for the same process; same-kind keeps the first.
      if (prev === undefined || (prev.running && !running)) {
        if (prev !== undefined) losers.push(prev.line)
        chosen.set(parsed.processId, { line, parsed, running })
      } else {
        losers.push(line)
      }
    }
    // 落选的重复行当场清掉：留到下次启动会被当成独立条目再次投递。
    for (const line of losers) this.#dropJournalLine(raw, line)
    for (const { line, parsed, running } of chosen.values()) {
      if (running) {
        if (this.#pidAlive(parsed.pid)) {
          // Live: re-adopt and KEEP the line (settle removes it; another
          // crash before that must find it again).
          this.#entries.set(parsed.processId, {
            id: parsed.processId,
            sessionId: parsed.sessionId,
            command: parsed.command,
            pid: parsed.pid,
            status: "running",
            exitCode: null,
            spillPath: parsed.spillPath,
            startedAt: parsed.startedAt,
          })
          this.#startProbe(parsed.processId, parsed.pid)
          continue
        }
        // Dead: deliver the completion the probe would have produced.
        this.#dropJournalLine(raw, line)
        try {
          await this.#onNotice?.({
            processId: parsed.processId,
            sessionId: parsed.sessionId,
            pid: parsed.pid,
            command: parsed.command,
            exitCode: null,
            killed: false,
            spillPath: parsed.spillPath,
            startedAt: parsed.startedAt,
          })
        } catch (e) {
          console.error(`kclaw process notice delivery failed (${parsed.processId}):`, e)
          appendFileSync(this.#noticesPath, line + "\n", "utf8")
        }
        continue
      }
      const notice = parsed as PendingNotice
      if (notice.killed !== true && this.#pidAlive(notice.pid)) {
        this.#entries.set(notice.processId, {
          id: notice.processId,
          sessionId: notice.sessionId,
          command: notice.command,
          pid: notice.pid,
          status: "running",
          exitCode: null,
          spillPath: notice.spillPath,
          startedAt: notice.startedAt,
        })
        this.#startProbe(notice.processId, notice.pid)
        this.#dropJournalLine(raw, line) // adopted: no undelivered notice anymore
        continue
      }
      // Dead: deliver; failure re-appends the line (redelivered next boot).
      this.#dropJournalLine(raw, line)
      try {
        await this.#onNotice?.(notice)
      } catch (e) {
        console.error(`kclaw process notice delivery failed (${notice.processId}):`, e)
        appendFileSync(this.#noticesPath, line + "\n", "utf8")
      }
    }
  }

  /** Liveness poll for re-adopted groups (no exit event exists for them). */
  #startProbe(id: string, pid: number): void {
    const timer = setInterval(() => {
      const entry = this.#entries.get(id)
      if (entry === undefined || entry.status !== "running") {
        clearInterval(timer)
        return
      }
      if (!this.#pidAlive(pid)) {
        clearInterval(timer)
        this.#settle(entry, null, false)
      }
    }, 2_000)
    timer.unref?.()
  }

  /** Zero-signal liveness probe: ESRCH = gone, EPERM = exists (not ours). */
  #pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  #dropJournalLine(_original: string, line: string): void {
    if (this.#noticesPath === undefined || !existsSync(this.#noticesPath)) return
    try {
      const kept = readFileSync(this.#noticesPath, "utf8").split("\n").filter((l) => l.trim() !== "" && l !== line)
      if (kept.length === 0) unlinkSync(this.#noticesPath)
      else writeFileSync(this.#noticesPath, kept.join("\n") + "\n", "utf8")
    } catch (e) {
      console.error("kclaw process notice journal rewrite failed:", e)
    }
  }

  /** Entries of one session, newest first. */
  list(sessionId: string): ProcessEntry[] {
    return [...this.#entries.values()]
      .filter((e) => e.sessionId === sessionId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  }

  /** One entry, owned by the caller's session only. */
  get(id: string, sessionId: string): ProcessEntry | undefined {
    const e = this.#entries.get(id)
    return e !== undefined && e.sessionId === sessionId ? e : undefined
  }

  /**
   * Read new output since `offset` from the entry's spill file. With `wait`,
   * poll until new bytes or a status change, bounded by timeoutMs.
   */
  async output(
    id: string,
    sessionId: string,
    opts: { offset?: number; wait?: boolean; timeoutMs?: number } = {},
  ): Promise<{ entry: ProcessEntry; output: string; nextOffset: number }> {
    const entry = this.get(id, sessionId)
    if (entry === undefined) {
      throw new Error(`进程不存在或不属于本会话: ${id}`)
    }
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30_000, OUTPUT_MIN_TIMEOUT_MS), OUTPUT_MAX_TIMEOUT_MS)
    let offset = opts.offset ?? 0
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { text, size, read } = this.#readFrom(entry.spillPath, offset)
      if (text !== "" || entry.status !== "running" || opts.wait !== true) {
        const nextOffset = offset + read
        // Cap marker: more content remains past the read window — tell the
        // model exactly how to continue (offset pagination), with the total
        // size so it can decide whether continuing is worth it.
        const output = read > 0 && nextOffset < size
          ? `${text}\n...[输出截断：单次最多读 ${OUTPUT_READ_CAP_BYTES} 字节，文件共 ${size} 字节；用 offset=${nextOffset} 继续读取]...`
          : text
        return { entry, output, nextOffset }
      }
      if (Date.now() >= deadline) {
        return { entry, output: "", nextOffset: offset }
      }
      await new Promise((r) => setTimeout(r, OUTPUT_POLL_MS))
      offset = size
    }
  }

  /** Capped read window: at most OUTPUT_READ_CAP_BYTES per call (see output()). */
  #readFrom(spillPath: string, offset: number): { text: string; size: number; read: number } {
    let fd: number | undefined
    try {
      fd = openSync(spillPath, "r")
      const size = fstatSync(fd).size
      if (size <= offset) return { text: "", size, read: 0 }
      const len = Math.min(size - offset, OUTPUT_READ_CAP_BYTES)
      const buf = Buffer.alloc(len)
      const read = readSync(fd, buf, 0, len, offset)
      return { text: buf.toString("utf8", 0, read), size, read }
    } catch {
      return { text: "", size: offset, read: 0 }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  /** SIGKILL the process group; the exit event settles the entry as killed. */
  kill(id: string, sessionId: string): ProcessEntry {
    const entry = this.get(id, sessionId)
    if (entry === undefined) {
      throw new Error(`进程不存在或不属于本会话: ${id}`)
    }
    if (entry.status !== "running") return entry
    if (process.platform !== "win32") {
      try {
        process.kill(-entry.pid, "SIGKILL")
      } catch {
        // group already gone
      }
    }
    try {
      process.kill(entry.pid, "SIGKILL")
    } catch {
      // already exited; the exit hook settles the entry
    }
    return entry
  }
}
