# run-manager — 会话串行 run、消息队列与确认网关（服务端侧）

## 职责

`packages/server/src/run.ts` 的 `RunManager` 负责 `send_message` 之后服务端的全部处理：消息去向的三处置决策（引导/等待/中断，见下文 submit）、每会话一条显式排队队列与其驱动循环、入队执行、附件挂载、模型解析、记忆注入、系统提示、工具与权限装配、事件发送到总线、消息持久化、token 台账记录、run 取消与排队取消。`packages/server/src/confirm.ts` 的 `ConfirmationBroker` 是确认网关的服务端半边：挂起的人工裁决经 WS/CLI 的 `confirmation.resolve` 命令在此完成裁决。`packages/server/src/autoname.ts` 的 `scheduleAutoname` 在首条用户消息后异步生成会话标题并把更名广播为 `session.renamed` 事件。调度心跳（`scheduler-tick.ts`）触发的 job run 也使用同一个入口。

## 设计决策

- **ack 与 run 解耦是结构性保证**：`ws.ts` 收到 `send_message` 后 `run.submit` 同步决策去向并立即回 `send_message_ack`（携带 `messageId` 与 `queued`，不 await run），run 的进展全部以 `run.*` 事件流回订阅者——长任务永远不阻塞命令通道。
- **队列模型：meta.json 持久化 + 内存镜像 + 每会话驱动器**（message-queue spec §3/§5.4）：排队消息是"当前状态"而非"已执行历史"，因此持久化在 `SessionMeta.queue`（`QueueEntry[]`，meta.json 原子重写，数组顺序即执行顺序），不进 JSONL——`readMessages` 的所有消费方（agent 历史、压缩范围、审计页）天然不含排队消息，崩溃恢复也只需读 meta.queue。内存侧 `#queues`（可执行条目 wait/interrupt）与 `#steerBuf`（steer 缓冲）是 meta.queue 的镜像；`#drive` 为每会话一个循环：`run settle → 残余 steer 降级并入队尾 → 队列非空？出队执行 → 循环`，run 因任何原因结束都先降级残余 steer 再触发下一轮出队判定。每会话排队 + steering 缓冲合计上限 10 条（`RunManager.QUEUE_LIMIT`，写死不做配置项，spec §5.5），超限 `submit` 抛 `队列已满（10 条）`。
- **三种处置只决定消息何时被模型看到**（spec §2）：steer 注入正在跑的对话（迭代边界，不产生新 run）；wait 留在队列等当前 run 结束后出队；interrupt 立即中止当前 run 并插队首。三条路径最终都写进 JSONL，消息 id 在入队时预分配（`entry.messageId`）、出队/注入执行时用同一 id 构建消息——前端气泡从"排队态"原地升级。处置生效层级：单次请求显式指定 > 会话级覆盖（`SessionMeta.dispositionOverride`，CLI `/steer`/`/wait` 与 Web 三选写入）> 配置默认 `sessions.defaultDisposition`（缺省 steer）。
- **steer 缓冲与降级**（spec §3.4）：steer 消息不进执行队列，进当前 run 的 steering 缓冲区；run 在迭代边界经 `AgentDeps.steering` 取走全部缓冲消息注入。若消息到达时会话恰好空闲（无活动 run），steer 当场降级为 wait 入队并按 wait 报告（`message.queued {disposition:"wait"}`）；若 run 在取走缓冲前结束（end_turn/aborted/failed 任何原因），残余条目在驱动器的下一拍自动降级为 wait、按原顺序并入队尾——消息绝不丢，队列里可执行的只有 wait 与 interrupt。
- **注入的取走是先构建后变更**（spec §5.6 不变量）：`#drainSteer` 先在局部把全部缓冲条目构建成 user Message（附件挂载可能失败——越界、文件被删），全部成功后才清空缓冲、重写 meta.queue 并把 id 登记进 `#injectedIds`（有界集合，容量 `QUEUE_LIMIT×2`，用于把排队取消请求区分为 `injected`（已进 JSONL，机器不删历史）与 `not_found`）；任一构建失败即整体不动，异常抛给循环走 `run.failed "steering_failed"`。
- **job 消息固定 wait 且同受上限约束**：服务器内部的入队（job tick 的通知消息）按 wait 处置、不读 `defaultDisposition`——job 的语义是"当前的事忙完后轮到我"，没有"引导正在跑的 run"的诉求。上限对 job 一视同仁：会话排满时 job tick 的消息同样吃 `队列已满` 错误。**这是有意的行为变更**（旧实现忙时无界排队，见文末行为变更清单）。
- **用户消息由 RunManager 预制**：以纯 text 骨架（先建只含一个文本块的消息，note 块随后补全）经 `RunInput.userMessage` 传入，循环原样使用且不重复持久化；note 块（job 来源 + 记忆）在 `onUserMessage` 钩子里追加——事件序固定为 `run.started → message.created → note.emitted ×N → message.completed`，且持久化先于 note 事件（事件反映已持久化状态）。附件挂载同样在骨架构建时完成；越界路径在 `mountAttachments` 里抛错终止整条 run。
- **历史在追加用户消息之前读**：`runAgent` 自己会把用户消息拼在 `history` 之后（`[...input.history, userMsg]`），若 history 已含它会向 provider 重复发送同一段文本。
- **broker 只做桥接，不发事件、不管理超时**：`confirmation.requested`/`confirmation.resolved` 由 agent 循环发（`packages/core/src/agent/loop.ts`），broker 若再发即造成线上重复；超时裁决也由循环的 `raceConfirmation` 完成。broker 的 `expiresAt` 只是登记信息。
- **双重竞速镜像**：RunManager 侧的 `raceResolution` 与循环侧的 `raceConfirmation` 用**同一个** `confirmTimeoutMs` 竞速同一个人工 promise——两侧结论一致；迟到的人工裁决被已 settle 的 race 丢弃，服务端再 `expire` 掉条目，晚到的 resolve 只能得到 `unknown confirmation`。
- **自动命名静默且不覆盖手动改名**：失败静默处理、两次校验默认标题（生成前、写回前），用户已手动改名则不再修改。更名成功写回 meta 后，经注入的 emit 钩子（`busEmit`）广播 `session.renamed {title}`——订阅者立即收到通知。
- **模型解析：每 run 一次，三级优先级**：本轮用哪个模型，按 `input.model`（job 配置的模型或客户端指定的）→ 会话 meta 的 `model`（POST `/sessions/:id/model` 写入的那个）→ daemon 默认模型的顺序取第一个非空的。取到的值再经 `resolveEntry` 做一次翻译：如果它是 config 里 provider 条目的名字（比如 `deepseek`），就换成该条目配置的线上模型名（比如 `deepseek-chat`）；如果本来就是一个直接的 API 模型名则原样通过。解析发生在每个 run 开始时，所以改完会话模型后下一次 run 即生效。
- **附件挂载：按文件类型分三种处理**：`mountAttachments` 把用户上传的文件转成用户消息上的 attachment 块。文本类文件（MIME 为 `text/*` 或扩展名是常见文本类型）且不超过 64KiB 时，读出正文内联进消息（超过 8000 字符截断并加 `\n…[已截断]`）；图片且不超过 5MiB 时转成 base64 内嵌（作为多模态内容段发给模型）；其余文件只在块里放 `{type:"file", path}` 路径信息，模型需要内容时自己用 fs_read 读。安全上有两道检查：ws 层在校验 send_message 帧时查过一次路径，这里再用 `realpathWithin` 复核一遍——引用越出本会话附件目录就直接抛错、终止整条 run。
- **用量记录失败不影响 run**：run 正常结束后向 `usageStore.record` 记一行（会话 id/run id/模型/输入输出 token/时刻）。这行代码包在 try/catch 里，失败只打 `kclaw usage record failed:` 日志；daemon 没注入 usageStore 时整个步骤跳过。
- **自动记忆提取：发出请求后不等结果**：run 以 `end_turn` 干净收场且 `config.memory.autoExtract === true` 时，调度 `#extractMemory` 后不 await 它——这是一次不带工具的 LLM 调用，从整轮对话里提取"值得长期记住的用户个人事实"（要求返回 JSON 字符串数组），逐条调 `memory.save({source:"auto"})` 存入记忆库。响应解析失败就整批放弃、只打日志；某一条保存失败不影响其余条目。记忆注入那一侧的机制不变。
- **上下文压缩 v3（token 触发的分层摘要，四个触发点）**：压缩不再发生在发送路径上——`#execute` 直接以全量 `history` 起 run，用户发消息永远零压缩等待。四个触发点由服务端编排（机制细节与数据格式见 [compaction](../core/compaction.md)）：
  - **收尾压缩**（主路径）：`runAgent` 返回且 stopReason 非 `aborted`/`error` 时，用 `estimateContextTokens(readMessages(sessionId))` 估算水位（锚定最后一条助手消息记录的真实 `usage.inputTokens`，锚之前的内容天然不计入——它们不在上一次请求里，所以直接对全量历史读数即可），水位 ≥ `budget × (compactAtRatio ?? 0.66)` 就 `#runAutoCompaction({phase:"post-run", signal})`。它在 `#execute` 内 await、位于 token 台账记录之后——会话驱动器的串行化保证压缩期间新到的消息排队等待、不会并发写会话元数据（这也让手动 /compact 在收尾压缩期间被"会话活跃"条件自然拒绝）。
  - **中途压缩**：经 `AgentDeps.midRunCompaction` 钩子（见 [agent-loop](../core/agent-loop.md)）在每轮迭代边界触发。钩子内先查取消标记与 run 的中止信号（任一命中返回 null 不压），再算水位，≥ `budget × (compactPanicRatio ?? 0.85)` 才压；压缩成功返回新的压缩视图 `{ upto, top }`，循环从下一次请求起应用（`upto` 之前原文不再发、脉络项垫在 `messages[0]`）；失败返回 null、运行不补救继续。
  - **超限紧急急救**：经 `AgentDeps.onContextOverflow` 钩子在流式调用抛出上下文超限错误且零输出时触发——不看水位，"已经爆了"就是事实，`#runAutoCompaction({phase:"in-run", emergency:true, signal})`；成功则循环整次请求静默重发一次（最多一次），仍失败才走报错路径。
  - **手动 /compact**：`compactSession` 直调 `#compactV2({manual:true, phase:"manual"})`，跳过触发线。
  - `#runAutoCompaction` 是收尾/中途/超限三路的共用装配：为每次压缩建独立 AbortController 并登记 `#compactionCtrl`，run 的中止信号联动过去（run 中止顺带掐压缩），finally 清理；压缩自身的摘要调用经 `collectStreamText` 带 `{ signal }`，取消信号触发时抛出 → `#compactV2` 走 cancelled 分支。`cancelCompaction`（WebUI 指示行取消按钮 → WS 帧 `compaction.cancel`）写会话级取消标记并 abort 在飞 controller；标记在每次 `#execute` 开头清除，只压制本次运行内的自动压缩。
  - `#compactV2` 内部：按 `SessionMeta.compaction.upto` 切出 active 历史（旧会话回落 `compactedUpto`，标记在历史里找不到视为无标记），水位过线后由 `chooseBoundary` 选出分界——从最新往回累加到预算 × `compactTargetRatio`（默认 0.33）为止，起点再对齐到最近的用户消息（保证段与保留部分都是完整轮次）。压缩是两次无 tools 的 `collectStreamText` 调用（复用本轮 `runLlm` 与解析出的 model，`#runAutoCompaction` 内 await）：新段经 `renderSegment` 生成固定五栏的段摘要，再与旧总摘要归并出新总摘要；**两次全部成功后**才一次 `updateMeta` 写入 `{ segments, top, upto }` 并删除旧字段 `compactedSummary`/`compactedUpto`。落盘之后还有两个 best-effort 动作：段文本与段摘要写入会话检索索引（`index.db`，失败记日志）、向 `compactions.jsonl` 追加一行审计（`trigger` 按 `manual`/`in-run`/`auto` 三值、超限急救带 `emergency`，失败记日志），两者都不影响压缩生效。事件：水位过线且边界已定先发 `compaction.started {phase}`，之后无论成败/取消必发 `compaction.completed {segments, kept, phase, result}`（失败/取消时 segments/kept 为 0）；水位未过线则两个事件都不发。模型调用或 meta 写入抛错时 `#compactV2` 记一行 `kclaw compaction failed:` 日志后上抛，`#runAutoCompaction` 消化为 null——运行照常继续，下一次过线重新触发。总摘要不再挂 note，而是经循环的压缩视图以脉络项进请求（见 [compaction](../core/compaction.md) 的"注入"）。

## 接口

```ts
// packages/server/src/run.ts
export interface RunManagerDeps {
  config: KclawConfig
  paths: KclawPaths
  sessions: SessionStore
  memory: MemoryStore
  bus: EventBus
  llm: LlmClient                       // 无 llmForRun 时的共享客户端
  workspace: string
  model?: string                       // daemon 解析一次后传入（provider 条目 ?? KCLAW_LLM_MODEL）
  broker?: ConfirmationBroker          // 缺省内部新建，暴露为 manager.broker
  resolveConfirmation?: (confirmationId: string) => Promise<{approved: boolean; by: "cli"|"web"|"timeout"}>
                                        // 测试注入点（测试缝：为测试替换内部实现的接口）；daemon 路径只用 broker
  llmForRun?: (onRetry: LlmRetrySink) => LlmClient
                                        // 每个 run 一个带重试可见性的客户端（daemon 默认组合设置）
  tools?: Map<string, ToolExecutor>    // 按名覆盖内置工具执行器（测试注入点；schema 仍用内置的）
  extraTools?: () => { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] }
                                        // 活的适配器工具（MCP 管理器）：是函数、每个 run 调一次求值，
                                        // 连接在两次 run 之间上/下线都反映到下一次请求；defs 追加在内置 defs 之后，
                                        // 与内置撞名时打一行日志且适配器执行器胜出（schema 随执行器走）
  usageStore?: UsageStore              // 每 run token 台账（缺省不记录；记录失败只打日志）
  readonly?: boolean                   // daemon 级只读旗标（CLI --readonly）：全部会话起步即只读
}

export interface EnqueueInput {
  userText: string
  trigger: "user" | "job"
  model?: string       // 本 run 的模型覆盖（job 配置的模型或客户端强制）；缺席 → 会话 meta → 默认
  attachments?: AttachmentRef[]  // 挂到用户消息上的附件引用（调用方已校验，这里防御性复验）
  note?: string        // job 来源行，落在用户消息的 kind:"job" note 块
  disposition?: "steer" | "wait" | "interrupt"
                        // 单次显式处置（层级最高）；缺省 = 会话覆盖 ?? 配置默认；
                        // trigger:"job" 固定 wait，不读默认
  messageId?: string   // 内部：驱动器出队执行时传入的预分配消息 id（ws 层不传）
}

/** submit 的同步决策结果：消息身份、是否入队与实际生效处置（降级后）。 */
export interface SubmitResult {
  messageId: string
  queued: boolean      // false = 空闲直发（不广播 message.queued，ack 里 queued:false）
  disposition: "steer" | "wait" | "interrupt"
                        // 实际生效处置：steer 无活动 run 时降级为 wait 并按 wait 报告
  outcome: Promise<RunOutcome>
                        // wait/interrupt：本条 run 的 outcome；steer：随当前 run settle
                        //（参考值，ws 层 fire-and-forget）
}

/** A reference to an uploaded attachment file (mounted as an attachment block). */
export interface AttachmentRef {
  path: string
  name: string
  size: number
  mimeType: string
}

export class RunManager {
  static readonly QUEUE_LIMIT = 10    // 每会话排队 + steer 缓冲合计上限（写死，spec §5.5）
  get broker(): ConfirmationBroker
  submit(sessionId: string, input: EnqueueInput): SubmitResult
                        // 同步决策去向（spec §4.1）：空闲直发；steer+活动 run → 入缓冲区；
                        // 其余入队（interrupt 伴随对活动 run 的 abort）；队列满抛错
  enqueue(sessionId: string, input: EnqueueInput): Promise<RunOutcome>
                        // 兼容包装 = submit().outcome（job tick 等旧调用方不变）
  queue(sessionId: string): QueueEntry[]
                        // 内存队列镜像（可执行条目 + steer 缓冲），与 meta.queue 同构，
                        // 供 GET /sessions/:id/queue 与恢复使用
  queueCancel(sessionId: string, messageId?: string):
    | { ok: true; cancelled: string[] }
    | { ok: false; reason: "not_found" | "injected" }
                        // 排队取消（spec §5.6）：wait 随时、steer 注入前可取消；
                        // 不带 id = 清空全部可取消条目并广播 {all:true}
  cancel(sessionId: string): boolean   // 仅中止当前 run（语义收窄）；false = 无活跃 run
  recoverQueues(): void                // daemon 启动恢复：meta.queue 整体重排，steer/interrupt 降级 wait
  cancelCompaction(sessionId: string): boolean
                                        // 取消在飞的自动压缩：写会话级取消标记 + abort 压缩用的
                                        // controller；返回"是否有压缩在飞"。标记只压制本次运行内
                                        // 的自动压缩（中途/收尾），下一次运行开始时清除；手动 /compact 不查标记
  compactSession(sessionId: string, focus?: string): Promise<{ message: string }>
                                        // 手动压缩（HTTP/CLI/web 三入口共用）：队列非空或会话活跃
                                        // 时拒绝（双条件文案不同；收尾压缩算在"活跃"窗口内）；
                                        // 无可压缩内容返回固定文案
}
```

```ts
// packages/server/src/confirm.ts
export class ConfirmationBroker {
  create(confirmationId, toolCall, risk, timeoutMs, sessionId?): Promise<ConfirmationResolution>
  resolve(confirmationId, approved, by = "cli"): boolean   // settle 仍挂起的条目；未知/已决/过期 → false
  wait(confirmationId): Promise<ConfirmationResolution>    // 未知的 id 永不 settle（超时归循环管）
  expire(confirmationId): void                             // 标记过期（Race 输给超时/abort 后调用）
  pending(): ConfirmationRequestedPayload[]                 // 当前挂起列表（供未来的 HTTP 列表端点）
}
```

关键常量（`run.ts`）：`MEMORY_QUERY_CHARS = 200`（用户文本前 200 字符做记忆检索）、`MEMORY_LIMIT = 5`（最多注入 5 条）、`DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"`；附件挂载的 `TEXT_INLINE_MAX_BYTES = 64KiB`、`TEXT_INLINE_MAX_CHARS = 8000`、`IMAGE_INLINE_MAX_BYTES = 5MiB`。三个固化系统提示词：`SEGMENT_SUMMARY_PROMPT`（段摘要：固定五栏 markdown、不超过 800 字）、`MERGE_SUMMARY_PROMPT`（总摘要归并：同样五栏、保留新版本并注明被推翻的旧版本）、`EXTRACT_SYSTEM_PROMPT`（记忆提取：只输出 JSON 字符串数组）。压缩触发的四个比例不在 defaultConfig 里（`sessions` 段的 `contextTokens`/`compactAtRatio`/`compactPanicRatio`/`compactTargetRatio`/`toolResultKeep` 均可选），缺省值在读取处兜底（128000 / 0.66 / 0.85 / 0.33 / 8）。确认超时来自 `config.permissions.confirmTimeoutMs`，默认 `120_000`（120 秒，`packages/core/src/storage/config.ts` 的 defaultConfig）。

## 核心流程

### submit：三处置同步决策

```
submit(sessionId, input)
  meta 存在性检查；处置解析（显式 > 会话覆盖 > 配置默认；job 固定 wait）
  queue.length + steerBuf.length >= 10 → throw 队列已满（10 条）
  空闲（无活动 run、无可执行条目、无驱动器）
    → 直发：条目入 #queues 并立即 #drive，返回 {queued:false}（不广播 message.queued）
  steer 且有活动 run
    → 入 #steerBuf，写 meta.queue，广播 message.queued {disposition:"steer"}（无 position）
    → outcome 随当前 run settle（参考值）
  其余（wait / interrupt / 无活动 run 的 steer 降级 wait）
    → wait|降级：追加队尾；interrupt：插队首 + 对活动 run abort()（spec §5.3）
    → 写 meta.queue，广播 message.queued {disposition, position}
    → #drive 起转，返回 {queued:true}
```

`position` 是该条在可执行队列中的序位（0 起）；steer 条目在缓冲区里、没有队列序位，故不带。事件序上 `message.queued` 在总线广播、`send_message_ack` 在命令通道回包，两条通路各自送达——客户端不应假设两者的先后（wire 上 queued 可能先于 ack 到达）。

### 驱动器 #drive：每会话一个循环

```
#drive(sessionId)：已在转则幂等返回
  循环：#demoteSteer（settle 后残余 steer 降级 wait 并入队尾）
        → 队列空？删除 #queues/#drivers 记录，循环退出
        → 出队队首（meta.queue 同步删除，原子重写）→ #executeEntry 执行 → 继续
```

出队执行的条目在 `#executeEntry` 里登记活动 controller（在任何 await 之前——消除旧实现"已出队未注册"的取消窗口）并把本 run 的 outcome 记为 `#activeOutcomes`（steer 的参考 outcome 与降级时序依赖它）。出队阶段的意外失败（meta 写盘炸掉，如会话被删、盘满）不允许重演两种死法：会话永久停转（僵尸驱动器让后续 submit 全部幂等返回、队列无人消费），或循环 promise 裸拒绝。处理：已出队条目以该错误落定并**塞回队首**——persist 抛错意味着 meta.queue 也没写成，塞回后内存与盘上重新一致，条目留在队列等待下一次出队重试，不会被此后任何一次成功的持久化无声抹掉；同时补发条目级失败事件 `run.failed {error.code:"queue_entry_failed"}`（见"边界与出错"）；`#drivers` 同步删除（下一次 submit 重新起转，自愈）、错误日志一次（`kclaw run queue driver … crashed:`）。

### #executeEntry → #execute：一次 run 的装配

1. **工作目录**：`sessionMeta.workdir ?? deps.workspace`——会话级覆盖全局。
2. **记忆注入**：`memory.search(userText.slice(0, 200), 5)`，每条命中变成 `kind:"memory"` note 块（文本 `相关记忆: <hit>`）；检索抛错则不带记忆继续（记忆是加速器，不得阻塞 run）。
3. **读 history**（此刻用户消息尚未追加），构造纯 text 骨架 `userMessage`，`input.attachments` 经 `mountAttachments` 挂成 attachment 块放进同一消息。**消息 id 采用排队时预分配的 `input.messageId`**（出队执行时由 `#executeEntry` 从条目还原传入）——前端气泡从"排队态"原地升级、id 不变；空闲直发没有这个附加，id 为构建时现生成。
4. **工具**：`createBuiltinTools({workspace, memory, tavilyApiKey, exec 超时/输出上限, web 超时/私网开关})`；`deps.tools` 的执行器按名覆盖；`extraTools()` 每 run 求值一次，defs 追加、撞名打 `kclaw tool name collision: <name> (adapter overrides builtin)` 且适配器执行器胜出。
5. **权限**：在 `ConfigPermissionGate` 外再包一层负责登记确认的 gate。装配 gate 时有三处值得注意：`readRoots` 传入附件目录 `paths.attachmentsDir`——上传目录里的文件是 daemon 自己收下的用户输入，fs_read/fs_list 读它们不需要人工确认；`readonly` 取 daemon 级旗标与会话开关的逻辑或，任一为真本 run 就是只读；safeTools 仍按内置工具里标 safe 的集合计算。gate 判出 `confirm` 时，用 gate 签发的 id 调 `broker.create(confirmationId, toolCall, risk ?? "sensitive", confirmTimeoutMs, sessionId)` 登记——这一步只做登记，`confirmation.requested` 事件仍由循环发，全链路用的是同一个 id。
6. **resolveConfirmation**：`broker.wait(confirmationId)` 经 `raceResolution(同 confirmTimeoutMs, controller.signal)` 竞速——人工裁决 / 超时 / abort 三方。非人工胜出（超时或 abort）即 `broker.expire`，晚到的人工 resolve 只会得到 `unknown confirmation`。
7. **模型解析与 LLM 客户端**：`llmForRun(onLlmRetry)` 为本 run 构造带重试可见性的客户端，provider 层每次重试变成 `llm.failed {willRetry:true}` 事件；`runId` 从循环的第一个事件 `run.started` 捕获，`llmAttempt` 计数在 `llm.completed/failed` 后复位。随后三级解析模型：`resolveEntry(input.model ?? sessionMeta?.model ?? defaultModel)`。
8. **压缩视图**：`RunInput.compaction` 传入会话 meta 里的压缩状态 `{ upto, top }`（无则 undefined）——循环据此在请求里垫脉络项、跳过已压缩部分。**不再有发送前预压缩**。`session_search` 的检索后端在此懒构造（`#buildSessionSearch`：返回一个首次调用才打开/重建 `index.db` 的闭包，交给 `createBuiltinTools`）。
9. **runAgent**：`system` 取 `paths.agentsMd`（`~/.kclaw/AGENTS.md`）非空内容，否则默认提示词；`signal` 接本 run 的 controller；`toolResultKeep` 从 `config.sessions.toolResultKeep`（默认 8）传入、`tokenBudget` 传 `预算 × compactAtRatio`，共同驱动请求构造时的预算驱动工具输出省略。`steering` 钩子接 `#drainSteer(sessionId)`——循环在每轮工具批次结束后、下一次调用模型前取走 steer 缓冲区全部消息注入（见下文引导注入口）。两个压缩钩子也在此装配：`midRunCompaction` 接中途压缩（水位≥红线才压，失败/取消返回 null）、`onContextOverflow` 接超限紧急急救（emergency 标记），两者都经 `#runAutoCompaction` 执行（见设计决策）。其余钩子：
    - `onUserMessage`：追加 job note + 记忆 note 块（compact note 已随 v3 移除）→ `appendMessage` 持久化 → （`trigger !== "job"` 时）异步 `scheduleAutoname` → 逐块发 `note.emitted`。
    - `onEvent`：捕获 runId / 复位 attempt → `bus.emit`（再包一层 try/catch，单个异常订阅者不会中断 run）。
    - `onMessage`：assistant/tool 消息持久化。
10. **收尾记账**：run 结束后做三件不影响结果的事——干净 `end_turn` 且配置开启了 autoExtract 时调度自动记忆提取（不等它完成）；有 usageStore 就在 try/catch 里记一行用量；**收尾压缩**：stopReason 非 `aborted`/`error` 且水位 ≥ `预算 × compactAtRatio` 时 `#runAutoCompaction({phase:"post-run", signal})`（await 它，发生在活动登记清除前——驱动器串行化让压缩期间新消息排队，手动 /compact 此时也被"会话活跃"拒绝）。最后在 finally 里清理 `#active`/`#activeOutcomes` 中属于本 run 的登记（仍是自己才删，防止误删后继 run 的）。

调度心跳的 job run 使用同一入口：`run.enqueue(session.id, {userText: job.prompt, trigger: "job", note: "本会话由定时任务「<name>」触发"})`（`packages/server/src/scheduler-tick.ts`），job 触发的 run 跳过自动命名。

### 引导注入口（#drainSteer）与 steer 的一生

steer 条目被 `submit` 放进 `#steerBuf` 后，目标 run 在**迭代边界**（工具批次完成后、下一次 `llm.stream` 前）经 `AgentDeps.steering` 调 `#drainSteer` 取走全部缓冲消息：循环对每条按序广播 `message.created` → 经 `onMessage` 落盘 → `message.completed` → `message.steered {messageId}`（事件级 `runId` 标识注入的 run）——模型在下一轮自然看到，流式输出不打断、不产生新 run。注入或落盘抛错与 `onUserMessage` 同语义：run 以 `run.failed "steering_failed"` 终止。若 run 在取走缓冲前先结束（任何 stopReason），驱动器的下一拍把残余条目降级为 wait 并入队尾（§3.4 降级），下轮出队照常执行——两条路都保证消息进 JSONL。

### 确认网关时序（服务端视角）

```
循环：gate.check(toolCall) → {type:"confirm", confirmationId:"conf_…"}
      ↓（RunManager 的包装 gate 同步登记）
      broker.create(conf_…, toolCall, risk, 120s, sessionId)
循环：广播 confirmation.requested {confirmationId, toolCall, risk, expiresAt}
      ↓ 等待 resolveConfirmation —— 三方竞速开始
      ├─ WS/CLI：confirmation.resolve {confirmationId, approved, client}
      │    → broker.resolve → settle {approved, by:"cli"|"web"} → true
      │    → ws.ts 回 confirmation.resolved_ack；循环发 confirmation.resolved
      ├─ 120s 超时：循环按拒绝处理（note「确认超时，操作未执行」）；
      │    RunManager 侧同超时 → broker.expire → 条目作废
      └─ run.cancel 的 abort：循环不发 confirmation.resolved（取消≠超时拒绝），
           RunManager 侧 expire；tool 结果补 "run aborted before execution"
批准备（approved:true）→ 循环在 tool 消息上记 grantedBy:"confirmed"
     （`packages/core/src/agent/loop.ts`：entry.grantedBy = "confirmed"，
      最终汇成 ToolMessage.grantedBy: Record<callId, GrantedBy> 持久化）
```

裁决来源 `by`：WS 命令的 `client` 字段（`"cli"|"web"`，缺省 cli）决定 `by`；超时为 `"timeout"`。审计依据是持久化的 `grantedBy`，不是事件。

### run.cancel 的 aborted 路径（语义收窄）

`cancel(sessionId)` 只做一件事：`#active` 有 controller → `abort()`、返回 true；没有 → false（ws 层回 `no active run`）。abort 后循环在下一个检查点以 `run.completed {stopReason:"aborted"}` 终止（不是 run.failed），确认等待中的 abort 不算超时拒绝。ack（`run_cancel_ack`）在处理完成后立即返回，终态事件随后经总线到达。

**收窄后的语义：仅中止当前 run，不连带排队消息**。排队中的 wait 条目原封不动，当前 run 停止后由驱动器照常出队执行；排队消息的取消一律走 `queueCancel`。旧实现"出队即取消"的 `#cancelQueued` 标记机制已删除（有意的行为变更，见文末清单）——CLI 的三段 Ctrl+C、Web 的"当前回复停止"都建立在这个窄语义上。

### queueCancel：排队取消

`queueCancel(sessionId, messageId?)` 的取消范围（spec §5.6）：

- **带 messageId**：先查可执行队列（wait 条目随时可取消），再查 steer 缓冲（注入前可取消——长工具批次期间注入窗口可达数分钟，此间条目占着共享上限的坑位）。命中即从内存与 meta.queue 删除、广播 `message.queue_cancelled {messageId}`、回 `{ok:true, cancelled:[id]}`；都不在时按 `#injectedIds` 区分两种失败：近期已注入 → `{ok:false, reason:"injected"}`（已进 JSONL 历史，机器不删历史），否则 `{ok:false, reason:"not_found"}`。ws 层把两者分别映射为错误文案 `已注入` 与 `not found`。
- **不带 messageId**：清空全部可取消条目（全部 wait + 全部未注入 steer），广播 `message.queue_cancelled {all:true}`。

`queue.cancel` 与注入取走在同一 daemon 进程的同一个线程内天然互斥（先到先得）：取消先到则条目被删、注入再也取不到；注入先到则条目已登记 `#injectedIds`、取消请求得到 `injected`。

### recoverQueues：崩溃恢复

daemon 启动时对每个 meta.queue 非空的会话调用：整体重排为内存队列并重新起转驱动器。**steer 与 interrupt 条目一律降级为 wait**——它们的目标场景（某个正在跑的 run）已不存在，降级重排是唯一自洽的语义；恢复后的队列在审计意义上无损（消息都还在），仅在"原本想引导/中断"的意图上打折，这是重启的固有代价。每条恢复条目重新广播 `message.queued {disposition:"wait", position:i}`，让重连的客户端重建排队气泡。

### compactSession：手动压缩（双条件拒绝）

`compactSession(sessionId, focus?)` 是 `/compact` 的服务端入口（HTTP `POST /sessions/:id/compact`、CLI `/compact`、web "压缩"按钮三者共同调用）。先检查忙，**两个拒绝条件、两条文案**（spec §5.7），队列优先——正在跑的 run 与积压队列并存时，"等它结束"永远解不了围，"先处理或取消排队"才是可行动的建议：

- `meta.queue` 非空 → 抛 `还有 N 条排队消息，先处理或取消`；
- `#active` 有活动 run → 抛 `会话正在运行，等它结束`。

两者都映射为 HTTP 409（压缩要读全量历史、写会话元数据，与运行中的写入并发会互相破坏）。通过后按会话 meta 解析模型，以 `manual: true` 调 `#compactV2`，跳过触发判断，其余流程（两次摘要调用、meta 写入、索引、审计）与自动压缩完全一致。返回一句话：成功是 `压缩了 N 段，剩 X 条原文消息`，历史太短没有可压缩内容是 `无可压缩内容`（不产生任何状态变化）。手动压缩**不产生新消息**：总摘要挂在下一条用户消息上注入，本次压缩的痕迹在 `compactions.jsonl`（`trigger: "manual"`，带 focus）。

### 自动命名（autoname.ts）

`scheduleAutoname({sessions, llm, model, emit}, sessionId, firstText)`：

1. 前置：`meta.title === "新会话"` 才命名（已手动改名的不处理）。
2. 异步生成：`defaultTitle` 用 run 的同一个 llm 流式调用，system 为 `"你是标题生成助手，只输出一个不超过30字的会话标题。"`，user 为 `给这段对话起一个不超过30字的标题：
<firstText>`；拼接全部 `text_delta`。
3. 写回：`title.trim().slice(0, 30)`，空串放弃；**写回前重读 meta**——生成期间用户可能已手动改名，此时标题仍不是 `"新会话"` 则不再修改。
4. 更名成功才 `emit(makeEvent("session.renamed", { title }, { sessionId }))`（注入的是 `busEmit`）；失败静默（catch 空处理，保持默认标题）；不阻塞 run（`void scheduleAutoname(...)`，不 await）。

## 边界与出错

- **enqueue 的 promise 对 provider 错误不 reject**（`runAgent` 内部消化为 `run.failed` + `RunOutcome.stopReason:"error"`）。**错误帧只回给同步失败**：`submit` 抛错（队列满 / 会话不存在 / 处置字段非法）发生在 ack 之前，ws 层当场回 error 帧、无 ack。ack 之后 ws 层对 `submit().outcome` 是 fire-and-forget——run 级与持久化级的**迟到失败不再发迟到帧**，改经总线事件到达订阅客户端：run 级失败走循环的 `run.failed`；出队持久化失败与条目执行失败（循环的 `run.failed` 兜不住的两类）走 RunManager 补发的 `run.failed {error:{code:"queue_entry_failed", message 含 messageId 与原因}}`。
- **队列已满是同步拒绝**：`submit` 在入队前检查上限（排队 + steer 缓冲合计 10），超限直接抛 `队列已满（10 条）`，ws 层回 error 帧、无 ack——消息不会半入队。上限不分池：steer 与 wait 挤同一个池子，挤压风险由"steer 注入前可单条删除"化解（排队气泡可见、可删）。
- **排队取消是三态的**：命中删除 / `injected`（近期已注入，进了 JSONL 机器不删历史）/ `not_found`（无此条目，或已被当前会话队列淘汰）。判定依赖 `#injectedIds`——有界集合（容量 `QUEUE_LIMIT×2`，够覆盖一个满队列加直发余量），注入时登记；重启后集合清空，恢复条目尚未注入前取消仍是合法的。
- **附件路径的第二道检查会终止整条 run**：正常情况下 ws 帧层已经把越界的附件引用拦在入队之前；如果有越界路径绕过了帧层到达 `mountAttachments`（比如直接调用 enqueue 的代码没做检查），这里的抛错让本次 run 以异常收场——await 该 outcome 的调用方看到 reject，订阅客户端经 `queue_entry_failed` 事件看到失败（见下一条）。steer 注入时的同一检查失败不终止整条 run 的历史注入批次——`#drainSteer` 先构建后变更，任一条构建失败即整体留在缓冲区（异常走 `run.failed "steering_failed"`），条目仍可取消、可重试注入；注入前 run 先结束的，残余条目降级入队后走到同一出队执行路径，装配段同步抛出同样补 `queue_entry_failed`。
- **条目级失败有可见性事件（`queue_entry_failed`）**：两类失败发生时循环的 `run.failed` 兜不住——出队持久化失败（run 还没起）与条目执行在装配段的同步抛出（如降级坏附件，`mountAttachments`/读历史在 `runAgent` 之前就炸）。驱动器在这两条路径上补发 `run.failed {error:{code:"queue_entry_failed", message}}`（message 含 `messageId` 与原因，sessionId 级事件），已 ack `queued:true` 的消息不会无声消失；出队持久化失败还伴随条目退回队首（内存与 meta.queue 保持一致，等待重试）。
- **确认裁决不落任何队列**：`broker.resolve` 对已 settle/过期条目返回 false 并回 `unknown confirmation`，不记录"迟到的意见"。确认卡挂起期间 steer 照常入缓冲区；run 在等确认期间不迭代，注入发生在确认解决后的下一个迭代边界——无特殊路径。
- **自动命名没有去重锁**：同一会话两次快速入队理论上可能并发两次命名，写回前的重读校验保证只有第一次生效（后到的发现标题已不是默认值即放弃）。
- **`resolveConfirmation` 测试缝优先于 broker**：设置了它 broker 就只剩登记职责——生产路径不设置。
- **压缩与记账失败都不影响 run 的结果**：自动压缩的模型调用或 meta 写入失败时 `#runAutoCompaction` 消化为 null、运行照常继续（事件 `completed {result:"failed"}`；`kclaw compaction failed:` / `kclaw compaction (phase) failed:` 日志）；段索引写入与审计追加失败只留一行日志、压缩照常生效；用量记录和自动记忆提取失败只留一行日志（`kclaw usage record failed:` / `kclaw memory extraction failed:`）。以上任何一种失败 run 都照常返回 outcome。

## 有意的行为变更（message-queue spec §9）

本轮队列机制落地时改变了四处既有行为，均为设计决定而非缺陷：

1. **`run.cancel` 语义收窄**：只中止当前 run，不再连带取消排队消息（旧实现 `#cancelQueued` 的"出队即取消"机制删除）。排队消息的取消一律走 `queue.cancel`（WS 命令 / CLI `/queue cancel` / Web 气泡取消按钮）。
2. **旧客户端的默认处置从"自动等待"变为"默认引导"**：不带 `disposition` 字段的 `send_message` 取会话覆盖 ?? `sessions.defaultDisposition`（缺省 steer）。旧版在会话忙时新消息自动排队等待；现在默认注入正在跑的 run（会话空闲时两种处置等价，行为不变）。
3. **job tick 消息同受队列上限约束**：旧实现在会话忙时无界排队；现在 job tick 的通知消息固定按 wait 入队，会话排满（10 条）时同样被拒。上限是有意的背压。
4. **CLI 运行中输入的行立即按当前处置发送**：不再等当前 run 的提示符回归——运行中回车即发（steer 注入 / wait 排队 / `/interrupt` 中断），呈现由帧泵接管。

## 关联

- [agent-loop](../core/agent-loop.md)：runAgent 状态机、确认的循环侧竞速、6 个 abort 检查点、attachment 块进模型视图的转换
- [permissions](../core/permissions.md)：ConfigPermissionGate 的判定链与 `conf_*` id 的签发；readRoots/readonly 两处装配
- [realtime](./realtime.md)：send_message/confirmation.resolve/run.cancel/queue.cancel 的帧协议与 ack
- [memory](../core/memory.md)：search 的实现（SQLite FTS5）
- [compaction](../core/compaction.md)：`#compactV2` 背后的触发/分界/摘要机制、审计记录格式与配置字段
- [mcp](../core/mcp.md)：`extraTools` 的来源（MCP 工具适配器）
- [storage](../core/storage.md)：UsageStore 的台账实现（`usageStore.record` 背后）
- [http-api](./http-api.md)：GET /sessions/:id/queue、POST /sessions/:id/disposition 两个队列路由与写入 session meta model/readonly 的既有路由
- [webui](../web/webui.md)：发送三选、排队气泡与重连纠偏的消费侧
