/**
 * executeRun — the daemon-proven assembly of ONE agent run.
 *
 * This is the engine side of the handoff: the server's RunManager owns the
 * queue (ordering, cancellation bookkeeping, queue.jsonl persistence) and,
 * for each dequeued entry, calls {@link executeRun} with the shared deps and
 * a drainSteer callback (the steer buffer is queue state, so it stays with
 * the queue).
 *
 * Hook system: every formerly-hardcoded behavior seam of the
 * run (memory notes, user-message persistence, autoname, skill wrapping,
 * retry visibility, steering drain, compaction decisions, the finalize trio,
 * system-prompt assembly + audit) now registers through the SAME HookChain
 * the user's file hooks take — the engine is its own first extension. The
 * chain's builtin entries close over THIS run's resources; user entries come
 * from the daemon-scoped HookRegistry, refreshed per run ("放文件，下轮生效",
 * the skills' mental model).
 *
 * Composition choices pinned here (unchanged through the migration):
 * - History is read BEFORE the user message is appended: runAgent places its
 *   user message after `history` (`[...input.history, userMsg]`), so it must
 *   not already contain it (would double-send the text to the provider).
 * - The user message is built here as a text-only skeleton and passed via
 *   `RunInput.userMessage`; runAgent uses it verbatim and does NOT re-persist
 *   it — the run-before hook chain lands it (notes + JSONL append) between
 *   the loop's message.created and message.completed, so the bus carries
 *   run.started → message.created → note.emitted ×N → message.completed.
 * - A failing usage record never affects the run; a failing follow-gate
 *   schedule never affects the run (both are fail-open hooks now, with a
 *   hook.failed event where the old code was silent).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent } from "../protocol/events.js"
import type { AttachmentBlock, NoteBlock, ToolCallBlock } from "../protocol/blocks.js"
import { newBlockId } from "../protocol/blocks.js"
import type { Message } from "../protocol/messages.js"
import { newMessage } from "../protocol/messages.js"
import type { AttachmentRef } from "../protocol/wire.js"
import type { LlmClient, ToolDefinition } from "../provider/types.js"
import type { KclawConfig } from "../storage/config.js"
import { defaultConfig, resolveContextTokens } from "../storage/config.js"
import type { KclawPaths } from "../storage/paths.js"
import type { UsageStore } from "../storage/usage.js"
import type { SessionStore } from "../session/store.js"
import type { Compactor } from "../session/compactor.js"
import { estimateTokens } from "../session/compaction.js"
import { ConfigPermissionGate, realpathWithin, SessionGrants } from "../permissions/engine.js"
import { appendDecidedRule, loadDecidedRulesForRun, narrowDecidedRule, projectDecidedRulesPath } from "../storage/decided-rules.js"
import type { AutoLearnCounter } from "../permissions/auto-learn.js"
import { ConfirmationBroker, raceConfirmation, type ConfirmationResolution } from "../permissions/broker.js"
import { createExecSandbox } from "../sandbox/provider.js"
import type { PermissionGate, RunOutcome } from "./loop.js"
import { runAgent } from "./loop.js"
import { SYSTEM_INJECTION_CONVENTION } from "./context.js"
import { subagentSystemPrompt, type SubagentSpawner } from "./subagent.js"
import type { SessionSearchFn } from "../tools/session.js"
import type { ToolExecutor } from "./tools.js"
import { createBuiltinTools, deriveToolFacts } from "../tools/index.js"
import { searchSessionEvents } from "../tools/session-search.js"
import { matchSkillInvocations, scanSkillDirs, skillListPrompt, wrapSkillInvocations } from "../skills/index.js"
import type { MemorySystem } from "../memory/system.js"
import type { EventBus } from "../bus.js"
import { HookChain, DEFAULT_HOOK_TIMEOUT_MS } from "../hooks/runner.js"
import { makeBuiltinHooks } from "../hooks/builtin.js"
import type { HookRegistry } from "../hooks/registry.js"
import type { HookEntry } from "../hooks/types.js"

/** System prompt fallback when ~/.kclaw/AGENTS.md is missing or empty. */
const DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"

/** Text-like MIME/exif: inlined into context when small enough. */
const TEXT_MIME = /^text\//
const TEXT_EXT = /\.(md|txt|json|csv|yaml|yml|xml|log|ts|js|tsx|jsx|py|go|rs|sh|toml|ini|env)$/i
/** Cap for inlining a text attachment into the prompt (chars). */
const TEXT_INLINE_MAX_CHARS = 8 * 1024
/** Cap for reading a text attachment off disk (bytes). */
const TEXT_INLINE_MAX_BYTES = 64 * 1024
/** Cap for embedding an image as base64 (bytes). */
const IMAGE_INLINE_MAX_BYTES = 5 * 1024 * 1024

/** withRetry's per-attempt notification shape (core provider/retry.ts onRetry). */
export type LlmRetrySink = (info: { attempt: number; error: unknown }) => void

/**
 * One queued run request (moved from server run.ts; the queue state machine
 * and the engine share this shape).
 */
export interface EnqueueInput {
  userText: string
  trigger: "user" | "job" | "agent"
  /**
   * Per-run model override (a job's configured model, or a client-forced
   * one). Priority per run: input.model > session meta model > daemon
   * default. Absent → the daemon default applies.
   */
  model?: string
  /**
   * Attachments to mount onto the user message: references to files
   * already uploaded under `<home>/attachments/<sessionId>/` (validated
   * by the caller and defensively re-checked here).
   */
  attachments?: AttachmentRef[]
  /**
   * Job provenance note: when the scheduler fires a job, the tick
   * passes the 「本会话由定时任务…」 line here and it lands as a kind:"job"
   * note block right after the text block on the user message.
   */
  note?: string
  /** 单次显式处置（层级最高）；缺省 = 会话覆盖 ?? 配置默认；job 触发强制 wait。 */
  disposition?: "steer" | "wait" | "interrupt"
  /** 内部：出队执行时传入的预分配消息 id（ws 层不传）。 */
  messageId?: string
}

/**
 * Engine deps: everything one run's assembly may reach. The daemon wires all
 * of these once (RunManager holds the same set); tests inject fakes.
 */
export interface RunEngineDeps {
  config: KclawConfig
  paths: KclawPaths
  sessions: SessionStore
  memory: MemorySystem
  bus: EventBus
  llm: LlmClient
  workspace: string
  /**
   * Model string sent to the provider: the daemon resolves it once
   * — provider entry, KCLAW_LLM_MODEL env fallback — because an env-only
   * provider would otherwise leave the config-derived model empty. Optional
   * for backwards compatibility: when omitted, the default provider's
   * config model is used as before (empty string when unconfigured).
   */
  model?: string
  /**
   * The RESOLVED confirmation gateway (RunManager guarantees one exists —
   * injected or internally constructed).
   */
  broker: ConfirmationBroker
  /**
   * Direct resolver override for tests. Takes precedence over the broker when
   * set — the daemon path relies on the broker alone.
   */
  resolveConfirmation?: (confirmationId: string) => Promise<ConfirmationResolution>
  /**
   * Auto-mode induction (batch C): when set, `auto` sessions' confirmation
   * resolutions are fed to the counter here — the assembly seam sees every
   * outcome (once / reject / timeout), which the ws command dispatcher cannot
   * (a timeout settles inside the loop and never produces a resolve frame).
   * A `once` verdict advances the per-session streak (crossing the threshold
   * persists a `source:"auto"` project rule); a `reject` or a TIMEOUT resets
   * it — denied operations are never inducted.
   */
  autoLearn?: { counter: AutoLearnCounter }
  /**
   * Retry-visible llm per run: when set, EVERY
   * run builds its own client through this factory, receiving that run's
   * retry sink as `onRetry` — provider-level retries (the daemon's default
   * withRetry composition) then surface as `llm.failed {willRetry:true}`
   * events carrying THIS run's sessionId/runId, even while other sessions
   * run concurrently against the same endpoint. Takes precedence over `llm`.
   * The daemon sets it for its default composition; injected test factories
   * (plain script clients) leave it unset and use `llm` as before.
   */
  llmForRun?: (onRetry: LlmRetrySink) => LlmClient
  /**
   * Per-name executor overrides for tests/adapters:
   * merged OVER the builtin tools after construction (defs stay the
   * builtins'), so a test can swap one executor — e.g. for one that throws —
   * without rebuilding the toolset.
   */
  tools?: Map<string, ToolExecutor>
  /**
   * Live adapter tools (e.g. the MCP manager): a FUNCTION evaluated per run,
   * so connections that come up or drop between runs (or mid-reconnect)
   * are reflected in the next LLM request. Defs are appended to the
   * builtin defs; a name collision with a builtin logs once and the
   * adapter's executor wins (schema follows the executor).
   */
  extraTools?: () => { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] }
  /**
   * Subagent dispatch (issue #16): the server-side spawner. When set,
   * mainline runs gain the `subagent_run` builtin tool; the child run's own
   * assembly never sees it (single-level delegation — child detection is the
   * session meta's parentSessionId, not this flag).
   */
  subagents?: { spawner: SubagentSpawner }
  /** Per-run token ledger (optional; recording failures are swallowed). */
  usageStore?: UsageStore
  /**
   * User hook registry: the daemon-scoped bookkeeping for
   * ~/.kclaw/hooks files. Refreshed per run; its snapshot joins the run's
   * hook chain. Optional (tests without user hooks omit it).
   */
  hooks?: HookRegistry
  /**
   * Test seam: entries registered into every run's chain beyond the
   * builtins and the user registry (hook-level tests inject fakes here
   * instead of writing files).
   */
  extraHooks?: HookEntry[]
}

/** What the queue hands the engine alongside one dequeued entry. */
export interface RunHandoff {
  sessionId: string
  input: EnqueueInput
  /** The run's abort controller, registered by the queue BEFORE any await. */
  controller: AbortController
  /**
   * Steer injection: the queue owns the steer buffer; the loop
   * drains it at iteration boundaries through this callback.
   */
  drainSteer: () => Message[]
}

/** The engine bundle: shared deps plus the compactor (per-run triggers). */
export interface RunEngine {
  deps: RunEngineDeps
  compactor: Compactor
}

/**
 * Turn attachment references into attachment blocks on the user message.
 * Decision per file: text-like and small → inline text (capped); image and
 * small → base64 source (multimodal parts); anything else → metadata only,
 * the agent reads it on demand via fs_read. Any path outside the session's
 * attachments dir is rejected (defense in depth — the caller validates too).
 */
export function mountAttachments(refs: AttachmentRef[], attachmentsDir: string, sessionId: string): AttachmentBlock[] {
  const blocks: AttachmentBlock[] = []
  for (const ref of refs) {
    const root = realpathWithin(join(attachmentsDir, sessionId))
    const resolved = realpathWithin(ref.path)
    if (resolved !== root && !resolved.startsWith(root + "/")) {
      throw new Error(`attachment outside the session's attachments dir: ${ref.path}`)
    }
    const isText = TEXT_MIME.test(ref.mimeType) || TEXT_EXT.test(ref.name)
    const isImage = ref.mimeType.startsWith("image/")
    if (isText && ref.size <= TEXT_INLINE_MAX_BYTES) {
      let text = readFileSync(resolved, "utf8")
      if (text.length > TEXT_INLINE_MAX_CHARS) text = `${text.slice(0, TEXT_INLINE_MAX_CHARS)}\n…[已截断]`
      blocks.push({ id: newBlockId(), type: "attachment", mimeType: ref.mimeType, name: ref.name, text, source: { type: "file", path: resolved } })
    } else if (isImage && ref.size <= IMAGE_INLINE_MAX_BYTES) {
      blocks.push({ id: newBlockId(), type: "attachment", mimeType: ref.mimeType, name: ref.name, source: { type: "base64", data: readFileSync(resolved).toString("base64") } })
    } else {
      blocks.push({ id: newBlockId(), type: "attachment", mimeType: ref.mimeType, name: ref.name, source: { type: "file", path: resolved } })
    }
  }
  return blocks
}

/**
 * Execute one dequeued entry. The controller arrives pre-registered by the
 * queue's #executeEntry (before any await), so cancellation windows and
 * active-cleanup stay with the queue; this function only consumes its signal.
 */
export async function executeRun(engine: RunEngine, handoff: RunHandoff): Promise<RunOutcome> {
  const { sessionId, input, controller } = handoff
  // 压缩取消标记只压制一次运行：新运行从干净状态开始。
  engine.compactor.clearCancelled(sessionId)
  const { config, paths, sessions, memory, bus } = engine.deps
  const sessionMeta = sessions.meta(sessionId)
  const workspace = sessionMeta?.workdir ?? engine.deps.workspace
  // Subagent child run: the session meta's parentSessionId is the single
  // source of child identity — lean prompt, narrow tool surface, hook
  // skippings and usage attribution all derive from it (issue #16).
  const childRun = sessionMeta?.parentSessionId !== undefined

  // 用户 hooks 每 run 现扫：改文件下一轮生效（与技能同心智）。新装载失败经
  // registry 去重后发一次 hook.failed(load) 事件。
  await engine.deps.hooks?.refresh()

  // bus fan-out：一个坏订阅者不能弄死 run（bus.emit 已逐 socket 自守；此
  // 包裹覆盖 emit 里剩余的同步工作，如 JSON.stringify）。
  const busEmit = (e: AgentEvent): void => {
    try {
      bus.emit(e)
    } catch {
      // ignore
    }
  }
  let runId: string | undefined
  const eventCtx = () => (runId === undefined ? { sessionId } : { sessionId, runId })

  // --- the run's hook chain: builtins (closures over run resources) +
  // user files + test injections, one execution path for all --------------
  const chain = new HookChain({
    timeoutMs: () => config.hooks?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    onFailure: (e) => busEmit(e),
    eventCtx,
  })

  // History BEFORE the append (runAgent appends the user message itself).
  // The user message starts as a text-only SKELETON: the run-before hook
  // chain lands it — memory/job notes appended, JSONL write, note.emitted ×N
  // — right after the loop announced the skeleton via message.created, so
  // the wire order stays
  // run.started → message.created → note.emitted ×N → message.completed.
  const history = sessions.readMessages(sessionId)
  const jobNotes: NoteBlock[] =
    input.note === undefined
      ? []
      : [{ id: newBlockId(), type: "note", kind: "job", text: input.note }]
  const userMessage = newMessage(sessionId, "user", [
    { id: newBlockId(), type: "text", text: input.userText },
    ...mountAttachments(input.attachments ?? [], paths.attachmentsDir, sessionId),
  ])
  if (input.messageId !== undefined) userMessage.id = input.messageId // 气泡原地升级

  // 技能目录每 run 重扫（渐进披露第一层）：全局 + 会话工作目录的项目级，
  // 项目同名整目录覆盖。列表段追加进系统提示词，与 system 审计事件同文；
  // skill_read 工具持有同一份扫描结果（第二层，按需取正文）。
  const skills = scanSkillDirs({
    global: paths.skillsDir,
    project: join(workspace, ".kclaw", "skills"),
  })

  // 技能点名的隐式包装（Master 2026-09-03）：用户消息里任意位置的 /技能名
  // 记号精确命中已装且用户可调用的技能时，只在发给模型的那份输入上追加
  // 一行调用指示——持久化、事件流与气泡保持原始文本（所见即所发）。
  // 仅 trigger:user 生效：job 提示是 daemon 生成的内部指令，不参与点名。
  // 内置 skill-wrap 钩子捕获这份预计算文本，在 llm-before 位置应用。
  const llmUserText =
    input.trigger === "user"
      ? wrapSkillInvocations(input.userText, matchSkillInvocations(input.userText, skills))
      : undefined

  // --- exec sandbox (batch A): one probe, two consumers --------------------
  // `available` gates BOTH the exec tool's actual wrapper and the permission
  // gate's sandboxed auto-pass from the SAME source, so a "sandboxed"
  // allowance can never be issued while exec runs bare (and vice versa).
  const sandbox = createExecSandbox(config.sandbox ?? defaultConfig.sandbox ?? { enabled: true, writeRoots: [] }, { workspace })
  // User-chosen disable (sandbox.enabled: false) is a deliberate decision and
  // stays silent; a probe failure (platform tool missing, userns blocked) is
  // an environment problem worth a daemon log line — fail-closed either way.
  const sandboxAttempted = config.sandbox?.enabled !== false
  if (sandboxAttempted && !sandbox.available && sandbox.unavailableReason !== undefined) {
    console.warn(`kclaw: exec sandbox unavailable (${sandbox.unavailableReason}); sandboxable exec falls back to manual confirmation`)
  }
  // When the sandbox was attempted but unavailable, the confirmation explains
  // why (User Story: "回落到确认框并说明沙箱不可用").
  const sandboxUnavailableNote = sandboxAttempted && !sandbox.available
    ? "exec 沙箱不可用，本次操作需人工确认"
    : undefined
  // Sandbox audit event (batch D): one per run, right after the probe — the
  // session's trail then shows what sandbox state THIS run had (config switch,
  // availability, reason) beside the grantedBy/deny trail of what the gate
  // decided with it. Same contract as the system audit event: a write failure
  // fails the run (the audit promise is all-or-nothing). A deliberately
  // disabled sandbox carries no reason — that's a choice, not an environment
  // problem.
  sessions.appendSandboxChecked(sessionId, {
    at: new Date().toISOString(),
    enabled: sandboxAttempted,
    available: sandbox.available,
    ...(sandboxAttempted && sandbox.unavailableReason !== undefined ? { unavailableReason: sandbox.unavailableReason } : {}),
  })

  const { tools, toolDefs } = createBuiltinTools({
    workspace,
    memoryCtx: {
      system: memory,
      sessionId,
      workdir: workspace,
      immediateEnabled: config.memory.write.immediate,
    },
    tavilyApiKey: config.web.tavilyApiKey,
    exec: {
      timeoutMs: config.exec.timeoutMs,
      maxOutputBytes: config.exec.maxOutputBytes,
      sandbox: sandbox.available ? sandbox : undefined,
      spillDir: paths.spillDir,
    },
    web: { timeoutMs: config.web.timeoutMs, allowPrivateNetworks: config.web.allowPrivateNetworks, spillDir: paths.spillDir },
    sessionSearch: buildSessionSearch(engine.deps, sessionId),
    skills,
    ...(engine.deps.subagents !== undefined && !childRun
      ? { subagent: { spawner: engine.deps.subagents.spawner, parentSessionId: sessionId } }
      : {}),
    ...(childRun ? { childRun: true } : {}),
  })
  // test/adapter seam: per-name executor overrides on top of the
  // builtins; toolDefs stay the builtins' — an override replaces behavior,
  // not the schema the model sees.
  if (engine.deps.tools !== undefined) {
    for (const [name, executor] of engine.deps.tools) tools.set(name, executor)
  }
  // Live adapter tools (MCP manager): defs appended, executor wins on a
  // name collision with a log line (schema follows the executor).
  if (engine.deps.extraTools !== undefined) {
    const extra = engine.deps.extraTools()
    for (const [name, executor] of extra.executors) {
      if (tools.has(name)) console.error(`kclaw tool name collision: ${name} (adapter overrides builtin)`)
      tools.set(name, executor)
    }
    toolDefs.push(...extra.defs)
  }

  // --- permission wiring (config gate + confirmation gateway) ---
  const pendingConfirmations = new Map<string, ToolCallBlock>()

  // Decided rules re-read every run (skills/hooks philosophy: edits take
  // effect next message, no restart). A git-tracked project file is ignored
  // here with a warning — a cloned repo must not pre-authorize itself.
  const decided = loadDecidedRulesForRun(paths, workspace)

  // SessionGrants (batch D): run-scoped grant store. A once-approval in THIS
  // run lands here (see the resolveConfirmation seam below), so the same call
  // stops re-prompting until the run ends — the next message asks again.
  // Wired only when config enables the feature; cross-run persistence stays
  // with decided rules, so no long-lived exemption is ever created here.
  const grants = config.permissions.sessionGrants === true ? new SessionGrants() : undefined

  const baseGate = new ConfigPermissionGate(config.permissions, {
    workspace,
    safeTools: new Set([...tools].filter(([, t]) => t.risk === "safe").map(([name]) => name)),
    // Registration facts (risk + schema arg field names): the gate derives
    // every treatment beyond safeTools from these — no permission logic in
    // the tools, no tool-name rosters in the gate (issue #9).
    toolFacts: deriveToolFacts(tools, toolDefs),
    // Human-approved "always allow" rules (project + global scopes).
    decidedRules: decided.rules,
    // Attachment reads: files under <home>/attachments are the daemon's own
    // uploaded inputs — safe path-arg tools reach them without a confirmation.
    // The spill dir joins the read roots so a truncation locator's fs_read
    // hint can actually read the spilled copy back.
    readRoots: [paths.attachmentsDir, paths.spillDir],
    // Mode: this session's own toggle (absent → default). The daemon has no
    // mode flag — the session meta is the single source of truth.
    mode: sessionMeta?.mode,
    // Sandbox availability (same probe as the exec wrapper above): a command
    // with no rule coverage auto-passes as sandboxed when available; when the
    // sandbox was attempted but unavailable, the confirmation carries an
    // explanation instead of the silent fail-closed default.
    sandboxAvailable: sandbox.available,
    sandboxUnavailableNote,
    // The tools this assembly actually wrapped in the OS sandbox (exec gets
    // the wrapper below; no other executor does). The gate's "sandboxed"
    // auto-pass must never claim an unwrapped tool is sandboxed.
    sandboxedTools: sandbox.available ? new Set(["exec"]) : new Set(),
    // Run-scoped grants (batch D): consulted only when config enables
    // sessionGrants; reason "session_grant".
    grants,
  })
  const confirmTimeoutMs = config.permissions.confirmTimeoutMs
  const broker = engine.deps.broker
  const gate: PermissionGate = {
    async check(toolCall) {
      const decision = await baseGate.check(toolCall)
      if (decision.type === "confirm") {
        pendingConfirmations.set(decision.confirmationId, toolCall)
        // Gateway registration under the gate-issued id (the loop echoes it
        // in its confirmation.requested event, which is what a WS client
        // resolves against). Purely registration — the loop emits the event
        // itself; the broker never emits.
        broker.create(
          decision.confirmationId,
          toolCall,
          tools.get(toolCall.name)?.risk ?? "sensitive",
          confirmTimeoutMs,
          sessionId,
        )
      }
      return decision
    },
  }

  // Confirmation answering: deps' direct resolver when wired (test seam),
  // else the broker's pending promise (the daemon path: WS/CLI verdicts
  // settle it). The resolver is raced against the SAME timeout the loop
  // races against — the single shared raceConfirmation (permissions/broker).
  // Whenever the race settles WITHOUT a human verdict (timeout/abort), the
  // broker entry goes stale so a late gateway resolve reports "unknown
  // confirmation" instead of acking a verdict nothing will act on.
  const baseResolver =
    engine.deps.resolveConfirmation ?? ((confirmationId: string) => broker.wait(confirmationId))
  const resolveConfirmation = async (confirmationId: string): Promise<ConfirmationResolution> => {
    const raced = await raceConfirmation(baseResolver(confirmationId), confirmTimeoutMs, controller.signal)
    // Auto-mode induction (batch C): this seam sees EVERY settlement a human
    // confirmation can reach — once / reject via the gateway, timeout when the
    // race expires — unlike the ws dispatcher, which only ever sees resolve
    // frames. The mode check uses this run's snapshot (the mode the
    // confirmation was issued under), not the live meta a switch may have
    // changed mid-run. An abort is NOT a denial (the run was cancelled) and
    // never touches the counter.
    const call = pendingConfirmations.get(confirmationId)
    pendingConfirmations.delete(confirmationId)
    if (raced === "aborted") {
      broker.expire(confirmationId)
      // the value is never used: the loop's own race resolved "aborted" and
      // denies without consulting the resolver
      return { decision: "timeout", by: "timeout" }
    }
    if (raced.by === "timeout") broker.expire(confirmationId)
    // SessionGrants (batch D): a once-approval also lands in this run's grant
    // store, keyed by the same narrowed rule the gate re-checks — the same
    // call within THIS run stops re-prompting. project/global approvals
    // already persist a rule (no grant needed); reject/timeout never grant.
    // The gate skips grants in `auto` mode (learning observes human
    // confirmations), so an auto-mode write here is dead weight — harmless,
    // and kept unconditional so the seam never has to know the gate's modes.
    if (raced.decision === "once" && call !== undefined) {
      grants?.grant(narrowDecidedRule(call, workspace))
    }
    const autoLearn = engine.deps.autoLearn
    if (autoLearn !== undefined && sessionMeta?.mode === "auto" && call !== undefined) {
      // Key is scoped per session: streaks must never leak across sessions
      // (another session's approvals must not help this one cross the
      // threshold) even though the counter is one per process.
      const ruleKey = narrowDecidedRule(call, workspace)
      const key = `${sessionId}\n${ruleKey}`
      if (raced.decision === "once") {
        if (autoLearn.counter.approve(key)) {
          try {
            appendDecidedRule(
              projectDecidedRulesPath(workspace),
              {
                rule: ruleKey,
                decidedAt: new Date().toISOString(),
                origin: { tool: call.name, argsJson: call.argsJson, sessionId },
                source: "auto",
              },
              { workspace },
            )
          } catch (e) {
            console.error(`kclaw: failed to persist auto-learned rule: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } else if (raced.decision === "reject" || raced.by === "timeout") {
        // a "no" — explicit or by silence — resets the streak
        autoLearn.counter.reject(key)
      }
    }
    return raced
  }

  // --- retry visibility --------------------------------------------------------
  // Provider-level retries live inside the llm wrapper (withRetry), where
  // the loop cannot see them. When deps.llmForRun is set, the wrapper's
  // onRetry lands in THIS closure: it advances the attempt counter the
  // loop's llm.started reads and hands the notification to the llm-retry
  // hook chain (builtin retry-notify emits `llm.failed {willRetry:true}` on
  // the bus). The counter is per llm call — a completed/failed call resets
  // it. The runId is learned from the loop's own run.started.
  let llmAttempt = 1
  const onLlmRetry: LlmRetrySink = (info) => {
    llmAttempt = info.attempt + 1
    void chain
      .run("llm-retry", {
        attempt: info.attempt,
        error: String((info.error as { message?: string } | null | undefined)?.message ?? info.error),
      })
      .catch(() => { /* retry visibility must not break the retry itself */ })
  }
  const runLlm = engine.deps.llmForRun?.(onLlmRetry) ?? engine.deps.llm
  const defaultModel = engine.deps.model ?? config.providers.entries[config.providers.default]?.model ?? ""
  // A session/job model may name a provider ENTRY ("deepseek") whose wire
  // model is the entry's `.model` ("deepseek-v4-flash"); resolve keys to that
  // model, leaving already-raw API model names untouched.
  const resolveEntry = (m: string): string => config.providers.entries[m]?.model ?? m
  const rawModel = input.model ?? sessionMeta?.model ?? defaultModel
  const model = resolveEntry(rawModel)
  // Entry metadata for this run: the budget (contextWindow cap via
  // resolveContextTokens) feeds every compaction line and the packing
  // budget; maxOutput rides each request as max_tokens.
  const entryKey = config.providers.entries[rawModel] !== undefined ? rawModel : config.providers.default
  const entry = config.providers.entries[entryKey]
  const budget = resolveContextTokens(config, entryKey)
  const maxOutput = entry?.maxOutput

  // v3/v4 compaction thresholds: the loop's packing budget reads the pack
  // ratio here; the compaction decision hooks get the yellow/red/ahead lines
  // via the chain deps (single config source, one read per side). The packing
  // budget is DECOUPLED from the yellow line: the yellow line only gates
  // post-run compaction, the pack line (default 0.70) owns request-assembly
  // omission — loosening the yellow line must not dilute omission.
  const packRatio = config.sessions.compactPackRatio ?? 0.7
  // Fixed per-request overhead for the compaction/packing judgments: the
  // assembled system prompt plus the wire tool schemas. The trigger estimate
  // anchors on the last assistant's reported inputTokens (already including
  // this overhead for anchored requests); this term covers the anchor-less
  // view — fresh session, or the first request after a compaction — and the
  // packing budget below is shrunk by the same amount. Filled in after the
  // system-before/after chains run; hooks read it lazily via the getter.
  const contextOverheadRef = { current: 0 }

  // Register the chain: builtins first (per-run closures), then user files,
  // then test injections. User entries land at default order 1000 — AFTER
  // the builtins within a position, BEFORE the system-audit (order 9000).
  chain.registerAll(makeBuiltinHooks({
    sessionId,
    sessions,
    memory,
    config,
    workspace,
    compactor: engine.compactor,
    signal: controller.signal,
    runLlm,
    model,
    budget,
    usageStore: engine.deps.usageStore,
    busEmit,
    runIdRef: { get current() { return runId } },
    jobNotes,
    trigger: input.trigger,
    llmUserText,
    drainSteer: handoff.drainSteer,
    skillList: skillListPrompt(skills),
    contextOverhead: () => contextOverheadRef.current,
    ...(childRun ? { childRun: true } : {}),
    usageSessionId: sessionMeta?.parentSessionId ?? sessionId,
    compactionAfter: async (phase, result) => {
      try {
        await chain.run("compaction-after", { phase, result })
      } catch {
        // observation must not disturb the compaction that just finished
      }
    },
  }))
  chain.registerAll(engine.deps.hooks?.snapshot() ?? [])
  if (engine.deps.extraHooks !== undefined) chain.registerAll(engine.deps.extraHooks)

  // 系统提示词（提示词缓存纪律）：会话 meta 里已有冻结基线时，基线文本就是
  // 本 run 的系统提示词——组装链（system-before/after）整体跳过，认知刷新、
  // 技能清单、AGENTS.md 与用户钩子的段落变化都不再重写请求前缀（provider
  // 前缀缓存按前缀逐字节命中，前缀稳定 = 纪元内后续 run 全部命中）。审计
  // 照旧每 run 一条全量留痕（直接落盘，与链内 fatal 钩子同语义：写失败即
  // run 失败），审计页的"已变化"标记因此恰落在重冻结点上。压缩事件在投影
  // 里清除基线（applyEvent），下一次 run 重新装配并在审计落盘时重新固化
  // ——压缩本来就使缓存全量失效，纪元边界设在冷启动处零额外成本。
  // 无基线（新会话 / 升级后首 run / 压缩后首 run）走既有链路装配，链内
  // system-audit 落盘时投影自动固化新基线。
  // 子代理 run 的精简模板同样适用（首 run 固化，模板无变化）。
  const frozenBaseline = sessionMeta?.systemBaseline
  let system: string
  if (frozenBaseline !== undefined) {
    system = frozenBaseline.text
    sessions.appendSystem(sessionId, { at: new Date().toISOString(), text: system })
  } else {
    // AGENTS.md 基座 → system-before 链追加段落（内置 system-materials：
    // 认知 + 技能列表）→ 末尾恒定拼接注入约定（放最后保持位置稳定）→
    // system-after 链（用户可改终稿；内置 system-audit fatal 全量留痕——
    // 审计永远记录模型实际看到的那份，落盘即固化新基线）。
    const base = childRun ? subagentSystemPrompt(workspace) : systemPrompt(paths.agentsMd)
    const segments = (await chain.run("system-before", { base })) ?? []
    system = [base, ...segments, SYSTEM_INJECTION_CONVENTION].filter((s) => s !== "").join("\n\n")
    const rewrittenSystem = await chain.run("system-after", { system })
    if (rewrittenSystem !== undefined) system = rewrittenSystem
  }
  contextOverheadRef.current = estimateTokens(system) + estimateTokens(JSON.stringify(toolDefs))

  const outcome = await runAgent(
    {
      sessionId,
      history,
      system,
      userText: input.userText, // ignored by the loop when userMessage is set
      trigger: input.trigger,
      userMessage,
      // 运行起点的压缩视图（来自会话 meta）：upto（含）之前的原文不再发送，
      // 脉络项由打包台垫在 messages[0]。
      ...(sessionMeta?.compaction !== undefined
        ? { compaction: { upto: sessionMeta.compaction.upto, top: sessionMeta.compaction.top } }
        : {}),
    },
    {
      llm: runLlm,
      model,
      tools,
      toolDefs,
      permissions: gate,
      resolveConfirmation,
      confirmTimeoutMs,
      signal: controller.signal,
      llmAttempt: () => llmAttempt,
      hooks: chain,
      toolResultKeep: config.sessions.toolResultKeep ?? 8,
      loopMaxRepeats: config.sessions.toolLoopMaxRepeats,
      // 省略预算（省略线值）透传给打包台：预算装不下的工具输出以省略占位符发送；
      // 固定开销（系统提示词 + 工具定义）先行扣除，打包台只裁决消息内容
      tokenBudget: Math.max(0, budget * packRatio - contextOverheadRef.current),
      ...(maxOutput === undefined ? {} : { maxTokens: maxOutput }),
      onEvent: (e) => {
        if (e.type === "run.started" && e.runId !== undefined) runId = e.runId
        else if (e.type === "llm.completed" || e.type === "llm.failed") llmAttempt = 1
        busEmit(e)
      },
      onMessage: (m) => sessions.appendMessage(m.sessionId, m),
    },
  )
  // run-after 链：用量台账（skip）→ 收尾压缩（fatal：与迁移前一致，压缩失败
  // 传播为条目级失败）→ 跟随门禁（skip）。串行化保证收尾压缩期间新消息排队
  // 无需额外忙碌标记。
  await chain.run("run-after", {
    outcome: {
      stopReason: outcome.stopReason,
      totalUsage: { inputTokens: outcome.totalUsage.inputTokens, outputTokens: outcome.totalUsage.outputTokens },
    },
    model,
  })
  return outcome
}

/**
 * Lazy per-run session_search backing: reads the session's
 * event stream on each call and scans its compacted segments via the pure
 * searchSessionEvents. Legacy-upgrade sessions have no compaction events
 * yet → always "(无可检索内容)" until the first v2 compaction.
 */
function buildSessionSearch(deps: RunEngineDeps, sessionId: string): SessionSearchFn {
  return async (query, limit) => {
    const events = deps.sessions.readEvents(sessionId)
    return searchSessionEvents(events, query, limit)
  }
}

/** AGENTS.md persona when the file exists and non-empty; default otherwise. */
function systemPrompt(agentsMd: string): string {
  try {
    const md = readFileSync(agentsMd, "utf8")
    if (md.trim() !== "") return md
  } catch {
    // missing/unreadable AGENTS.md → default persona
  }
  return DEFAULT_SYSTEM_PROMPT
}
