import type { ConfirmationDecision, ConfirmationRequestedPayload, ToolCallBlock } from "../protocol/index.js"

/**
 * Verdict value carried between the loop and its human resolver: the
 * persistence scope of the approval. Approving decisions are every value but
 * `reject`; the scope itself is consumed in the run assembly's
 * resolveConfirmation seam, which also persists the decided rule.
 */
export type ConfirmationResolution = { decision: ConfirmationDecision; by: ConfirmationActor }

/** A human answer set for a pending question: one string array per asked question, in ask order. */
export type QuestionResolution = { answers: string[][]; by: ConfirmationActor }

/**
 * `Promise.race` against a timer AND an abort signal; the timer is cleared
 * and the listener removed once the race settles. The race answers with the
 * awaited value, or the named sentinels "timeout" (the timer won) and
 * "aborted" (the signal fired) — an abort is kept distinct from a timeout so
 * an aborted wait is never misreported as a timeout-deny, and neither
 * sentinel is ever smuggled through as a human answer.
 *
 * The SINGLE implementation for every racer that must agree on a pending
 * entry's outcome: the loop and the run assembly (confirmations), the ask
 * tool (questions).
 */
export function racePending<T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<T | "timeout" | "aborted"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const sleep = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  let onAbort = () => {}
  const abort = new Promise<"aborted">((resolve) => {
    if (!signal) return
    if (signal.aborted) resolve("aborted")
    else {
      onAbort = () => resolve("aborted")
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
  return Promise.race([p, sleep, abort]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  })
}

/** The confirmation-shaped race: resolver vs timeout vs run abort. */
export function raceConfirmation(
  p: Promise<ConfirmationResolution | "timeout">,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<ConfirmationResolution | "timeout" | "aborted"> {
  return racePending(p, ms, signal)
}

/** Who answered a confirmation (v1 is single-user CLI; "web" is retained for the UI). */
export type ConfirmationActor = "cli" | "web"

interface PendingEntry<R, V> {
  record: R
  /** settles the promise returned by create()/wait(); removal from the map is the settled flag */
  settle: (v: V) => void
  resolution: Promise<V>
}

/**
 * One waiting registry: id → a record with an informational expiry, and a
 * promise only resolve() can settle. Expired entries are dropped lazily on
 * the next read (their promise stays pending forever — the outer race owns
 * the denial). Confirmations and questions are two instances of this one
 * shape; the per-kind payloads live in the record type.
 */
class PendingRegistry<R extends { expiresAt: string }, V> {
  readonly #entries = new Map<string, PendingEntry<R, V>>()

  /** Register a pending entry; returns the promise only resolve() can settle. */
  create(id: string, record: R): Promise<V> {
    let settle!: (v: V) => void
    const resolution = new Promise<V>((res) => {
      settle = res
    })
    this.#entries.set(id, { record, settle, resolution })
    return resolution
  }

  /** The promise behind create(). Unknown ids never settle — the caller's own timeout race owns the denial. */
  wait(id: string): Promise<V> {
    return this.#entries.get(id)?.resolution ?? new Promise<V>(() => {})
  }

  /** Read-only record snapshot; undefined for unknown/stale ids. */
  lookup(id: string): R | undefined {
    this.#prune()
    return this.#entries.get(id)?.record
  }

  /**
   * Settle with a value. True when a pending entry existed and settled NOW;
   * false for unknown ids, already-resolved entries, and stale (expired) ones.
   */
  resolve(id: string, v: V): boolean {
    this.#prune()
    const entry = this.#entries.get(id)
    if (entry === undefined) return false
    this.#entries.delete(id)
    entry.settle(v)
    return true
  }

  /** Drop the entry without a verdict: a late resolve observes "unknown id". */
  expire(id: string): void {
    this.#entries.delete(id)
  }

  /** Current records (pruned), e.g. for a listing endpoint. */
  pending(): R[] {
    this.#prune()
    return [...this.#entries.values()].map((e) => e.record)
  }

  #prune(): void {
    const now = Date.now()
    for (const [id, entry] of this.#entries) {
      if (Date.parse(entry.record.expiresAt) <= now) this.#entries.delete(id)
    }
  }
}

interface ConfirmationRecord {
  confirmationId: string
  toolCall: ToolCallBlock
  risk: "safe" | "sensitive"
  expiresAt: string
  sessionId?: string
}

interface QuestionRecord {
  questionId: string
  expiresAt: string
}

/**
 * ConfirmationBroker — the human side of the confirm gate.
 *
 * Responsibilities, deliberately narrow:
 * - `create` registers a pending entry keyed by the confirmationId the
 *   PERMISSION GATE issued (core ConfigPermissionGate mints `conf_*` ids and
 *   the loop echoes them in its confirmation.requested event); the entry
 *   carries the toolCall, risk and an expiresAt for a future HTTP list
 *   endpoint. Returns the promise only `resolve` can settle.
 * - `resolve` applies a human verdict arriving over the gateway (WS/CLI) and
 *   reports whether it settled a still-pending entry.
 * - `wait` is the resolver side the run assembly hands to the loop.
 *
 * What it deliberately does NOT do:
 * - It never emits confirmation.requested / confirmation.resolved: the LOOP
 *   emits both (core agent/loop.ts, right around its resolver await) and the
 *   assembly fans them onto the bus — a broker-side emission would be a
 *   duplicate on every wire.
 * - It runs NO internal timeout: the loop races the confirm timeout itself
 *   (and the assembly races the same one). When that outer race settles
 *   without a human verdict, the assembly calls `expire` so the entry goes
 *   stale and a LATE resolve returns false silently instead of acking a
 *   verdict nothing will act on. `pending()` additionally prunes entries
 *   whose expiresAt passed.
 *
 * A TWO-kind waiting registry:
 * confirmations (verdict → tool proceeds or is denied) and questions
 * (answers → the tool result the model reads). Both kinds are one
 * PendingRegistry instance each — same shape, same gateway path (the daemon
 * hands ws frames to one object). Events are still emitted by whoever awaits
 * (the loop for confirmations, the tool executor for questions); the broker
 * never emits.
 */
export class ConfirmationBroker {
  readonly #entries = new PendingRegistry<ConfirmationRecord, ConfirmationResolution>()
  readonly #questions = new PendingRegistry<QuestionRecord, QuestionResolution>()

  /**
   * Register a pending confirmation. `timeoutMs` only stamps the entry's
   * informational expiresAt — the surrounding loop owns the actual timeout.
   */
  create(
    confirmationId: string,
    toolCall: ToolCallBlock,
    risk: "safe" | "sensitive",
    timeoutMs: number,
    sessionId?: string,
  ): Promise<ConfirmationResolution> {
    return this.#entries.create(confirmationId, {
      confirmationId,
      toolCall,
      risk,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      sessionId,
    })
  }

  /**
   * The resolver side: the promise behind `create` for a registered id.
   * Unknown ids never settle — the loop's own timeout race owns the denial.
   */
  wait(confirmationId: string): Promise<ConfirmationResolution> {
    return this.#entries.wait(confirmationId)
  }

  /**
   * Read-only snapshot of a pending entry (toolCall + sessionId). Undefined
   * for unknown/stale ids.
   */
  lookup(confirmationId: string): { toolCall: ToolCallBlock; sessionId?: string } | undefined {
    const record = this.#entries.lookup(confirmationId)
    if (record === undefined) return undefined
    return { toolCall: record.toolCall, sessionId: record.sessionId }
  }

  /**
   * Apply a human verdict. True when a pending entry existed and settled NOW;
   * false for unknown ids, already-resolved entries, and stale (expired)
   * ones. `by` defaults to "cli" (v1 single-user; the field is retained for
   * the web UI).
   */
  resolve(confirmationId: string, decision: ConfirmationDecision, by: ConfirmationActor = "cli"): boolean {
    return this.#entries.resolve(confirmationId, { decision, by })
  }

  /**
   * Mark an entry stale without a verdict: the assembly calls this once its
   * race settled on timeout or abort, so a late gateway resolve can
   * only ever observe "unknown confirmation".
   */
  expire(confirmationId: string): void {
    this.#entries.expire(confirmationId)
  }

  /** Current pending entries as the wire payloads (for a future HTTP list endpoint). */
  pending(): ConfirmationRequestedPayload[] {
    return this.#entries.pending().map(({ confirmationId, toolCall, risk, expiresAt }) => ({
      confirmationId,
      toolCall,
      risk,
      expiresAt,
    }))
  }

  // ---- questions (ask_user_questions): same registry, answer instead of
  // verdict. The tool executor owns the timeout race (it created the entry);
  // a resolution that settles nothing returns false so a late gateway frame
  // reports "unknown question".

  /** Register a pending question; the promise settles only via resolveQuestion.
   * The asked questions themselves live on the question.requested event, not here. */
  createQuestion(questionId: string, timeoutMs: number): Promise<QuestionResolution> {
    return this.#questions.create(questionId, {
      questionId,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    })
  }

  /** Apply a human answer set. True when a pending question existed and settled NOW. */
  resolveQuestion(questionId: string, answers: string[][], by: ConfirmationActor = "cli"): boolean {
    return this.#questions.resolve(questionId, { answers, by })
  }

  /** Mark a question stale (timeout/abort settled the race without a human). */
  expireQuestion(questionId: string): void {
    this.#questions.expire(questionId)
  }
}
