/**
 * In-process notification for config-section changes: the mutating routes
 * publish after they persist, and long-lived consumers (the provider client
 * resolver) subscribe so their caches follow the live config. Typed by
 * section rather than a free-form string so publishers and subscribers
 * agree on the vocabulary; sections beyond "providers" are reserved slots
 * for the other config-backed subsystems (mcp, channels) to adopt.
 *
 * Synchronous and fire-and-forget: a publish never fails and one broken
 * listener never blocks the others (each listener is isolated, the same
 * convention as the event bus).
 */
export type ConfigSection = "providers" | "mcp" | "channels"

export interface ConfigNotifier {
  /** Announce that the section changed (after the in-memory mutation is live). */
  publish(section: ConfigSection): void
  /** Listen for changes to a section; returns the unsubscribe function. */
  subscribe(section: ConfigSection, listener: () => void): () => void
}

export function createConfigNotifier(): ConfigNotifier {
  const listeners = new Map<ConfigSection, Set<() => void>>()
  return {
    publish(section: ConfigSection): void {
      for (const listener of listeners.get(section) ?? []) {
        try {
          listener()
        } catch (e) {
          console.error(`kclaw config: ${section} change listener failed: ${(e as Error).message}`)
        }
      }
    },
    subscribe(section: ConfigSection, listener: () => void): () => void {
      let set = listeners.get(section)
      if (set === undefined) {
        set = new Set()
        listeners.set(section, set)
      }
      const settled = set
      settled.add(listener)
      return () => {
        settled.delete(listener)
      }
    },
  }
}
