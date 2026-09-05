/** The position grid as a runtime value — mirrors HookContextMap's keys. */
export const HOOK_POSITIONS = [
  "run-before",
  "run-after",
  "llm-before",
  "llm-after",
  "llm-retry",
  "tool-before",
  "tool-after",
  "turn-boundary",
  "compaction-check",
  "overflow-rescue",
  "compaction-after",
  "think-after",
  "system-before",
  "system-after",
] as const satisfies readonly import("./types.js").HookPosition[]
