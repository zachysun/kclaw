import type { ConfirmationDecision, ConfirmationRequestedPayload, QuestionSpec, ToolCallBlock } from "../protocol/index.js"

/**
 * Verdict value carried between the loop and its human resolver: the
 * persistence scope of the approval, or `timeout` when the outer race
 * denied it without a human. Approving decisions are every value but
 * `reject`/`timeout`; the scope itself is consumed ABOVE the broker
 * (the daemon persists decided rules from it).
 */
export type ConfirmationResolution = { decision: ConfirmationDecision | "timeout"; by: "cli" | "web" | "timeout" }

/** A human answer set for a pending question: one string array per asked question, in ask order.
 * `by` carries "timeout" only as the race sentinel — the gateway never settles a question with it. */
export type QuestionResolution = { answers: string[][]; by: "cli" | "web" | "timeout" }

/**
 * `Promise.race` against a timer AND an abort signal; the timer is cleared
 * and the listener removed once the race settles. An abort wins as the
 * sentinel "aborted" — kept distinct from the timeout fallback so an aborted
 * wait is never misreported as a timeout-deny.
 *
 * The SINGLE implementation for both racers that must agree on a
 * confirmation's outcome: the loop (waiting to act on the verdict) and the
 * run assembly (expiring the broker entry when the race settles without a
 * human). Formerly two verbatim-identical copies (loop vs assembly) kept in
 * sync by comments — unified as part of the hook-system migration.
 */
export function raceConfirmation(
  p: Promise<ConfirmationResolution>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<ConfirmationResolution | "aborted"> {
  return racePending(p, ms, signal, { decision: "timeout", by: "timeout" })
}

/** The value-type-generic core of raceConfirmation: questions race with an answer-shaped timeout sentinel. */
export function racePending<T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  timeoutValue: T,
): Promise<T | "aborted"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const sleep = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), ms)
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

/** Who answered a confirmation (v1 is single-user CLI; "web" is retained for the UI). */
export type ConfirmationActor = "cli" | "web"

interface PendingEntry {
  confirmationId: string
  toolCall: ToolCallBlock
  risk: "safe" | "sensitive"
  expiresAt: string
  sessionId?: string
  /** settles the promise returned by create()/wait(); removal from the map is the settled flag */
  settle: (r: ConfirmationResolution) => void
  resolution: Promise<ConfirmationResolution>
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
 * Relocated verbatim from server/src/confirm.ts (card ① engine relocation).
 *
 * Since the ask_user_questions tool (issue #21) this is a TWO-kind waiting
 * registry: confirmations (verdict → tool proceeds or is denied) and
 * questions (answers → the tool result the model reads). Both kinds share
 * the same shape — id → pending promise raced against a timeout and abort —
 * and the same gateway path (the daemon hands ws frames to one object), so
 * they live side by side in one class. Events are still emitted by whoever
 * awaits (the loop for confirmations, the tool executor for questions);
 * the broker never emits.
 */
export class ConfirmationBroker {
  readonly #entries = new Map<string, PendingEntry>()
  readonly #questions = new Map<string, PendingQuestion>()

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
    let settle!: (r: ConfirmationResolution) => void
    const resolution = new Promise<ConfirmationResolution>((res) => {
      settle = res
    })
    this.#entries.set(confirmationId, {
      confirmationId,
      toolCall,
      risk,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      sessionId,
      settle,
      resolution,
    })
    return resolution
  }

  /**
   * The resolver side: the promise behind `create` for a registered id.
   * Unknown ids never settle — the loop's own timeout race owns the denial.
   */
  wait(confirmationId: string): Promise<ConfirmationResolution> {
    const entry = this.#entries.get(confirmationId)
    return entry?.resolution ?? new Promise<ConfirmationResolution>(() => {})
  }

  /**
   * Read-only snapshot of a pending entry (toolCall + sessionId), for the
   * daemon to scope a decided-rule persistence BEFORE resolving: after
   * `resolve` the entry is gone. Undefined for unknown/stale ids.
   */
  lookup(confirmationId: string): { toolCall: ToolCallBlock; sessionId?: string } | undefined {
    this.#prune()
    const entry = this.#entries.get(confirmationId)
    if (entry === undefined) return undefined
    return { toolCall: entry.toolCall, sessionId: entry.sessionId }
  }

  /**
   * Apply a human verdict. True when a pending entry existed and settled NOW;
   * false for unknown ids, already-resolved entries, and stale (expired)
   * ones. `by` defaults to "cli" (v1 single-user; the field is retained for
   * the web UI).
   */
  resolve(confirmationId: string, decision: ConfirmationDecision, by: ConfirmationActor = "cli"): boolean {
    this.#prune()
    const entry = this.#entries.get(confirmationId)
    if (entry === undefined) return false
    this.#entries.delete(confirmationId)
    entry.settle({ decision, by })
    return true
  }

  /**
   * Mark an entry stale without a verdict: the assembly calls this once its
   * race settled on timeout or abort, so a late gateway resolve can
   * only ever observe "unknown confirmation".
   */
  expire(confirmationId: string): void {
    this.#entries.delete(confirmationId)
  }

  /** Current pending entries as the wire payloads (for a future HTTP list endpoint). */
  pending(): ConfirmationRequestedPayload[] {
    this.#prune()
    return [...this.#entries.values()].map(({ confirmationId, toolCall, risk, expiresAt }) => ({
      confirmationId,
      toolCall,
      risk,
      expiresAt,
    }))
  }

  /** Drop entries whose informational expiry passed (their promise stays pending forever). */
  #prune(): void {
    const now = Date.now()
    for (const [id, entry] of this.#entries) {
      if (Date.parse(entry.expiresAt) <= now) this.#entries.delete(id)
    }
    for (const [id, entry] of this.#questions) {
      if (Date.parse(entry.expiresAt) <= now) this.#questions.delete(id)
    }
  }

  // ---- questions (ask_user_questions): same registry shape, answer instead
  // of verdict. The tool executor owns the timeout race (it created the
  // entry); a resolution that settles nothing returns false so a late
  // gateway frame reports "unknown question".

  /** Register a pending question; the promise settles only via resolveQuestion. */
  createQuestion(
    questionId: string,
    questions: QuestionSpec[],
    timeoutMs: number,
    sessionId?: string,
  ): Promise<QuestionResolution> {
    let settle!: (r: QuestionResolution) => void
    const resolution = new Promise<QuestionResolution>((res) => {
      settle = res
    })
    this.#questions.set(questionId, {
      questionId,
      questions,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      ...(sessionId === undefined ? {} : { sessionId }),
      settle,
      resolution,
    })
    return resolution
  }

  /** Apply a human answer set. True when a pending question existed and settled NOW. */
  resolveQuestion(questionId: string, answers: string[][], by: ConfirmationActor = "cli"): boolean {
    this.#prune()
    const entry = this.#questions.get(questionId)
    if (entry === undefined) return false
    this.#questions.delete(questionId)
    entry.settle({ answers, by })
    return true
  }

  /** Mark a question stale (timeout/abort settled the race without a human). */
  expireQuestion(questionId: string): void {
    this.#questions.delete(questionId)
  }
}

interface PendingQuestion {
  questionId: string
  questions: QuestionSpec[]
  expiresAt: string
  sessionId?: string
  settle: (r: QuestionResolution) => void
  resolution: Promise<QuestionResolution>
}
