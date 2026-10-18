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
   * Undelivered-notice journal (<home>/process-notices.jsonl). Wired by the
   * daemon; absent = notices are fire-and-forget (bare engine tests).
   */
  noticesPath?: string
}

const DEFAULT_MAX_RUNNING = 8
const OUTPUT_POLL_MS = 200
const OUTPUT_MIN_TIMEOUT_MS = 1_000
const OUTPUT_MAX_TIMEOUT_MS = 600_000

export class ProcessRegistry {
  readonly #entries = new Map<string, ProcessEntry>()
  readonly #maxRunning: number
  readonly #noticesPath: string | undefined
  #onNotice?: (notice: PendingNotice) => void | Promise<void>

  constructor(opts: ProcessRegistryOpts = {}) {
    this.#maxRunning = opts.maxRunningPerSession ?? DEFAULT_MAX_RUNNING
    this.#noticesPath = opts.noticesPath
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
    input.onExit((exitCode, killed) => this.#settle(entry, exitCode, killed))
    return entry
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
   * Boot recovery: probe journaled process groups. Live pids are re-adopted
   * as running entries (the record is theirs again, exit settles it), dead
   * ones get their notice delivered now. The journal is consumed either way,
   * so a delivered notice never fires twice.
   */
  async adopt(): Promise<void> {
    if (this.#noticesPath === undefined || !existsSync(this.#noticesPath)) return
    const lines = readFileSync(this.#noticesPath, "utf8").split("\n").filter((l) => l.trim() !== "")
    if (lines.length === 0) return
    try {
      unlinkSync(this.#noticesPath)
    } catch {
      return
    }
    for (const line of lines) {
      let notice: PendingNotice
      try {
        notice = JSON.parse(line) as PendingNotice
      } catch {
        continue // torn line from a crash mid-append: nothing to deliver
      }
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
        continue
      }
      await this.#onNotice?.(notice)
    }
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
      const { text, size } = this.#readFrom(entry.spillPath, offset)
      if (text !== "" || entry.status !== "running" || opts.wait !== true) {
        return { entry, output: text, nextOffset: offset + Buffer.byteLength(text, "utf8") }
      }
      if (Date.now() >= deadline) {
        return { entry, output: "", nextOffset: offset }
      }
      await new Promise((r) => setTimeout(r, OUTPUT_POLL_MS))
      offset = size
    }
  }

  #readFrom(spillPath: string, offset: number): { text: string; size: number } {
    let fd: number | undefined
    try {
      fd = openSync(spillPath, "r")
      const size = fstatSync(fd).size
      if (size <= offset) return { text: "", size }
      const buf = Buffer.alloc(size - offset)
      const read = readSync(fd, buf, 0, buf.length, offset)
      return { text: buf.toString("utf8", 0, read), size }
    } catch {
      return { text: "", size: offset }
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
