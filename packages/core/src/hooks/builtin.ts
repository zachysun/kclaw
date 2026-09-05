/**
 * Builtin hooks (spec issue #6) — the one-shot migration of the engine's
 * formerly-hardcoded loop behaviors onto the position grid. Every builtin is
 * the same shape as a user hook file (metadata + handler) and registers
 * through the same HookChain; the only difference is that these close over
 * run resources and may declare `failure: "fatal"` where the old inline code
 * propagated throws.
 *
 * Zero-behavior-change contract (verified by the existing suite):
 * wire order, failure semantics and error codes of every migrated behavior
 * match its pre-migration form exactly. Notable orderings:
 * - run-before: memory-inject(10) → user-message-land(20, fatal: persist +
 *   note.emitted — wire order created → note.emitted ×N → completed) →
 *   autoname(30, fire-and-forget).
 * - system-after: user hooks (default order 1000, rewrite the final draft)
 *   run BEFORE system-audit(9000, fatal: appendSystem), so the audit always
 *   captures what the model will actually see.
 * - The two compaction decision hooks (mid-run panic / overflow emergency)
 *   keep their old "throw == decline" semantics via failure: "skip" (a failed
 *   decision resolves to undefined, which the loop treats as "don't
 *   compact"), and post-run-compaction stays fatal (its old throw propagated
 *   to the queue's entry-level failure).
 */
import { newBlockId } from "../protocol/blocks.js"
import type { NoteBlock } from "../protocol/blocks.js"
import { makeEvent, type AgentEvent } from "../protocol/index.js"
import type { Message } from "../protocol/messages.js"
import type { LlmClient } from "../provider/types.js"
import { estimateContextTokens, type ActiveSummary } from "../session/compaction.js"
import { scheduleAutoname } from "../session/autoname.js"
import type { SessionStore } from "../session/store.js"
import type { Compactor } from "../session/compactor.js"
import type { KclawConfig } from "../storage/config.js"
import type { MemoryQuery, MemoryScheduleBook } from "../memory/system.js"
import type { UsageStore } from "../storage/usage.js"
import { withLastUserText } from "../agent/context.js"
import type { HookEntry, HookContextMap, HookPosition, HookResultMap } from "./types.js"

/** How many chars of the user text feed the memory lookup (run-assembly parity). */
const MEMORY_QUERY_CHARS = 200
/** Top-N memory notes injected onto the user message. */
const MEMORY_LIMIT = 5

/** Per-run resources the builtin closures capture. */
export interface BuiltinHookDeps {
  sessionId: string
  sessions: SessionStore
  memory: MemoryQuery & Pick<MemoryScheduleBook, "scheduleFollowCheck">
  config: KclawConfig
  workspace: string
  compactor: Compactor
  signal: AbortSignal
  runLlm: LlmClient
  model: string
  usageStore?: UsageStore
  /** bus fan-out with its swallow-guard (the assembly's busEmit). */
  busEmit: (e: AgentEvent) => void
  /** runId becomes known after run.started; closures read it lazily. */
  runIdRef: { current?: string }
  // user-message-land / autoname inputs (former onUserMessage closure state)
  jobNotes: NoteBlock[]
  trigger: "user" | "job"
  // skill-wrap input (former mapLlmMessages closure state)
  llmUserText: string | undefined
  // steering input (former AgentDeps.steering)
  drainSteer: () => Message[]
  // system-materials input: the model-facing skill listing (per-run scan)
  skillList: string
  // compaction-after wiring: the factory calls back into the run's chain
  compactionAfter: (phase: "in-run" | "post-run" | "manual", result: "ok" | "failed" | "cancelled") => Promise<void>
}

/** Static builtin specs for the management plane (positions + copy). */
export const BUILTIN_HOOK_SPECS: ReadonlyArray<{
  name: string
  position: HookPosition
  description: string
  failure: "fatal" | "skip"
}> = [
  { name: "memory-inject", position: "run-before", description: "检索记忆库并把相关经历挂为用户消息的 note", failure: "skip" },
  { name: "user-message-land", position: "run-before", description: "补齐任务来源 note 并持久化用户消息", failure: "fatal" },
  { name: "autoname", position: "run-before", description: "新会话首条消息的后台自动命名", failure: "skip" },
  { name: "skill-wrap", position: "llm-before", description: "技能点名的隐式包装（只改发给模型的视图）", failure: "skip" },
  { name: "retry-notify", position: "llm-retry", description: "把 provider 重试转成 llm.failed(willRetry) 事件", failure: "skip" },
  { name: "steering-drain", position: "turn-boundary", description: "取走队列的引导缓冲并注入对话", failure: "fatal" },
  { name: "mid-run-panic", position: "compaction-check", description: "红线水位的迭代边界中途压缩判定", failure: "skip" },
  { name: "overflow-emergency", position: "overflow-rescue", description: "上下文溢出的急救压缩（换视图整次重发）", failure: "skip" },
  { name: "usage-ledger", position: "run-after", description: "记录本次 run 的 token 用量台账", failure: "skip" },
  { name: "post-run-compaction", position: "run-after", description: "黄线水位触发的收尾压缩", failure: "fatal" },
  { name: "follow-check", position: "run-after", description: "挂起记忆空闲检查（调度器补查）", failure: "skip" },
  { name: "system-materials", position: "system-before", description: "收集认知与技能列表两个提示词段", failure: "skip" },
  { name: "system-audit", position: "system-after", description: "系统提示词全量审计留痕（写失败即 run 失败）", failure: "fatal" },
]

/** Build this run's builtin chain entries (closures over run resources). */
export function makeBuiltinHooks(deps: BuiltinHookDeps): HookEntry[] {
  const {
    sessionId, sessions, memory, config, workspace, compactor, signal,
    runLlm, model, usageStore, busEmit, runIdRef, jobNotes, trigger,
    llmUserText, drainSteer, skillList, compactionAfter,
  } = deps
  const budget = config.sessions.contextTokens ?? 128_000
  const atRatio = config.sessions.compactAtRatio ?? 0.66
  const panicRatio = config.sessions.compactPanicRatio ?? 0.85
  const runCtx = () => (runIdRef.current === undefined ? { sessionId } : { sessionId, runId: runIdRef.current })
  const memoryNotes: NoteBlock[] = []

  const builtin = <K extends HookPosition>(
    name: string, position: K, order: number, description: string,
    failure: "fatal" | "skip",
    handler: (ctx: HookContextMap[K]) => Promise<HookResultMap[K] | undefined | void> | HookResultMap[K] | undefined | void,
  ): HookEntry => ({
    meta: { name, position, description, enabled: true, order, failure, origin: "builtin" },
    handler: handler as HookEntry["handler"],
  })

  return [
    builtin("memory-inject", "run-before", 10, BUILTIN_HOOK_SPECS[0]!.description, "skip", async ({ message }) => {
      // Memory is an accelerator: a failing search never blocks the run.
      // Notes are COLLECTED here, not pushed onto the message: the land step
      // (order 20) appends job notes first, then these — preserving the
      // pre-migration block order (text → job → memory) and the matching
      // note.emitted order.
      try {
        for (const hit of await memory.searchEpisodes(workspace, textOf(message).slice(0, MEMORY_QUERY_CHARS), MEMORY_LIMIT)) {
          memoryNotes.push({ id: newBlockId(), type: "note", kind: "memory", text: `相关经历（${hit.title}）: ${hit.text}` })
        }
      } catch {
        // ignore: run without memory context
      }
    }),
    builtin("user-message-land", "run-before", 20, BUILTIN_HOOK_SPECS[1]!.description, "fatal", ({ message }) => {
      // Notes become part of the message BEFORE it is persisted and
      // completed; persist first, then announce — wire order stays
      // created → note.emitted ×N → completed, job notes before memory notes.
      message.blocks.push(...jobNotes, ...memoryNotes)
      sessions.appendMessage(sessionId, message)
      const noteCtx = runCtx()
      for (const block of [...jobNotes, ...memoryNotes]) {
        busEmit(makeEvent("note.emitted", { messageId: message.id, block }, noteCtx))
      }
      return message
    }),
    builtin("autoname", "run-before", 30, BUILTIN_HOOK_SPECS[2]!.description, "skip", ({ message }) => {
      if (trigger === "job") return
      void scheduleAutoname(
        { sessions, llm: runLlm, model, emit: busEmit },
        sessionId, textOf(message),
      )
    }),
    builtin("skill-wrap", "llm-before", 10, BUILTIN_HOOK_SPECS[3]!.description, "skip", ({ messages }) => {
      // Implicit wrap of named skills: only the provider view is rewritten —
      // persistence, events and the chat bubble keep the user's raw text.
      return llmUserText === undefined ? undefined : withLastUserText(messages, llmUserText)
    }),
    builtin("retry-notify", "llm-retry", 10, BUILTIN_HOOK_SPECS[4]!.description, "skip", ({ attempt, error }) => {
      busEmit(makeEvent("llm.failed", {
        error: { code: "llm_retry", message: error },
        willRetry: true,
      }, runCtx()))
    }),
    builtin("steering-drain", "turn-boundary", 10, BUILTIN_HOOK_SPECS[5]!.description, "fatal", () => {
      return drainSteer()
    }),
    builtin("mid-run-panic", "compaction-check", 10, BUILTIN_HOOK_SPECS[6]!.description, "skip", async () => {
      // Cancellation marker or an already-aborted run → don't compact; below
      // the red line → don't compact. A throw resolves undefined == decline.
      if (compactor.cancelled(sessionId) || signal.aborted) return null
      const boundaryHistory = sessions.readMessages(sessionId)
      if (estimateContextTokens(boundaryHistory) < budget * panicRatio) return null
      const next = await compactor.auto(sessionId, boundaryHistory, config, runLlm, model, {
        phase: "in-run",
        signal,
      })
      void compactionAfter("in-run", "ok")
      return next
    }),
    builtin("overflow-emergency", "overflow-rescue", 10, BUILTIN_HOOK_SPECS[7]!.description, "skip", async () => {
      // No watermark check — "it already overflowed" is a fact. Abort after
      // the await → null (the resend would be torn down at the next
      // checkpoint anyway).
      const next = await compactor.auto(sessionId, sessions.readMessages(sessionId), config, runLlm, model, {
        phase: "in-run",
        emergency: true,
        signal,
      })
      void compactionAfter("in-run", "ok")
      return signal.aborted ? null : next
    }),
    builtin("usage-ledger", "run-after", 10, BUILTIN_HOOK_SPECS[8]!.description, "skip", ({ outcome }) => {
      if (usageStore === undefined) return
      try {
        usageStore.record({
          sessionId,
          runId: runIdRef.current ?? "",
          model,
          inputTokens: outcome.totalUsage.inputTokens,
          outputTokens: outcome.totalUsage.outputTokens,
          at: new Date().toISOString(),
        })
      } catch (err) {
        console.error("kclaw usage record failed:", err)
      }
    }),
    builtin("post-run-compaction", "run-after", 20, BUILTIN_HOOK_SPECS[9]!.description, "fatal", async ({ outcome }) => {
      // aborted/error runs are not finalized (the former is being torn down,
      // the latter just failed); the cancellation marker suppresses a
      // user-cancelled compaction for this run.
      if (outcome.stopReason === "aborted" || outcome.stopReason === "error" || compactor.cancelled(sessionId)) return
      const postRunHistory = sessions.readMessages(sessionId)
      if (estimateContextTokens(postRunHistory) < budget * atRatio) return
      await compactor.auto(sessionId, postRunHistory, config, runLlm, model, {
        phase: "post-run",
        signal,
      })
      void compactionAfter("post-run", "ok")
    }),
    builtin("follow-check", "run-after", 30, BUILTIN_HOOK_SPECS[10]!.description, "skip", () => {
      if (config.memory.write.idleMinutes > 0) {
        try {
          memory.scheduleFollowCheck?.(sessionId, new Date().toISOString())
        } catch {
          // a failed follow-gate schedule never affects the run
        }
      }
    }),
    builtin("system-materials", "system-before", 10, BUILTIN_HOOK_SPECS[11]!.description, "skip", () => {
      // Cognition injection failure is silently skipped (run proceeds with
      // base prompt only) — pre-migration parity.
      let cognition = ""
      try {
        cognition = memory.cognitionPrompt(workspace)
      } catch {
        // 认知注入失败静默跳过
      }
      return [cognition, skillList].filter((s) => s !== "")
    }),
    builtin("system-audit", "system-after", 9000, BUILTIN_HOOK_SPECS[12]!.description, "fatal", ({ system }) => {
      // Exactly one full-text audit event per run — steer injections and
      // in-run LLM calls reuse the same prompt. No phantom-session guard
      // (parity with message writes) and no swallowing: a failed write fails
      // the run (the queue's entry-level failure catches it).
      sessions.appendSystem(sessionId, { at: new Date().toISOString(), text: system })
    }),
  ]
}

function textOf(m: Message): string {
  return m.blocks.find((b) => b.type === "text")?.text ?? ""
}
