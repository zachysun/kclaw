/**
 * RunManager — the daemon-side QUEUE STATE MACHINE (card ① engine relocation).
 *
 * `submit` is the send_message pipeline's synchronous front door: per-session
 * ordering (queue + steer buffer), persistence of queue.jsonl, per-session
 * drive loop. For each dequeued entry it hands off to the ENGINE —
 * `executeRun` in @kclaw/core (agent/run-assembly.ts) — which owns the
 * assembly of one runAgent invocation: memory note injection, AGENTS.md
 * system prompt, builtin tools, a permission gate, event bus fan-out and
 * JSONL persistence.
 *
 * Handoff contract pinned here:
 * - The AbortController is created and registered in `#executeEntry` BEFORE
 *   any await (no cancellation window); the engine only consumes its signal.
 * - The steer buffer is queue state, so the engine drains it through the
 *   `drainSteer` callback handed over per run.
 * - History is read BEFORE the user message is appended (inside the engine —
 *   runAgent places its user message after `history`), and the user message
 *   is persisted inside the run's `onUserMessage` hook so the bus carries
 *   run.started → message.created → note.emitted ×N → message.completed.
 */
import {
  Compactor,
  ConfirmationBroker,
  executeRun,
  makeEvent,
  mountAttachments,
  newBlockId,
  newId,
  newMessage,
  type ConfirmationResolution,
  type EnqueueInput,
  type EventBus,
  type HookRegistry,
  type KclawConfig,
  type KclawPaths,
  type LlmClient,
  type LlmRetrySink,
  type MemorySystem,
  type Message,
  type NoteBlock,
  type QueueEntry,
  type RunEngine,
  type RunOutcome,
  type SessionStore,
  type SubagentCollector,
  type SubagentSpawner,
  type ToolDefinition,
  type ToolExecutor,
  type UsageStore,
  type AutoLearnCounter,
  resolveContextTokens,
} from "@kclaw/core"

export interface RunManagerDeps {
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
  resolveConfirmation?: (confirmationId: string) => Promise<ConfirmationResolution>
  /**
   * Auto-mode induction (batch C): the per-process streak counter, threaded
   * into every run's assembly (see RunEngineDeps.autoLearn). One instance per
   * daemon; keys are session-scoped at the assembly seam. Absent → auto mode
   * keeps the default decision chain without induction (tests).
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
   * Subagent dispatch (issue #16): the daemon's spawner implementation
   * (server/src/subagent.ts). Flows into every mainline run's assembly as the
   * `subagent_run` builtin; child runs never see it. `collector` (issue #22)
   * adds `subagent_collect` next to it; `cancelBackgroundForParent` backs the
   * delete/purge cascade (exposed via cancelBackgroundChildren).
   */
  subagents?: {
    spawner: SubagentSpawner
    collector?: SubagentCollector
    cancelBackgroundForParent?: (parentSessionId: string) => number
  }
  /** Per-run token ledger (optional; recording failures are swallowed). */
  usageStore?: UsageStore
  /**
   * User-hook registry: refreshed per run by the engine and
   * snapshotted into every run's hook chain. Optional (tests without user
   * hooks omit it).
   */
  hooks?: HookRegistry
}

/** One queued run request lives in core now (the engine's input shape). */
export type { EnqueueInput } from "@kclaw/core"

/** submit 的同步决策结果：消息身份、是否入队与实际生效处置（降级后）。 */
export interface SubmitResult {
  messageId: string
  /** false = 空闲直发（现状行为：不广播 message.queued）。 */
  queued: boolean
  /** 实际生效处置：steer 无活动 run 时降级为 wait。 */
  disposition: "steer" | "wait" | "interrupt"
  /**
   * wait/interrupt：本条 run 的 outcome；steer：随当前 run settle
   * （参考值，ws 层 fire-and-forget）。
   */
  outcome: Promise<RunOutcome>
}

/** withRetry's per-attempt notification shape (core provider/retry.ts onRetry). */
export type { LlmRetrySink } from "@kclaw/core"

/**
 * One in-memory queue node: the persisted entry plus its settle plumbing.
 * `entry` is what lands in queue.jsonl ；outcome 在本条 run 结束时
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

export class RunManager {
  /** 每会话排队 + steer 缓冲合计上限；先写死，不做配置项。 */
  static readonly QUEUE_LIMIT = 10

  readonly #deps: RunManagerDeps
  /** 每会话可执行条目（wait/interrupt），数组顺序即执行顺序。 */
  readonly #queues = new Map<string, QueueNode[]>()
  /** steer 缓冲：活动 run 在迭代边界取走；settle 后残余降级入队尾。 */
  readonly #steerBuf = new Map<string, QueueEntry[]>()
  /** 每会话驱动循环；存在即该会话的队列由驱动器托管。 */
  readonly #drivers = new Map<string, Promise<void>>()
  /** Abort controller of the session's ACTIVE run; absent while idle or queued. */
  readonly #active = new Map<string, AbortController>()
  /** 活动 run 的 outcome：steer 的参考 outcome / 降级时序。 */
  readonly #activeOutcomes = new Map<string, Promise<RunOutcome>>()
  /**
   * 压缩引擎（core Compactor，card ① 迁入）：两段摘要调用、事件对、审计写盘
   * 与每会话取消状态都在那里；本类只转发 cancelCompaction 并在 run 钩子里调用。
   */
  readonly #compactor: Compactor
  /** Confirmation gateway shared by every run; injected or internally constructed. */
  readonly #broker: ConfirmationBroker
  /** The engine bundle handed to core's executeRun for every dequeued entry. */
  readonly #engine: RunEngine

  constructor(deps: RunManagerDeps) {
    this.#deps = deps
    this.#compactor = new Compactor({
      sessions: deps.sessions,
      emit: (e) => deps.bus.emit(e),
    })
    this.#broker = deps.broker ?? new ConfirmationBroker()
    this.#engine = {
      deps: { ...deps, broker: this.#broker },
      compactor: this.#compactor,
    }
  }

  /** The confirmation gateway this manager's runs answer through (WS/CLI verdicts land here). */
  get broker(): ConfirmationBroker {
    return this.#broker
  }

  /**
   * Cancel every live BACKGROUND subagent of one parent session (issue #22) —
   * the delete/purge cascade's cancellation half. No-op (returns 0) when no
   * spawner with background bookkeeping is wired.
   */
  cancelBackgroundChildren(parentSessionId: string): number {
    return this.#deps.subagents?.cancelBackgroundForParent?.(parentSessionId) ?? 0
  }

  /**
   * 同步决策一条消息的去向：空闲直发；steer 且有活动 run →
   * 入缓冲区；其余（wait/interrupt，以及无活动 run 的 steer 降级 wait）入队，
   * interrupt 伴随对活动 run 的 abort。立即返回消息身份与实际生效处置。
   */
  submit(sessionId: string, input: EnqueueInput): SubmitResult {
    const { config, sessions, bus } = this.#deps
    const meta = sessions.meta(sessionId)
    if (meta === undefined) throw new Error("session not found")
    // Child sessions are read-only to users: their only input is the dispatch
    // task (delegation semantics). User-triggered submissions (a chat client
    // connected to a child session) are rejected; "agent" is the spawner's own
    // submission and "job" never lands on a child — neither is affected.
    if (input.trigger === "user" && meta.parentSessionId !== undefined) {
      throw new Error("子代理会话不接收用户消息（只读；过程与结果见审计页）")
    }
    // 处置解析链：显式 > 会话覆盖 > 配置默认；job/agent 触发固定 wait
    // （无人值守的排队行为必须可预测；agent 子 run 由派发器独占驱动）。
    const disposition = input.trigger === "job" || input.trigger === "agent"
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
    // 空闲 = 无活动 run、无可执行条目、无驱动器 → 直发开跑（不广播 message.queued）
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
      // outcome：随当前 run settle（参考值；ws 层 fire-and-forget）
      const active = this.#activeOutcomes.get(sessionId)
        ?? Promise.resolve({ stopReason: "aborted", totalUsage: { inputTokens: 0, outputTokens: 0 }, messages: [] })
      return { messageId: entry.messageId, queued: true, disposition: "steer", outcome: active }
    }
    // steer 但无活动 run（队列在转）：降级 wait 入队并报 wait
    const effective = disposition === "steer" ? ("wait" as const) : disposition
    const atHead = effective === "interrupt"
    const node = makeNode({ ...entry, disposition: effective })
    if (input.model !== undefined) node.model = input.model // 内存还原用（现状行为）
    if (atHead) {
      queue.unshift(node)
      if (this.#active.has(sessionId)) this.#active.get(sessionId)!.abort() // 中断伴随 abort
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
   * Queue one run on the session. 兼容包装 = submit().outcome：
   * Promise 仍是 ws 层 fire-and-forget 的返回值，但不再是排队载体——
   * wait/interrupt 随本条 run settle；steer 随当前 run settle（参考值）。
   */
  enqueue(sessionId: string, input: EnqueueInput): Promise<RunOutcome> {
    return this.submit(sessionId, input).outcome
  }

  /**
   * 内存队列镜像：可执行条目 + steer 缓冲，数组顺序即执行
   * 顺序。与 queue.jsonl 同构，供队列查询/恢复使用。
   */
  queue(sessionId: string): QueueEntry[] {
    return this.#queueEntries(sessionId)
  }

  /**
   * 仅中止会话的活动 run（语义收窄）：它停在下一个检查点并
   * 以 stopReason "aborted" 结束。排队消息不受影响——排队取消一律走
   * queue.cancel。无活动 run 时返回 false。
   */
  cancel(sessionId: string): boolean {
    const controller = this.#active.get(sessionId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /**
   * 取消自动压缩（ws 层调用）：转发给 core 的
   * Compactor——abort 在飞的压缩 controller，同时写取消标记压制本次 run 内
   * 后续的中途/收尾压缩；标记在下一次 run 装配（core executeRun）开头清除。返回：调用时刻
   * 是否存在在飞的压缩（false = 没什么可掐，但标记仍写入）。
   */
  cancelCompaction(sessionId: string): boolean {
    return this.#compactor.cancel(sessionId)
  }

  /**
   * 排队取消：wait 随时、steer 注入前；已注入的不删（机器不删历史）。
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
   * Manual compaction: runs #compactV2 with a focus, ignoring
   * the trigger line. Both refusals are checked before any
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
    // Same budget resolution as executeRun: a model entry contextWindow
    // tightens the manual path's line too.
    const entryKey = meta.model !== undefined && config.providers.entries[meta.model] !== undefined ? meta.model : undefined
    const out = await this.#compactor.compact(sessionId, history, "", config, llm, model, {
      focus,
      manual: true,
      phase: "manual",
      budget: resolveContextTokens(config, entryKey),
    })
    return {
      message: out.compacted
        ? `压缩了 ${out.segments} 段，剩 ${out.active.length} 条原文消息`
        : "无可压缩内容",
    }
  }

  /** daemon 启动恢复：持久化队列整体重排，steer/interrupt 一律降级 wait。 */
  recoverQueues(): void {
    for (const meta of this.#deps.sessions.list()) {
      const entries = this.#deps.sessions.readQueue(meta.id)
      if (entries.length === 0) continue
      const demoted: QueueEntry[] = entries.map((e) => ({ ...e, disposition: "wait" }))
      this.#deps.sessions.replaceQueue(meta.id, demoted)
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
   * 每会话驱动循环：run settle → 残余 steer 降级并入队尾 →
   * 队列非空？出队执行 → 循环。已在转则幂等返回。
   *
   * 出队阶段的意外失败（#demoteSteer / 出队后的 #persistQueue 的 meta 写盘炸掉，如
   * 会话被删、盘满）不允许重演两种死法：会话永久停转（僵尸驱动器让后续
   * submit 全部幂等返回、队列无人消费），或循环 promise 裸拒绝（unhandled
   * rejection）。处理：手头已出队的 node 以该错误落定（等待方看见失败而非
   * 永久悬挂）并**塞回队首**——persist 抛错意味着 queue.jsonl 也没写成，塞回后
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
            this.#persistQueue(sessionId) // 出队即从 queue.jsonl 删除（原子重写）
          } catch (err) {
            if (node !== undefined) {
              // persist 失败 = queue.jsonl 未动：塞回队首恢复两边一致，条目等待重试
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

  /** 残余 steer → wait 并入队尾，原顺序保持。 */
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

  /**
   * The queue view (executable entries then steer buffer, in run order) —
   * the single expression both the in-memory mirror (`queue`) and the
   * queue.jsonl persistence (`#persistQueue`) derive from, so the two can
   * never drift.
   */
  #queueEntries(sessionId: string): QueueEntry[] {
    return [
      ...(this.#queues.get(sessionId) ?? []).map((n) => n.entry),
      ...(this.#steerBuf.get(sessionId) ?? []),
    ]
  }

  /** queue.jsonl = 可执行条目 + steer 缓冲，数组顺序即执行顺序；空数组写空文件。 */
  #persistQueue(sessionId: string): void {
    this.#deps.sessions.replaceQueue(sessionId, this.#queueEntries(sessionId))
  }

  /**
   * 执行一条出队条目：登记活动 controller（在任何 await 之前，
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
    const execution = executeRun(this.#engine, {
      sessionId,
      input,
      controller,
      drainSteer: () => this.#drainSteer(sessionId),
    })
    this.#activeOutcomes.set(sessionId, execution)
    try {
      return await execution
    } finally {
      if (this.#active.get(sessionId) === controller) this.#active.delete(sessionId)
      this.#activeOutcomes.delete(sessionId)
    }
  }

  /**
   * Steering drain：活动 run 在迭代边界取走 steer 缓冲区里的
   * 全部消息注入对话。同步取走（先到先得，与 queueCancel 在同一线程内天然
   * 互斥）；返回按发送顺序构建的 user Message（id=entry.messageId；
   * blocks = text + attachments + note(job provenance)）。
   *
   * 先构建后变更（不变量：登记 injected = 确已进 JSONL，机器不删）：
   * mountAttachments 可失败（附件越界、steer 等待期间文件被删），故全部 Message
   * 先在局部构建，全部成功后才清空缓冲、移除 queue.jsonl 并登记 #injectedIds——
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
    this.#persistQueue(sessionId) // 从 queue.jsonl 移除这些条目
    for (const e of buf) this.#markInjected(e.messageId)
    return msgs
  }

  /** 已注入 id 的近期记录（有界），区分 injected 与 not_found。 */
  readonly #injectedIds = new Set<string>()

  #markInjected(id: string): void {
    this.#injectedIds.add(id)
    if (this.#injectedIds.size > RunManager.QUEUE_LIMIT * 2) {
      const oldest = this.#injectedIds.values().next().value
      if (oldest !== undefined) this.#injectedIds.delete(oldest)
    }
  }
}
