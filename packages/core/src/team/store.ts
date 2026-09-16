/**
 * Team directory store — the single state truth for one agent team, on disk
 * at `<workspace>/<stateDir>/<teamId>/`:
 *
 *   team.json              team record
 *   team/members.json      the member list (whole-file atomic rewrite)
 *   team/inbox/<name>.jsonl one inbox per recipient, append + status rewrite
 *   task/board.json        task-id counter
 *   task/<id>.json         one full task snapshot per file
 *
 * Semantics: atomic writes (tmp + rename) so a crash can
 * never truncate a file; every mutation runs under an in-process mutex (one
 * daemon = one writer); CAS on task revision; attempt/attemptId late-write
 * protection; "pending inbox entries = undelivered" is the crash-recovery
 * contract. Identity rules (who may claim/assign/transition) live in the
 * facade layer; the store enforces mechanics only.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomic } from "../storage/atomic.js"
import { newId } from "../protocol/ids.js"
import { appendJsonlLine, readJsonl } from "../storage/jsonl.js"
import type {
  MailboxEntry, MailboxStatus, TaskSnapshot, TaskStatus, TeamMember, TeamMemberList, TeamMemberStatus, TeamRecord, TeamSenderKind,
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
const TEAM_FILE = "team.json"
const MEMBERS_FILE = "members.json"
const BOARD_FILE = "board.json"
const INBOX_DIR = "inbox"
const LEAD_INBOX = "lead"

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

/** Create the on-disk skeleton for a new team (idempotent per fresh teamId). */
export function initTeamDirectory(teamDir: string, record: TeamRecord): void {
  mkdirSync(join(teamDir, "team", INBOX_DIR), { recursive: true })
  mkdirSync(join(teamDir, "task"), { recursive: true })
  writeJsonAtomic(join(teamDir, TEAM_FILE), record)
  writeJsonAtomic(join(teamDir, "team", MEMBERS_FILE), { version: 1, members: [] } satisfies TeamMemberList)
  writeJsonAtomic(join(teamDir, "task", BOARD_FILE), { version: 1, nextId: 1 })
}

/**
 * Keep the team state directory out of version control (local runtime
 * state, the .kclaw/ precedent): ensure a `.agent-teams/` style ignore line
 * exists in the workspace .gitignore. Best-effort; missing .gitignore is
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

export class TeamStore {
  readonly teamDir: string
  private readonly limits: TeamLimits
  private chain: Promise<unknown> = Promise.resolve()

  constructor(teamDir: string, limits: TeamLimits) {
    this.teamDir = teamDir
    this.limits = limits
  }

  /** Serialize every mutation: one daemon process is the only writer. */
  private locked<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  // ---- team record ----

  record(): TeamRecord | null {
    return readJsonOrNull<TeamRecord>(join(this.teamDir, TEAM_FILE))
  }

  // ---- member list ----

  private membersPath(): string {
    return join(this.teamDir, "team", MEMBERS_FILE)
  }

  readMembers(): TeamMemberList {
    return readJsonOrNull<TeamMemberList>(this.membersPath()) ?? { version: 1, members: [] }
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
   * session is created after this record is on disk.
   */
  async provisionMember(req: { name: string; role?: string; model?: string }): Promise<TeamMember> {
    return this.locked(() => {
      if (!isValidMemberName(req.name)) {
        throw new TeamConflictError(`invalid member name "${req.name}" (lowercase letters/digits/hyphen, must start with a letter, "lead" is reserved)`)
      }
      const list = this.readMembers()
      if (list.members.some((m) => m.name === req.name)) {
        throw new TeamConflictError(`member name "${req.name}" is taken (names are never reused)`)
      }
      if (list.members.length >= this.limits.maxMembers) {
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
      writeJsonAtomic(this.membersPath(), { version: 1, members: [...list.members, member] } satisfies TeamMemberList)
      return member
    })
  }

  /** Provisioning, step 2: attach the created child session (still provisioning). */
  async attachMemberSession(name: string, sessionId: string): Promise<TeamMember> {
    return this.locked(() => {
      const list = this.readMembers()
      const member = list.members.find((m) => m.name === name)
      if (member === undefined || member.status !== "provisioning") {
        throw new TeamConflictError(`member "${name}" is not provisioning`)
      }
      member.sessionId = sessionId
      writeJsonAtomic(this.membersPath(), list)
      return member
    })
  }

  /** Terminal transition: active (initial inbox accepted) or failed (with reason). */
  async settleMember(name: string, status: Extract<TeamMemberStatus, "active" | "failed">, reason?: string): Promise<TeamMember> {
    return this.locked(() => {
      const list = this.readMembers()
      const member = list.members.find((m) => m.name === name)
      if (member === undefined || member.status !== "provisioning") {
        throw new TeamConflictError(`member "${name}" is not pending settlement`)
      }
      member.status = status
      member.settledAt = new Date().toISOString()
      if (reason !== undefined) member.failReason = reason
      writeJsonAtomic(this.membersPath(), list)
      return member
    })
  }

  // ---- inboxes ----

  private inboxPath(to: string): string {
    return join(this.teamDir, "team", INBOX_DIR, `${to}.jsonl`)
  }

  readInbox(to: string): MailboxEntry[] {
    return readJsonl(this.inboxPath(to)) as MailboxEntry[]
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
      mkdirSync(join(this.teamDir, "team", INBOX_DIR), { recursive: true })
      appendJsonlLine(this.inboxPath(entry.to), full)
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
      if (changed) writeFileAtomic(this.inboxPath(to), renderedInbox(entries), 0o644)
    })
  }

  /** Same flip without the mutex — for the host's locked compound operations. */
  markDeliveredSync(to: string, id: string): void {
    const entries = this.readInbox(to)
    let changed = false
    for (const e of entries) {
      if (e.id === id && e.status === "pending") {
        e.status = "delivered"
        e.deliveredAt = new Date().toISOString()
        changed = true
      }
    }
    if (changed) writeFileAtomic(this.inboxPath(to), renderedInbox(entries), 0o644)
  }

  // ---- task board ----

  private taskPath(id: number): string {
    return join(this.teamDir, "task", `${id}.json`)
  }

  private boardPath(): string {
    return join(this.teamDir, "task", BOARD_FILE)
  }

  task(id: number): TaskSnapshot | null {
    return readJsonOrNull<TaskSnapshot>(this.taskPath(id))
  }

  listTasks(): TaskSnapshot[] {
    const dir = join(this.teamDir, "task")
    if (!existsSync(dir)) return []
    const out: TaskSnapshot[] = []
    for (const name of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue
      const task = readJsonOrNull<TaskSnapshot>(join(dir, name))
      if (task !== null) out.push(task)
    }
    return out.sort((a, b) => a.id - b.id)
  }

  /**
   * Create a task: existence-checked dependencies (the fresh id cannot close
   * a cycle — it has no incoming edges yet), monotonic id from the board,
   * revision 1. Not dispatch-ready until claimed.
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
      const board = readJsonOrNull<{ version: 1; nextId: number }>(this.boardPath()) ?? { version: 1, nextId: 1 }
      if (board.nextId > Number.MAX_SAFE_INTEGER - 1_000_000) {
        throw new TeamConflictError("task id space exhausted (ids are never reused)")
      }
      const now = new Date().toISOString()
      const task: TaskSnapshot = {
        id: board.nextId,
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
      board.nextId += 1
      writeJsonAtomic(this.boardPath(), board)
      writeJsonAtomic(this.taskPath(task.id), task)
      return task
    })
  }

  /**
   * Compare-and-swap update: `expectedRevision` must match; when the update
   * transitions an in_progress task (or reassigns it), the caller must echo
   * the current attemptId — a superseded executor's late write therefore
   * cannot clobber the successor's result. Claim/retry shapes increment the
   * attempt and mint a fresh attemptId.
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
}

function renderedInbox(entries: MailboxEntry[]): string {
  return entries.map((e) => JSON.stringify(e) + "\n").join("")
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
