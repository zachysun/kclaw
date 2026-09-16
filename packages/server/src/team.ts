/**
 * The server-side team host — the daemon's TeamFacade implementation and the
 * runtime side of the agent team. One host per daemon.
 *
 * Responsibilities:
 * - discovery: map a session id to its team identity by scanning the lead's
 *   workspace `.agent-teams/` directory (team.json records the lead; the
 *   member list maps member sessions);
 * - lifecycle: create_team materializes the directory; spawn_teammate runs
 *   the provisioning transaction (reserve the name → create the child
 *   session → attach → settle active), reconciling interrupted provisioning
 *   on the lead's next touch after a daemon restart;
 * - mailbox: send = durable append (pending) → dispatch → delivered flip.
 *   Dispatch rides the run queue with trigger "team" / disposition "steer",
 *   so an active run takes the message at its next turn boundary and an idle
 *   member starts immediately (no polling anywhere). Delivery is
 *   at-least-once: the flip happens after submit acceptance, so a crash in
 *   the tiny window may redeliver — never silently drop;
 * - task board: the facade enforces identity rules (assign is lead-only,
 *   edits belong to the owner or the lead, a member's claim fills in its own
 *   name) while the store enforces mechanics (CAS, attempt echo, transitions);
 * - auto-dispatch: at every idle edge (a member run settled, a task created
 *   or advanced) idle members with a free plate are woken onto one ready
 *   unclaimed task — the member model claims it with its own attemptId, so
 *   two woken members race safely under the store's CAS;
 * - card forwarding: a member's confirmation/question cards re-emit on the
 *   LEAD channel labeled `来自组员 <name>` (resolution stays global by id).
 *
 * No cascade anywhere: stopping a member is an explicit
 * run.cancel on its session; stopping the lead never touches members; the
 * only lead-scoped sweep is the delete/purge data cleanup, which cancels
 * still-running member runs so nothing keeps writing into deleted sessions.
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import {
  ensureWorkspaceIgnore,
  initTeamDirectory,
  makeEvent,
  newBlockId,
  newId,
  newMessage,
  TeamConflictError,
  TeamStore,
  type AgentSummary,
  type AnyAgentEvent,
  type EventBus,
  type KclawConfig,
  type MailboxEntry,
  type SessionStore,
  type TeamAuditEvent,
  type TeamFacade,
  type TeamIdentity,
  type TeamMember,
  type TeamPanel,
  type TeamRecord,
  type TeamLimits,
  type TeamSenderKind,
} from "@kclaw/core"
import type { RunManager } from "./run.js"

export interface TeamHostDeps {
  config: KclawConfig
  sessions: SessionStore
  bus: EventBus
  /** Late-bound: the host dispatches member runs through the RunManager. */
  getRun: () => RunManager
}

export interface TeamHost {
  facade: TeamFacade
  /** The team panel payload for a lead or member session; null = no team. */
  panel(sessionId: string): Promise<TeamPanel | null>
  /** A user's chat message aimed at one member (ws send_message `target`). */
  deliverUserToMember(leadSessionId: string, memberName: string, text: string): Promise<{ id: string }>
  /** Delete/purge cascade: cancel still-running member runs of this lead's team. */
  cancelMembersForLead(leadSessionId: string): number
  /** Delete/purge cascade: move the team directory under `archive/` (the
   * record and trails stay inspectable; best-effort rename, a name collision
   * gets a timestamp suffix). */
  archiveTeamForLead(leadSessionId: string): boolean
}

const STATE_DIR = ".agent-teams"
const LEAD_INBOX = "lead"

/** Omit that distributes over unions (plain Omit collapses union key sets). */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

export function createTeamHost(deps: TeamHostDeps): TeamHost {
  const { config, sessions, bus } = deps
  const limits: TeamLimits = {
    maxMembers: config.team?.maxMembers ?? 8,
    maxActive: config.team?.maxActive ?? 4,
    maxUnreadPerTarget: config.team?.mailbox?.maxUnreadPerTarget ?? 64,
    maxMessageBytes: config.team?.mailbox?.maxMessageBytes ?? 65_536,
    maxTasks: config.team?.taskBoard?.maxTasks ?? 64,
  }
  const stateDir = config.team?.stateDir ?? STATE_DIR
  /** TeamStore cache keyed by absolute team directory (constructors are pure). */
  const stores = new Map<string, TeamStore>()
  /** Members with a live run — the busy observation and the idle edge both read it. */
  const running = new Set<string>()
  /**
   * Auto-dispatch ledger: one offer of a task to a member per "situation".
   * Without it an unclaimed ready task + an idle member would wake forever
   * (member declines → idle edge → same task → wake …). Any board or mailbox
   * activity bumps the epoch, so a changed situation re-enables offers; a
   * daemon restart resets the ledger (one re-offer per task — harmless).
   */
  let offerEpoch = 0
  const offered = new Map<string, { task: number; epoch: number }>()

  const storeFor = (workspace: string, teamId: string): TeamStore => {
    const dir = join(workspace, stateDir, teamId)
    let store = stores.get(dir)
    if (store === undefined) {
      store = new TeamStore(dir, limits)
      stores.set(dir, store)
    }
    return store
  }

  interface Found {
    identity: TeamIdentity
    store: TeamStore
    record: TeamRecord
  }

  /** Reverse lookup: session → (team, identity). Reads are cheap; the scan is bounded by the team count. */
  const find = (sessionId: string): Found | null => {
    const meta = sessions.meta(sessionId)
    if (meta === undefined) return null
    const workspace = meta.workdir ?? config.workspace
    let entries: string[]
    try {
      entries = readdirSync(join(workspace, stateDir))
    } catch {
      return null
    }
    for (const teamId of entries) {
      const store = storeFor(workspace, teamId)
      const record = store.record()
      if (record === null) continue
      if (record.leadSessionId === sessionId) {
        return { identity: { role: "lead", teamId, sessionId }, store, record }
      }
      const member = store.memberBySession(sessionId)
      if (member !== null && member.sessionId === sessionId && member.status !== "failed") {
        return { identity: { role: "member", teamId, sessionId, name: member.name }, store, record }
      }
    }
    return null
  }

  /** Team audit events land on the LEAD session's stream (audit-only; the
   * truth is the directory). The schema version is injected here so every
   * producer stays uniform. */
  const audit = (found: Found, event: DistributiveOmit<TeamAuditEvent, "at" | "version">): void => {
    try {
      sessions.appendTeamAudit(found.record.leadSessionId, { version: 1 as const, ...(event as object), at: new Date().toISOString() } as TeamAuditEvent)
    } catch (err) {
      console.error("kclaw team: audit append failed:", err)
    }
  }

  /** Crash reconciliation: provisioning leftovers settle from what survived on disk. */
  const reconcile = async (found: Found): Promise<void> => {
    for (const m of found.store.readMembers().members) {
      if (m.status !== "provisioning") continue
      if (m.sessionId !== "" && sessions.meta(m.sessionId) !== undefined) {
        await found.store.settleMember(m.name, "active")
        audit(found, { type: "team.member.settled", teamId: found.record.teamId, member: m.name, status: "active" })
      } else {
        await found.store.settleMember(m.name, "failed", "provisioning interrupted (session missing)")
        audit(found, { type: "team.member.settled", teamId: found.record.teamId, member: m.name, status: "failed", reason: "provisioning interrupted (session missing)" })
      }
    }
  }

  const senderLabel = (from: { kind: TeamSenderKind; name?: string }): string =>
    from.kind === "lead" ? "组长" : from.kind === "user" ? "用户" : `组员 ${from.name ?? ""}`.trim()

  /** The model-facing text of one mailbox dispatch: every claimed entry, in order. */
  const renderMailboxInput = (teamName: string, memberName: string, entries: MailboxEntry[], firstRun: boolean): string => {
    const body = entries.map((e) => `【来自 ${senderLabel(e.from)}】\n${e.text}`).join("\n\n")
    const prefix = firstRun
      ? `<system-reminder kind="team-identity">你是 agent team「${teamName}」的组员 ${memberName}；以下消息来自你的收信箱。</system-reminder>\n\n`
      : ""
    return `${prefix}${body}`
  }

  /** Confirmation/question card forwarding: a member's cards re-emit on the lead channel. */
  const makeForwarder = (record: TeamRecord, member: TeamMember) => {
    const who = `组员 ${member.name}`
    const forwardCtx = (e: AnyAgentEvent): { sessionId: string; runId?: string } =>
      e.runId === undefined
        ? { sessionId: record.leadSessionId }
        : { sessionId: record.leadSessionId, runId: e.runId }
    return {
      send(data: string): void {
        let e: AnyAgentEvent
        try {
          e = JSON.parse(data) as AnyAgentEvent
        } catch {
          return
        }
        switch (e.type) {
          case "confirmation.requested":
            bus.emit(makeEvent("confirmation.requested", {
              ...e.payload,
              noteText: e.payload.noteText === undefined ? `来自${who}` : `来自${who} · ${e.payload.noteText}`,
            }, forwardCtx(e)))
            break
          case "confirmation.resolved":
            bus.emit(makeEvent("confirmation.resolved", { ...e.payload }, forwardCtx(e)))
            break
          case "question.requested":
            bus.emit(makeEvent("question.requested", {
              ...e.payload,
              noteText: e.payload.noteText === undefined ? `来自${who}` : `来自${who} · ${e.payload.noteText}`,
            }, forwardCtx(e)))
            break
          case "question.resolved":
            bus.emit(makeEvent("question.resolved", { ...e.payload }, forwardCtx(e)))
            break
          default:
            break
        }
      },
    }
  }

  /** One dispatched session run: forwarder on, running ledger on, idle edge
   * after settle. Returns false when submit was rejected (queue full / session
   * gone) so the caller can release whatever it pinned for this attempt. */
  const startRun = (found: Found, targetName: string, sessionId: string, model: string | undefined, text: string, mail?: { to: string; ids: string[]; onDrop: () => void }): boolean => {
    const member = found.store.memberByName(targetName)
    const forwarder = member !== null ? makeForwarder(found.record, member) : undefined
    if (forwarder !== undefined) bus.subscribe(sessionId, forwarder)
    const landWatcher = mail === undefined ? undefined : makeLandWatcher(found, sessionId, mail)
    if (landWatcher !== undefined) bus.subscribe(sessionId, landWatcher)
    running.add(targetName)
    let submitted: ReturnType<RunManager["submit"]>
    try {
      submitted = deps.getRun().submit(sessionId, {
        userText: text,
        trigger: "team",
        disposition: "steer",
        ...(model !== undefined && model !== "" ? { model } : {}),
      })
    } catch (err) {
      // Queue full / session gone: the input text stays composed of whatever
      // is still pending (never claimed away) — the next wake retries.
      if (forwarder !== undefined) bus.unsubscribe(sessionId, forwarder)
      if (landWatcher !== undefined) bus.unsubscribe(sessionId, landWatcher)
      running.delete(targetName)
      mail?.onDrop()
      console.error(`kclaw team: dispatch to ${targetName} failed:`, err)
      return false
    }
    void submitted.outcome
      .catch(() => undefined)
      .then(() => {
        if (forwarder !== undefined) bus.unsubscribe(sessionId, forwarder)
        // A run that settled without landing its input releases the mail for
        // a later retry; a landed watcher already released itself.
        if (landWatcher !== undefined) {
          bus.unsubscribe(sessionId, landWatcher)
          if (!landWatcher.landed()) mail?.onDrop()
        }
        running.delete(targetName)
        // Idle edge: leftover pending mail or a fresh ready task keeps the
        // member (or a teammate) working without anyone polling.
        pumpIdle(found)
      })
    return true
  }

  /** Mailbox ids already rendered into a live run and awaiting their landing. */
  const inFlight = new Map<string, Set<string>>()
  const markInFlight = (to: string, id: string): void => {
    let set = inFlight.get(to)
    if (set === undefined) {
      set = new Set()
      inFlight.set(to, set)
    }
    set.add(id)
  }
  const releaseInFlight = (to: string, ids: string[]): void => {
    const set = inFlight.get(to)
    if (set === undefined) return
    for (const id of ids) set.delete(id)
    if (set.size === 0) inFlight.delete(to)
  }

  interface MailDispatch {
    to: string
    ids: string[]
    onDrop: () => void
  }

  interface LandWatcher {
    send(data: string): void
    landed(): boolean
  }

  /**
   * Delivery flip on target-side land: pending mailbox entries count as
   * delivered only once the dispatched input actually reaches the target
   * session's history (its first message.created). A crash before that leaves
   * the mail pending on disk — the next idle edge redelivers, never drops.
   */
  const makeLandWatcher = (found: Found, sessionId: string, mail: MailDispatch): LandWatcher => {
    let landed = false
    const watcher: LandWatcher = {
      landed: () => landed,
      send(data: string): void {
        if (landed) return
        let e: AnyAgentEvent
        try {
          e = JSON.parse(data) as AnyAgentEvent
        } catch {
          return
        }
        if (e.type !== "message.created" || e.sessionId !== sessionId) return
        landed = true
        bus.unsubscribe(sessionId, watcher)
        // The in-flight release waits for the durable flip: releasing earlier
        // would open a window where the entry is still pending on disk but no
        // longer filtered, and the next idle edge would render it twice.
        void found.store
          .markDeliveredMany(mail.to, mail.ids)
          .then(() => releaseInFlight(mail.to, mail.ids))
          .catch((err: unknown) => {
            console.error(`kclaw team: delivery flip failed for ${mail.to}:`, err)
            releaseInFlight(mail.to, mail.ids) // still pending on disk — let a later edge retry
          })
        for (const id of mail.ids) {
          audit(found, { type: "team.message.delivered", teamId: found.record.teamId, id, to: mail.to })
        }
      },
    }
    return watcher
  }

  /** Deliver the member's pending mail: append → dispatch → flip (at-least-once). */
  const deliverToMember = async (found: Found, member: TeamMember, from: { kind: TeamSenderKind; name?: string }, text: string): Promise<MailboxEntry> => {
    const entry = await found.store.enqueueMail({ from, to: member.name, type: "text", text })
    offerEpoch++ // a new message is a new situation: dispatch offers reset
    audit(found, {
      type: "team.message.queued", teamId: found.record.teamId, id: entry.id,
      from: senderLabel(from), to: member.name, textPreview: excerpt(text),
    })
    deliverPendingMail(found, member)
    return entry
  }

  /** Members with a run in flight — the lead's own wake ("lead" key) is not a member run. */
  const runningMembers = (): number => {
    let n = 0
    for (const name of running) if (name !== LEAD_INBOX) n += 1
    return n
  }

  /**
   * Dispatch one member's pending mail (render → run → flip on land,
   * at-least-once). Entries already in flight (a previous wake's input not
   * landed yet) are left out of the render so they cannot be delivered twice;
   * a full plate (team.maxActive) leaves the mail pending: the next idle edge
   * (any member finishing a run) pumps it out — nothing polls, nothing drops.
   */
  const deliverPendingMail = (found: Found, member: TeamMember): void => {
    if (runningMembers() >= limits.maxActive) return
    // A busy member is never dispatched into: its run's input would only land
    // after the current run settles, past the point where this dispatch's
    // land-watcher dies — the idle edge (this run's settle) delivers instead.
    if (running.has(member.name)) return
    const inFlightFor = inFlight.get(member.name)
    const pending = inFlightFor === undefined ? found.store.pendingInbox(member.name) : found.store.pendingInbox(member.name).filter((e) => !inFlightFor.has(e.id))
    if (member.sessionId === "" || pending.length === 0 || member.status !== "active") return
    const ids = pending.map((e) => e.id)
    for (const id of ids) markInFlight(member.name, id)
    const firstRun = sessions.readMessages(member.sessionId).length === 0
    const input = renderMailboxInput(found.record.name, member.name, pending, firstRun)
    const started = startRun(found, member.name, member.sessionId, member.model, input, {
      to: member.name,
      ids,
      onDrop: () => releaseInFlight(member.name, ids),
    })
    if (!started) releaseInFlight(member.name, ids)
  }

  /**
   * Render + dispatch the lead's pending inbox entries (one run carrying every
   * fresh entry — two members may report at once). Busy lead = no dispatch:
   * the report waits for an idle edge, same as member mail.
   */
  const flushLeadInbox = (found: Found): void => {
    if (running.has(LEAD_INBOX)) return
    const pending = found.store.pendingInbox(LEAD_INBOX)
    const inFlightFor = inFlight.get(LEAD_INBOX)
    const fresh = inFlightFor === undefined ? pending : pending.filter((e) => !inFlightFor.has(e.id))
    if (fresh.length === 0) return
    const ids = fresh.map((e) => e.id)
    for (const id of ids) markInFlight(LEAD_INBOX, id)
    const body = fresh.map((e) => `【来自 ${senderLabel(e.from)}】\n${e.text}`).join("\n\n")
    const started = startRun(found, LEAD_INBOX, found.record.leadSessionId, undefined, body, {
      to: LEAD_INBOX,
      ids,
      onDrop: () => releaseInFlight(LEAD_INBOX, ids),
    })
    if (!started) releaseInFlight(LEAD_INBOX, ids)
  }

  /**
   * Idle-edge pump: flush reports deferred on the lead's inbox, deliver mail
   * that a full plate deferred, then auto-dispatch one ready unclaimed task to
   * one idle member with a free plate.
   */
  const pumpIdle = (found: Found): void => {
    flushLeadInbox(found)
    const ready = found.store.readyTasks()
    for (const m of found.store.readMembers().members) {
      if (runningMembers() >= limits.maxActive) return
      if (m.status !== "active" || m.sessionId === "") continue
      if (running.has(m.name)) continue
      // Deferred mail first — the mail wake IS the run (a task offer on top
      // would only queue behind unread mail anyway).
      if (found.store.unreadCount(m.name) > 0) {
        deliverPendingMail(found, m)
        continue
      }
      const held = found.store.heldTask(m.name)
      if (held !== null) {
        // Resume-wake (crash recovery): a member holding an in_progress task
        // while idle — e.g. right after a daemon restart — gets one nudge per
        // situation; the offer ledger keeps a stalling member from looping.
        const key = `${found.record.teamId}|${m.name}`
        const prev = offered.get(key)
        if (prev !== undefined && prev.task === held.id && prev.epoch === offerEpoch) continue
        offered.set(key, { task: held.id, epoch: offerEpoch })
        startRun(found, m.name, m.sessionId, m.model, [
          `恢复提醒：你名下有进行中的任务 #${held.id}「${held.subject}」。`,
          "请继续推进：用 task_list 查看任务详情；完成时落 completed 并给组长发结题信，受阻则落 failed 并说明原因。",
        ].join("\n"))
        return
      }
      if (ready.length === 0) continue
      const task = ready[0]!
      // Already offered THIS task in the current situation → never re-wake
      // (the member may have declined; a board/mail change re-enables).
      const key = `${found.record.teamId}|${m.name}`
      const prev = offered.get(key)
      if (prev !== undefined && prev.task === task.id && prev.epoch === offerEpoch) continue
      offered.set(key, { task: task.id, epoch: offerEpoch })
      startRun(found, m.name, m.sessionId, m.model, [
        `任务派发：任务板有就绪任务 #${task.id}「${task.subject}」。`,
        "用 task_list 查看详情，用 task_update 认领（回传 expected_revision）后推进；完成时落 completed 并给组长发结题信。",
      ].join("\n"))
      return
    }
  }

  const summaries = (found: Found): AgentSummary[] =>
    found.store.readMembers().members.map((m) => ({
      name: m.name,
      status: m.status,
      busy: m.status === "active" && running.has(m.name),
      ...(m.role !== undefined ? { role: m.role } : {}),
      ...(m.model !== undefined && m.model !== "" ? { model: m.model } : {}),
      ...(m.failReason !== undefined ? { failReason: m.failReason } : {}),
      ...(m.sessionId !== "" ? { sessionId: m.sessionId } : {}),
      ...(m.status === "active" && found.store.heldTask(m.name)?.subject !== undefined
        ? { currentTask: found.store.heldTask(m.name)!.subject }
        : {}),
    }))

  const facade: TeamFacade = {
    async describeSession(sessionId) {
      const found = find(sessionId)
      if (found === null) return null
      if (found.identity.role === "lead") await reconcile(found)
      return found.identity
    },

    async createTeam(leadSessionId, name) {
      if (find(leadSessionId) !== null) {
        throw new TeamConflictError("this session already belongs to a team (one team per session)")
      }
      const meta = sessions.meta(leadSessionId)
      if (meta === undefined) throw new TeamConflictError("lead session not found")
      const workspace = meta.workdir ?? config.workspace
      // teamId IS the lead session id — one team per session makes it
      // naturally unique, and every reverse lookup stays a plain directory
      // name (no second id space to reconcile).
      const teamId = leadSessionId
      const record: TeamRecord = {
        version: 1,
        teamId,
        name: name?.trim() !== "" && name !== undefined ? name.trim() : meta.title || "team",
        leadSessionId,
        createdAt: new Date().toISOString(),
      }
      initTeamDirectory(join(workspace, stateDir, teamId), record)
      ensureWorkspaceIgnore(workspace, stateDir)
      const found: Found = { identity: { role: "lead", teamId, sessionId: leadSessionId }, store: storeFor(workspace, teamId), record }
      audit(found, { type: "team.created", teamId, name: record.name })
      return { teamId, name: record.name }
    },

    async spawnTeammate(lead, req) {
      const found = find(lead.sessionId)
      if (found === null || found.identity.role !== "lead") {
        throw new TeamConflictError("spawn_teammate is lead-only (create_team first)")
      }
      const meta = sessions.meta(lead.sessionId)
      if (meta === undefined) throw new TeamConflictError("lead session not found")
      const model = req.model?.trim() !== "" && req.model !== undefined ? req.model.trim() : meta.model
      await found.store.provisionMember({ name: req.name, role: req.role, model })
      let childId: string
      try {
        const child = sessions.create(`组员 · ${req.name}`, undefined, meta.workdir, meta.mode ?? "default", lead.sessionId)
        childId = child.id
        await found.store.attachMemberSession(req.name, child.id)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        try {
          await found.store.settleMember(req.name, "failed", reason)
        } catch {
          // already settled — keep the original failure
        }
        audit(found, { type: "team.member.settled", teamId: found.record.teamId, member: req.name, status: "failed", reason })
        throw err
      }
      audit(found, { type: "team.member.provisioned", teamId: found.record.teamId, member: req.name, sessionId: childId, ...(model !== undefined ? { model } : {}) })
      await found.store.settleMember(req.name, "active")
      audit(found, { type: "team.member.settled", teamId: found.record.teamId, member: req.name, status: "active" })
      const member = found.store.memberByName(req.name)
      if (member !== null) await deliverToMember(found, member, { kind: "lead" }, req.task)
      return { name: req.name, sessionId: childId, ...(model !== undefined ? { model } : {}) }
    },

    async sendMessage(from, req) {
      const found = find(from.sessionId)
      if (found === null) throw new TeamConflictError("sender session is not in a team")
      if (req.to.kind === "user") throw new TeamConflictError("cannot send to a user target")
      const fromField = { kind: (from.role === "member" ? "member" : "lead") as TeamSenderKind, ...(from.role === "member" ? { name: from.name } : {}) }
      if (req.to.kind === "lead") {
        // The lead has an inbox too ("lead"): append, then wake the lead
        // session with EVERY pending entry (two members may report at once).
        const entry = await found.store.enqueueMail({ from: fromField, to: LEAD_INBOX, type: "text", text: req.text })
        offerEpoch++
        audit(found, {
          type: "team.message.queued", teamId: found.record.teamId, id: entry.id,
          from: senderLabel(fromField), to: "lead", textPreview: excerpt(req.text),
        })
        flushLeadInbox(found)
        return { id: entry.id }
      }
      const member = found.store.memberByName(req.to.name ?? "")
      if (member === null || member.status !== "active") {
        throw new TeamConflictError(`no active member named "${req.to.name ?? ""}" on the list`)
      }
      const entry = await deliverToMember(found, member, fromField, req.text)
      return { id: entry.id }
    },

    async listAgents(identity) {
      const found = find(identity.sessionId)
      if (found === null) throw new TeamConflictError("session is not in a team")
      return { members: summaries(found) }
    },

    async taskList(identity) {
      const found = find(identity.sessionId)
      if (found === null) throw new TeamConflictError("session is not in a team")
      return { tasks: found.store.listTasks() }
    },

    async taskCreate(identity, req) {
      const found = find(identity.sessionId)
      if (found === null) throw new TeamConflictError("session is not in a team")
      const task = await found.store.createTask({
        subject: req.subject,
        detail: req.detail,
        dependencies: req.dependencies,
        // Direct assignment is a lead prerogative at create time too.
        ...(identity.role === "lead" && req.assignee !== undefined ? { assignee: req.assignee } : {}),
      })
      offerEpoch++
      audit(found, { type: "team.task.created", teamId: found.record.teamId, task })
      pumpIdle(found)
      return task
    },

    async taskUpdate(identity, req) {
      const found = find(identity.sessionId)
      if (found === null) throw new TeamConflictError("session is not in a team")
      if (req.assignee !== undefined && identity.role !== "lead") {
        throw new TeamConflictError("only the lead may assign or reassign a task")
      }
      const patch = { ...req }
      const task = found.store.task(req.id)
      if (task === null) throw new TeamConflictError(`task #${req.id} does not exist`)
      if (identity.role === "member" && task.assignee !== null && task.assignee !== identity.name) {
        throw new TeamConflictError(`task #${req.id} belongs to ${task.assignee}; only its owner or the lead may update it`)
      }
      // A member claiming an unclaimed ready task fills in its own name.
      if (identity.role === "member" && task.assignee === null && patch.assignee === undefined && patch.status === "in_progress") {
        patch.assignee = identity.name
      }
      const updated = await found.store.updateTask(patch)
      offerEpoch++
      audit(found, { type: "team.task.updated", teamId: found.record.teamId, task: updated })
      pumpIdle(found)
      return updated
    },
  }

  return {
    facade,
    async panel(sessionId) {
      const found = find(sessionId)
      if (found === null) return null
      if (found.identity.role === "lead") await reconcile(found)
      return {
        team: found.record,
        identity: found.identity.role,
        members: summaries(found),
        tasks: found.store.listTasks(),
      }
    },
    async deliverUserToMember(leadSessionId, memberName, text) {
      const found = find(leadSessionId)
      if (found === null || found.identity.role !== "lead") {
        throw new TeamConflictError("this session has no team (create_team first)")
      }
      const member = found.store.memberByName(memberName)
      if (member === null || member.status !== "active") {
        throw new TeamConflictError(`no active member named "${memberName}" on the list`)
      }
      // The message lands in the LEAD's history too (forwarding marker note),
      // so the chat view shows what the user asked whom — the run itself
      // happens on the member session.
      const message = newMessage(leadSessionId, "user", [
        { id: newBlockId(), type: "text", text },
        { id: newBlockId(), type: "note", kind: "system", text: `已转发给组员 ${memberName}（团队收信箱投递）` },
      ])
      sessions.appendMessage(leadSessionId, message)
      bus.emit(makeEvent("message.created", { message }, { sessionId: leadSessionId }))
      bus.emit(makeEvent("message.completed", { message }, { sessionId: leadSessionId }))
      const entry = await deliverToMember(found, member, { kind: "user" }, text)
      return { id: entry.id }
    },
    cancelMembersForLead(leadSessionId) {
      const found = find(leadSessionId)
      if (found === null || found.identity.role !== "lead") return 0
      let count = 0
      for (const m of found.store.readMembers().members) {
        if (m.sessionId === "" || m.status === "failed") continue
        try {
          if (deps.getRun().cancel(m.sessionId)) count++
        } catch {
          // daemon teardown — nothing left to cancel
        }
      }
      return count
    },
    archiveTeamForLead(leadSessionId) {
      const found = find(leadSessionId)
      if (found === null || found.identity.role !== "lead") return false
      const meta = sessions.meta(leadSessionId)
      const workspace = meta?.workdir ?? config.workspace
      const src = join(workspace, stateDir, found.record.teamId)
      if (!existsSync(src)) return false
      try {
        const archiveDir = join(workspace, stateDir, "archive")
        mkdirSync(archiveDir, { recursive: true })
        let dest = join(archiveDir, found.record.teamId)
        if (existsSync(dest)) dest = `${dest}-${Date.now()}`
        renameSync(src, dest)
      } catch (err) {
        console.error("kclaw team: archiving the team directory failed:", err)
        return false
      }
      stores.delete(src)
      return true
    },
  }
}

/** Single-line head excerpt for the audit preview. */
function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed
}
