/**
 * Hook system types: the loop's anatomy as a CLOSED set of
 * named positions, one uniform handler signature, and per-position ctx /
 * result contracts.
 *
 * Layering: the position grid and the registry live here; builtin behaviors
 * (hooks/builtin/) and user files (hooks/loader.ts) both register through the
 * same chain (hooks/runner.ts). Nothing in this module imports the agent loop
 * — the loop depends on these types, never the reverse.
 */
import type { Message, ThinkingBlock, ToolCallBlock, ToolResultBlock } from "../protocol/index.js"
import type { ProviderMessage } from "../provider/types.js"
import type { ActiveSummary } from "../session/compaction.js"

/**
 * The position grid — every named seam on the run timeline. Closed union:
 * adding a position updates the ctx/result maps below and the compiler walks
 * every consumer through exhaustiveness.
 *
 * Rewriting positions (user hooks may return a replacement value):
 * run-before / llm-before / system-before / system-after. Everything else is
 * observe (return value ignored) or a builtin-only decision slot
 * (compaction-check / overflow-rescue: user hooks are not registered there).
 */
export type HookPosition =
  | "run-before"
  | "run-after"
  | "llm-before"
  | "llm-after"
  | "llm-retry"
  | "tool-before"
  | "tool-after"
  | "turn-boundary"
  | "compaction-check"
  | "overflow-rescue"
  | "compaction-after"
  | "think-after"
  | "system-before"
  | "system-after"

/** Per-position context handed to handlers — pure data, never engine handles. */
export interface HookContextMap {
  /** 用户消息入场（message.created 与 completed 之间）。返回 Message = 改写生效。 */
  "run-before": { message: Message }
  /** run 结束（runAgent 已返回）。返回值忽略。 */
  "run-after": {
    outcome: { stopReason: string; totalUsage: { inputTokens: number; outputTokens: number } }
    model: string
  }
  /** 每次 LLM 调用前（模型视图已装配）。返回 ProviderMessage[] = 改写生效。 */
  "llm-before": { messages: ProviderMessage[] }
  /** 一次 LLM 调用完成。返回值忽略。 */
  "llm-after": { usage: { inputTokens: number; outputTokens: number }; stopReason: string; latencyMs: number }
  /** provider 层重试（withRetry 回调）。返回值忽略。 */
  "llm-retry": { attempt: number; error: string }
  /** 工具执行前、权限裁决之前。观察位；声明 failure:"deny" 的钩子失败时本次调用被拒绝（fail-closed 自选档）。返回值忽略。 */
  "tool-before": { toolCall: ToolCallBlock }
  /** 单个工具执行完成后。返回值忽略。 */
  "tool-after": { toolCall: ToolCallBlock; result: ToolResultBlock }
  /** 迭代边界（一轮工具结束、下一轮 LLM 前）。返回 Message[] = 注入。 */
  "turn-boundary": Record<string, never>
  /** 迭代边界中途压缩判定（内置独占）。返回 ActiveSummary = 压缩后的新视图。 */
  "compaction-check": Record<string, never>
  /** 上下文溢出急救（内置独占）。返回 ActiveSummary = 换视图整次重发。 */
  "overflow-rescue": { error: string }
  /** 一次压缩完成后。返回值忽略。 */
  "compaction-after": { phase: "in-run" | "post-run" | "manual"; result: "ok" | "failed" | "cancelled" }
  /** 思考块完成后。返回值忽略。 */
  "think-after": { block: ThinkingBlock }
  /** 系统提示词组装前。返回 string[] = 追加的段落（按序拼接在 base 之后）。 */
  "system-before": { base: string }
  /** 系统提示词终稿（审计之前）。返回 string = 终稿改写生效。 */
  "system-after": { system: string }
}

/** Per-position result semantics: undefined = untouched / nothing to say. */
export type HookResultMap = {
  "run-before": Message
  "run-after": void
  "llm-before": ProviderMessage[]
  "llm-after": void
  "llm-retry": void
  "tool-before": void
  "tool-after": void
  "turn-boundary": Message[]
  "compaction-check": ActiveSummary | null
  "overflow-rescue": ActiveSummary | null
  "compaction-after": void
  "think-after": void
  "system-before": string[]
  "system-after": string
}

/** Self-declared metadata — the same shape for builtin and file hooks. */
export interface HookMeta {
  /** Builtin: feature name; user: file basename (identity, shown in管理面). */
  name: string
  position: HookPosition
  description?: string
  enabled: boolean
  /** Ascending execution order within a position; ties break by name. */
  order: number
  /**
   * Failure policy, self-declared by the hook:
   * - "fatal": a throw propagates through run() (builtin-only; the loader
   *   rejects user declarations) — the loop's existing per-position failure
   *   paths own the terminal behavior.
   * - "skip": fail-open — the failure is reported (hook.failed) and the
   *   chain continues without this hook.
   * - "deny": fail-closed by choice — the failure is reported AND, at a
   *   gate position (tool-before), vetoes the gated operation.
   */
  failure: "fatal" | "skip" | "deny"
  origin: "builtin" | "user"
  /**
   * Per-entry time budget override (ms). undefined = the chain default
   * (config hooks.timeoutMs, 5s); Infinity = untimed. The compaction
   * builtins (mid-run-panic / overflow-emergency / post-run-compaction)
   * declare Infinity: their work is two provider calls whose duration is
   * the LLM's — bounded by the provider per-request timeout and the run's
   * abort signal — which is exactly the pre-migration inline behavior
   * (a 5s race here made every real compaction time out and orphan a
   * background duplicate).
   */
  timeoutMs?: number
  /** Load failure reason (user hooks only); a failed entry never runs. */
  error?: string
}

/** File-level module contract (user hooks): metadata export + default handler. */
export interface HookModule {
  hook: {
    position: HookPosition
    description?: string
    enabled?: boolean
    order?: number
    /**
     * "skip" (default) or "deny" are accepted; "fatal" is typed here because
     * a js file may declare it — the loader rejects it at load time.
     */
    failure?: "skip" | "deny" | "fatal"
  }
  default: (ctx: never) => unknown
}

export interface HookEntry {
  meta: HookMeta
  handler: (ctx: never) => unknown
}

/** What the loop talks to — and the only hook surface it knows. */
export interface HookRunner {
  /** Runs the position's enabled chain; resolves with the last rewrite or undefined. */
  run<K extends HookPosition>(position: K, ctx: HookContextMap[K]): Promise<HookResultMap[K] | undefined>
  /**
   * Gate positions (tool-before): like run, but a failing hook that declared
   * `failure: "deny"` vetoes the gated operation instead of being skipped.
   * The chain still runs to completion (later observers see the failure);
   * the FIRST denial is reported.
   */
  runGate<K extends HookPosition>(position: K, ctx: HookContextMap[K]): Promise<GateOutcome>
  /** True when the position has at least one enabled, successfully-loaded handler. */
  has(position: HookPosition): boolean
}

/** runGate's verdict: denied carries the first deny-declared failure. */
export type GateOutcome = { denied: false } | { denied: true; hook: string; error: string }

/** Uniform per-position ctx/result typing for implementors of HookRunner. */
export type HookHandlerOf<K extends HookPosition> = (
  ctx: HookContextMap[K],
) => Promise<HookResultMap[K] | undefined> | HookResultMap[K] | undefined
