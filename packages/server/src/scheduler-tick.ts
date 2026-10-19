/**
 * Scheduler tick — the daemon's heartbeat that turns due Cron
 * rows into runs: every `intervalMs` (default 30s, plus one immediate check
 * on start) it asks the scheduler what is due and, per cron, creates a fresh
 * session, broadcasts cron.started, enqueues a cron-triggered run on the
 * RunManager and settles the cron's lastStatus from the run outcome.
 *
 * Composition choices pinned here:
 * - cron.* events carry NO sessionId (makeEvent without ctx) — the EventBus
 *   broadcasts those to every connected socket, subscribers and bare
 *   connections alike, so any client sees scheduler activity.
 * - The per-cron user message is built by RunManager; the tick only passes the
 *   provenance line as `note` (it lands as a kind:"cron" block after the text).
 * - Due rows are claimed atomically: claimDue advances nextRunAt the moment
 *   a tick takes the cron, so a later tick (or a second handle on the same
 *   db) cannot re-fire it. The in-flight set is the second, in-process
 *   guard: a run still executing when the next scheduled point arrives is
 *   skipped — that fire is dropped rather than run concurrently with the
 *   still-settling one.
 * - A tick that throws (scheduler.claimDue, or the guards around one cron)
 *   is logged and dropped: the interval must survive its own failures (v1).
 *   The timer/in-flight skeleton itself lives in host-kit.
 */
import { makeEvent } from "@kclaw/core"
import type { Cron, CronScheduler, Message, Notifier, PermissionMode, SessionMeta, SessionStore, TextBlock } from "@kclaw/core"
import type { EventBus } from "@kclaw/core"
import type { RunManager } from "./run.js"
import { startIntervalHost, type IntervalHost } from "./host-kit.js"

/** Default cadence (30s polling). */
const DEFAULT_INTERVAL_MS = 30_000

/** Cron session history cap: soft-delete a cron's older sessions beyond this. */
const CRON_SESSION_KEEP = 20

/** Default recycle-bin retention (30 days) when config omits it. */
const DEFAULT_RECYCLE_BIN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface SchedulerTickDeps {
  scheduler: CronScheduler
  run: RunManager
  bus: EventBus
  sessions: SessionStore
  /** Tick cadence; defaults to 30s, tests inject small values. */
  intervalMs?: number
  /** Recycle-bin retention: soft-deleted sessions older than this are purged each tick. */
  purgeTtlMs?: number
  /** Clock seam, defaults to `() => new Date()`; tests inject a fake. */
  now?: () => Date
  /** Terminal-state cron notifier; absent → no pushes (zero overhead). */
  notifier?: Notifier
  /** Web UI base (e.g. http://127.0.0.1:<port>) for session links in pushes. */
  webBase?: string
  /**
   * Initial permission mode for cron-created sessions (the daemon's config
   * `permissions.defaultMode`); absent → "default". Cron sessions are daemon
   * sessions like any other — a configured default applies to them too.
   */
  defaultMode?: PermissionMode
}

/** Handle over a running tick loop. */
export interface SchedulerTickHandle {
  /** Clear the interval and await every in-flight cron run (bounded). Idempotent. */
  stop(): Promise<void>
}

/** Summary cap for ok pushes; longer last-assistant text is truncated. */
const SUMMARY_MAX_CHARS = 500

/**
 * The text of the LAST assistant message, its text blocks joined. This is the
 * "what did the cron say" summary pushed on the ok path; "" when the run
 * produced no assistant message.
 */
function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "assistant") continue
    const text = m.blocks
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
    return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text
  }
  return ""
}

export function startSchedulerTick(deps: SchedulerTickDeps): SchedulerTickHandle {
  const { scheduler, run, bus, sessions, notifier, webBase } = deps
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const purgeTtlMs = deps.purgeTtlMs ?? DEFAULT_RECYCLE_BIN_TTL_MS
  const now = deps.now ?? (() => new Date())

  /** Cron ids with a run in flight; a due cron already here is skipped this tick. */
  const inFlight = new Set<string>()

  /**
   * Push the terminal-state payload through the injected notifier. Fire and
   * forget under track(): notifyCronFinished never rejects, and stop() awaits
   * pending pushes alongside the cron runs. No notifier dep → no push at all.
   */
  function push(host: IntervalHost, cron: Cron, status: "ok" | "error", summary: string, session: SessionMeta | undefined): void {
    if (notifier === undefined) return
    host.track(
      notifier.notifyCronFinished({
        cronId: cron.id,
        cronName: cron.name,
        status,
        summary,
        sessionId: session?.id ?? "",
        sessionUrl: webBase !== undefined && session !== undefined ? `${webBase}/?session=${session.id}` : "",
      }),
    )
  }

  /** Record a failed fire and broadcast cron.failed. */
  function fail(host: IntervalHost, cron: Cron, message: string, session: SessionMeta | undefined): void {
    scheduler.markRun(cron.id, "error", now(), message)
    bus.emit(makeEvent("cron.failed", { cronId: cron.id, error: { code: "cron_failed", message } }))
    push(host, cron, "error", message, session)
  }

  /** Fire one due cron: session → cron.started → run → markRun + cron.completed/failed. */
  async function fireCron(host: IntervalHost, cron: Cron): Promise<void> {
    inFlight.add(cron.id)
    let session: SessionMeta | undefined // hoisted: fail() pushes its handle
    try {
      session = sessions.create(cron.name, cron.id, undefined, deps.defaultMode)
      // Keep the cron's history bounded: soft-delete older sessions beyond
      // CRON_SESSION_KEEP (newest first). They land in the recycle bin and are
      // purged by the existing retention sweep.
      for (const old of sessions.listByCron(cron.id).slice(CRON_SESSION_KEEP)) {
        sessions.delete(old.id)
      }
      bus.emit(makeEvent("cron.started", { cronId: cron.id })) // no sessionId → broadcast
      const outcome = await run.enqueue(session.id, {
        userText: cron.prompt,
        trigger: "cron",
        ...(cron.model !== undefined && cron.model !== "" ? { model: cron.model } : {}),
        note: { kind: "cron", text: `本会话由定时任务「${cron.name}」触发` },
      })
      if (outcome.stopReason !== "error") {
        scheduler.markRun(cron.id, "ok", now())
        bus.emit(makeEvent("cron.completed", { cronId: cron.id, summary: outcome.stopReason }))
        push(host, cron, "ok", lastAssistantText(outcome.messages), session)
      } else {
        // the loop surfaced the provider failure as stopReason "error"; the
        // outcome carries no message of its own, so the reason is the record
        fail(host, cron, outcome.stopReason, session)
      }
    } catch (err) {
      // enqueue throwing before/inside the run: same recording, the error's own message
      fail(host, cron, err instanceof Error ? err.message : String(err), session)
    } finally {
      inFlight.delete(cron.id) // ALWAYS: a settled (or never-started) run frees the slot
    }
  }

  /** One pass: claim due crons (claiming advances nextRunAt), fire each not already in flight, sequentially. */
  async function tick(host: IntervalHost): Promise<void> {
    let due: Cron[]
    try {
      due = scheduler.claimDue(now())
    } catch (err) {
      // v1: log and carry on — a broken tick must not kill the interval
      console.error("kclaw scheduler tick failed:", err instanceof Error ? err.message : err)
      return
    }
    for (const cron of due) {
      if (host.stopped) return
      if (inFlight.has(cron.id)) continue
      const p = fireCron(host, cron)
      host.track(p)
      // crons are rare: sequential await is fine. fireCron settles its own
      // outcomes; this catch guards its guards (e.g. a throwing markRun) so
      // one bad cron can never end the interval either.
      await p.catch((err: unknown) => {
        console.error(`kclaw scheduler cron ${cron.id} crashed:`, err)
      })
    }

    // Recycle bin: drop soft-deleted sessions past retention
    // on the same heartbeat. A purge failure must not kill the interval.
    try {
      sessions.purgeExpired(purgeTtlMs)
    } catch (err) {
      console.error("kclaw recycle-bin purge failed:", err instanceof Error ? err.message : err)
    }
  }

  const handle = startIntervalHost({
    label: "scheduler tick",
    intervalMs,
    sweep: (host) => tick(host),
  })
  return { stop: () => handle.stop() }
}
