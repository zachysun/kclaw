/**
 * HookChain — the single execution path every hook (builtin or user file)
 * runs through (spec issue #6).
 *
 * Semantics pinned here:
 * - Order: meta.order ascending, ties by meta.name (deterministic — rewrite
 *   chains depend on it).
 * - Rewrite positions (run-before / llm-before / system-after): a handler's
 *   non-undefined return REPLACES the ctx field the position rewrites (see
 *   REWRITE_FIELD below), so the next handler — and the loop's caller — sees
 *   the rewritten value. This is what keeps e.g. a user rewrite ahead of the
 *   builtin land step coherent: the land hook persists the rewritten message,
 *   not the original.
 * - Append positions (system-before): results are string[] SEGMENTS and
 *   accumulate across handlers — two hooks each contribute their paragraphs,
 *   none is lost.
 * - Observe positions ignore returns entirely.
 * - Failure (throw / timeout / non-async rejection): `failure: "fatal"` REJECTS
 *   the whole run() call — the loop's existing per-position catch paths own the
 *   terminal behavior (user_message_failed / steering_failed / entry-level
 *   failure), preserving each migrated behavior's old semantics exactly.
 *   `failure: "skip"` reports via `onFailure` and continues with the next
 *   handler (fail-open; user hooks are forced to skip at load time).
 * - Timeout: every handler is raced against `timeoutMs` (config
 *   hooks.timeoutMs, default 5s); a timeout is a failure with the same
 *   fatal/skip split.
 * - An empty position short-circuits: run() resolves undefined synchronously
 *   (zero cost when no hook is installed) and has() is false.
 */
import { makeEvent, type AgentEvent } from "../protocol/index.js"
import type {
  HookContextMap,
  HookEntry,
  HookPosition,
  HookResultMap,
  HookRunner,
} from "./types.js"

export const DEFAULT_HOOK_TIMEOUT_MS = 5_000

/**
 * The ctx field each rewrite position's result replaces (a shallow ctx copy is
 * mutated in the loop below — the caller's object is never touched).
 */
const REWRITE_FIELD: Partial<Record<HookPosition, string>> = {
  "run-before": "message",
  "llm-before": "messages",
  "system-after": "system",
}

/** Positions whose array results accumulate instead of replacing. */
const APPEND_POSITIONS: ReadonlySet<HookPosition> = new Set(["system-before"])

/** One reported failure (throw / timeout) of a skip-failure hook. */
export type HookFailureSink = (e: AgentEvent<"hook.failed">) => void

interface SortedEntry {
  entry: HookEntry
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface HookChainOptions {
  /** Per-handler time budget in ms (config hooks.timeoutMs; default 5s). */
  timeoutMs?: () => number
  /** Receives one hook.failed event per skip-failure (loader callers fan it onto the bus). */
  onFailure?: HookFailureSink
  /** Event context factory: sessionId/runId known mid-run; loader-phase failures have neither. */
  eventCtx?: () => { sessionId?: string; runId?: string }
}

export class HookChain implements HookRunner {
  readonly #byPosition = new Map<HookPosition, SortedEntry[]>()
  readonly #opts: HookChainOptions

  constructor(opts: HookChainOptions = {}) {
    this.#opts = opts
  }

  /** Register one handler (builtin closures and loader output take this same door). */
  register(entry: HookEntry): void {
    if (!entry.meta.enabled || entry.meta.error !== undefined) return
    const list = this.#byPosition.get(entry.meta.position) ?? []
    list.push({ entry, timer: undefined })
    list.sort((a, b) =>
      a.entry.meta.order !== b.entry.meta.order
        ? a.entry.meta.order - b.entry.meta.order
        : a.entry.meta.name < b.entry.meta.name ? -1 : 1,
    )
    this.#byPosition.set(entry.meta.position, list)
  }

  registerAll(entries: Iterable<HookEntry>): void {
    for (const e of entries) this.register(e)
  }

  has(position: HookPosition): boolean {
    return (this.#byPosition.get(position)?.length ?? 0) > 0
  }

  async run<K extends HookPosition>(position: K, ctx: HookContextMap[K]): Promise<HookResultMap[K] | undefined> {
    const list = this.#byPosition.get(position)
    if (list === undefined || list.length === 0) return undefined
    // A shallow copy: rewrite positions mutate THIS object (not the caller's)
    // as the rewrite chain's carrier.
    const invokeCtx: Record<string, unknown> = { ...ctx }
    let current: unknown = undefined
    for (const { entry } of list) {
      const outcome = await this.#invoke(entry, position, invokeCtx as HookContextMap[HookPosition])
      if (!outcome.ok) {
        if (entry.meta.failure === "fatal") throw outcome.error
        this.#report(entry, position, outcome.error)
        continue
      }
      if (outcome.value === undefined) continue
      if (APPEND_POSITIONS.has(position)) {
        // 追加型：段落累积（undefined/非数组结果不参与）
        current = Array.isArray(outcome.value)
          ? [...(Array.isArray(current) ? current as unknown[] : []), ...outcome.value as unknown[]]
          : outcome.value
        continue
      }
      current = outcome.value
      const field = REWRITE_FIELD[position]
      if (field !== undefined) invokeCtx[field] = outcome.value // 下一个 handler 看到改写值
    }
    return current as HookResultMap[K] | undefined
  }

  /** Invoke one handler under the timeout race; never throws. */
  async #invoke(
    entry: HookEntry,
    position: HookPosition,
    ctx: HookContextMap[HookPosition],
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
    const budget = this.#opts.timeoutMs?.() ?? DEFAULT_HOOK_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      if (budget <= 0 || !Number.isFinite(budget)) return
      timer = setTimeout(() => reject(new Error(`hook timed out after ${budget}ms`)), budget)
    })
    try {
      const value = await Promise.race([
        Promise.resolve((entry.handler as (c: unknown) => unknown)(ctx)),
        timeout,
      ])
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #report(entry: HookEntry, position: HookPosition, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`kclaw hook failed (${position}/${entry.meta.name}):`, message)
    this.#opts.onFailure?.(makeEvent("hook.failed", {
      hook: entry.meta.name,
      position,
      error: message,
      phase: "run",
    }, this.#opts.eventCtx?.() ?? {}))
  }
}
