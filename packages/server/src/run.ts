/**
 * RunManager — the daemon-side assembly of one runAgent invocation.
 *
 * `enqueue` is the send_message pipeline: per-session serialization, memory
 * note injection onto a caller-persisted user message, AGENTS.md system
 * prompt, builtin tools, a permission gate, event bus fan-out and JSONL
 * persistence — the composition proven by the integration smoke test, now
 * owned by the server.
 *
 * Composition choices pinned here:
 * - History is read BEFORE the user message is appended: runAgent places its
 *   user message after `history` (`[...input.history, userMsg]`), so it must
 *   not already contain it (would double-send the text to the provider).
 * - The user message is built here as a text-only skeleton and passed via
 *   `RunInput.userMessage`; runAgent uses it verbatim and does NOT re-persist
 *   it. Its note blocks (job provenance + memory notes) are appended — and
 *   the finished message appended to the session log — inside the run's
 *   `onUserMessage` hook, landing between the loop's
 *   message.created and message.completed so the bus carries the wire order
 *   run.started → message.created → note.emitted ×N → message.completed.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  chooseBoundary,
  collectStreamText,
  ConfigPermissionGate,
  createBuiltinTools,
  emergencyBoundary,
  estimateContextTokens,
  makeEvent,
  newBlockId,
  newId,
  newMessage,
  realpathWithin,
  renderSegment,
  runAgent,
  segmentRanges,
  SegmentIndex,
} from "@kclaw/core"
import type {
  ActiveSummary,
  AgentEvent,
  AttachmentBlock,
  CompactionPhase,
  CompactionState,
  KclawConfig,
  KclawPaths,
  LlmClient,
  MemoryStore,
  Message,
  NoteBlock,
  PermissionGate,
  QueueEntry,
  RunOutcome,
  SessionSearchFn,
  SessionStore,
  ToolCallBlock,
  ToolExecutor,
  ToolDefinition,
  UsageStore,
} from "@kclaw/core"
import type { EventBus } from "./bus.js"
import { ConfirmationBroker, type ConfirmationResolution } from "./confirm.js"
import { scheduleAutoname } from "./autoname.js"

/** System prompt fallback when ~/.kclaw/AGENTS.md is missing or empty. */
const DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"

/** How many chars of the user text feed the memory lookup. */
const MEMORY_QUERY_CHARS = 200
/** Top-N memory notes injected onto the user message. */
const MEMORY_LIMIT = 5

/** Segment summarizer prompt (spec 6.2.2, verbatim-pinned). */
const SEGMENT_SUMMARY_PROMPT =
  "你是对话摘要器。把给定的一段对话（可能包含工具调用与结果）压缩为不超过800字的中文摘要，使用以下固定五个二级标题的 markdown 结构：## 关键事实、## 用户偏好与约定、## 已做决定、## 未完成事项、## 文件与命令。\"文件与命令\"一栏只记路径或命令加一句话要点，不要复制文件内容。同一栏目内每条一行。直接输出摘要正文，不要任何前后缀。"

/** Top-summary merge prompt (spec 6.2.3, verbatim-pinned). */
const MERGE_SUMMARY_PROMPT =
  "你是对话摘要归并器。输入是旧的总摘要和一个新的段摘要，两者都是同样五栏结构的 markdown。把它们归并为一份新的总摘要：保持同样的五个二级标题；同一栏目内合并去重；同一事项有先后版本时保留新版本，并注明被推翻的旧版本；总长不超过800字。直接输出摘要正文，不要任何前后缀。"

/** Verbatim memory-extraction system prompt (spec-pinned). */
const EXTRACT_SYSTEM_PROMPT =
  "从对话中提取值得长期记住的用户个人事实（居住地、偏好、约定、背景等）。只输出 JSON 字符串数组，无值得记的内容输出 []。"

/** Text-like MIME/exif: inlined into context when small enough. */
const TEXT_MIME = /^text\//
const TEXT_EXT = /\.(md|txt|json|csv|yaml|yml|xml|log|ts|js|tsx|jsx|py|go|rs|sh|toml|ini|env)$/i
/** Cap for inlining a text attachment into the prompt (chars). */
const TEXT_INLINE_MAX_CHARS = 8 * 1024
/** Cap for reading a text attachment off disk (bytes). */
const TEXT_INLINE_MAX_BYTES = 64 * 1024
/** Cap for embedding an image as base64 (bytes). */
const IMAGE_INLINE_MAX_BYTES = 5 * 1024 * 1024

/**
 * Turn attachment references into attachment blocks on the user message.
 * Decision per file: text-like and small → inline text (capped); image and
 * small → base64 source (multimodal parts); anything else → metadata only,
 * the agent reads it on demand via fs_read. Any path outside the session's
 * attachments dir is rejected (defense in depth — the caller validates too).
 */
function mountAttachments(refs: AttachmentRef[], attachmentsDir: string, sessionId: string): AttachmentBlock[] {
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

export interface RunManagerDeps {
  config: KclawConfig
  paths: KclawPaths
  sessions: SessionStore
  memory: MemoryStore
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
   * Confirmation gateway: pending confirmations register here when
   * the gate issues them, and WS/CLI verdicts settle through it. Missing → a
   * fresh internal broker, exposed as `manager.broker` (the daemon hands the
   * RunManager to createApp via its `run` option, which routes
   * confirmation.resolve frames to this broker).
   */
  broker?: ConfirmationBroker
  /**
   * Direct resolver override for tests. Takes precedence over the broker when
   * set — the daemon path relies on the broker alone.
   */
  resolveConfirmation?: (confirmationId: string) => Promise<{ approved: boolean; by: "cli" | "web" | "timeout" }>
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
  /** Per-run token ledger (optional; recording failures are swallowed). */
  usageStore?: UsageStore
  /** Daemon-level readonly flag (`--readonly`): all sessions start read-only. */
  readonly?: boolean
}

/** One queued run request. */
export interface EnqueueInput {
  userText: string
  trigger: "user" | "job"
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
  /** 单次显式处置（spec §6 层级最高）；缺省 = 会话覆盖 ?? 配置默认；job 触发强制 wait。 */
  disposition?: "steer" | "wait" | "interrupt"
  /** 内部：出队执行时传入的预分配消息 id（ws 层不传）。 */
  messageId?: string
}

/** submit 的同步决策结果：消息身份、是否入队与实际生效处置（降级后）。 */
export interface SubmitResult {
  messageId: string
  /** false = 空闲直发（现状行为：不广播 message.queued）。 */
  queued: boolean
  /** 实际生效处置：steer 无活动 run 时降级为 wait（spec §4.2）。 */
  disposition: "steer" | "wait" | "interrupt"
  /**
   * wait/interrupt：本条 run 的 outcome；steer：随当前 run settle
   * （参考值，ws 层 fire-and-forget，spec §3.3）。
   */
  outcome: Promise<RunOutcome>
}

/** A reference to an uploaded attachment file (mounted as an attachment block). */
export interface AttachmentRef {
  path: string
  name: string
  size: number
  mimeType: string
}

/** withRetry's per-attempt notification shape (core provider/retry.ts onRetry). */
export type LlmRetrySink = (info: { attempt: number; error: unknown }) => void

/**
 * One in-memory queue node: the persisted entry plus its settle plumbing.
 * `entry` is what lands in meta.queue (spec §3.1)；outcome 在本条 run 结束时
 * 以其 RunOutcome settle（wait/interrupt 为本条 run，steer 不建 node）。
 * `model` 是仅存于内存的入队时 per-run 覆盖（QueueEntry 不含 model，出队时
 * 在此还原——现状行为：job 的配置模型与调用方强制模型不因排队而丢失；
 * steer 降级路径无此附加，因旧实现本无 steer，无从保留）。
 */
interface QueueNode {
  entry: QueueEntry
  model?: string
  resolve(o: RunOutcome): void
  reject(e: unknown): void
  outcome: Promise<RunOutcome>
}

/** Build a queue node: the entry plus a deferred outcome promise. */
function makeNode(entry: QueueEntry): QueueNode {
  let resolve!: QueueNode["resolve"]
  let reject!: QueueNode["reject"]
  const outcome = new Promise<RunOutcome>((res, rej) => { resolve = res; reject = rej })
  // 哑 handler：标记"拒绝已处理"，防止无人观察的 node（ws fire-and-forget 的
  // steer 降级条目）在 run 抛错时演成 unhandled rejection；真实消费者
  // （wait 条目的 enqueue 调用方）仍通过自己的 .catch/await 收到原拒绝。
  outcome.catch(() => undefined)
  return { entry, resolve, reject, outcome }
}

/**
 * Mirror of the loop's raceConfirmation (core agent/loop.ts): a human
 * resolver raced against the same confirmTimeoutMs timer and the run's abort
 * signal. On a timeout the LOOP synthesizes `{approved: false, by:
 * "timeout"}` itself and never settles the human promise, so the resolver
 * alone would never fire the broker-expire that marks the entry stale.
 * Racing here keeps this adapter's view of the resolution semantically
 * identical to the one the loop acted on (same timeout on both sides yields
 * the same value; a human verdict that wins here also wins there), and a
 * losing late verdict is discarded by the settled race.
 */
function raceResolution(
  p: Promise<ConfirmationResolution>,
  ms: number,
  signal: AbortSignal,
): Promise<ConfirmationResolution | "aborted"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const sleep = new Promise<ConfirmationResolution>((resolve) => {
    timer = setTimeout(() => resolve({ approved: false, by: "timeout" }), ms)
  })
  let onAbort = () => {}
  const abort = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted")
    else {
      onAbort = () => resolve("aborted")
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
  return Promise.race([p, sleep, abort]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  })
}

export class RunManager {
  /** 每会话排队 + steer 缓冲合计上限（spec §5.5）；先写死，不做配置项。 */
  static readonly QUEUE_LIMIT = 10

  readonly #deps: RunManagerDeps
  /** 每会话可执行条目（wait/interrupt），数组顺序即执行顺序（spec §3.2）。 */
  readonly #queues = new Map<string, QueueNode[]>()
  /** steer 缓冲（spec §3.4）：活动 run 在迭代边界取走（Task 5）；settle 后残余降级入队尾。 */
  readonly #steerBuf = new Map<string, QueueEntry[]>()
  /** 每会话驱动循环（spec §5.4）；存在即该会话的队列由驱动器托管。 */
  readonly #drivers = new Map<string, Promise<void>>()
  /** Abort controller of the session's ACTIVE run; absent while idle or queued. */
  readonly #active = new Map<string, AbortController>()
  /** 活动 run 的 outcome：steer 的参考 outcome / 降级时序。 */
  readonly #activeOutcomes = new Map<string, Promise<RunOutcome>>()
  /**
   * 每会话压缩取消标记（spec 5.3 第 6 条）：cancelCompaction 写入，压制本次
   * 运行内的全部自动压缩（中途/收尾）；每次 #execute 开头清除——取消只作用于
   * 当时那次运行，新运行从干净状态恢复。
   */
  readonly #compactionCancelled = new Set<string>()
  /** 每会话在飞的自动压缩 controller：cancelCompaction 掐它；finally 清理。 */
  readonly #compactionCtrl = new Map<string, AbortController>()
  /** Confirmation gateway shared by every run; injected or internally constructed. */
  readonly #broker: ConfirmationBroker

  constructor(deps: RunManagerDeps) {
    this.#deps = deps
    this.#broker = deps.broker ?? new ConfirmationBroker()
  }

  /** The confirmation gateway this manager's runs answer through (WS/CLI verdicts land here). */
  get broker(): ConfirmationBroker {
    return this.#broker
  }

  /**
   * 同步决策一条消息的去向（spec §4.1）：空闲直发；steer 且有活动 run →
   * 入缓冲区；其余（wait/interrupt，以及无活动 run 的 steer 降级 wait）入队，
   * interrupt 伴随对活动 run 的 abort。立即返回消息身份与实际生效处置。
   */
  submit(sessionId: string, input: EnqueueInput): SubmitResult {
    const { config, sessions, bus } = this.#deps
    const meta = sessions.meta(sessionId)
    if (meta === undefined) throw new Error("session not found")
    // 处置解析链（spec §6）：显式 > 会话覆盖 > 配置默认；job 触发固定 wait（不读默认）
    const disposition = input.trigger === "job"
      ? "wait"
      : input.disposition ?? meta.dispositionOverride ?? config.sessions.defaultDisposition ?? "steer"
    const queue = this.#queues.get(sessionId) ?? []
    const steer = this.#steerBuf.get(sessionId) ?? []
    if (queue.length + steer.length >= RunManager.QUEUE_LIMIT) {
      throw new Error(`队列已满（${RunManager.QUEUE_LIMIT} 条）`)
    }
    const entry: QueueEntry = {
      messageId: input.messageId ?? newId("msg"),
      disposition,
      text: input.userText,
      trigger: input.trigger,
      ...(input.attachments !== undefined && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      enqueuedAt: new Date().toISOString(),
    }
    // 空闲 = 无活动 run、无可执行条目、无驱动器 → 直发开跑（spec §4.1：不广播 message.queued）
    const idle = !this.#active.has(sessionId) && queue.length === 0 && !this.#drivers.has(sessionId)
    if (idle) {
      const node = makeNode(entry)
      if (input.model !== undefined) node.model = input.model // 内存还原用（现状行为）
      this.#queues.set(sessionId, [node]) // 直发条目也由驱动器托管（settle 后的 steer 降级才有人接）
      this.#drive(sessionId)
      return { messageId: entry.messageId, queued: false, disposition, outcome: node.outcome }
    }
    if (disposition === "steer" && this.#active.has(sessionId)) {
      steer.push(entry)
      this.#steerBuf.set(sessionId, steer)
      this.#persistQueue(sessionId)
      bus.emit(makeEvent("message.queued", { messageId: entry.messageId, disposition: "steer" }, { sessionId }))
      // outcome：随当前 run settle（参考值；ws 层 fire-and-forget，spec §3.3）
      const active = this.#activeOutcomes.get(sessionId)
        ?? Promise.resolve({ stopReason: "aborted", totalUsage: { inputTokens: 0, outputTokens: 0 }, messages: [] })
      return { messageId: entry.messageId, queued: true, disposition: "steer", outcome: active }
    }
    // steer 但无活动 run（队列在转）：降级 wait 入队并报 wait（spec §4.2）
    const effective = disposition === "steer" ? ("wait" as const) : disposition
    const atHead = effective === "interrupt"
    const node = makeNode({ ...entry, disposition: effective })
    if (input.model !== undefined) node.model = input.model // 内存还原用（现状行为）
    if (atHead) {
      queue.unshift(node)
      if (this.#active.has(sessionId)) this.#active.get(sessionId)!.abort() // spec §5.3：中断伴随 abort
    } else {
      queue.push(node)
    }
    this.#queues.set(sessionId, queue)
    this.#persistQueue(sessionId)
    bus.emit(makeEvent("message.queued", { messageId: node.entry.messageId, disposition: effective, position: atHead ? 0 : queue.length - 1 }, { sessionId }))
    this.#drive(sessionId)
    return { messageId: node.entry.messageId, queued: true, disposition: effective, outcome: node.outcome }
  }

  /**
   * Queue one run on the session. 兼容包装 = submit().outcome（spec §3.3）：
   * Promise 仍是 ws 层 fire-and-forget 的返回值，但不再是排队载体——
   * wait/interrupt 随本条 run settle；steer 随当前 run settle（参考值）。
   */
  enqueue(sessionId: string, input: EnqueueInput): Promise<RunOutcome> {
    return this.submit(sessionId, input).outcome
  }

  /**
   * 内存队列镜像（spec §3.2）：可执行条目 + steer 缓冲，数组顺序即执行
   * 顺序。与 meta.queue 同构，供队列查询/恢复使用。
   */
  queue(sessionId: string): QueueEntry[] {
    return [
      ...(this.#queues.get(sessionId) ?? []).map((n) => n.entry),
      ...(this.#steerBuf.get(sessionId) ?? []),
    ]
  }

  /**
   * 仅中止会话的活动 run（语义收窄，spec §5.4/§9）：它停在下一个检查点并
   * 以 stopReason "aborted" 结束。排队消息不受影响——排队取消一律走
   * queue.cancel（Task 5）。无活动 run 时返回 false。
   */
  cancel(sessionId: string): boolean {
    const controller = this.#active.get(sessionId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /**
   * 取消自动压缩（spec 5.3 第 6 条，Task 8 的 ws 层调用）：abort 在飞的压缩
   * controller（#compactV2 的取消分支吞掉中止，发 completed result:"cancelled"），
   * 同时写 #compactionCancelled 标记——本次 #execute 内后续的中途/收尾压缩
   * 钩子据此直接跳过；标记在下一次 #execute 开头清除，新运行恢复正常压缩。
   * 返回：调用时刻是否存在在飞的压缩（false = 没什么可掐，但标记仍写入，
   * 压制本次运行内尚未发生的自动压缩）。
   */
  cancelCompaction(sessionId: string): boolean {
    this.#compactionCancelled.add(sessionId)
    const ctrl = this.#compactionCtrl.get(sessionId)
    if (ctrl === undefined) return false
    ctrl.abort()
    return true
  }

  /**
   * 排队取消（spec §5.6）：wait 随时、steer 注入前；已注入的不删（机器不删历史）。
   * 带 id：单条取消（先查可执行队列，再查 steer 缓冲；都不在且近期已注入 →
   * injected，进了 JSONL 机器不删）；不带 id：清空全部 wait + 未注入 steer，
   * 广播 message.queue_cancelled {all:true}。
   */
  queueCancel(sessionId: string, messageId?: string): { ok: true; cancelled: string[] } | { ok: false; reason: "not_found" | "injected" } {
    const cancelIds: string[] = []
    if (messageId !== undefined) {
      const queue = this.#queues.get(sessionId) ?? []
      const qIdx = queue.findIndex((n) => n.entry.messageId === messageId)
      if (qIdx >= 0) {
        queue.splice(qIdx, 1)
        this.#queues.set(sessionId, queue)
        cancelIds.push(messageId)
      } else {
        const buf = this.#steerBuf.get(sessionId) ?? []
        const bIdx = buf.findIndex((e) => e.messageId === messageId)
        if (bIdx >= 0) {
          buf.splice(bIdx, 1)
          this.#steerBuf.set(sessionId, buf)
          cancelIds.push(messageId)
        }
      }
      if (cancelIds.length === 0) {
        return this.#injectedIds.has(messageId)
          ? { ok: false, reason: "injected" }
          : { ok: false, reason: "not_found" }
      }
    } else {
      for (const n of this.#queues.get(sessionId) ?? []) cancelIds.push(n.entry.messageId)
      this.#queues.delete(sessionId)
      for (const e of this.#steerBuf.get(sessionId) ?? []) cancelIds.push(e.messageId)
      this.#steerBuf.delete(sessionId)
    }
    this.#persistQueue(sessionId)
    this.#deps.bus.emit(makeEvent(
      "message.queue_cancelled",
      messageId !== undefined ? { messageId } : { all: true },
      { sessionId },
    ))
    return { ok: true, cancelled: cancelIds }
  }

  /**
   * Manual compaction (spec 6.5): runs #compactV2 with a focus, ignoring
   * the trigger line. Both refusals (spec §5.7) are checked before any
   * compaction work, queue first: when an active run AND a backed-up queue
   * coexist, the queued-count message is the actionable one — "wait it out"
   * alone never unblocks a backed-up queue. Compaction reads full history
   * and writes meta, which a concurrent run would corrupt.
   */
  async compactSession(sessionId: string, focus?: string): Promise<{ message: string }> {
    const pending = this.queue(sessionId).length
    if (pending > 0) throw new Error(`还有 ${pending} 条排队消息，先处理或取消`)
    if (this.#active.has(sessionId)) throw new Error("会话正在运行，等它结束")
    const { config, sessions, llm } = this.#deps
    const meta = sessions.meta(sessionId)
    if (meta === undefined) throw new Error("session not found")
    const history = sessions.readMessages(sessionId)
    const defaultModel = this.#deps.model ?? config.providers.entries[config.providers.default]?.model ?? ""
    const model = config.providers.entries[meta.model ?? ""]?.model ?? meta.model ?? defaultModel
    const out = await this.#compactV2(sessionId, history, "", config, llm, model, { focus, manual: true, phase: "manual" })
    return {
      message: out.compacted
        ? `压缩了 ${out.segments} 段，剩 ${out.active.length} 条原文消息`
        : "无可压缩内容",
    }
  }

  /** daemon 启动恢复（spec §5.5）：持久化队列整体重排，steer/interrupt 一律降级 wait。 */
  recoverQueues(): void {
    for (const meta of this.#deps.sessions.list()) {
      const entries = meta.queue
      if (entries === undefined || entries.length === 0) continue
      const demoted: QueueEntry[] = entries.map((e) => ({ ...e, disposition: "wait" }))
      this.#deps.sessions.updateMeta(meta.id, { queue: demoted })
      const queue = this.#queues.get(meta.id) ?? []
      demoted.forEach((entry, i) => {
        queue.push(makeNode(entry))
        this.#deps.bus.emit(makeEvent("message.queued", { messageId: entry.messageId, disposition: "wait", position: i }, { sessionId: meta.id }))
      })
      this.#queues.set(meta.id, queue)
      this.#drive(meta.id)
    }
  }

  /**
   * 每会话驱动循环（spec §5.4）：run settle → 残余 steer 降级并入队尾 →
   * 队列非空？出队执行 → 循环。已在转则幂等返回。
   *
   * 出队阶段的意外失败（#demoteSteer / 出队后的 #persistQueue 的 meta 写盘炸掉，如
   * 会话被删、盘满）不允许重演两种死法：会话永久停转（僵尸驱动器让后续
   * submit 全部幂等返回、队列无人消费），或循环 promise 裸拒绝（unhandled
   * rejection）。处理：手头已出队的 node 以该错误落定（等待方看见失败而非
   * 永久悬挂）并**塞回队首**——persist 抛错意味着 meta.queue 也没写成，塞回后
   * 内存与盘上重新一致，条目留在队列等待下一次出队重试，而不是被此后任何一次
   * 成功的持久化按内存视图无声抹掉；#drivers 同步删除——下一次 submit 重新起转
   * （自愈）；错误日志一次。两条失败路径（出队持久化、条目执行）都补发条目级
   * 可见性事件（#emitEntryFailed）：已 ack 的消息不允许无声消失。
   */
  #drive(sessionId: string): void {
    if (this.#drivers.has(sessionId)) return
    let stopped = false // 循环在同步首拍内已退出（空队列返回 / 出队失败崩溃）
    const loop = (async (): Promise<void> => {
      try {
        for (;;) {
          let node: QueueNode | undefined
          try {
            this.#demoteSteer(sessionId) // settle 后（以及驱动器启动时）先降级残余 steer
            const queue = this.#queues.get(sessionId)
            if (queue === undefined || queue.length === 0) {
              this.#queues.delete(sessionId)
              this.#drivers.delete(sessionId)
              return
            }
            node = queue.shift()!
            this.#persistQueue(sessionId) // 出队即从 meta.queue 删除（原子重写）
          } catch (err) {
            if (node !== undefined) {
              // persist 失败 = meta.queue 未动：塞回队首恢复两边一致，条目等待重试
              const queue = this.#queues.get(sessionId) ?? []
              queue.unshift(node)
              this.#queues.set(sessionId, queue)
              this.#emitEntryFailed(sessionId, node, "出队持久化失败（条目已退回队列）", err)
            }
            node?.reject(err)
            this.#drivers.delete(sessionId)
            throw err
          }
          try {
            node.resolve(await this.#executeEntry(sessionId, node))
          } catch (err) {
            // 循环自己的 run.failed 兜不到的条目级失败（如降级坏附件在装配段同步抛）
            this.#emitEntryFailed(sessionId, node, "执行失败", err)
            node.reject(err)
          }
        }
      } finally {
        stopped = true
      }
    })()
    // 循环自身的意外错误只日志一次；循环 promise 绝不裸拒绝（unhandled rejection）。
    void loop.catch((err) => {
      console.error(`kclaw run queue driver (${sessionId}) crashed:`, err)
    })
    // 同步首拍即崩溃时循环已自行删除 #drivers：不得把死循环复登记成僵尸。
    if (!stopped) this.#drivers.set(sessionId, loop)
  }

  /** 残余 steer → wait 并入队尾（spec §3.4/§5.4），原顺序保持。 */
  #demoteSteer(sessionId: string): void {
    const buf = this.#steerBuf.get(sessionId)
    if (buf === undefined || buf.length === 0) return
    this.#steerBuf.set(sessionId, [])
    const queue = this.#queues.get(sessionId) ?? []
    for (const e of buf) queue.push(makeNode({ ...e, disposition: "wait" }))
    this.#queues.set(sessionId, queue)
    this.#persistQueue(sessionId)
  }

  /**
   * 条目级失败可见性：出队持久化 / 条目执行的失败发生时循环的 run.failed
   * 兜不住（run 还没起，或同步抛在装配段）——已 ack `queued:true` 的消息
   * 不允许无声消失。以 run.failed 形状补一条 code "queue_entry_failed" 的
   * 事件（message 含 messageId 与原因），订阅客户端据此可见；总线发送
   * 本身不再包裹（与 submit/queueCancel 的直接 emit 一致，逐 socket 投递
   * 已由 EventBus 自守）。
   */
  #emitEntryFailed(sessionId: string, node: QueueNode, why: string, err: unknown): void {
    this.#deps.bus.emit(makeEvent("run.failed", {
      error: {
        code: "queue_entry_failed",
        message: `排队消息 ${node.entry.messageId} ${why}：${err instanceof Error ? err.message : String(err)}`,
      },
    }, { sessionId }))
  }

  /** meta.queue = 可执行条目 + steer 缓冲，数组顺序即执行顺序（spec §3.2）；空则删除字段。 */
  #persistQueue(sessionId: string): void {
    const entries = [
      ...(this.#queues.get(sessionId) ?? []).map((n) => n.entry),
      ...(this.#steerBuf.get(sessionId) ?? []),
    ]
    this.#deps.sessions.updateMeta(sessionId, entries.length === 0 ? { queue: undefined } : { queue: entries })
  }

  /**
   * 执行一条出队条目（spec §5.2）：登记活动 controller（在任何 await 之前，
   * 消除旧实现的取消注册窗口）、记录活动 outcome 供 steer 参考，结束后清理。
   * 入队时的 per-run model 覆盖从 node 还原（内存附加，见 QueueNode）。
   */
  async #executeEntry(sessionId: string, node: QueueNode): Promise<RunOutcome> {
    const controller = new AbortController()
    this.#active.set(sessionId, controller)
    const entry = node.entry
    const input: EnqueueInput = {
      userText: entry.text,
      trigger: entry.trigger,
      ...(node.model !== undefined ? { model: node.model } : {}),
      ...(entry.attachments !== undefined && entry.attachments.length > 0 ? { attachments: entry.attachments } : {}),
      ...(entry.note !== undefined ? { note: entry.note } : {}),
      messageId: entry.messageId,
    }
    const execution = this.#execute(sessionId, input, controller)
    this.#activeOutcomes.set(sessionId, execution)
    try {
      return await execution
    } finally {
      if (this.#active.get(sessionId) === controller) this.#active.delete(sessionId)
      this.#activeOutcomes.delete(sessionId)
    }
  }

  async #execute(sessionId: string, input: EnqueueInput, controller: AbortController): Promise<RunOutcome> {
    // controller 由 #executeEntry 在任何 await 之前创建并登记（spec §5.2）：
    // 出队执行的取消窗口与活动清理都在那里，这里只消费它的 signal。
    // 压缩取消标记只压制一次运行（spec 5.3 第 6 条）：新运行从干净状态开始。
    this.#compactionCancelled.delete(sessionId)
    const { config, paths, sessions, memory, bus, llm } = this.#deps
    const sessionMeta = sessions.meta(sessionId)
    const workspace = sessionMeta?.workdir ?? this.#deps.workspace

    // Memory injection: the leading 200 chars of the user text
    // look up the top-5 notes. Memory is an accelerator — a failing search
    // must never block the run, so misses/errors just mean no notes.
    const notes: NoteBlock[] = []
    try {
      for (const hit of await memory.search(input.userText.slice(0, MEMORY_QUERY_CHARS), MEMORY_LIMIT)) {
        notes.push({ id: newBlockId(), type: "note", kind: "memory", text: `相关记忆: ${hit.text}` })
      }
    } catch {
      // ignore: run without memory context
    }

    // History BEFORE the append (runAgent appends the user message itself).
    // The user message starts as a text-only SKELETON: its note blocks (job
    // provenance first, memory notes after) are appended inside
    // the run's onUserMessage hook, right after the loop announced the
    // skeleton via message.created, so the bus carries the wire order
    // run.started → message.created → note.emitted ×N → message.completed,
    // with the note events (inside the hook) trailing the JSONL append —
    // the persist happens first, then the notes are announced.
    const history = sessions.readMessages(sessionId)
    const jobNote: NoteBlock[] =
      input.note === undefined
        ? []
        : [{ id: newBlockId(), type: "note", kind: "job", text: input.note }]
    const userMessage = newMessage(sessionId, "user", [
      { id: newBlockId(), type: "text", text: input.userText },
      ...mountAttachments(input.attachments ?? [], paths.attachmentsDir, sessionId),
    ])
    if (input.messageId !== undefined) userMessage.id = input.messageId // 气泡原地升级（spec §3.1）

    const { tools, toolDefs } = createBuiltinTools({
      workspace,
      memory,
      tavilyApiKey: config.web.tavilyApiKey,
      exec: { timeoutMs: config.exec.timeoutMs, maxOutputBytes: config.exec.maxOutputBytes },
      web: { timeoutMs: config.web.timeoutMs, allowPrivateNetworks: config.web.allowPrivateNetworks },
      sessionSearch: this.#buildSessionSearch(sessionId, history),
    })
    // test/adapter seam: per-name executor overrides on top of the
    // builtins; toolDefs stay the builtins' — an override replaces behavior,
    // not the schema the model sees.
    if (this.#deps.tools !== undefined) {
      for (const [name, executor] of this.#deps.tools) tools.set(name, executor)
    }
    // Live adapter tools (MCP manager): defs appended, executor wins on a
    // name collision with a log line (schema follows the executor).
    if (this.#deps.extraTools !== undefined) {
      const extra = this.#deps.extraTools()
      for (const [name, executor] of extra.executors) {
        if (tools.has(name)) console.error(`kclaw tool name collision: ${name} (adapter overrides builtin)`)
        tools.set(name, executor)
      }
      toolDefs.push(...extra.defs)
    }

    // --- permission wiring (config gate + confirmation gateway) ---
    const pendingConfirmations = new Map<string, ToolCallBlock>()

    const baseGate = new ConfigPermissionGate(config.permissions, {
      workspace,
      safeTools: new Set([...tools].filter(([, t]) => t.risk === "safe").map(([name]) => name)),
      // Attachment reads: files under <home>/attachments are the daemon's own
      // uploaded inputs — fs_read/fs_list reach them without a confirmation.
      readRoots: [paths.attachmentsDir],
      // Readonly: the daemon-level flag OR this session's own toggle.
      readonly: this.#deps.readonly === true || sessionMeta?.readonly === true,
    })
    const confirmTimeoutMs = config.permissions.confirmTimeoutMs
    const broker = this.#broker
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
    // races against (raceResolution above). Whenever the race settles WITHOUT
    // a human verdict (timeout/abort), the broker entry goes stale so a late
    // gateway resolve reports "unknown confirmation" instead of acking a
    // verdict nothing will act on.
    const baseResolver =
      this.#deps.resolveConfirmation ?? ((confirmationId: string) => broker.wait(confirmationId))
    const resolveConfirmation = async (confirmationId: string): Promise<ConfirmationResolution> => {
      const raced = await raceResolution(baseResolver(confirmationId), confirmTimeoutMs, controller.signal)
      if (raced === "aborted") {
        pendingConfirmations.delete(confirmationId)
        broker.expire(confirmationId)
        // the value is never used: the loop's own race resolved "aborted" and
        // denies without consulting the resolver
        return { approved: false, by: "timeout" }
      }
      pendingConfirmations.delete(confirmationId)
      if (raced.by === "timeout") broker.expire(confirmationId)
      return raced
    }

    // --- retry visibility --------------------------------------------------------
    // Provider-level retries live inside the llm wrapper (withRetry), where
    // the loop cannot see them. When deps.llmForRun is set, the wrapper's
    // onRetry lands in THIS closure: each notification becomes an
    // `llm.failed {willRetry:true}` event on the bus (so clients can tell a
    // hung call from a backoff), and advances the attempt counter the loop's
    // llm.started reads via AgentDeps.llmAttempt. The counter is per llm
    // call — a completed/failed call resets it, so the next iteration's
    // llm.started reports a fresh attempt 1. The runId is learned from the
    // loop's own run.started (always a run's first event, emitted before any
    // stream — and therefore before any retry — can start).
    let runId: string | undefined
    let llmAttempt = 1
    const busEmit = (e: AgentEvent): void => {
      try {
        bus.emit(e)
      } catch {
        // one broken subscriber must not kill the run — bus.emit already
        // guards each socket individually; this guard covers the remaining
        // synchronous work in emit, e.g. JSON.stringify
      }
    }
    const onLlmRetry: LlmRetrySink = (info) => {
      llmAttempt = info.attempt + 1
      busEmit(makeEvent("llm.failed", {
        error: {
          code: "llm_retry",
          message: String((info.error as { message?: string } | null | undefined)?.message ?? info.error),
        },
        willRetry: true,
      }, runId === undefined ? { sessionId } : { sessionId, runId }))
    }
    const runLlm = this.#deps.llmForRun?.(onLlmRetry) ?? llm
    const defaultModel = this.#deps.model ?? config.providers.entries[config.providers.default]?.model ?? ""
    // A session/job model may name a provider ENTRY ("deepseek") whose wire
    // model is the entry's `.model` ("deepseek-v4-flash"); resolve keys to that
    // model, leaving already-raw API model names untouched.
    const resolveEntry = (m: string): string => config.providers.entries[m]?.model ?? m
    const model = resolveEntry(input.model ?? sessionMeta?.model ?? defaultModel)

    // --- v3 compaction triggers (spec 5.1-5.3, 5.8) -------------------------
    // 发消息零压缩（开场预压缩已删除）。三条触发路径全部由 server 注入：
    // 中途（迭代边界水位 ≥ 红线，经循环钩子）、超限（onContextOverflow 急救）、
    // 收尾（runAgent 返回后水位 ≥ 黄线）。水位锚定最后一条 assistant 的真实
    // usage，黄/红两线的读点集中在此。
    const budget = config.sessions.contextTokens ?? 128_000
    const atRatio = config.sessions.compactAtRatio ?? 0.66
    const panicRatio = config.sessions.compactPanicRatio ?? 0.85

    const outcome = await runAgent(
      {
        sessionId,
        history,
        system: this.#systemPrompt(paths.agentsMd),
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
        toolResultKeep: config.sessions.toolResultKeep ?? 8,
        // 省略预算（黄线值）透传给打包台：预算装不下的工具输出以省略占位符发送
        tokenBudget: budget * atRatio,
        // steer 注入口（spec §5.1）：迭代边界取走缓冲区；Task 5 实装，本任务恒为空。
        steering: () => this.#drainSteer(sessionId),
        // 中途压缩钩子（spec 5.3 第 5 条）：取消标记或 run 已中止 → 不压；
        // 水位 < 红线 → 不压；否则独立可取消地压缩，返回新视图（下一次请求生效）。
        midRunCompaction: () => {
          if (this.#compactionCancelled.has(sessionId) || controller.signal.aborted) return Promise.resolve(null)
          const boundaryHistory = sessions.readMessages(sessionId)
          if (estimateContextTokens(boundaryHistory) < budget * panicRatio) return Promise.resolve(null)
          return this.#runAutoCompaction(sessionId, boundaryHistory, config, runLlm, model, {
            phase: "in-run",
            signal: controller.signal,
          })
        },
        // 超限急救钩子（spec 5.6）：不看水位线——"已经爆了"就是事实；emergency
        // 压缩成功返回新视图由循环整次重发。await 归来时 run 已中止则返回 null
        // （窄窗口：重发注定立刻被拆，不再多此一举）。
        onContextOverflow: async () => {
          const next = await this.#runAutoCompaction(sessionId, sessions.readMessages(sessionId), config, runLlm, model, {
            phase: "in-run",
            emergency: true,
            signal: controller.signal,
          })
          return controller.signal.aborted ? null : next
        },
        onUserMessage: (m) => {
          // The notes become part of the message BEFORE it is
          // persisted and completed. Persist first (events trail persisted
          // state), then announce each note — the loop's message.completed
          // follows, so the wire order stays
          // created → note.emitted ×N → completed. runId is known by now
          // (run.started is always a run's first event and precedes this
          // hook); the sessionId-only fallback is defensive only.
          m.blocks.push(...jobNote, ...notes)
          sessions.appendMessage(sessionId, m)
          if (input.trigger !== "job") {
            const firstText = m.blocks.find((b) => b.type === "text")?.text ?? ""
            void scheduleAutoname(
              { sessions, llm: runLlm, model, emit: busEmit },
              sessionId, firstText,
            )
          }
          const noteCtx = runId === undefined ? { sessionId } : { sessionId, runId }
          for (const block of [...jobNote, ...notes]) {
            busEmit(makeEvent("note.emitted", { messageId: m.id, block }, noteCtx))
          }
          return m
        },
        onEvent: (e) => {
          if (e.type === "run.started" && e.runId !== undefined) runId = e.runId
          else if (e.type === "llm.completed" || e.type === "llm.failed") llmAttempt = 1
          busEmit(e)
        },
        onMessage: (m) => sessions.appendMessage(m.sessionId, m),
      },
    )
    // Auto memory extraction: fire-and-forget after a clean end_turn —
    // never awaited, never affects the returned outcome; any failure
    // inside #extractMemory lands in the .catch below as a log line.
    if (outcome.stopReason === "end_turn" && config.memory.autoExtract === true) {
      const extractModel = config.memory.extractModel || model
      void this.#extractMemory(sessionId, outcome.messages, runLlm, extractModel)
        .catch((err) => console.error("kclaw memory extraction failed:", err))
    }
    // Token usage ledger: a failing record must never affect the run.
    if (this.#deps.usageStore !== undefined) {
      try {
        this.#deps.usageStore.record({
          sessionId,
          runId: runId ?? "",
          model,
          inputTokens: outcome.totalUsage.inputTokens,
          outputTokens: outcome.totalUsage.outputTokens,
          at: new Date().toISOString(),
        })
      } catch (err) {
        console.error("kclaw usage record failed:", err)
      }
    }
    // --- 收尾压缩（v3 触发三路之一，spec 5.1/5.4）-----------------------------
    // run 正常结束且水位 ≥ 黄线：压缩一次。它在 #execute 内 await，驱动器的
    // 串行化自动保证"压缩期间新消息排队"（spec 5.4），无需额外忙碌标记；
    // aborted/error 的 run 不收尾（前者正在被拆，后者刚失败）。取消标记压制
    // 本次运行内已被用户取消的压缩（spec 5.3 第 6 条）。
    if (
      outcome.stopReason !== "aborted" && outcome.stopReason !== "error"
      && !this.#compactionCancelled.has(sessionId)
    ) {
      const postRunHistory = sessions.readMessages(sessionId)
      if (estimateContextTokens(postRunHistory) >= budget * atRatio) {
        await this.#runAutoCompaction(sessionId, postRunHistory, config, runLlm, model, {
          phase: "post-run",
          signal: controller.signal,
        })
      }
    }
    return outcome
  }

  /**
   * Steering drain（spec §5.1/§5.6）：活动 run 在迭代边界取走 steer 缓冲区里的
   * 全部消息注入对话。同步取走（先到先得，与 queueCancel 在同一线程内天然
   * 互斥）；返回按发送顺序构建的 user Message（id=entry.messageId；
   * blocks = text + attachments + note(job provenance)）。
   *
   * 先构建后变更（spec §5.6 不变量：登记 injected = 确已进 JSONL，机器不删）：
   * mountAttachments 可失败（附件越界、steer 等待期间文件被删），故全部 Message
   * 先在局部构建，全部成功后才清空缓冲、移除 meta.queue 并登记 #injectedIds——
   * 任一构建失败即整体不动：条目留在缓冲区（可取消、可重试注入），异常抛给
   * loop 走 run.failed "steering_failed"，同批其余消息不被连带丢掉。
   */
  #drainSteer(sessionId: string): Message[] {
    const buf = this.#steerBuf.get(sessionId)
    if (buf === undefined || buf.length === 0) return []
    const msgs = buf.map((e) => {
      const m = newMessage(sessionId, "user", [
        { id: newBlockId(), type: "text", text: e.text },
        ...(e.attachments ? mountAttachments(e.attachments, this.#deps.paths.attachmentsDir, sessionId) : []),
        ...(e.note !== undefined ? [{ id: newBlockId(), type: "note", kind: "job", text: e.note } satisfies NoteBlock] : []),
      ])
      m.id = e.messageId
      return m
    })
    this.#steerBuf.set(sessionId, [])
    this.#persistQueue(sessionId) // 从 meta.queue 移除这些条目
    for (const e of buf) this.#markInjected(e.messageId)
    return msgs
  }

  /** 已注入 id 的近期记录（有界），区分 injected 与 not_found（spec §5.6）。 */
  readonly #injectedIds = new Set<string>()

  #markInjected(id: string): void {
    this.#injectedIds.add(id)
    if (this.#injectedIds.size > RunManager.QUEUE_LIMIT * 2) {
      const oldest = this.#injectedIds.values().next().value
      if (oldest !== undefined) this.#injectedIds.delete(oldest)
    }
  }

  /**
   * Extract durable personal facts from a finished run's messages with one
   * tool-less LLM call and save each as a source-"auto" memory note (save's
   * own findSimilar dedupes/merges). The response is trimmed, an optional
   * ```json fence is stripped, then JSON.parsed — a non-array payload or any
   * non-string element abandons the whole batch (log only, no partial
   * writes); an empty array writes nothing. A single failing save is logged
   * and the remaining facts still go in. All throws propagate to the
   * caller's fire-and-forget .catch.
   */
  async #extractMemory(
    sessionId: string,
    messages: Message[],
    runLlm: LlmClient,
    model: string,
  ): Promise<void> {
    const raw = await collectStreamText(runLlm, {
      model,
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: renderSegment(messages) }],
      tools: [],
    })
    let text = raw.trim()
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
    if (fenced !== null) text = fenced[1]!.trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      console.error(`kclaw memory extraction (${sessionId}): unparseable response:`, err)
      return
    }
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
      console.error(`kclaw memory extraction (${sessionId}): response is not a string array, skipping`)
      return
    }
    for (const fact of parsed) {
      try {
        await this.#deps.memory.save({ text: fact, source: "auto" })
      } catch (err) {
        console.error(`kclaw memory extraction (${sessionId}): save failed:`, err)
      }
    }
  }

  /**
   * 自动压缩装配（v3,spec 5.3/5.6/5.8）:中途钩子、超限钩子与收尾压缩共用。
   * 独立 AbortController 登记 #compactionCtrl（cancelCompaction 掐它），并监听
   * run 的 signal——run 中止顺带掐压缩;finally 清理。取消标记或 run signal 已
   * 中止时不开工（三路统一入口,manual 路径不经此——emergency 因此永远不会与
   * manual 组合)。任何异常打一行 `kclaw compaction (phase) failed:` 后返回
   * null（钩子侧"压缩失败不补救",真失败的 started/completed 与第一行日志
   * 已由 #compactV2 发出/记录）。压缩成功返回新视图 { upto, top },水位不够
   * 或无可压缩边界时 #compactV2 返回 compacted:false → null。
   */
  async #runAutoCompaction(
    sessionId: string,
    history: Message[],
    config: KclawConfig,
    llm: LlmClient,
    model: string,
    opts: { phase: CompactionPhase; signal?: AbortSignal; emergency?: boolean },
  ): Promise<ActiveSummary | null> {
    if (this.#compactionCancelled.has(sessionId) || opts.signal?.aborted === true) return null
    const ctrl = new AbortController()
    this.#compactionCtrl.set(sessionId, ctrl)
    const onAbort = (): void => { ctrl.abort() }
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const out = await this.#compactV2(sessionId, history, "", config, llm, model, {
        phase: opts.phase,
        signal: ctrl.signal,
        ...(opts.emergency === true ? { emergency: true } : {}),
      })
      return out.compacted && out.upto !== undefined
        ? { upto: out.upto, top: out.summary ?? "" }
        : null
    } catch (err) {
      console.error(`kclaw compaction (${opts.phase}) failed:`, err)
      return null
    } finally {
      opts.signal?.removeEventListener("abort", onAbort)
      if (this.#compactionCtrl.get(sessionId) === ctrl) this.#compactionCtrl.delete(sessionId)
    }
  }

  /**
   * v2 layered compaction (spec 6). Trigger: estimate ≥ budget×ratio, or a
   * manual focus. Two tool-less LLM calls (segment summary, top merge), then
   * ONE meta write — no state lands unless both calls succeed, so a throw
   * anywhere equals "compaction did not happen" and the caller falls back to
   * the full history. The segment index write and the audit append are
   * best-effort (logged, never fatal).
   *
   * v3 additions: `phase` names the trigger stage (started/completed events
   * carry it; the audit trigger maps manual → "manual", phase "in-run" →
   * "in-run", else "auto"), `emergency` flags the over-limit rescue in the
   * audit record, and `signal` makes both summarizer calls abortable.
   * completed is GUARANTEED once started has fired: ok on success, "failed"
   * on a throw (rethrown to the caller — "throw = compaction did not
   * happen" — and logged here exactly once), "cancelled" when the signal
   * aborted (swallowed — the run is being torn down, not failing). Below the
   * water mark or without a boundary, NEITHER event fires (nothing began).
   */
  async #compactV2(
    sessionId: string,
    history: Message[],
    userText: string,
    config: KclawConfig,
    runLlm: LlmClient,
    model: string,
    opts: { focus?: string; manual?: boolean; phase?: CompactionPhase; signal?: AbortSignal; emergency?: boolean } = {},
  ): Promise<{ summary?: string; upto?: string; segments: number; active: Message[]; compacted: boolean }> {
    const { sessions } = this.#deps
    const meta = sessions.meta(sessionId)
    const prev: CompactionState | undefined = meta?.compaction ??
      (meta?.compactedSummary !== undefined && meta.compactedUpto !== undefined
        ? { segments: [], top: meta.compactedSummary, upto: meta.compactedUpto }
        : undefined)
    const prevIdx = prev === undefined ? -1 : history.findIndex((m) => m.id === prev.upto)
    const active = prevIdx >= 0 ? history.slice(prevIdx + 1) : history

    const budget = config.sessions.contextTokens ?? 128_000
    const atRatio = config.sessions.compactAtRatio ?? 0.66
    const targetRatio = config.sessions.compactTargetRatio ?? 0.33
    const manual = opts.manual === true
    const emergency = opts.emergency === true
    // 急救豁免黄线细判（spec 5.6）：溢出发生时"已经爆了"就是事实——尤其压缩后
    // 首请求里 active 没有 assistant 锚点，system/工具定义开销全漏计，估算会明显
    // 偏低，按黄线拦截会静默放弃急救、run 直接以 error 收场。急救只跳过触发判断，
    // 后续流程（两次摘要调用、meta 写入、审计、事件）与普通压缩完全一致。
    if (!manual && !emergency && estimateContextTokens(active, userText) < budget * atRatio) {
      return { summary: prev?.top, upto: prev?.upto, segments: prev?.segments.length ?? 0, active, compacted: false }
    }

    let boundary = chooseBoundary(active, { budget, targetRatio })
    if (boundary === undefined && emergency) {
      // 预算细判不可信时 chooseBoundary 可能切不出边界——强制退守最小可行
      // 上下文：只保留最近一轮用户轮次（emergencyBoundary）。
      const forced = emergencyBoundary(active)
      if (forced !== undefined) boundary = { keepFrom: forced }
    }
    if (boundary === undefined) {
      return { summary: prev?.top, upto: prev?.upto, segments: prev?.segments.length ?? 0, active, compacted: false }
    }

    const phase = opts.phase ?? (manual ? "manual" : "post-run")

    // The compaction will really run (two LLM calls ahead): announce it so
    // subscribed clients can show a "正在压缩…" state. This fires BEFORE
    // run.started — the pre-run compaction is otherwise a silent multi-second
    // gap between send and the first run event. From here on a paired
    // completed is guaranteed, whatever happens next.
    this.#deps.bus.emit(makeEvent("compaction.started", { phase }, { sessionId }))

    try {
      const seg = active.slice(0, boundary.keepFrom)
      const body = renderSegment(seg)
      const focusLine = opts.focus === undefined ? "" : `\n\n用户特别要求重点保留：${opts.focus}`
      const segmentSummary = await collectStreamText(runLlm, {
        model,
        system: SEGMENT_SUMMARY_PROMPT,
        messages: [{ role: "user", content: body + focusLine }],
        tools: [],
      }, { signal: opts.signal })
      const mergeInput = prev === undefined ? segmentSummary : `${prev.top}\n\n新的段摘要：\n${segmentSummary}`
      const top = await collectStreamText(runLlm, {
        model,
        system: MERGE_SUMMARY_PROMPT,
        messages: [{ role: "user", content: mergeInput + focusLine }],
        tools: [],
      }, { signal: opts.signal })

      const upto = seg[seg.length - 1]!.id
      const nextSegments = [...(prev?.segments ?? []), { upto, summary: segmentSummary }]
      sessions.updateMeta(sessionId, {
        compaction: { segments: nextSegments, top, upto },
        compactedSummary: undefined,
        compactedUpto: undefined,
      })
      try {
        SegmentIndex.open(join(this.#deps.paths.sessionsDir, sessionId, "index.db")).addSegment(upto, body, segmentSummary)
      } catch (err) {
        console.error(`kclaw segment index (${sessionId}) write failed:`, err)
      }
      try {
        sessions.appendCompaction(sessionId, {
          at: new Date().toISOString(),
          trigger: manual ? "manual" : phase === "in-run" ? "in-run" : "auto",
          ...(opts.emergency === true ? { emergency: true } : {}),
          ...(opts.focus === undefined ? {} : { focus: opts.focus }),
          // null = the span starts at session start (or the legacy upgrade
          // point) — only a continuation compaction has a real first id.
          from: prevIdx >= 0 ? seg[0]!.id : null,
          upto,
          messages: seg.length,
          segmentSummary,
          top,
        })
      } catch (err) {
        console.error(`kclaw compaction audit (${sessionId}) append failed:`, err)
      }
      this.#deps.bus.emit(
        makeEvent("compaction.completed", { segments: nextSegments.length, kept: active.length - boundary.keepFrom, phase, result: "ok" }, { sessionId }),
      )
      return { summary: top, upto, segments: nextSegments.length, active: active.slice(boundary.keepFrom), compacted: true }
    } catch (err) {
      // An aborted signal turns any throw into "cancelled": the run is being
      // torn down, the summarizer call was cut mid-flight — report that (and
      // swallow: cancellation is not a failure). Everything else is a real
      // failure: announce it, log it ONCE here, and rethrow — the caller's
      // "throw = compaction did not happen" contract is unchanged.
      const cancelled = opts.signal?.aborted === true
      this.#deps.bus.emit(
        makeEvent("compaction.completed", { segments: 0, kept: 0, phase, result: cancelled ? "cancelled" : "failed" }, { sessionId }),
      )
      if (cancelled) {
        return { summary: prev?.top, upto: prev?.upto, segments: prev?.segments.length ?? 0, active, compacted: false }
      }
      console.error("kclaw compaction failed:", err)
      throw err
    }
  }

  /**
   * Lazy per-run session_search backing (spec 6.4): opens (or rebuilds)
   * the segment index on first call. Legacy-upgrade sessions have no
   * segments yet → always "(无可检索内容)" until the first v2 compaction.
   */
  #buildSessionSearch(sessionId: string, history: Message[]): SessionSearchFn {
    let index: SegmentIndex | undefined
    return async (query, limit) => {
      const meta = this.#deps.sessions.meta(sessionId)
      const state = meta?.compaction
      if (state === undefined || state.segments.length === 0) return []
      if (index === undefined) {
        const legacyUpto = meta?.compactedUpto
        const entries = segmentRanges(history, state.segments, legacyUpto)
          .map((r) => ({
            upto: r.upto,
            body: renderSegment(r.messages),
            summary: state.segments.find((s) => s.upto === r.upto)?.summary ?? "",
          }))
          .filter((e) => e.body !== "")
        index = SegmentIndex.ensure(join(this.#deps.paths.sessionsDir, sessionId, "index.db"), entries)
      }
      return index.search(query, limit)
    }
  }

  /** AGENTS.md persona when the file exists and is non-empty; default otherwise. */
  #systemPrompt(agentsMd: string): string {
    try {
      const md = readFileSync(agentsMd, "utf8")
      if (md.trim() !== "") return md
    } catch {
      // missing/unreadable AGENTS.md → default persona
    }
    return DEFAULT_SYSTEM_PROMPT
  }
}
