/**
 * Scheduler tick (P3 Task 8) — the daemon's heartbeat that turns due Job
 * rows into runs: every `intervalMs` (default 30s, plus one immediate check
 * on start) it asks the scheduler what is due and, per job, creates a fresh
 * session, broadcasts job.started, enqueues a job-triggered run on the
 * RunManager and settles the job's lastStatus from the run outcome.
 *
 * Composition choices pinned here:
 * - job.* events carry NO sessionId (makeEvent without ctx) — the EventBus
 *   broadcasts those to every connected socket, subscribers and bare
 *   connections alike, so any client sees scheduler activity.
 * - The per-job user message is built by RunManager; the tick only passes the
 *   provenance line as `note` (it lands as a kind:"job" block after the text).
 * - An in-flight set guards re-entry: a job still executing when the next
 *   tick fires is skipped (markRun — which advances nextRunAt — only happens
 *   once its run settles, so the row stays "due" until then).
 * - A tick that throws (scheduler.due, or the guards around one job) is
 *   logged and dropped: the interval must survive its own failures (v1).
 */
import { makeEvent } from "@kclaw/core"
import type { Job, JobScheduler, SessionStore } from "@kclaw/core"
import type { EventBus } from "./bus.js"
import type { RunManager } from "./run.js"

/** Default cadence (spec: 30s 轮询). */
const DEFAULT_INTERVAL_MS = 30_000

/** Default recycle-bin retention (30 days) when config omits it. */
const DEFAULT_RECYCLE_BIN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface SchedulerTickDeps {
  scheduler: JobScheduler
  run: RunManager
  bus: EventBus
  sessions: SessionStore
  /** Tick cadence; defaults to 30s, tests inject small values. */
  intervalMs?: number
  /** Recycle-bin retention: soft-deleted sessions older than this are purged each tick. */
  purgeTtlMs?: number
  /** Clock seam, defaults to `() => new Date()`; tests inject a fake. */
  now?: () => Date
}

/** Handle over a running tick loop. */
export interface SchedulerTickHandle {
  /** Clear the interval and await every in-flight job run (bounded). Idempotent. */
  stop(): Promise<void>
}

export function startSchedulerTick(deps: SchedulerTickDeps): SchedulerTickHandle {
  const { scheduler, run, bus, sessions } = deps
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const purgeTtlMs = deps.purgeTtlMs ?? DEFAULT_RECYCLE_BIN_TTL_MS
  const now = deps.now ?? (() => new Date())

  /** Job ids with a run in flight; a due job already here is skipped this tick. */
  const inFlight = new Set<string>()
  /** Not-yet-settled job-run promises; `stop` awaits a snapshot of this. */
  const tracked: Promise<void>[] = []
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  /** Remember a fire-and-forget job run until it settles (bounded growth). */
  function track(p: Promise<void>): void {
    tracked.push(p)
    void p.then(
      () => detach(),
      () => detach(),
    )
    function detach(): void {
      const i = tracked.indexOf(p)
      if (i !== -1) tracked.splice(i, 1)
    }
  }

  /** Record a failed fire and broadcast job.failed. */
  function fail(job: Job, message: string): void {
    scheduler.markRun(job.id, "error", now(), message)
    bus.emit(makeEvent("job.failed", { jobId: job.id, error: { code: "job_failed", message } }))
  }

  /** Fire one due job: session → job.started → run → markRun + job.completed/failed. */
  async function fireJob(job: Job): Promise<void> {
    inFlight.add(job.id)
    try {
      const session = sessions.create(job.name, job.id)
      bus.emit(makeEvent("job.started", { jobId: job.id })) // no sessionId → broadcast
      const outcome = await run.enqueue(session.id, {
        userText: job.prompt,
        trigger: "job",
        note: `本会话由定时任务「${job.name}」触发`,
      })
      if (outcome.stopReason !== "error") {
        scheduler.markRun(job.id, "ok", now())
        bus.emit(makeEvent("job.completed", { jobId: job.id, summary: outcome.stopReason }))
      } else {
        // the loop surfaced the provider failure as stopReason "error"; the
        // outcome carries no message of its own, so the reason is the record
        fail(job, outcome.stopReason)
      }
    } catch (err) {
      // enqueue throwing before/inside the run: same recording, the error's own message
      fail(job, err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.delete(job.id) // ALWAYS: a settled (or never-started) run frees the slot
    }
  }

  /** One pass: collect due jobs, fire each not already in flight, sequentially. */
  async function tick(): Promise<void> {
    let due: Job[]
    try {
      due = scheduler.due(now())
    } catch (err) {
      // v1: log and carry on — a broken tick must not kill the interval
      console.error("kclaw scheduler tick failed:", err instanceof Error ? err.message : err)
      return
    }
    for (const job of due) {
      if (stopped) return
      if (inFlight.has(job.id)) continue
      const p = fireJob(job)
      track(p)
      // jobs are rare: sequential await is fine. fireJob settles its own
      // outcomes; this catch guards its guards (e.g. a throwing markRun) so
      // one bad job can never end the interval either.
      await p.catch((err: unknown) => {
        console.error(`kclaw scheduler job ${job.id} crashed:`, err)
      })
    }

    // Recycle bin (final-review #4): drop soft-deleted sessions past retention
    // on the same heartbeat. A purge failure must not kill the interval.
    try {
      sessions.purgeExpired(purgeTtlMs)
    } catch (err) {
      console.error("kclaw recycle-bin purge failed:", err instanceof Error ? err.message : err)
    }
  }

  // one immediate check, then the interval
  void tick()
  timer = setInterval(() => void tick(), intervalMs)

  return {
    async stop(): Promise<void> {
      stopped = true
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      await Promise.allSettled([...tracked]) // bounded: settled promises self-detach
    },
  }
}
