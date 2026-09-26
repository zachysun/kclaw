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
import { readFileSync, statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import type { AgentEvent, AnyAgentEvent } from "../protocol/events.js"
import type { AttachmentBlock, NoteBlock, ToolCallBlock } from "../protocol/blocks.js"
import { newBlockId } from "../protocol/blocks.js"
import type { Message } from "../protocol/messages.js"
import { newMessage } from "../protocol/messages.js"
import type { AttachmentRef, QueueNote } from "../protocol/wire.js"
import type { LlmClient, ToolDefinition } from "../provider/types.js"
import type { KclawConfig } from "../storage/config.js"
import { defaultConfig, resolveContextTokens, resolveRunModel } from "../storage/config.js"
import type { KclawPaths } from "../storage/paths.js"
import type { UsageStore } from "../storage/usage.js"
import type { SessionStore } from "../session/store.js"
import type { Compactor } from "../session/compactor.js"
import { resolveWaterlines } from "../session/waterlines.js"
import { ConfigPermissionGate, realpathWithin, SessionGrants } from "../permissions/engine.js"
import { appendDecidedRule, globalDecidedRulesPath, loadDecidedRulesForRun, narrowDecidedRule, projectDecidedRulesPath } from "../storage/decided-rules.js"
import type { AutoLearnCounter } from "../permissions/auto-learn.js"
import { ConfirmationBroker, raceConfirmation, type ConfirmationResolution } from "../permissions/broker.js"
import { createExecSandbox } from "../sandbox/provider.js"
import type { PermissionGate, RunOutcome } from "./loop.js"
import { runAgent } from "./loop.js"
import { assembleSystemPrompt } from "./system-prompt.js"
import { subagentSystemPrompt, type SubagentCollector, type SubagentSpawner } from "./subagent.js"
import { teamLeadProtocol, teamMemberSystemPrompt } from "../team/prompt.js"
import type { TeamFacade, TeamIdentity } from "../team/facade.js"
import type { SessionSearchFn } from "../tools/session.js"
import type { ToolExecutor } from "./tools.js"
import { createBuiltinTools, deriveToolFacts, dropSensitiveTools } from "../tools/index.js"
import { makeEvent } from "../protocol/events.js"
import { searchSessionEvents } from "../tools/session-search.js"
import { applyReuseTiers, matchSkillInvocations, projectSkillsDir, readLinksFile, resolveEvolutionGate, scanSkillDirs, skillListPrompt, wrapSkillInvocations } from "../skills/index.js"
import type { SkillEvolutionScheduleBook, SkillEvolutionTriggers } from "../skills/evolution.js"
import { extractFileMentions, wrapFileMentions, type MentionResolution } from "../mentions.js"
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
  /** team = 团队收信箱投递/任务派活（引擎或宿主发起）：不走技能/文件点名包装，处置按提交方显式声明（常规派活=steer）。 */
  trigger: "user" | "job" | "agent" | "team"
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
   * Machine-originated provenance note: lands as a note block right after
   * the text block on the user message. The scheduler passes its
   * 「本会话由定时任务…」 line as kind:"job"; a background completion
   * delivery (#44) passes its identity declaration as kind:"subagent" —
   * the model must be able to tell machine input from user speech.
   */
  note?: QueueNote
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
  resolveConfirmation?: (confirmationId: string) => Promise<ConfirmationResolution | "timeout">
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
   * `entryKey` is the run's resolved provider entry (see resolveRunModel):
   * non-default entries own their endpoint, so the factory builds the
   * matching client; unknown/empty keys fall back to the daemon default.
   * The daemon sets it for its default composition; injected test factories
   * (plain script clients) leave it unset and use `llm` as before.
   */
  llmForRun?: (onRetry: LlmRetrySink, entryKey?: string) => LlmClient
  /**
   * Per-name executor overrides for tests/adapters:
   * merged OVER the builtin tools after construction (defs stay the
   * builtins'), so a test can swap one executor — e.g. for one that throws —
   * without rebuilding the toolset.
   */
  tools?: Map<string, ToolExecutor>
  /**
   * Live adapter tools (e.g. the MCP manager): a FUNCTION of the run's
   * workspace, evaluated per run — the MCP use-view (and its lazy
   * connections) follows the session's project, and connections that come
   * up or drop between runs are reflected in the next LLM request. Defs
   * are appended to the builtin defs; a name collision with a builtin logs
   * once and the adapter's executor wins (schema follows the executor).
   */
  extraTools?: (workdir: string) => { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] }
  /**
   * Subagent dispatch (issue #16): the server-side spawner. When set,
   * mainline runs gain the `subagent_run` builtin tool; the child run's own
   * assembly never sees it (single-level delegation — child detection is the
   * session meta's parentSessionId, not this flag).
   */
  subagents?: { spawner: SubagentSpawner; collector?: SubagentCollector }
  /**
   * Agent team: the server-side team facade. When set,
   * every run probes it once for the session's team identity — lead gets the
   * lead protocol plus the full team tool surface, a member runs the member
   * persona with the member surface, no team changes nothing. The facade
   * lives with the daemon (it spawns sessions and dispatches runs); core
   * only programs against the interface.
   */
  team?: { facade: TeamFacade }
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
  /**
   * 技能进化（提案制）：daemon 注入的完整系统（调度簿记 + 提炼/提案两个面）。
   * run 收尾钩子 skill-follow-check（order 40）消费簿记面做粗查排检查；工具
   * 面 skill_create 消费 propose。config 未开启时钩子直接跳过，工具拿到固定
   * 关闭文案；该 dep 缺席（裸引擎测试）则两者都不在面里。
   */
  skillsEvolution?: SkillEvolutionScheduleBook & SkillEvolutionTriggers
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
 * Workspace resolution of the mention tokens extracted from a user message:
 * each token resolves against the workspace root the same way the permission
 * engine sees file paths (realpath, symlinks followed — an in-workspace link
 * pointing outside escapes). ok = an existing regular file; missing = the
 * path does not resolve to a file (deleted, never existed, or a directory);
 * a token that escapes the workspace is dropped entirely — it stays plain
 * text and produces no instruction line.
 */
export function resolveFileMentions(text: string, workspace: string): MentionResolution[] {
  const root = realpathWithin(resolve(workspace))
  return extractFileMentions(text).flatMap((token): MentionResolution[] => {
    const resolved = realpathWithin(resolve(root, token))
    if (resolved !== root && !resolved.startsWith(root + sep)) return []
    try {
      return statSync(resolved).isFile() ? [{ token, status: "ok" }] : [{ token, status: "missing" }]
    } catch {
      return [{ token, status: "missing" }]
    }
  })
}

/**
 * Compose the skill wrap and the file wrap into one model-facing text. Both
 * wraps keep the user's message VERBATIM with trailing instruction lines, so
 * the composition appends the file wrap's lines (produced by calling
 * wrapFileMentions with an empty message) after the skill wrap's text.
 * undefined = neither wrap matched, send the message as-is.
 */
export function combineMentionTexts(userText: string, skillText: string | undefined, fileLines: string | undefined): string | undefined {
  if (fileLines !== undefined) return (skillText ?? userText) + fileLines
  return skillText
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
  // Team identity probe: one query per run — the host's facade answers
  // lead / member(name) / none from the team directory. A mainline session
  // with no team yet still gets a provisional lead identity so the team
  // surface (create_team first) is reachable — every other team action hits
  // the facade's loud conflict until the team exists. Child runs and job
  // sessions register no team tools at all.
  const teamIdentity =
    engine.deps.team === undefined
      ? null
      : (await engine.deps.team.facade.describeSession(sessionId)) ??
        (childRun || input.trigger === "job"
          ? null
          : { role: "lead" as const, teamId: "", sessionId })

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
  const inputNotes: NoteBlock[] =
    input.note === undefined
      ? []
      : [{ id: newBlockId(), type: "note", kind: input.note.kind, text: input.note.text }]
  const userMessage = newMessage(sessionId, "user", [
    { id: newBlockId(), type: "text", text: input.userText },
    ...mountAttachments(input.attachments ?? [], paths.attachmentsDir, sessionId),
  ])
  if (input.messageId !== undefined) userMessage.id = input.messageId // 气泡原地升级

  // 技能目录每 run 重扫（渐进披露第一层）：全局 + 会话工作目录的项目级，
  // 项目同名整目录覆盖。列表段追加进系统提示词，与 system 审计事件同文；
  // skill_read 工具持有同一份扫描结果（第二层，按需取正文）。
  // 复用技能（他方 agent 软链接接入）的可见档位在合并后按 realpath 覆盖
  // frontmatter 两布尔——项目 scope 的档位后应用、盖过全局，与目录覆盖同向。
  const projectDir = projectSkillsDir(workspace)
  const skills = applyReuseTiers(
    scanSkillDirs({
      global: paths.skillsDir,
      project: projectDir,
    }),
    [readLinksFile(paths.skillsDir), readLinksFile(projectDir)],
  )

  // 技能点名与文件点名的隐式包装（Master 2026-09-03 / 2026-09-13）：用户消
  // 息里任意位置的 /技能名 精确命中已装且用户可调用的技能、@路径 解析为工作
  // 区内的真实文件时，只在发给模型的那份输入上追加调用/读取指示——持久化、
  // 事件流与气泡保持原始文本（所见即所发）。仅 trigger:user 生效：job 提示
  // 是 daemon 生成的内部指令，不参与点名。内置 skill-wrap 钩子捕获这份预计
  // 算文本，在 llm-before 位置应用。
  const llmUserText =
    input.trigger === "user"
      ? combineMentionTexts(
          input.userText,
          wrapSkillInvocations(input.userText, matchSkillInvocations(input.userText, skills)),
          wrapFileMentions("", resolveFileMentions(input.userText, workspace)),
        )
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
    ...(engine.deps.skillsEvolution === undefined
      ? {}
      : {
          skillCreate: {
            enabled: resolveEvolutionGate(config).enabled,
            sessionId,
            propose: (sid: string, input: { name: string; content: string; rationale?: string }) =>
              engine.deps.skillsEvolution!.propose(sid, input),
          },
        }),
    ...(engine.deps.subagents !== undefined && !childRun
      ? {
          subagent: {
            spawner: engine.deps.subagents.spawner,
            parentSessionId: sessionId,
            ...(engine.deps.subagents.collector === undefined ? {} : { collector: engine.deps.subagents.collector }),
          },
        }
      : {}),
    // Mid-run questions (issue #21): every run — mainline and child alike —
    // can ask; the broker is the shared gateway object, and the emitter
    // stamps the events with this run's session/runId context.
    ask: {
      broker: engine.deps.broker,
      timeoutMs: config.sessions.askTimeoutMs,
      emit: (type, payload) => busEmit(makeEvent(type, payload, eventCtx())),
    },
    ...(childRun ? { childRun: true } : {}),
    ...(engine.deps.team !== undefined && teamIdentity !== null
      ? { team: { facade: engine.deps.team.facade, identity: teamIdentity } }
      : {}),
  })
  // test/adapter seam: per-name executor overrides on top of the
  // builtins; toolDefs stay the builtins' — an override replaces behavior,
  // not the schema the model sees.
  if (engine.deps.tools !== undefined) {
    for (const [name, executor] of engine.deps.tools) tools.set(name, executor)
  }
  // Live adapter tools (MCP manager): the view follows the run's workspace;
  // defs appended, executor wins on a name collision with a log line
  // (schema follows the executor).
  if (engine.deps.extraTools !== undefined) {
    const extra = engine.deps.extraTools(workspace)
    for (const [name, executor] of extra.executors) {
      if (tools.has(name)) console.error(`kclaw tool name collision: ${name} (adapter overrides builtin)`)
      tools.set(name, executor)
    }
    toolDefs.push(...extra.defs)
  }

  // Readonly visibility: the gate short-circuits every sensitive tool in
  // readonly mode before any rule (reason "readonly"), so listing one would
  // only buy the model a guaranteed refusal. Narrow the surface instead —
  // builtins and adapters alike; the gate below derives safeTools and tool
  // facts from whatever survives. Surfaces are built per run, so a mode
  // switch takes effect on the next message, same as the gate's own mode
  // snapshot.
  if (sessionMeta?.mode === "readonly") dropSensitiveTools(tools, toolDefs)

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
    // When the sandbox was attempted but unavailable (nothing wrapped), the
    // confirmation carries an explanation instead of the silent fail-closed
    // default.
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

  // Best-effort decided-rule write: a failure logs and the verdict stands.
  const persistDecidedRule = (
    target: string,
    rule: string,
    origin: { tool: string; argsJson: string; sessionId?: string },
    opts: { workspace?: string; autoLearned?: boolean } = {},
  ): void => {
    try {
      appendDecidedRule(target, {
        rule,
        decidedAt: new Date().toISOString(),
        origin,
        ...(opts.autoLearned === true ? { source: "auto" as const } : {}),
      }, opts.workspace === undefined ? {} : { workspace: opts.workspace })
    } catch (e) {
      console.error(`kclaw: failed to persist ${opts.autoLearned === true ? "auto-learned " : ""}decided rule: ${e instanceof Error ? e.message : String(e)}`)
    }
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
  const resolveConfirmation = async (confirmationId: string): Promise<ConfirmationResolution | "timeout"> => {
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
      // denies without consulting the resolver. No decision is archived —
      // an abort is not a verdict.
      return "timeout"
    }
    const timedOut = raced === "timeout"
    if (timedOut) broker.expire(confirmationId)
    // Permission-decision archive: who approved what, and when, lands in the
    // session archive beside the tool row's grantedBy outcome. Timeouts are
    // verdicts too (silence is a "no"); aborts never reach here.
    if (call !== undefined) {
      sessions.appendPermissionDecided(sessionId, {
        at: new Date().toISOString(),
        confirmationId,
        decision: timedOut ? "timeout" : raced.decision,
        by: timedOut ? "timeout" : raced.by,
        tool: { callId: call.callId, name: call.name, argsJson: call.argsJson },
      })
    }
    // Always-allow persistence (project/global): every consequence of one
    // human verdict lives in this seam. Best-effort — a write failure logs
    // and the settled verdict stands; a once/reject/timeout verdict never
    // writes a rule.
    if (!timedOut && (raced.decision === "project" || raced.decision === "global") && call !== undefined) {
      persistDecidedRule(
        raced.decision === "global" ? globalDecidedRulesPath(paths.home) : projectDecidedRulesPath(workspace),
        narrowDecidedRule(call, workspace),
        { tool: call.name, argsJson: call.argsJson, sessionId },
        raced.decision === "project" ? { workspace } : {},
      )
    }
    // SessionGrants (batch D): a once-approval also lands in this run's grant
    // store, keyed by the same narrowed rule the gate re-checks — the same
    // call within THIS run stops re-prompting. project/global approvals
    // already persist a rule (no grant needed); reject/timeout never grant.
    // The gate skips grants in `auto` mode (learning observes human
    // confirmations), so an auto-mode write here is dead weight — harmless,
    // and kept unconditional so the seam never has to know the gate's modes.
    if (!timedOut && raced.decision === "once" && call !== undefined) {
      grants?.grant(narrowDecidedRule(call, workspace))
    }
    const autoLearn = engine.deps.autoLearn
    if (autoLearn !== undefined && sessionMeta?.mode === "auto" && call !== undefined) {
      // Key is scoped per session: streaks must never leak across sessions
      // (another session's approvals must not help this one cross the
      // threshold) even though the counter is one per process.
      const ruleKey = narrowDecidedRule(call, workspace)
      const key = `${sessionId}\n${ruleKey}`
      if (!timedOut && raced.decision === "once") {
        if (autoLearn.counter.approve(key)) {
          persistDecidedRule(
            projectDecidedRulesPath(workspace),
            ruleKey,
            { tool: call.name, argsJson: call.argsJson, sessionId },
            { workspace, autoLearned: true },
          )
        }
      } else if (timedOut || raced.decision === "reject") {
        // a "no" — explicit or by silence — resets the streak
        autoLearn.counter.reject(key)
      }
    }
    return timedOut ? "timeout" : raced
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
  // Default model line: the default entry's CURRENT model wins (Model-tab
  // edits hot-apply); the launch-resolved deps.model only backs env-only
  // setups with no configured entry.
  const defaultModel = config.providers.entries[config.providers.default]?.model || engine.deps.model || ""
  const rawModel = input.model ?? sessionMeta?.model ?? defaultModel
  // Entry metadata for this run: the wire model (entry names resolve to the
  // entry's `.model`), the budget (contextWindow cap via resolveContextTokens)
  // feeds every compaction line and the packing budget; maxOutput rides each
  // request as max_tokens.
  const { model, entryKey, budget, maxOutput } = resolveRunModel(config, rawModel)
  // The client resolves AFTER the entry: every entry owns its endpoint, so
  // llmForRun needs the resolved entry key to build the matching client.
  const runLlm = engine.deps.llmForRun?.(onLlmRetry, entryKey) ?? engine.deps.llm
  // Waterlines resolved once for this run's budget: the request-assembly
  // omission budget reads the pack line here; the compaction trigger hooks get
  // the full schedule via the chain deps. The packing budget is DECOUPLED from
  // the yellow line: the yellow line only gates post-run compaction, the pack
  // line owns request-assembly omission — loosening the yellow line must not
  // dilute omission.
  const waterlines = resolveWaterlines(config, budget)

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
    waterlines,
    usageStore: engine.deps.usageStore,
    busEmit,
    runIdRef: { get current() { return runId } },
    inputNotes,
    trigger: input.trigger,
    llmUserText,
    drainSteer: handoff.drainSteer,
    skillList: skillListPrompt(skills),
    skillNames: skills.map((s) => s.name),
    ...(engine.deps.skillsEvolution === undefined ? {} : { skillsEvolution: engine.deps.skillsEvolution }),
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

  // 系统提示词组装 + 双段冻结 + 审计落盘在 system-prompt.ts 一处完成；
  // 固定开销在这里赋值一次，压缩/打包钩子经 contextOverhead 读取函数惰性
  // 取值（钩子注册先于组装，读取函数必须保持惰性）。
  const { system, overheadTokens } = await assembleSystemPrompt({
    chain,
    sessions,
    sessionId,
    base: resolveBasePrompt({ childRun, team: teamIdentity, workspace, agentsMd: paths.agentsMd }),
    baseline: sessionMeta?.systemBaseline,
    toolDefs,
  })
  contextOverheadRef.current = overheadTokens

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
      tokenBudget: Math.max(0, waterlines.pack - contextOverheadRef.current),
      ...(maxOutput === undefined ? {} : { maxTokens: maxOutput }),
      onEvent: (raw) => {
        // Narrow to the distributive form so per-type payload access typechecks.
        const e = raw as AnyAgentEvent
        if (e.type === "run.started" && e.runId !== undefined) runId = e.runId
        else if (e.type === "llm.completed" || e.type === "llm.failed") llmAttempt = 1
        // Run-boundary archive: every run brackets its message events with a
        // run.started + run.ended pair in the session archive, so the archive
        // shows where each run began and ended without inferring it from the
        // last assistant message's stop reason. A failed run lands an ended
        // record too (stopReason "error" + the failure) — a started run
        // always reaches a terminal record, same invariant as the wire
        // events. Same contract as the system/sandbox audit events: a write
        // failure fails the run (the audit promise is all-or-nothing).
        if (e.type === "run.started") {
          sessions.appendRunStarted(sessionId, { at: new Date().toISOString(), trigger: e.payload.trigger })
        } else if (e.type === "run.completed") {
          sessions.appendRunEnded(sessionId, {
            at: new Date().toISOString(),
            stopReason: e.payload.stopReason,
            usage: e.payload.usage,
          })
        } else if (e.type === "run.failed") {
          sessions.appendRunEnded(sessionId, {
            at: new Date().toISOString(),
            stopReason: "error",
            error: e.payload.error,
          })
        }
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

/**
 * Base-persona selection (the stable segment's head, agent-team): a member
 * runs the lean member template, the lead appends the team protocol to the
 * mainline persona — the baseline comparison re-freezes the changed stable
 * segment, so the protocol hot-applies on the first run after create_team —
 * a plain subagent child keeps the subagent template, everyone else gets the
 * mainline persona unchanged.
 */
export function resolveBasePrompt(opts: {
  childRun: boolean
  team: TeamIdentity | null
  workspace: string
  agentsMd: string
}): string {
  if (opts.team?.role === "member") return teamMemberSystemPrompt(opts.workspace, opts.team.name)
  const main = systemPrompt(opts.agentsMd)
  if (opts.team?.role === "lead") return `${main}\n\n${teamLeadProtocol()}`
  return opts.childRun ? subagentSystemPrompt(opts.workspace) : main
}
