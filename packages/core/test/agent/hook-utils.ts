/**
 * Shared helpers for loop tests under the hook system (spec issue #6): the
 * loop only knows positions, so tests install test behaviors by registering
 * entries on a HookChain instead of passing per-behavior deps fields.
 */
import { HookChain } from "../../src/hooks/runner.js"
import type { HookContextMap, HookEntry, HookPosition } from "../../src/hooks/types.js"

/** One test hook entry; defaults mirror builtin semantics (fatal, order 10). */
export function hook<K extends HookPosition>(
  name: string,
  position: K,
  handler: (ctx: HookContextMap[K]) => unknown,
  opts: { failure?: "fatal" | "skip"; order?: number; enabled?: boolean } = {},
): HookEntry {
  return {
    meta: {
      name,
      position,
      enabled: opts.enabled ?? true,
      order: opts.order ?? 10,
      failure: opts.failure ?? "fatal",
      origin: "builtin",
    },
    handler: handler as HookEntry["handler"],
  }
}

/** A HookChain with the given entries and no per-handler timeout (tests control hangs explicitly). */
export function chainOf(...entries: HookEntry[]): HookChain {
  const chain = new HookChain({ timeoutMs: () => Number.POSITIVE_INFINITY })
  chain.registerAll(entries)
  return chain
}
