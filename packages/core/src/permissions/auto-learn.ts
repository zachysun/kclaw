/**
 * AutoLearnCounter — the auto mode's induction bookkeeping.
 *
 * In `auto` mode, when a human keeps approving the SAME operation via the
 * `once` verdict, the mode inducts it into a decided rule after N consecutive
 * approvals (instead of waiting for the human to pick "always allow").
 *
 * This counter tracks those streaks: per key (the run assembly scopes it per
 * session — `sessionId\n` + the narrowed-rule shape `narrowDecidedRule`
 * produces: exec first word + prefix, fs realpath exact path), `approve()`
 * advances the streak and returns true exactly once when it crosses the
 * threshold (caller persists the rule; the streak resets). Any rejection or
 * TIMEOUT on the same key resets it — a "no" is an explicit signal and must
 * never be overwritten by older approvals.
 *
 * One instance per daemon process (the server wires it through the run
 * manager); a daemon restart clears all streaks, which is acceptable for v1 —
 * cross-session persistence is a documented follow-up. Session isolation is
 * the CALLER's job (the key carries the session id).
 */
export class AutoLearnCounter {
  readonly #threshold: number
  readonly #counts = new Map<string, number>()

  /** threshold <= 0 disables induction entirely (approve() never fires). */
  constructor(threshold: number) {
    this.#threshold = threshold
  }

  /** One human `once` approval for `key`; true when it just crossed the threshold. */
  approve(key: string): boolean {
    if (this.#threshold <= 0) return false
    const next = (this.#counts.get(key) ?? 0) + 1
    if (next >= this.#threshold) {
      this.#counts.delete(key)
      return true
    }
    this.#counts.set(key, next)
    return false
  }

  /** Any rejection (reject / timeout) on `key` resets its streak. */
  reject(key: string): void {
    this.#counts.delete(key)
  }

  /** Number of live streaks (exposed for tests/diagnostics). */
  size(): number {
    return this.#counts.size
  }
}
