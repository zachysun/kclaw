/**
 * Team directory store — the single state truth for one agent team, on disk
 * under the workspace's `.kclaw/` (the same root the permissions decided
 * rules use):
 *
 *   .kclaw/teams/<team-name>/config.json        team record + member list
 *   .kclaw/teams/<team-name>/inboxes/           one JSON inbox per recipient
 *     team-lead.json                              (the lead's)
 *     <member>.json                               (one per member)
 *   .kclaw/tasks/<team-name>/task-<id>.json     one full task snapshot per file
 *   .kclaw/tasks/<team-name>/current_tasks/     one lock file per executing task
 *
 * Semantics: atomic writes (tmp + rename) so a crash can never truncate a
 * file; every mutation runs under an in-process mutex (one daemon = one
 * writer); task ids are never reused (next = max existing + 1); CAS on task
 * revision; attempt/attemptId late-write protection; "pending inbox entries =
 * undelivered" is the crash-recovery contract. A current_tasks lock is the
 * visible projection of "this task is executing": created when work starts,
 * removed at a terminal state, reconciled against the task files when the
 * store is first loaded (a leftover lock marks an interrupted execution).
 * Identity rules (who may claim/assign/transition) live in the facade layer;
 * the store enforces mechanics only.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomic } from "../storage/atomic.js"
import { newId } from "../protocol/ids.js"
import type {
  MailboxEntry, TaskSnapshot, TaskStatus, TeamMember, TeamMemberList, TeamMemberStatus, TeamRecord,
} from "../protocol/team.js"

/** The effective limits one store enforces (resolved from config by the host). */
export interface TeamLimits {
  maxMembers: number
  /** Concurrently running members (the host enforces this one; the store never gates on it). */
  maxActive: number
  maxUnreadPerTarget: number
  maxMessageBytes: number
  maxTasks: number
}

/** A CAS/attempt/limit violation — tool surfaces turn this into an error result. */
export class TeamConflictError extends Error {}

const MEMBER_NAME = /^[a-z][a-z0-9-]{0,31}$/
const RESERVED_NAMES = new Set(["lead"])
/** Team names become directory names: letters/numbers (any script) + hyphen. */
const TEAM_NAME = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,31}$/u
const TEAMS_DIR = "teams"
const TASKS_DIR = "tasks"
const ARCHIVE_DIR = ".archive"
const CONFIG_FILE = "config.json"
const INBOXES_DIR = "inboxes"
const CURRENT_TASKS_DIR = "current_tasks"
const LEAD_INBOX = "lead"
const LEAD_INBOX_FILE = "team-lead.json"

/** config.json: the team record and the member list in one file. */
export interface TeamConfigFile extends TeamRecord {
  members: TeamMember[]
}

/** One inbox file: the full entry trail, pending entries first-class. */
interface InboxFile {
  version: 1
  entries: MailboxEntry[]
}

/** The current_tasks lock payload (what/who/which attempt, and since when). */
interface TaskLock {
  taskId: number
  subject: string
  assignee: string | null
  attemptId: string | null
  claimedAt: string
}

/** Whole-file atomic replace with parent-dir guarantee (small state files). */
function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", 0o644)
}

function readJsonOrNull<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

export function isValidMemberName(name: string): boolean {
  return MEMBER_NAME.test(name) && !RESERVED_NAMES.has(name)
}

export function isValidTeamName(name: string): boolean {
  return TEAM_NAME.test(name)
}

/** Create the on-disk skeleton for a new team (the name must be free). */
export function initTeamDirectory(kclawDir: string, teamName: string, record: TeamRecord): void {
  mkdirSync(join(kclawDir, TEAMS_DIR, teamName, INBOXES_DIR), { recursive: true })
  mkdirSync(join(kclawDir, TASKS_DIR, teamName, CURRENT_TASKS_DIR), { recursive: true })
  writeJsonAtomic(join(kclawDir, TEAMS_DIR, teamName, CONFIG_FILE), { ...record, members: [] } satisfies TeamConfigFile)
  writeJsonAtomic(join(kclawDir, TEAMS_DIR, teamName, INBOXES_DIR, LEAD_INBOX_FILE), { version: 1, entries: [] } satisfies InboxFile)
}

/**
 * Keep the team state directory out of version control (local runtime
 * state, the permissions decided-rules precedent): ensure the ignore line
 * exists in the workspace .gitignore. Best-effort; a missing .gitignore is
 * created.
 */
export function ensureWorkspaceIgnore(workspaceRoot: string, dirName: string): void {
  const gitignore = join(workspaceRoot, ".gitignore")
  const line = `${dirName}/`
  let current = ""
  try {
    current = readFileSync(gitignore, "utf8")
  } catch {
    // missing → create below
  }
  if (current.split("\n").some((l) => l.trim() === line)) return
  const next = current === "" ? `${line}\n` : `${current.endsWith("\n") ? current : `${current}\n`}${line}\n`
  try {
    writeFileSync(gitignore, next, "utf8")
  } catch {
    // best-effort: a read-only workspace must not break team creation
  }
}

/** Lock files carry a readable subject slug (CJK included, path-hostile chars out). */
function taskSlug(subject: string): string {
  const slug = subject
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[/\\:*?"<>|#[\]]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/^-|-$/g, "")
  return slug === "" ? "task" : slug
}

export class TeamStore {
  /** `.kclaw/teams/<team-name>` — record, members and inboxes. */
  readonly teamDir: string
  /** `.kclaw/tasks/<team-name>` — task files and current_tasks locks. */
  readonly tasksDir: string
  private readonly limits: TeamLimits
  private chain: Promise<unknown> = Promise.resolve()
  private reconciled = false

  constructor(kclawDir: string, readonly name: string, limits: TeamLimits) {
    this.teamDir = join(kclawDir, TEAMS_DIR, name)
    this.tasksDir = join(kclawDir, TASKS_DIR, name)
    this.limits = limits
  }

  /** Serialize every mutation: one daemon process is the only writer. */
  private locked<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  // ---- team record + members (config.json) ----

  private configPath(): string {
    return join(this.teamDir, CONFIG_FILE)
  }

  private readConfig(): TeamConfigFile | null {
    return readJsonOrNull<TeamConfigFile>(this.configPath())
  }

  private writeConfig(config: TeamConfigFile): void {
    writeJsonAtomic(this.configPath(), config)
  }

  record(): TeamRecord | null {
    const config = this.readConfig()
    if (config === null) return null
    return { version: 1, teamId: config.teamId, name: config.name, leadSessionId: config.leadSessionId, createdAt: config.createdAt }
  }

  readMembers(): TeamMemberList {
    return { version: 1, members: this.readConfig()?.members ?? [] }
  }

  memberByName(name: string): TeamMember | null {
    return this.readMembers().members.find((m) => m.name === name) ?? null
  }

  memberBySession(sessionId: string): TeamMember | null {
    return this.readMembers().members.find((m) => m.sessionId === sessionId) ?? null
  }

  /**
   * Provisioning transaction, step 1: reserve the name (format, reserved
   * words, duplicates, member-list cap — failed spawns included; failures
   * stay visible on the list) and append the entry as `provisioning`. The
   * session is created after this record is on disk; the member's inbox
   * file is created empty here so the layout stays complete.
   */
  async provisionMember(req: { name: string; role?: string; model?: string }): Promise<TeamMember> {
    return this.locked(() => {
      if (!isValidMemberName(req.name)) {
        throw new TeamConflictError(`invalid member name "${req.name}" (lowercase letters/digits/hyphen, must start with a letter, "lead" is reserved)`)
      }
      const config = this.readConfig()
      if (config === null) throw new TeamConflictError("team config.json is missing")
      if (config.members.some((m) => m.name === req.name)) {
        throw new TeamConflictError(`member name "${req.name}" is taken (names are never reused)`)
      }
      if (config.members.length >= this.limits.maxMembers) {
        throw new TeamConflictError(`member list is full (cap ${this.limits.maxMembers}, failed spawns included)`)
      }
      const member: TeamMember = {
        name: req.name,
        sessionId: "",
        role: req.role,
        status: "provisioning",
        model: req.model,
        createdAt: new Date().toISOString(),
      }
      this.writeConfig({ ...config, members: [...config.members, member] })
      mkdirSync(join(this.teamDir, INBOXES_DIR), { recursive: true })
      this.writeInbox(req.name, [])
      return member
    })
  }

  /** Provisioning, step 2: attach the created child session (still provisioning). */
  async attachMemberSession(name: string, sessionId: string): Promise<TeamMember> {
    return this.locked(() => {
      const config = this.readConfig()
      if (config === null) throw new TeamConflictError("team config.json is missing")
      const member = config.members.find((m) => m.name === name)
      if (member === undefined || member.status !== "provisioning") {
        throw new TeamConflictError(`member "${name}" is not provisioning`)
      }
      member.sessionId = sessionId
      this.writeConfig(config)
      return member
    })
  }

  /** Terminal transition: active (initial inbox accepted) or failed (with reason). */
  async settleMember(name: string, status: Extract<TeamMemberStatus, "active" | "failed">, reason?: string): Promise<TeamMember> {
    return this.locked(() => {
      const config = this.readConfig()
      if (config === null) throw new TeamConflictError("team config.json is missing")
      const member = config.members.find((m) => m.name === name)
      if (member === undefined || member.status !== "provisioning") {
        throw new TeamConflictError(`member "${name}" is not pending settlement`)
      }
      member.status = status
      member.settledAt = new Date().toISOString()
      if (reason !== undefined) member.failReason = reason
      this.writeConfig(config)
      return member
    })
  }

  // ---- inboxes (one JSON file per recipient) ----

  private inboxPath(to: string): string {
    return join(this.teamDir, INBOXES_DIR, to === LEAD_INBOX ? LEAD_INBOX_FILE : `${to}.json`)
  }

  readInbox(to: string): MailboxEntry[] {
    return readJsonOrNull<InboxFile>(this.inboxPath(to))?.entries ?? []
  }

  private writeInbox(to: string, entries: MailboxEntry[]): void {
    writeJsonAtomic(this.inboxPath(to), { version: 1, entries } satisfies InboxFile)
  }

  pendingInbox(to: string): MailboxEntry[] {
    return this.readInbox(to).filter((e) => e.status === "pending")
  }

  unreadCount(to: string): number {
    return this.pendingInbox(to).length
  }

  /**
   * Append one entry as pending (the durability point of a send: once this
   * returns, the message survives a crash and will be redelivered). Enforces
   * the unread cap and the per-message byte cap loudly (never silent drop).
   */
  async enqueueMail(entry: Omit<MailboxEntry, "id" | "status" | "at">): Promise<MailboxEntry> {
    return this.locked(() => {
      if (Buffer.byteLength(entry.text, "utf8") > this.limits.maxMessageBytes) {
        throw new TeamConflictError(`message exceeds the ${this.limits.maxMessageBytes}-byte cap`)
      }
      if (this.pendingInbox(entry.to).length >= this.limits.maxUnreadPerTarget) {
        throw new TeamConflictError(`inbox of "${entry.to}" is full (${this.limits.maxUnreadPerTarget} unread)`)
      }
      const full: MailboxEntry = { ...entry, id: newId("tm"), status: "pending", at: new Date().toISOString() }
      mkdirSync(join(this.teamDir, INBOXES_DIR), { recursive: true })
      this.writeInbox(entry.to, [...this.readInbox(entry.to), full])
      return full
    })
  }

  /** Flip one entry to delivered (read-modify-atomic-rewrite; inbox files stay small by the unread cap). */
  async markDelivered(to: string, id: string): Promise<void> {
    return this.locked(() => {
      this.markDeliveredSync(to, id)
    })
  }

  /** Flip a rendered batch to delivered in one locked rewrite (at-least-once delivery: the host marks after submit acceptance). */
  async markDeliveredMany(to: string, ids: string[]): Promise<void> {
    return this.locked(() => {
      this.flipDelivered(to, ids)
    })
  }

  /** Same flip without the mutex — for the host's locked compound operations. */
  markDeliveredSync(to: string, id: string): void {
    this.flipDelivered(to, [id])
  }

  private flipDelivered(to: string, ids: string[]): void {
    const entries = this.readInbox(to)
    const set = new Set(ids)
    let changed = false
    for (const e of entries) {
      if (set.has(e.id) && e.status === "pending") {
        e.status = "delivered"
        e.deliveredAt = new Date().toISOString()
        changed = true
      }
    }
    if (changed) this.writeInbox(to, entries)
  }

  // ---- task board (one snapshot file per task) ----

  private taskPath(id: number): string {
    return join(this.tasksDir, `task-${id}.json`)
  }

  task(id: number): TaskSnapshot | null {
    return readJsonOrNull<TaskSnapshot>(this.taskPath(id))
  }

  listTasks(): TaskSnapshot[] {
    if (!existsSync(this.tasksDir)) return []
    const out: TaskSnapshot[] = []
    for (const name of readdirSync(this.tasksDir)) {
      if (!/^task-\d+\.json$/.test(name)) continue
      const task = readJsonOrNull<TaskSnapshot>(join(this.tasksDir, name))
      if (task !== null) out.push(task)
    }
    return out.sort((a, b) => a.id - b.id)
  }

  /**
   * Create a task: existence-checked dependencies (the fresh id cannot close
   * a cycle — it has no incoming edges yet), monotonic id derived from the
   * existing files (ids are never reused), revision 1. Not dispatch-ready
   * until claimed.
   */
  async createTask(req: { subject: string; detail?: string; dependencies?: number[]; assignee?: string | null }): Promise<TaskSnapshot> {
    return this.locked(() => {
      const tasks = this.listTasks()
      if (tasks.length >= this.limits.maxTasks) {
        throw new TeamConflictError(`task board is full (cap ${this.limits.maxTasks})`)
      }
      const deps = req.dependencies ?? []
      for (const dep of deps) {
        if (!tasks.some((t) => t.id === dep)) {
          throw new TeamConflictError(`dependency #${dep} does not exist`)
        }
      }
      const nextId = tasks.length === 0 ? 1 : Math.max(...tasks.map((t) => t.id)) + 1
      if (nextId > Number.MAX_SAFE_INTEGER - 1_000_000) {
        throw new TeamConflictError("task id space exhausted (ids are never reused)")
      }
      const now = new Date().toISOString()
      const task: TaskSnapshot = {
        id: nextId,
        subject: req.subject,
        detail: req.detail ?? "",
        status: "pending",
        assignee: req.assignee ?? null,
        dependencies: [...deps],
        attempt: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
      writeJsonAtomic(this.taskPath(task.id), task)
      return task
    })
  }

  /**
   * Compare-and-swap update: `expectedRevision` must match; when the update
   * transitions an in_progress task (or reassigns it), the caller must echo
   * the current attemptId — a superseded executor's late write therefore
   * cannot clobber the successor's result. Claim/retry shapes increment the
   * attempt and mint a fresh attemptId. The current_tasks lock follows the
   * task: written when work starts (or the executor changes), removed at a
   * terminal state.
   */
  updateTask(req: {
    id: number
    expectedRevision: number
    attemptId?: string
    status?: TaskStatus
    subject?: string
    detail?: string
    assignee?: string | null
    dependencies?: number[]
  }): Promise<TaskSnapshot> {
    return this.locked(() => {
      const task = this.task(req.id)
      if (task === null) throw new TeamConflictError(`task #${req.id} does not exist`)
      if (task.revision !== req.expectedRevision) {
        throw new TeamConflictError(`task #${req.id} changed under you (revision ${task.revision}, expected ${req.expectedRevision}); re-read with task_list`)
      }
      const next: TaskSnapshot = { ...task, dependencies: [...task.dependencies] }

      if (req.subject !== undefined) next.subject = req.subject
      if (req.detail !== undefined) next.detail = req.detail

      if (req.dependencies !== undefined) {
        const tasks = this.listTasks()
        for (const dep of req.dependencies) {
          if (dep === req.id) throw new TeamConflictError(`task #${req.id} cannot depend on itself`)
          if (!tasks.some((t) => t.id === dep)) throw new TeamConflictError(`dependency #${dep} does not exist`)
        }
        if (reaches(req.dependencies, req.id, (id) => tasks.find((t) => t.id === id)?.dependencies ?? [])) {
          throw new TeamConflictError("dependency edit would create a cycle")
        }
        next.dependencies = [...req.dependencies]
      }

      let mintAttempt = false
      if (req.assignee !== undefined) {
        if (req.assignee !== null && this.memberByName(req.assignee) === null) {
          throw new TeamConflictError(`assignee "${req.assignee}" is not on the member list`)
        }
        if (req.assignee !== next.assignee) {
          // One unfinished task per member: a reassignment onto an in_progress
          // task must not hand a member a second plate.
          if (req.assignee !== null && next.status === "in_progress") {
            const held = this.heldTask(req.assignee)
            if (held !== null && held.id !== next.id) {
              throw new TeamConflictError(`"${req.assignee}" already holds task #${held.id} (one unfinished task per member)`)
            }
          }
          next.assignee = req.assignee
          // Reassignment supersedes the current execution.
          if (next.status === "in_progress") mintAttempt = true
        }
      }

      if (req.status !== undefined && req.status !== next.status) {
        const from = next.status
        const to = req.status
        if (!isLegalTransition(from, to)) {
          throw new TeamConflictError(`illegal transition ${from} → ${to}`)
        }
        if (from === "in_progress" && (to === "completed" || to === "failed")) {
          if (req.attemptId === undefined || req.attemptId !== next.attemptId) {
            throw new TeamConflictError(`task #${req.id} progress requires the current attemptId (late-write protection)`)
          }
        }
        next.status = to
        if (to === "in_progress") {
          if (next.assignee === null) throw new TeamConflictError(`task #${req.id} cannot start without an assignee`)
          const held = this.heldTask(next.assignee)
          if (held !== null && held.id !== next.id) {
            throw new TeamConflictError(`"${next.assignee}" already holds task #${held.id} (one unfinished task per member)`)
          }
          mintAttempt = true
        }
      }

      if (mintAttempt) {
        next.attempt += 1
        next.attemptId = newId("tma")
      }

      next.revision = task.revision + 1
      next.updatedAt = new Date().toISOString()
      writeJsonAtomic(this.taskPath(next.id), next)

      const wasRunning = task.status === "in_progress"
      const isRunning = next.status === "in_progress"
      if (wasRunning && (!isRunning || task.subject !== next.subject)) this.removeLock(task.id, task.subject)
      if (isRunning) this.writeLock(next)
      return next
    })
  }

  /** Dispatch-ready: unclaimed, every dependency completed. */
  readyTasks(): TaskSnapshot[] {
    const tasks = this.listTasks()
    const completed = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id))
    return tasks.filter((t) => t.status === "pending" && t.assignee === null && t.dependencies.every((d) => completed.has(d)))
  }

  /** The in_progress task a member currently holds, if any (one per member). */
  heldTask(memberName: string): TaskSnapshot | null {
    return this.listTasks().find((t) => t.status === "in_progress" && t.assignee === memberName) ?? null
  }

  // ---- current_tasks locks ----

  private lockPath(id: number, subject: string): string {
    return join(this.tasksDir, CURRENT_TASKS_DIR, `${id}-${taskSlug(subject)}.txt`)
  }

  private writeLock(task: TaskSnapshot): void {
    mkdirSync(join(this.tasksDir, CURRENT_TASKS_DIR), { recursive: true })
    const lock: TaskLock = {
      taskId: task.id,
      subject: task.subject,
      assignee: task.assignee,
      attemptId: task.attemptId ?? null,
      claimedAt: task.updatedAt,
    }
    writeJsonAtomic(this.lockPath(task.id, task.subject), lock)
  }

  private removeLock(id: number, subject: string): void {
    try {
      rmSync(this.lockPath(id, subject))
    } catch {
      // already gone — the goal state is reached
    }
  }

  /**
   * Crash reconciliation for the current_tasks locks, run once when the host
   * first loads the store: drop locks whose task is not executing (or whose
   * name no longer matches), then write a fresh lock for every executing
   * task. A leftover lock after a daemon restart marks an interrupted
   * execution — exactly what the resume nudge looks for.
   */
  reconcileLocks(): void {
    if (this.reconciled) return
    this.reconciled = true
    const dir = join(this.tasksDir, CURRENT_TASKS_DIR)
    const running = new Map(this.listTasks().filter((t) => t.status === "in_progress").map((t) => [t.id, t]))
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const id = Number(/^(\d+)-/.exec(name)?.[1])
        const task = Number.isFinite(id) && id > 0 ? running.get(id) : undefined
        if (task === undefined || `${task.id}-${taskSlug(task.subject)}.txt` !== name) {
          try {
            rmSync(join(dir, name))
          } catch {
            // best-effort cleanup
          }
        }
      }
    }
    for (const task of running.values()) this.writeLock(task)
  }
}

/** DFS: does any of `from` reach `target` through the dependency edges? */
function reaches(from: number[], target: number, edgesOf: (id: number) => number[]): boolean {
  const stack = [...from]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...edgesOf(id))
  }
  return false
}

function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  switch (from) {
    case "pending": return to === "in_progress" || to === "cancelled"
    case "in_progress": return to === "completed" || to === "failed" || to === "cancelled"
    case "failed": return to === "in_progress" || to === "cancelled"
    case "completed":
    case "cancelled": return false // terminal
  }
}
