/**
 * Builtin hooks — the one-shot migration of the engine's
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
 * - system-audit is NOT a hook: the run assembly appends the two-segment
 *   audit record itself (the split freeze needs the stable/live segments,
 *   which live above the chain). User system-after hooks rewrite the draft;
 *   a rewrite is frozen as the stable baseline by the assembly.
 * - The compaction hooks branch on the Compactor's named CompactionOutcome
 *   (applied/declined/failed/cancelled) and forward the truth to the
 *   compaction-after chain; a failed compaction is announced by its
 *   completed event and never fails the run (failure: "skip" everywhere).
 *   Every compaction hook runs UNTIMED (meta.timeoutMs = Infinity): its
 *   body is two provider calls whose duration is the LLM's — a timed hook
 *   would cut real compactions off and orphan a background duplicate that
 *   races the next boundary's second attempt.
 *
 * Single source of truth: every builtin is declared ONCE in
 * BUILTIN_HOOK_SPECS (metadata + a handler factory bound to the run's
 * runtime). The management-plane list (BUILTIN_HOOK_DEFINITIONS) is projected
 * from it and makeBuiltinHooks builds the chain entries from it — the two
 * can never drift apart (an index shift once silently mispaired a hook with
 * another's description after an entry was removed).
 */
import { newBlockId } from "../protocol/blocks.js"
import type { NoteBlock } from "../protocol/blocks.js"
import { makeEvent, type AgentEvent } from "../protocol/index.js"
import type { Message } from "../protocol/messages.js"
import type { LlmClient } from "../provider/types.js"
import { estimateContextTokens, type ActiveSummary } from "../session/compaction.js"
import type { CompactionOutcome } from "../session/compactor.js"
import type { Waterlines } from "../session/waterlines.js"
import { scheduleAutoname } from "../session/autoname.js"
import type { SessionStore } from "../session/store.js"
import type { Compactor } from "../session/compactor.js"
import type { KclawConfig } from "../storage/config.js"
import type { MemoryQuery, MemoryScheduleBook } from "../memory/system.js"
import { resolveEvolutionGate, type SkillEvolutionScheduleBook } from "../skills/evolution.js"
import type { UsageStore } from "../storage/usage.js"
import { withLastUserText } from "../agent/context.js"
import type { HookEntry, HookContextMap, HookPosition, HookResultMap } from "./types.js"

/** How many chars of the user text feed the memory lookup (run-assembly parity). */
const MEMORY_QUERY_CHARS = 200
/** Top-N memory notes injected onto the user message. */
const MEMORY_LIMIT = 5

/**
 * Forward a compaction outcome to the compaction-after chain: applied/
 * failed/cancelled under their own name, declined silently — nothing
 * happened, matching the event stream where neither started nor completed
 * fired.
 */
function forwardOutcome(
  compactionAfter: BuiltinHookDeps["compactionAfter"],
  phase: "in-run" | "post-run" | "manual",
  outcome: CompactionOutcome,
): void {
  if (outcome.status === "applied") void compactionAfter(phase, "ok")
  else if (outcome.status === "failed") void compactionAfter(phase, "failed")
  else if (outcome.status === "cancelled") void compactionAfter(phase, "cancelled")
}

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
  /**
   * Waterline thresholds resolved once for this run's budget (absolute token
   * values from resolveWaterlines): compaction trigger decisions read this
   * instead of re-deriving from config, so a per-model contextWindow tightens
   * them too. `.budget` is the same budget the compactor calls receive.
   */
  waterlines: Waterlines
  usageStore?: UsageStore
  /** bus fan-out with its swallow-guard (the assembly's busEmit). */
  busEmit: (e: AgentEvent) => void
  /** runId becomes known after run.started; closures read it lazily. */
  runIdRef: { current?: string }
  // user-message-land / autoname inputs (former onUserMessage closure state):
  // machine-originated provenance notes (job / subagent) riding the input message
  inputNotes: NoteBlock[]
  trigger: "user" | "job" | "agent" | "team"
  /**
   * Subagent child run (the session's parentSessionId is set): the run is a
   * dispatched executor's only turn — memory injection, autoname, the follow
   * gate and system materials (cognition + skill list) all skip; the usage
   * ledger records under the PARENT session (usageSessionId).
   */
  childRun?: boolean
  /** Session the usage ledger attributes this run's tokens to (child → parent). */
  usageSessionId?: string
  // skill-wrap input (former mapLlmMessages closure state)
  llmUserText: string | undefined
  // steering input (former AgentDeps.steering)
  drainSteer: () => Message[]
  // system-materials input: the model-facing skill listing (per-run scan)
  skillList: string
  /** 本次 run 技能扫描的目录名集合（skill-follow-check 粗查的 /记号 匹配集）。 */
  skillNames?: readonly string[]
  /**
   * 技能进化的调度簿记面（提案制）：在位且 config.skills.evolution 开启时，
   * skill-follow-check（run-after 40）做零成本粗查，卷入技能才排空闲检查。
   */
  skillsEvolution?: SkillEvolutionScheduleBook
  /**
   * Fixed per-request overhead in estimated tokens (assembled system prompt +
   * wire tool schemas). Lazy getter: hooks register before the system prompt
   * is assembled and only read this when they fire.
   */
  contextOverhead: () => number
  // compaction-after wiring: the factory calls back into the run's chain
  compactionAfter: (phase: "in-run" | "post-run" | "manual", result: "ok" | "failed" | "cancelled") => Promise<void>
}

/**
 * HookRuntime — the deps plus the cheap per-run derivations the handlers
 * used to close over from the factory scope. Each spec's handler factory
 * destructures what it needs.
 */
interface HookRuntime extends BuiltinHookDeps {
  childRun: boolean
  usageSessionId: string
  runCtx: () => { sessionId: string; runId?: string }
  /** Notes collected by memory-inject(10), appended by user-message-land(20). */
  memoryNotes: NoteBlock[]
}

/** One builtin hook: metadata + a handler factory bound to the run's runtime. */
interface BuiltinHookSpec<K extends HookPosition> {
  name: string
  position: K
  order: number
  description: string
  failure: "fatal" | "skip"
  timeoutMs?: number
  makeHandler: (
    rt: HookRuntime,
  ) => (ctx: HookContextMap[K]) => Promise<HookResultMap[K] | undefined | void> | HookResultMap[K] | undefined | void
}

/** Position-widened spec as stored in the array (ctx typing already checked per-spec). */
type AnyBuiltinHookSpec = Omit<BuiltinHookSpec<HookPosition>, "makeHandler"> & {
  makeHandler: (rt: HookRuntime) => HookEntry["handler"]
}

/** Keeps each spec's ctx type tied to its position literal at the declaration site. */
function spec<K extends HookPosition>(s: BuiltinHookSpec<K>): AnyBuiltinHookSpec {
  return { ...s, makeHandler: s.makeHandler as AnyBuiltinHookSpec["makeHandler"] }
}

const BUILTIN_HOOK_SPECS: ReadonlyArray<AnyBuiltinHookSpec> = [
  spec({
    name: "memory-inject",
    position: "run-before",
    order: 10,
    description: "检索记忆库并把相关经历挂为用户消息的 note",
    failure: "skip",
    makeHandler: (rt) => {
      const { childRun, memory, workspace, memoryNotes } = rt
      return async ({ message }) => {
        // Memory is an accelerator: a failing search never blocks the run.
        // Subagent children carry no memory materials (Q7: 记忆隔离).
        if (childRun) return
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
      }
    },
  }),
  spec({
    name: "user-message-land",
    position: "run-before",
    order: 20,
    description: "补齐任务来源 note 并持久化用户消息",
    failure: "fatal",
    makeHandler: (rt) => {
      const { inputNotes, memoryNotes, sessions, sessionId, runCtx, busEmit } = rt
      return ({ message }) => {
        // Notes become part of the message BEFORE it is persisted and
        // completed; persist first, then announce — wire order stays
        // created → note.emitted ×N → completed, job notes before memory notes.
        message.blocks.push(...inputNotes, ...memoryNotes)
        sessions.appendMessage(sessionId, message)
        const noteCtx = runCtx()
        for (const block of [...inputNotes, ...memoryNotes]) {
          busEmit(makeEvent("note.emitted", { messageId: message.id, block }, noteCtx))
        }
        return message
      }
    },
  }),
  spec({
    name: "autoname",
    position: "run-before",
    order: 30,
    description: "新会话首条消息的后台自动命名",
    failure: "skip",
    makeHandler: (rt) => {
      const { trigger, sessions, runLlm, model, busEmit, sessionId } = rt
      return ({ message }) => {
        // Only human-sent turns autoname: job notes are daemon-composed and
        // subagent children get their title at spawn time (label/task).
        if (trigger !== "user") return
        void scheduleAutoname(
          { sessions, llm: runLlm, model, emit: busEmit },
          sessionId, textOf(message),
        )
      }
    },
  }),
  spec({
    name: "skill-wrap",
    position: "llm-before",
    order: 10,
    description: "技能点名的隐式包装（只改发给模型的视图）",
    failure: "skip",
    makeHandler: (rt) => {
      const { llmUserText } = rt
      return ({ messages }) => {
        // Implicit wrap of named skills: only the provider view is rewritten —
        // persistence, events and the chat bubble keep the user's raw text.
        return llmUserText === undefined ? undefined : withLastUserText(messages, llmUserText)
      }
    },
  }),
  spec({
    name: "retry-notify",
    position: "llm-retry",
    order: 10,
    description: "把 provider 重试转成 llm.failed(willRetry) 事件",
    failure: "skip",
    makeHandler: (rt) => {
      const { busEmit, runCtx } = rt
      return ({ attempt, error }) => {
        busEmit(makeEvent("llm.failed", {
          error: { code: "llm_retry", message: error },
          willRetry: true,
        }, runCtx()))
      }
    },
  }),
  spec({
    name: "steering-drain",
    position: "turn-boundary",
    order: 10,
    description: "取走队列的引导缓冲并注入对话",
    failure: "fatal",
    makeHandler: (rt) => {
      const { drainSteer } = rt
      return () => {
        return drainSteer()
      }
    },
  }),
  spec({
    name: "background-precompact",
    position: "compaction-check",
    order: 5,
    description: "预压线触发后台压缩（不阻塞请求，成果待应用）",
    failure: "skip",
    timeoutMs: Number.POSITIVE_INFINITY,
    makeHandler: (rt) => {
      const { compactor, sessionId, signal, sessions, contextOverhead, waterlines, config, runLlm, model } = rt
      return () => {
        // 预压线（ahead ≤ 估算水位 < 红线）且无在飞、无暂存成果时，在后台启动
        // 压缩：不阻塞下一次请求，成果由后续迭代边界应用（mid-run-panic）。
        // 水位已达红线的场景让位给 mid-run-panic 的同步路径。
        if (compactor.cancelled(sessionId) || signal.aborted) return
        const history = sessions.readMessages(sessionId)
        const overhead = contextOverhead()
        const level = estimateContextTokens(history, undefined, overhead)
        if (!waterlines.exceedsFullHistory("ahead", level) || waterlines.exceedsFullHistory("panic", level)) return
        compactor.background(sessionId, history, config, runLlm, model, {
          overheadTokens: overhead,
          budget: waterlines.budget,
        })
        // 只开工，不换视图：undefined 不影响同位后续钩子的返回值。
        return undefined
      }
    },
  }),
  spec({
    name: "mid-run-panic",
    position: "compaction-check",
    order: 10,
    description: "红线水位的迭代边界中途压缩判定（含后台成果应用）",
    failure: "skip",
    timeoutMs: Number.POSITIVE_INFINITY,
    makeHandler: (rt) => {
      const { compactor, sessionId, signal, contextOverhead, waterlines, sessions, config, runLlm, model, compactionAfter } = rt
      return async () => {
        // Cancellation marker or an already-aborted run → don't compact.
        if (compactor.cancelled(sessionId) || signal.aborted) return null
        // A parked background result is applied first — it is strictly newer
        // than the run's view and the real request anchor self-heals at the
        // next boundary (no post-apply re-estimate: the anchor is stale).
        const parkedView = compactor.takeParked(sessionId)
        if (parkedView !== null) return parkedView
        const overhead = contextOverhead()
        if (!waterlines.exceedsFullHistory("panic", estimateContextTokens(sessions.readMessages(sessionId), undefined, overhead))) return null
        if (compactor.hasInFlight(sessionId)) {
          // Red line hit while a background compaction is in flight: wait for
          // it to settle (single-compaction invariant), then re-estimate on the
          // span its parked view would keep — sync-compact only if that active
          // span still crosses the red line (spec D5). The re-read is biased
          // large (anchor predates the parked view) — the safe direction.
          await compactor.waitForSettled(sessionId, signal)
          if (compactor.cancelled(sessionId) || signal.aborted) return null
        }
        const history = sessions.readMessages(sessionId)
        const settled = compactor.takeParked(sessionId)
        if (settled !== null) {
          const keepFrom = history.findIndex((m) => m.id === settled.upto) + 1
          const active = keepFrom > 0 ? history.slice(keepFrom) : undefined
          if (active !== undefined && active.length > 0 &&
              !waterlines.exceedsActiveSpan("panic", estimateContextTokens(active, undefined, overhead))) {
            return settled
          }
        }
        const outcome = await compactor.auto(sessionId, history, config, runLlm, model, {
          phase: "in-run",
          signal,
          overheadTokens: overhead,
          budget: waterlines.budget,
        })
        forwardOutcome(compactionAfter, "in-run", outcome)
        // A failed or declined sync attempt falls through to the parked view:
        // it is the newest thing we have.
        return outcome.status === "applied" ? { upto: outcome.upto, top: outcome.top } : settled
      }
    },
  }),
  spec({
    name: "overflow-emergency",
    position: "overflow-rescue",
    order: 10,
    description: "上下文溢出的急救压缩（换视图整次重发）",
    failure: "skip",
    timeoutMs: Number.POSITIVE_INFINITY,
    makeHandler: (rt) => {
      const { compactor, sessionId, sessions, config, runLlm, model, signal, contextOverhead, waterlines, compactionAfter } = rt
      return async () => {
        // No watermark check — "it already overflowed" is a fact. Abort after
        // the await → null (the resend would be torn down at the next
        // checkpoint anyway).
        // 急救撞在飞后台：abortInFlight 掐掉它并等其退出（单压缩不变量；成果
        // 丢弃——原文无损，下次重压），再立即同步急救。救援路径不等摘要慢慢
        // 跑完；不用 cancel()——它的取消标记会压制紧随其后的急救 auto()。
        if (compactor.hasInFlight(sessionId)) {
          compactor.abortInFlight(sessionId)
          await compactor.waitForSettled(sessionId)
        }
        const outcome = await compactor.auto(sessionId, sessions.readMessages(sessionId), config, runLlm, model, {
          phase: "in-run",
          emergency: true,
          signal,
          overheadTokens: contextOverhead(),
          budget: waterlines.budget,
        })
        forwardOutcome(compactionAfter, "in-run", outcome)
        return outcome.status === "applied" ? { upto: outcome.upto, top: outcome.top } : null
      }
    },
  }),
  spec({
    name: "usage-ledger",
    position: "run-after",
    order: 10,
    description: "记录本次 run 的 token 用量台账",
    failure: "skip",
    makeHandler: (rt) => {
      const { usageStore, usageSessionId, runIdRef, model } = rt
      return ({ outcome }) => {
        if (usageStore === undefined) return
        try {
          usageStore.record({
            // Subagent tokens group under the parent session (issue #16 记账).
            sessionId: usageSessionId,
            runId: runIdRef.current ?? "",
            model,
            inputTokens: outcome.totalUsage.inputTokens,
            outputTokens: outcome.totalUsage.outputTokens,
            at: new Date().toISOString(),
          })
        } catch (err) {
          console.error("kclaw usage record failed:", err)
        }
      }
    },
  }),
  spec({
    name: "manual-compact-flush",
    position: "run-after",
    order: 15,
    description: "冲刷排队的 /compact（忙时登记，运行结束后执行）",
    failure: "skip",
    timeoutMs: Number.POSITIVE_INFINITY,
    makeHandler: (rt) => {
      const { compactor, sessionId, signal, sessions, config, runLlm, model, waterlines, contextOverhead, compactionAfter } = rt
      return async () => {
        // 冲刷挂起的 /compact（会话忙时登记的）：在自动收尾压缩之前执行——
        // 用户显式意图优先，压完水位落回，自动收尾检查自然不再触发。
        // 不做忙碌/排队检查（收尾链时刻必然不忙；运行期间排队的消息等下一条
        // 出队，与压缩无关）。
        if (!compactor.hasDeferredManual(sessionId)) return
        if (compactor.hasInFlight(sessionId)) await compactor.waitForSettled(sessionId, signal)
        const deferred = compactor.takeDeferredManual(sessionId)
        if (deferred === null) return
        const outcome = await compactor.compact(sessionId, sessions.readMessages(sessionId), "", config, runLlm, model, {
          focus: deferred.focus,
          manual: true,
          phase: "manual",
          budget: waterlines.budget,
          overheadTokens: contextOverhead(),
        })
        forwardOutcome(compactionAfter, "manual", outcome)
      }
    },
  }),
  spec({
    name: "post-run-compaction",
    position: "run-after",
    order: 20,
    description: "黄线水位触发的收尾压缩",
    failure: "skip",
    timeoutMs: Number.POSITIVE_INFINITY,
    makeHandler: (rt) => {
      const { compactor, sessionId, sessions, contextOverhead, waterlines, config, runLlm, model, signal, compactionAfter } = rt
      return async ({ outcome: runOutcome }) => {
        // aborted/error runs are not finalized (the former is being torn down,
        // the latter just failed); the cancellation marker suppresses a
        // user-cancelled compaction for this run.
        if (runOutcome.stopReason === "aborted" || runOutcome.stopReason === "error" || compactor.cancelled(sessionId)) return
        if (compactor.hasInFlight(sessionId)) {
          // 收尾撞在飞后台（预压没跑完 run 就结束了）：等它完成再判断——绝不
          // 并发第二个压缩。等待后走正常判断（auto 内部的活跃段细判自适应）。
          // 循环已结束，挂起视图没有"下一次请求"可应用，取走丢弃——元数据
          // 已携带同一成果，下一次运行从 meta 读到它。
          await compactor.waitForSettled(sessionId, signal)
          compactor.takeParked(sessionId)
        }
        const postRunHistory = sessions.readMessages(sessionId)
        const overhead = contextOverhead()
        if (!waterlines.exceedsFullHistory("at", estimateContextTokens(postRunHistory, undefined, overhead))) return
        const outcome = await compactor.auto(sessionId, postRunHistory, config, runLlm, model, {
          phase: "post-run",
          signal,
          overheadTokens: overhead,
          budget: waterlines.budget,
        })
        forwardOutcome(compactionAfter, "post-run", outcome)
      }
    },
  }),
  spec({
    name: "follow-check",
    position: "run-after",
    order: 30,
    description: "排一个记忆空闲检查（调度器补查）",
    failure: "skip",
    makeHandler: (rt) => {
      const { childRun, config, memory, sessionId } = rt
      return () => {
        // Children never schedule follow extraction (memory isolation).
        if (childRun) return
        if (config.memory.write.idleMinutes > 0) {
          try {
            memory.scheduleFollowCheck?.(sessionId, new Date().toISOString())
          } catch {
            // a failed follow-gate schedule never affects the run
          }
        }
      }
    },
  }),
  spec({
    name: "skill-follow-check",
    position: "run-after",
    order: 40,
    description: "排一个技能提炼空闲检查（提案制；未启用即跳过）",
    failure: "skip",
    makeHandler: (rt) => {
      const { childRun, config, skillsEvolution, skillNames, sessionId } = rt
      return () => {
        // 与记忆 follow 门禁同向：子会话不排检查（记忆隔离）。子会话的增量
        // 不会被漏看——粗查读的是全项目各会话的未处理增量（含子会话）。
        if (childRun) return
        const gate = resolveEvolutionGate(config)
        if (skillsEvolution === undefined || !gate.enabled || gate.idleMinutes <= 0) return
        try {
          skillsEvolution.considerFollowCheck(sessionId, new Date().toISOString(), skillNames ?? [])
        } catch {
          // a failed coarse check never affects the run
        }
      }
    },
  }),
  spec({
    name: "system-materials",
    position: "system-before",
    order: 10,
    description: "收集认知与技能列表两个提示词段",
    failure: "skip",
    makeHandler: (rt) => {
      const { childRun, memory, workspace, skillList } = rt
      return () => {
        // Subagent children run on the lean prompt: no cognition, no skill list.
        if (childRun) return []
        // Cognition injection failure is silently skipped (run proceeds with
        // base prompt only) — pre-migration parity.
        let cognition = ""
        try {
          cognition = memory.cognitionPrompt(workspace)
        } catch {
          // 认知注入失败静默跳过
        }
        return [cognition, skillList].filter((s) => s !== "")
      }
    },
  }),
]

/**
 * Static builtin hook definitions for the management plane (positions +
 * copy) — projected from BUILTIN_HOOK_SPECS, the single source both the
 * chain assembly and this list build on.
 */
export const BUILTIN_HOOK_DEFINITIONS: ReadonlyArray<{
  name: string
  position: HookPosition
  description: string
  failure: "fatal" | "skip"
}> = BUILTIN_HOOK_SPECS.map(({ name, position, description, failure }) => ({ name, position, description, failure }))

/** Build this run's builtin chain entries (closures over run resources). */
export function makeBuiltinHooks(deps: BuiltinHookDeps): HookEntry[] {
  const rt: HookRuntime = {
    ...deps,
    childRun: deps.childRun === true,
    usageSessionId: deps.usageSessionId ?? deps.sessionId,
    runCtx: () => (deps.runIdRef.current === undefined
      ? { sessionId: deps.sessionId }
      : { sessionId: deps.sessionId, runId: deps.runIdRef.current }),
    memoryNotes: [],
  }
  return BUILTIN_HOOK_SPECS.map((s) => ({
    meta: {
      name: s.name, position: s.position, description: s.description,
      enabled: true, order: s.order, failure: s.failure, origin: "builtin",
      ...(s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs }),
    },
    handler: s.makeHandler(rt),
  }))
}

function textOf(m: Message): string {
  return m.blocks.find((b) => b.type === "text")?.text ?? ""
}
