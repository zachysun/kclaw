# run-manager — 会话串行 run、消息队列与确认网关（服务端侧）

## 职责

`packages/server/src/run.ts` 的 `RunManager` 是 `send_message` 之后服务端的**队列状态机**：消息去向的三处置决策（引导/等待/中断，见下文 submit）、每会话一条显式排队队列与其驱动循环、入队执行（把出队条目连同 AbortController 与 steer 取走回调交接给引擎）、run 取消、排队取消、手动压缩入口与崩溃恢复。单条 run 的**装配**——附件挂载、模型解析、记忆注入（L2 认知常驻系统提示 + L1 情节 note，见装配第 4 步）、技能目录扫描与点名包装（见装配第 6 步）、系统提示（双段冻结基线或拼装，每 run 一条 `system` 事件按 stable/live 记录，见装配第 11 步）、工具与权限装配、事件发送到总线、run 边界与裁决留痕（`run.started`/`run.ended`/`permission.decided` 三事件）、消息持久化、token 用量记录——在 core 的 `executeRun`（`packages/core/src/agent/run-assembly.ts`，引擎侧）完成，经 `RunEngine`/`RunHandoff` 两个形状与队列交接。确认网关 `ConfirmationBroker`（`packages/core/src/permissions/broker.ts`）是人工裁决的服务端半边：等待中的裁决经 WS/CLI 的 `confirmation.resolve` 命令、等待中的问题经 `question.resolve` 命令在此完成（同一个对象、两类等待中的条目）。`packages/core/src/session/autoname.ts` 的 `scheduleAutoname` 在首条用户消息后异步生成会话标题并把更名广播为 `session.renamed` 事件。调度心跳（`scheduler-tick.ts`）触发的 job run 也使用同一个入口。

## 设计决策

- **ack 与 run 解耦是结构性保证**：`ws.ts` 收到 `send_message` 后 `run.submit` 同步决策去向并立即回 `send_message_ack`（携带 `messageId` 与 `queued`，不 await run），run 的进展全部以 `run.*` 事件流回订阅者——长任务永远不阻塞命令通道。
- **队列模型：queue.jsonl 持久化 + 内存副本 + 每会话驱动器**：排队消息是"当前状态"而非"已执行历史"，因此持久化在独立文件 `queue.jsonl`（`QueueEntry[]`，整文件重写、原子写入磁盘，数组顺序即执行顺序），不进事件流（`events.jsonl`）——`readMessages` 的所有消费方（agent 历史、压缩范围、审计页）天然不含排队消息，崩溃恢复也只需读 queue.jsonl。内存侧 `#queues`（可执行条目 wait/interrupt）与 `#steerBuf`（steer 缓冲）是 queue.jsonl 在内存里的同步副本；`#drive` 为每会话一个循环：`run 结束 → 残余 steer 降级并入队尾 → 队列非空？出队执行 → 循环`，run 因任何原因结束都先降级残余 steer 再触发下一轮出队判定。每会话排队 + steering 缓冲合计上限 10 条（`RunManager.QUEUE_LIMIT`，写死不做配置项），超限 `submit` 抛 `队列已满（10 条）`。
- **三种处置只决定消息何时被模型看到**：steer 注入正在跑的对话（在迭代边界注入——即模型完成一轮输出、要发起下一轮请求之间的间隙；不产生新 run）；wait 留在队列等当前 run 结束后出队；interrupt 立即中止当前 run 并插队首。三条路径最终都写进 JSONL，消息 id 在入队时预分配（`entry.messageId`）、出队/注入执行时用同一 id 构建消息——前端气泡从"排队态"原地升级。处置生效层级：单次请求显式指定 > 会话级覆盖（`SessionMeta.dispositionOverride`，CLI `/steer`/`/wait` 与 Web 三选的 steer/wait 写入；interrupt 是一次性动作、Web 与 CLI 均不写覆盖）> 配置默认 `sessions.defaultDisposition`（缺省 steer）。
- **steer 缓冲与降级**：steer 消息不进执行队列，进当前 run 的 steering 缓冲区；run 在迭代边界经 `turn-boundary` 位置的钩子链（内置 `steering-drain`）取走全部缓冲消息注入。会话**完全空闲**（无活动 run、无可执行条目、无驱动器）时消息不降级、直接开跑（`queued:false`，不广播 `message.queued`）；只有"队列/驱动器在转但无活动 run"时 steer 才降级为 wait 入队并按 wait 报告（`message.queued {disposition:"wait", position}`）。若 run 在取走缓冲前结束（end_turn/aborted/failed 任何原因），残余条目在驱动器的下一拍自动降级为 wait、按原顺序并入队尾——消息绝不丢，队列里可执行的只有 wait 与 interrupt。
- **注入的取走是先构建后变更**（不变量）：`#drainSteer` 先在局部把全部缓冲条目构建成 user Message（附件挂载可能失败——越界、文件被删），全部成功后才清空缓冲、重写 queue.jsonl 并把 id 登记进 `#injectedIds`（有界集合，容量 `QUEUE_LIMIT×2`，用于把排队取消请求区分为 `injected`（已进事件流历史，机器不删历史）与 `not_found`）；任一构建失败即整体不动，异常抛给循环走 `run.failed "steering_failed"`。
- **job 消息固定 wait 且同受上限约束**：服务器内部的入队（job tick 的通知消息）按 wait 处置、不读 `defaultDisposition`——job 的语义是"当前的事忙完后轮到我"，没有"引导正在跑的 run"的诉求。上限对 job 一视同仁：会话排满时 job tick 的消息同样吃 `队列已满` 错误。**这是有意的行为变更**（旧实现忙时无界排队，见文末行为变更清单）。
- **用户消息由引擎预制**：以纯 text 骨架（先建只含一个文本块的消息，note 块随后补全）经 `RunInput.userMessage` 传入，循环原样使用且不重复持久化；note 块（job 来源 + 记忆）由 run-before 钩子链（内置 `memory-inject` 收集 → `user-message-land` 统一追加）补全——事件序固定为 `run.started → message.created → note.emitted ×N → message.completed`，且持久化先于 note 事件（事件反映已持久化状态）。附件挂载同样在骨架构建时完成；越界路径在 `mountAttachments` 里抛错终止整条 run。
- **历史在追加用户消息之前读**：`runAgent` 自己会把用户消息拼在 `history` 之后（`[...input.history, userMsg]`），若 history 已含它会向 provider 重复发送同一段文本。
- **broker 只做桥接，不发事件、不管理超时**：`confirmation.requested`/`confirmation.resolved` 由 agent 循环发（`packages/core/src/agent/loop.ts`），broker 若再发即造成线上重复；超时裁决也由循环的 `raceConfirmation` 完成。broker 的 `expiresAt` 只是登记信息。
- **两侧的超时裁决互相一致**：引擎侧（core run-assembly）的 `raceResolution` 与循环侧的 `raceConfirmation` 用**同一个** `confirmTimeoutMs` 同时等待同一个人工 promise，谁先出结果算谁的——两侧结论一致；迟到的人工裁决被已经出结果的等待丢弃，服务端再把条目标记为过期，晚到的 resolve 只能得到 `unknown confirmation`。
- **自动命名静默且不覆盖手动改名**：失败静默处理、两次校验默认标题（生成前、写回前），用户已手动改名则不再修改。更名成功写回 meta 后，经注入的 emit 钩子（`busEmit`）广播 `session.renamed {title}`——订阅者立即收到通知。
- **模型解析：每 run 一次，三级优先级**：本轮用哪个模型，按 `input.model`（job 配置的模型或客户端指定的）→ 会话 meta 的 `model`（POST `/sessions/:id/model` 写入的那个）→ daemon 默认模型的顺序取第一个非空的。取到的值再经 `resolveEntry` 做一次翻译：如果它是 config 里 provider 条目的名字（比如 `deepseek`），就换成该条目配置的线上模型名（比如 `deepseek-chat`）；如果本来就是一个直接的 API 模型名则原样通过。解析发生在每个 run 开始时，所以改完会话模型后下一次 run 即生效。
- **附件挂载：按文件类型分三种处理**：`mountAttachments` 把用户上传的文件转成用户消息上的 attachment 块。文本类文件（MIME 为 `text/*` 或扩展名是常见文本类型）且不超过 64KiB 时，读出正文内联进消息（超过 8192 字符截断并加 `\n…[已截断]`）；图片且不超过 5MiB 时转成 base64 内嵌（作为多模态内容段发给模型）；其余文件只在块里放 `{type:"file", path}` 路径信息，模型需要内容时自己用 fs_read 读。安全上有两道检查：ws 层在校验 send_message 帧时查过一次路径，这里再用 `realpathWithin` 复核一遍——引用越出本会话附件目录就直接抛错、终止整条 run。
- **用量记录失败不影响 run**：run 正常结束后向 `usageStore.record` 记一行（会话 id/run id/模型/输入输出 token/时刻）。这行代码包在 try/catch 里，失败只打 `kclaw usage record failed:` 日志；daemon 没注入 usageStore 时整个步骤跳过。
- **记忆写入在 core 侧，run 路径只留注入与检查排期**：旧版的"run 结束后服务端发出即忘的自动提取"（`config.memory.autoExtract`）已移除——写入管线整体移入 core 的 `MemoryPipeline`（`packages/core/src/memory/pipeline.ts`），由五触发驱动（`memory_save` 工具的 immediate、`/memory save` 的手动 manual、新建会话路由的 clear、定时 interval、跟随 follow，机制见 [memory](../core/memory.md)）。run 路径（core `executeRun`）只承担三件事：每次 run 的两级注入（L2 认知常驻系统提示 + L1 情节 note，见装配第 4 步）；给 `createBuiltinTools` 传入 `memoryCtx.immediateEnabled = config.memory.write.immediate`（决定 `memory_save` 工具是否当场触发写入）；run 收尾时排一个跟随检查（`idleMinutes > 0` 时 `memory.scheduleFollowCheck`，写入 `<projectDir>/state.json`，daemon 重启后由记忆调度器补查，见下文装配第 13 步）。
- **上下文压缩（token 触发的分层摘要，五个触发点）**：压缩不再发生在发送路径上——引擎直接以全量 `history` 起 run，用户发消息永远零压缩等待。五个触发点由 run 路径编排（机制细节与数据格式见 [compaction](../core/compaction.md)）：
  - **后台预压**：`compaction-check` 位置的内置钩子 `background-precompact`（排在 `mid-run-panic` 之前）在每个迭代边界检查：上下文占用进入 [预压线, 红线) 区间且没有正在执行的压缩、无暂存成果、无取消标记时，`compactor.background(...)` 非阻塞派一次后台压缩（`Compactor.background` 登记为正在执行后立即返回，摘要调用在后台跑，不挂 run 的中止信号）。成功后成果先写入元数据、视图暂存，由下一次迭代边界的 `mid-run-panic` 取用。
  - **收尾压缩**（主路径）：`runAgent` 返回且 stopReason 非 `aborted`/`error` 时，用 `estimateContextTokens(readMessages(sessionId))` 估算上下文占用（锚定最后一条助手消息记录的真实 `usage.inputTokens`，锚之前的内容天然不计入——它们不在上一次请求里，所以直接对全量历史读数即可），上下文占用 ≥ `budget × (compactAtRatio ?? 0.80)` 就 `compactor.auto({phase:"post-run", signal})`。它在 `executeRun` 内 await、位于 token 用量记录之后——会话驱动器的串行化保证压缩期间新到的消息排队等待、不会并发写会话元数据（这窗口内收到的手动 /compact 也被"会话活跃"条件自然排队，下一轮 run 的收尾链冲刷）。估算前若还有正在执行的后台压缩，先等它结束（暂存视图取走丢弃——循环已结束没有下一次请求可应用，元数据已携带同一成果）再读数；等待后走正常黄线判断，auto 内部的活跃段细粒度判断自适应——后台成果已把活跃段打下去时它自然不再压。
  - **中途压缩**：`compaction-check` 位置的内置钩子 `mid-run-panic`（见 [hooks](../core/hooks.md)）在每轮迭代边界触发。钩子内先查取消标记与 run 的中止信号（任一命中返回 null 不压，暂存的后台成果也留到下一次运行再应用），未命中再取暂存的后台成果（有就直接采用为新压缩视图——占用多半已降回线以下，不再压第二次），然后算上下文占用：≥ `budget × (compactPanicRatio ?? 0.90)` 才进入压的分支。若此刻有正在执行的后台压缩则先等它结束，再按暂存视图的分界重估活跃段（重估读数受旧锚点影响偏高，安全方向）——仍超红线才同步压（活跃段切不出边界就放弃硬压、应用暂存成果），否则直接应用暂存成果；压缩成功返回新的压缩视图 `{ upto, top }`，循环从下一次请求起应用（`upto` 之前原文不再发、脉络项垫在 `messages[0]`）；失败返回 null、运行不补救继续。
  - **超限急救**：`overflow-rescue` 位置的内置钩子 `overflow-emergency` 在流式调用抛出上下文超限错误且零输出时触发——不看上下文占用，"已经爆了"就是事实。救援等不得：先 `compactor.abortInFlight` 掐掉正在执行的后台压缩并等它结束（被掐的成果丢弃，原文无损；不用 `cancel`——它的取消标记会压制紧随其后的急救本身），再 `compactor.auto({phase:"in-run", emergency:true, signal})`；成功则循环整次请求静默重发一次（最多一次），仍失败才走报错路径。
  - **手动 /compact**：`compactSession` 直调 core `Compactor.compact({manual:true, phase:"manual"})`，跳过触发线；会话忙时不拒绝而是排队，运行结束的收尾链先冲刷它（见下文第 13 步），已有排队消息时仍拒绝。
  - `Compactor.auto`（core `session/compactor.ts`）是收尾/中途/超限三路的共用装配：为每次压缩建独立 AbortController 并登记在一张"正在进行中"的表里（后台预压也登记同一张表，`waitForSettled` 供同步路径等待），run 的中止信号联动过去（run 中止时顺带取消同步压缩），run 结束时清理；压缩自身的摘要调用经 `collectStreamText` 带 `{ signal }`，取消信号触发时抛出 → `Compactor.compact` 走 cancelled 分支。`cancelCompaction`（WebUI 指示行取消按钮 → WS 帧 `compaction.cancel`）写会话级取消标记并取消正在进行的压缩（含后台预压）；标记在每次 run 装配（`executeRun`）开头清除，只压制本次运行内的自动压缩。
  - `Compactor.compact` 内部：按 `SessionMeta.compaction.upto` 切出 active 历史（旧会话退回读 `compactedUpto`，标记在历史里找不到视为无标记），上下文占用过线后由 `chooseBoundary` 选出分界——从最新往回累加到预算 × `compactTargetRatio`（默认 0.33）为止，起点再对齐到最近的用户消息（保证段与保留部分都是完整轮次）。压缩是两次无 tools 的 `collectStreamText` 调用（复用本轮 `runLlm` 与解析出的 model，`Compactor.auto` 内 await）：新段经 `renderSegment` 生成固定五栏的段摘要，再与旧总摘要归并出新总摘要；**两次全部成功后**追加一条 `compaction` 事件（这是 `meta.compaction` 与压缩审计的唯一写入点——事件投影据此维护 `{ segments, top, upto }`，`trigger` 按 `manual`/`in-run`/`auto` 三值、超限急救带 `emergency`）。旧版压缩的遗留字段 `compactedSummary`/`compactedUpto` 不再主动删除（有 `meta.compaction` 后即被遮蔽、无实际作用）。事件：上下文占用过线且边界已定先发 `compaction.started {phase}`，之后无论成败/取消必发 `compaction.completed {segments, kept, phase, result}`（失败/取消时 segments/kept 为 0）；占用未过线则两个事件都不发。摘要调用或事件写入失败时 `Compactor.compact` 记一行 `kclaw compaction (<阶段>) failed:` 日志并以 failed 结局回答（`Compactor.auto` 把结局原样转发给触发钩子）——运行照常继续，下一次过线重新触发。总摘要不再挂 note，而是经循环的压缩视图以脉络项进请求（见 [compaction](../core/compaction.md) 的"注入"）。

## 接口

```ts
// packages/server/src/run.ts（RunManagerDeps 原样收进引擎 deps；EnqueueInput、
// LlmRetrySink、AttachmentRef 等输入形状已移入 @kclaw/core，见下）
export interface RunManagerDeps {
  config: KclawConfig
  paths: KclawPaths
  sessions: SessionStore
  memory: MemorySystem                 // 记忆系统门面（把各记忆子系统包成一个统一入口）：两级注入 + 跟随检查排期（见 executeRun 装配）
  bus: EventBus
  llm: LlmClient                       // 无 llmForRun 时的共享客户端
  workspace: string
  model?: string                       // daemon 解析一次后传入（provider 条目 ?? KCLAW_LLM_MODEL）
  broker?: ConfirmationBroker          // 缺省内部新建，暴露为 manager.broker
  resolveConfirmation?: (confirmationId: string) => Promise<ConfirmationResolution | "timeout">
                                        // 测试注入点（仅为测试替换内部实现预留的接口）；daemon 路径只用 broker
  llmForRun?: (onRetry: LlmRetrySink) => LlmClient
                                        // 每个 run 一个带重试可见性的客户端（daemon 默认组合设置）
  tools?: Map<string, ToolExecutor>    // 按名覆盖内置工具执行器（测试注入点；schema 仍用内置的）
  extraTools?: () => { executors: Map<string, ToolExecutor>; defs: ToolDefinition[] }
                                        // 活的适配器工具（MCP 管理器）：是函数、每个 run 调一次求值，
                                        // 连接在两次 run 之间上/下线都反映到下一次请求；defs 追加在内置 defs 之后，
                                        // 与内置撞名时打一行日志且适配器执行器胜出（schema 随执行器走）
  usageStore?: UsageStore              // 每 run token 用量记录（缺省不记录；记录失败只打日志）
  subagents?: {
    spawner: SubagentSpawner             // 派发后端（阻塞与后台子代理的创建、并发计数、状态转发）
    collector?: SubagentCollector        // 后台子代理的结题答复收集（subagent_collect 工具的后端，
                                          // 校验子会话确属本父会话）
  }
                                        // daemon 装配 createSubagentHost 的三件产物（见 subagents.md）：
                                        // 注入后主线 run 的工具清单多出 subagent_run 与 subagent_collect
}

export interface EnqueueInput {
  userText: string
  trigger: "user" | "job" | "agent"
  model?: string       // 本 run 的模型覆盖（job 配置的模型或客户端强制）；缺席 → 会话 meta → 默认
  attachments?: AttachmentRef[]  // 挂到用户消息上的附件引用（调用方已校验，这里防御性复验）
  note?: string        // job 来源行，落在用户消息的 kind:"job" note 块
  disposition?: "steer" | "wait" | "interrupt"
                        // 单次显式处置（层级最高）；缺省 = 会话覆盖 ?? 配置默认；
                        // trigger:"job" 与 "agent" 固定 wait，不读默认
  messageId?: string   // 内部：驱动器出队执行时传入的预分配消息 id（ws 层不传）
}

/** submit 的同步决策结果：消息身份、是否入队与实际生效处置（降级后）。 */
export interface SubmitResult {
  messageId: string
  queued: boolean      // false = 空闲直发（不广播 message.queued，ack 里 queued:false）
  disposition: "steer" | "wait" | "interrupt"
                        // 实际生效处置：空闲直发时为原值；队列在转但无活动 run 时 steer 降级为 wait 并按 wait 报告
  outcome: Promise<RunOutcome>
                        // wait/interrupt：本条 run 的 outcome；steer：随当前 run 结束而定
                        //（参考值，ws 层发出后不等待结果）
}

/** A reference to an uploaded attachment file (mounted as an attachment block). */
export interface AttachmentRef {
  path: string
  name: string
  size: number
  mimeType: string
}

export class RunManager {
  static readonly QUEUE_LIMIT = 10    // 每会话排队 + steer 缓冲合计上限（写死）
  get broker(): ConfirmationBroker
  submit(sessionId: string, input: EnqueueInput): SubmitResult
                        // 同步决策去向：空闲直发；steer+活动 run → 入缓冲区；
                        // 其余入队（interrupt 伴随对活动 run 的 abort）；队列满抛错
  enqueue(sessionId: string, input: EnqueueInput): Promise<RunOutcome>
                        // 兼容包装 = submit().outcome（job tick 等旧调用方不变）
  queue(sessionId: string): QueueEntry[]
                        // queue.jsonl 的内存副本（可执行条目 + steer 缓冲），内容与之一致，
                        // 供 GET /sessions/:id/queue 与恢复使用
  queueCancel(sessionId: string, messageId?: string):
    | { ok: true; cancelled: string[] }
    | { ok: false; reason: "not_found" | "injected" }
                        // 排队取消：wait 随时、steer 注入前可取消；
                        // 不带 id = 清空全部可取消条目并广播 {all:true}
  cancel(sessionId: string): boolean   // 只中止当前 run；false = 无活跃 run
  recoverQueues(): void                // daemon 启动恢复：queue.jsonl 整体重排，steer/interrupt 降级 wait
  cancelCompaction(sessionId: string): boolean
                                        // 取消进行中的自动压缩：写会话级取消标记 + 取消压缩用的
                                        // controller；返回"是否有压缩正在进行"。标记只压制本次运行内
                                        // 的自动压缩（中途/收尾），下一次运行开始时清除；手动 /compact 不查标记
  compactSession(sessionId: string, focus?: string): Promise<{ queued?: boolean; message: string }>
                                        // 手动压缩（HTTP/CLI/web 三入口共用）：队列非空仍拒绝
                                        // （409）；会话活跃时不再拒绝而是排队——返回
                                        // {queued:true}，运行结束的收尾链先冲刷它（manual-compact-flush）；
                                        // 无可压缩内容返回固定文案
}
```

```ts
// @kclaw/core — packages/core/src/permissions/broker.ts
export class ConfirmationBroker {
  create(confirmationId, toolCall, risk, timeoutMs, sessionId?): Promise<ConfirmationResolution>
  resolve(confirmationId, decision, by = "cli"): boolean   // 完结仍等待中的条目；未知/已决/过期 → false
  wait(confirmationId): Promise<ConfirmationResolution>    // 未知的 id 永不出结果（超时归循环管）
  expire(confirmationId): void                             // 标记过期（Race 输给超时/abort 后调用）
  pending(): ConfirmationRequestedPayload[]                 // 当前等待中的列表（供未来的 HTTP 列表端点）
}
```

关键常量（core `agent/run-assembly.ts`；两个压缩提示词在 `session/compactor.ts`）：`MEMORY_QUERY_CHARS = 200`（用户文本前 200 字符做 L1 情节检索）、`MEMORY_LIMIT = 5`（最多注入 5 条情节 note）、`DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"`（AGENTS.md 缺失/为空时的回退提示）；附件挂载的 `TEXT_INLINE_MAX_BYTES = 64KiB`、`TEXT_INLINE_MAX_CHARS = 8192`、`IMAGE_INLINE_MAX_BYTES = 5MiB`。两个固化系统提示词（压缩用）：`SEGMENT_SUMMARY_PROMPT`（段摘要：固定五栏 markdown、不超过 800 字）、`MERGE_SUMMARY_PROMPT`（总摘要归并：同样五栏、保留新版本并注明被推翻的旧版本）；记忆提取/内化的提示词已随写入管线移入 core（见 [memory](../core/memory.md)）。压缩触发的五个比例不在 defaultConfig 里（`sessions` 段的 `contextTokens`/`compactPackRatio`/`compactAheadRatio`/`compactAtRatio`/`compactPanicRatio`/`compactTargetRatio`/`toolResultKeep` 均可选），缺省值在读取处补齐：预算与省略线（128000 / 0.70）在 core `executeRun`，预压线/红线/黄线复核（0.75 / 0.90 / 0.80）在压缩内置钩子定义处，目标比例（0.33）与黄线在压缩引擎 `Compactor`。确认超时来自 `config.permissions.confirmTimeoutMs`，默认 `120_000`（120 秒，`packages/core/src/storage/config.ts` 的 defaultConfig）。

## 核心流程

### submit：三处置同步决策

```
submit(sessionId, input)
  meta 存在性检查；处置解析（显式 > 会话覆盖 > 配置默认；job 固定 wait）
  queue.length + steerBuf.length >= 10 → throw 队列已满（10 条）
  空闲（无活动 run、无可执行条目、无驱动器）
    → 直发：条目入 #queues 并立即 #drive，返回 {queued:false}（不广播 message.queued）
  steer 且有活动 run
    → 入 #steerBuf，写 queue.jsonl，广播 message.queued {disposition:"steer"}（无 position）
    → outcome 随当前 run 结束而定（参考值）
  其余（wait / interrupt / 无活动 run 的 steer 降级 wait）
    → wait|降级：追加队尾；interrupt：插队首 + 对活动 run abort()
    → 写 queue.jsonl，广播 message.queued {disposition, position}
    → #drive 起转，返回 {queued:true}
```

`position` 是该条在可执行队列中的序位（0 起）；steer 条目在缓冲区里、没有队列序位，故不带。事件序上 `message.queued` 在总线广播、`send_message_ack` 在命令通道回包，两条通路各自送达——客户端不应假设两者的先后（网络上 queued 可能先于 ack 到达）。

### 驱动器 #drive：每会话一个循环

```
#drive(sessionId)：已在转则幂等返回
  循环：#demoteSteer（run 结束后残余 steer 降级 wait 并入队尾）
        → 队列空？删除 #queues/#drivers 记录，循环退出
        → 出队队首（queue.jsonl 同步删除，整文件重写）→ #executeEntry 执行 → 继续
```

出队执行的条目在 `#executeEntry` 里登记活动 controller（在任何 await 之前——消除旧实现"已出队未注册"的取消窗口）并把本 run 的 outcome 记为 `#activeOutcomes`（steer 的参考 outcome 与降级时序依赖它）。出队阶段的意外失败（queue.jsonl 写入失败，如会话被删、盘满）不允许出现两种故障形态：会话永久停转（僵尸驱动器让后续 submit 全部幂等返回、队列无人消费），或循环 promise 直接以异常告终、无人接住。处理：已出队条目以该错误落定并**塞回队首**——写入抛错意味着 queue.jsonl 也没写成，塞回后内存与盘上重新一致，条目留在队列等待下一次出队重试，不会被此后任何一次成功的持久化无声抹掉；同时补发条目级失败事件 `run.failed {error.code:"queue_entry_failed"}`（见"边界与出错"）；`#drivers` 同步删除（下一次 submit 重新起转，自愈）、错误日志一次（`kclaw run queue driver … crashed:`）。

### #executeEntry → executeRun（core）：一次 run 的装配

队列侧的 `#executeEntry` 出队后构造 `RunHandoff { sessionId, input, controller, drainSteer }`，调 core 的 `executeRun(engine, handoff)`（`packages/core/src/agent/run-assembly.ts`）——以下装配步骤都在那里发生（`engine = { deps, compactor }`，deps 与 RunManagerDeps 同一组依赖、broker 已解析为必选）：

1. **工作目录**：`sessionMeta.workdir ?? deps.workspace`——会话级覆盖全局。
2. **用户钩子重扫**：`engine.deps.hooks`（daemon 级 `HookRegistry`）`refresh()` 重扫 `~/.kclaw/hooks/`——"放文件，下一轮生效"（与技能目录扫描同一套思路，机制见 [hooks](../core/hooks.md)）；新装载失败经 registry 按"文件名+mtime+错误"去重后发一次 `hook.failed {phase:"load"}` 事件。
3. **钩子链**：为本 run 建一个 `HookChain`（超时读 `config.hooks.timeoutMs` 默认 5s；skip 失败经 `onFailure` 扇上总线；`eventCtx` 惰性携带 runId）。随后按序注册三批条目：`makeBuiltinHooks({...})` 的内置闭包（记忆检索、消息写入、自动命名、技能包装、重试可见、引导 drain、两个压缩决策、收尾四件套、系统提示词材料——清单与次序见 [hooks](../core/hooks.md)，系统提示词审计不在链上、由装配层直接写入事件流）→ `hooks.snapshot()` 的用户文件条目（默认 order 1000）→ `deps.extraHooks` 的测试注入。循环只知道位置，所有行为都在这条链上。
4. **记忆注入**（两级，机制见 [memory](../core/memory.md)）：
   - **L2 常驻（系统提示）**：认知块不再由装配直接拼——它由 `system-before` 位置的内置 `system-materials` 钩子收集（`memory.cognitionPrompt(workspace)`，scope 过滤 + 预算取舍详见 memory.md；认知为空或抛错时该段缺席，run 照常进行），与技能清单一起在系统提示词组装时追加（见第 11 步）。
   - **L1 情节（用户消息 note）**：由 run-before 位置的内置 `memory-inject` 钩子检索（`memory.searchEpisodes(workspace, 首条文本前 200 字符, 5)`），命中变成 `kind:"memory"` note 块（文本 `相关经历（<线的一句话标题>）: <情节正文>`）；检索抛错则不带记忆继续（记忆是加速器，不得阻塞 run）。
5. **读 history**（此刻用户消息尚未追加），构造纯 text 骨架 `userMessage`，`input.attachments` 经 `mountAttachments` 挂成 attachment 块放进同一消息。**消息 id 采用排队时预分配的 `input.messageId`**（出队执行时由 `#executeEntry` 从条目还原传入）——前端气泡从"排队态"原地升级、id 不变；空闲直发没有这个附加，id 为构建时现生成。job 触发的提示文案（`input.note`）也在此备成 `kind:"job"` note 块，交由 run-before 链追加进消息。
6. **技能扫描与工具**：先 `scanSkillDirs({global: paths.skillsDir, project: join(workspace, ".kclaw", "skills")})` 扫描技能目录（全局 `<home>/skills` + 会话工作目录的项目级 `.kclaw/skills`，项目同名整目录覆盖；渐进披露第一层的数据源，机制见 [skills](../core/skills.md)）；同时算好技能点名的隐式包装——`trigger: "user"` 时对用户原文做点名检测（`matchSkillInvocations`）并生成模型视图改写文本 `llmUserText`（交给 `llm-before` 位置的内置 `skill-wrap` 钩子应用），`job`/`agent` 触发不参与点名。随后 `createBuiltinTools({workspace, memory, tavilyApiKey, exec 超时/输出上限 + 沙箱包装器（可用才注入）, web 超时/私网开关, skills, subagent?, ask?, childRun})`——把同一份扫描结果传给 `skill_read` 工具（渐进披露第二层，按需取正文）；`deps.subagents` 存在且本 run 非子代理时多注册 `subagent_run`（`run_in_background` 支持）与 `subagent_collect`（spawner/collector 与父会话 id 随行，机制见 [subagents](../core/subagents.md)）；每个 run 都注入 `ask`（`ask_user_questions` 工具：broker 与确认共用同一个网关对象、`timeoutMs` 取 `config.sessions.askTimeoutMs`、emit 钩子给事件带 run 上下文，机制见 [tools](../core/tools.md)）；会话 meta 带 `parentSessionId`（子代理 run）时带 `childRun: true`——工具清单裁掉 `memory_save`、`subagent_run` 与 `subagent_collect`（单层委派），系统提示词换成精简的子代理提示词；`deps.tools` 的执行器按名覆盖；`extraTools()` 每 run 求值一次，defs 追加、撞名打 `kclaw tool name collision: <name> (adapter overrides builtin)` 且适配器执行器胜出。
7. **权限**：在 `ConfigPermissionGate` 外再包一层负责登记确认的 gate。装配 gate 的输入一半来自会话、一半来自磁盘，每个 run 重新读取：`mode` 读会话 meta（`sessionMeta.mode`，缺省 `default`——daemon 没有全局模式旗标，会话 meta 是唯一真相）；`decidedRules` 经 `loadDecidedRulesForRun` 每 run 重读已保存的规则文件（全局档恒载；项目档被 git 跟踪则跳过并告警，机制见 [permissions](../core/permissions.md)）；`workspace` 取会话 `workdir`（缺省 `deps.workspace`），越界判定与项目档路径都以此为准；`readRoots` 传入附件目录 `paths.attachmentsDir`——上传目录里的文件是 daemon 自己收下的用户输入，fs_read/fs_list 读它们不需要人工确认；`safeTools`/`toolFacts` 按内置工具注册的 risk 与参数 schema 字段名派生（引擎不持工具名单）。exec 沙箱在创建工具之前先探测一次可用性（`createExecSandbox`，结果写 daemon 日志当观察、不打断 run），探测结果同源喂两个消费方——exec 工具的沙箱包装器（第 6 步）与 gate 的 `sandboxedTools`；沙箱启用但探测不可用时，gate 判出的 exec 确认请求带说明 `noteText`（"exec 沙箱不可用，本次操作需人工确认"）。gate 判出 `confirm` 时，用 gate 签发的 id 调 `broker.create(confirmationId, toolCall, risk ?? "sensitive", confirmTimeoutMs, sessionId)` 登记——这一步只做登记，`confirmation.requested` 事件仍由循环发，全链路用的是同一个 id。
8. **resolveConfirmation**：`broker.wait(confirmationId)` 经共享的 `raceConfirmation(同 confirmTimeoutMs, controller.signal)`（`permissions/broker.ts` 导出，循环与装配用同一个函数）同时等待三方——人工裁决 / 超时 / abort，谁先到算谁。非人工胜出（超时或 abort）即 `broker.expire`，晚到的人工 resolve 只会得到 `unknown confirmation`。人工裁决落定（含超时——沉默也是"否"）时向会话事件流写一条 `permission.decided` 审计事件（裁决、裁决者 by、工具身份；abort 不是裁决不落），与 `system` / `sandbox.checked` 同契约：只写事件流、不进投影、不推进 updatedAt、写失败即 run 失败（运行档案三事件之一，见第 12 步）。
9. **模型解析与 LLM 客户端**：`llmForRun(onLlmRetry)` 为本 run 构造带重试可见性的客户端——重试回调把 attempt 计数推进并触发 `llm-retry` 位置的钩子链（内置 `retry-notify` 转 `llm.failed {willRetry:true}` 事件）；`runId` 从循环的第一个事件 `run.started` 捕获，`llmAttempt` 计数在 `llm.completed/failed` 后复位。随后按三级优先级解析模型：`resolveEntry(input.model ?? sessionMeta?.model ?? defaultModel)`。
10. **压缩视图**：`RunInput.compaction` 传入会话 meta 里的压缩状态 `{ upto, top }`（无则 undefined）——循环据此在请求里垫脉络项、跳过已压缩部分。**不再有发送前预压缩**。`session_search` 的检索后端在此懒构造（`buildSessionSearch`：返回一个首次调用才读取该会话事件流的闭包，交给 `createBuiltinTools`）。
11. **系统提示词（双段冻结基线 + 钩子化组装）**：系统提示词分两段——**stable**（人设基座 + 注入约定，缓存冻结面）与 **live**（认知 + 技能清单，低频变化面），会话 meta 的 `systemBaseline` 为两段各存一份基线（提示词缓存纪律，见 [hooks](../core/hooks.md)）。每 run 两段现算、与基线逐段比对：`base` 取 AGENTS.md（缺省回退 `DEFAULT_SYSTEM_PROMPT`；子代理 run 换成 `subagentSystemPrompt(workspace)` 精简提示词，见 [subagents](../core/subagents.md)）→ 拼注入约定段（`agent/context.ts` 的 `SYSTEM_INJECTION_CONVENTION`：声明 `<system-reminder>` / `<compacted-summary>` 标签是系统注入而非用户输入，见 [agent-loop](../core/agent-loop.md)）组成 stable；`system-before` 链追加段落（内置 `system-materials`：L2 认知 + 技能清单 `skillListPrompt(skills)`；子代理 run 该钩子返回空段——live 恒空；用户文件段落累积在其后）组成 live。两段都命中基线时直接用基线文本（`system-before` / `system-after` 链整体不跑，认知/技能/AGENTS.md 的改动都等该段文本变化才重冻结——前缀缓存按前缀逐字节命中，live 变化只失效变化点之后，stable 前缀继续命中）；至少一段变化时走 `system-after` 链过终稿（用户改写在前；改写发生时终稿整体固化进 stable 基线——改写每 run 重新生效，审计恒记录模型实际看到的那份）。审计由**装配层直接写入事件流**（不再是钩子：分段冻结需要 stable/live 两段文本，它们在钩子链之上）：`sessions.appendSystem` 写一条双段 `system` 事件进事件流，每 run 恰好一条、写失败即本次 run 失败；投影随之按段固化新基线（哪段文本变了就重冻结哪段，未变的保留 `frozenAt`——它记录这份文本成为基线的时刻）。压缩事件在投影里清除基线，下一个 run 回到装配路径重新固化——基线重置点就设在压缩后的缓存冷启动处，零额外成本。
12. **runAgent**：`hooks` 传第 3 步的链（循环的全部行为挂载点：run-before 写入消息、llm-before 改写视图、turn-boundary 接 `handoff.drainSteer` 的引导注入、compaction-check / overflow-rescue 两个压缩决策位经 `compactor.auto`/`compactor.background` 执行）；`signal` 接本 run 的 controller；`toolResultKeep` 从 `config.sessions.toolResultKeep`（默认 8）传入、`tokenBudget` 传 `预算 × compactPackRatio`（省略线 0.70 扣除固定开销），共同驱动请求构造时的预算驱动工具输出省略。两个持久化回调整装在 deps 上：
    - `onEvent`：捕获 runId / 复位 attempt → 按事件类型把 run 边界落进会话档案（`run.started` 落 `appendRunStarted`、`run.completed`/`run.failed` 落 `appendRunEnded`——失败 run 也落终点、起点必有终点，与 `system`/`sandbox.checked` 同契约：写失败即 run 失败）→ `bus.emit`（再包一层 try/catch，单个异常订阅者不会中断 run）。
    - `onMessage`：assistant/tool 消息持久化（用户消息的持久化由 run-before 链的 `user-message-land` 负责，不经这里）。
13. **run-after 链**：`runAgent` 返回后串行跑收尾链——内置 `usage-ledger(10)`（有 usageStore 就记一行用量，失败仅日志；子代理 run 记到父会话名下——`usageSessionId` = `meta.parentSessionId ?? 自身`）→ 任何排其后的用户/注入条目 → 内置 `manual-compact-flush(15)`（运行忙时排队的 /compact 在这里冲刷：取排队的 focus，直调 `Compactor.compact({manual:true, phase:"manual"})`；没有暂存就零开销跳过）→ 内置 `post-run-compaction(20)`（stopReason 非 `aborted`/`error` 且上下文占用 ≥ `预算 × compactAtRatio` 时 `compactor.auto({phase:"post-run", signal})`；估算前有正在执行的后台压缩则先等它结束——等来的成果多半已把占用压回线以下。fatal：压缩失败传播为条目级失败；await 它，发生在活动登记清除前——驱动器串行化让压缩期间新消息排队，手动 /compact 此时也被"会话活跃"条件自然排到下一轮）→ 内置 `follow-check(30)`（`config.memory.write.idleMinutes > 0` 时排一个跟随检查，写入该项目 `state.json`，daemon 重启后由记忆调度器补查；子代理 run 不挂；失败静默）。最后 `#executeEntry` 在 finally 里清理 `#active`/`#activeOutcomes` 中属于本 run 的登记（仍是自己才删，防止误删后继 run 的）。

调度心跳的 job run 使用同一入口：`run.enqueue(session.id, {userText: job.prompt, trigger: "job", note: "本会话由定时任务「<name>」触发"})`（`packages/server/src/scheduler-tick.ts`），job 触发的 run 跳过自动命名。

### 引导注入口（#drainSteer）与 steer 的一生

steer 条目被 `submit` 放进 `#steerBuf` 后，目标 run 在**迭代边界**（工具批次完成后、下一次 `llm.stream` 前）经 `turn-boundary` 位置的内置 `steering-drain` 钩子调 `#drainSteer` 取走全部缓冲消息：循环对每条按序广播 `message.created` → 经 `onMessage` 写入磁盘 → `message.completed` → `message.steered {messageId}`（事件级 `runId` 标识注入的 run）——模型在下一轮自然看到，流式输出不打断、不产生新 run。注入或写入抛错与用户消息写入同一语义：run 以 `run.failed "steering_failed"` 终止。若 run 在取走缓冲前先结束（任何 stopReason），驱动器的下一拍把残余条目降级为 wait 并入队尾（见上文 steer 缓冲与降级），下轮出队照常执行——两条路都保证消息进 JSONL。

### 确认网关时序（服务端视角）

```
循环：gate.check(toolCall) → {type:"confirm", confirmationId:"conf_…"}
      （命令类工具无规则命中且 exec 沙箱可用时 gate 直接 allow {reason:"sandboxed"}，不经确认，
       见 [permissions](../core/permissions.md) 第 7 节）
      ↓（引擎装配的包装 gate 同步登记）
      broker.create(conf_…, toolCall, risk, 120s, sessionId)
循环：广播 confirmation.requested {confirmationId, toolCall, risk, expiresAt}
      （沙箱启用但不可用的回落确认带 noteText，CLI 暗色一行 / WebUI 卡片注明）
      ↓ 等待 resolveConfirmation —— 三方同时等待，谁先到算谁
      ├─ WS/CLI：confirmation.resolve {confirmationId, decision, client}
      │    → ws.ts 先 broker.lookup(conf_…) 快照 toolCall 与会话（resolve 会移除条目）；
      │      decision 为 project/global 时按快照收紧规则后写入规则文件（项目档/全局档，见
      │      [permissions](../core/permissions.md) 的沉淀规则一节）；once/reject/未知 id 不写文件
      │    → broker.resolve → true；ws.ts 回 confirmation.resolved_ack；循环发 confirmation.resolved
      ├─ 120s 超时：循环按拒绝处理（note「确认超时，操作未执行」）；
      │    引擎侧同超时 → broker.expire → 条目作废
      └─ run.cancel 的 abort：循环不发 confirmation.resolved（取消≠超时拒绝），
           引擎侧 expire；tool 结果补 "run aborted before execution"
裁决 once/project/global（非 reject/timeout）→ 循环在 tool 消息上记 grantedBy:"confirmed"
     （`packages/core/src/agent/loop.ts`：entry.grantedBy = "confirmed"，
      最终汇成 ToolMessage.grantedBy: Record<callId, GrantedBy> 持久化）
```

裁决来源 `by`：WS 命令的 `client` 字段（`"cli"|"web"`，缺省 cli）决定 `by`；超时为 `"timeout"`。审计依据是持久化的 `grantedBy`，不是事件；裁决本身另落一条 `permission.decided` 会话事件（谁、何时、批了什么，见第 8 步）。

### 运行中提问（ask_user_questions 的服务端半边）

`question.resolve` 命令走与 `confirmation.resolve` 同一个网关对象（`ConfirmationBroker` 的一个对象、两类等待中的条目）：ws.ts 收到命令后 `broker.resolveQuestion(questionId, answers, actor)`，成功回 `question.resolved_ack`；`question.resolved` **事件**由工具执行器自己发（它知道竞速结果），daemon 不发。未知/已过期的 questionId 回 `unknown question`。

### run.cancel 的 aborted 路径（只中止当前 run）

`cancel(sessionId)` 只做一件事：`#active` 有 controller → `abort()`、返回 true；没有 → false（ws 层回 `no active run`）。abort 后循环在下一个检查点以 `run.completed {stopReason:"aborted"}` 终止（不是 run.failed），确认等待中的 abort 不算超时拒绝。ack（`run_cancel_ack`）在处理完成后立即返回，终态事件随后经总线到达。

**改后的语义：仅中止当前 run，不连带排队消息**。排队中的 wait 条目原封不动，当前 run 停止后由驱动器照常出队执行；排队消息的取消一律走 `queueCancel`。旧实现"出队即取消"的 `#cancelQueued` 标记机制已删除（有意的行为变更，见文末清单）——CLI 的三段 Ctrl+C、Web 的"当前回复停止"都建立在这个窄语义上。

### queueCancel：排队取消

`queueCancel(sessionId, messageId?)` 的取消范围：

- **带 messageId**：先查可执行队列（wait 条目随时可取消），再查 steer 缓冲（注入前可取消——长工具批次期间注入窗口可达数分钟，此间条目占用着共享上限的名额）。命中即从内存与 queue.jsonl 删除、广播 `message.queue_cancelled {messageId}`、回 `{ok:true, cancelled:[id]}`；都不在时按 `#injectedIds` 区分两种失败：近期已注入 → `{ok:false, reason:"injected"}`（已进事件流历史，机器不删历史），否则 `{ok:false, reason:"not_found"}`。ws 层把两者分别映射为错误文案 `已注入` 与 `not found`。
- **不带 messageId**：清空全部可取消条目（全部 wait + 全部未注入 steer），广播 `message.queue_cancelled {all:true}`。

`queue.cancel` 与注入取走在同一 daemon 进程的同一个线程内天然互斥（先到先得）：取消先到则条目被删、注入再也取不到；注入先到则条目已登记 `#injectedIds`、取消请求得到 `injected`。

### recoverQueues：崩溃恢复

daemon 启动时对每个 queue.jsonl 非空的会话调用：整体重排为内存队列并重新起转驱动器。**steer 与 interrupt 条目一律降级为 wait**——它们的目标场景（某个正在跑的 run）已不存在，降级重排是唯一说得通的语义；恢复后的队列在审计意义上无损（消息都还在），仅在"原本想引导/中断"的意图上打了折扣，这是重启的固有代价。每条恢复条目重新广播 `message.queued {disposition:"wait", position:i}`，让重连的客户端重建排队气泡。

### compactSession：手动压缩（忙时排队执行，发消息的排队仍拒绝）

`compactSession(sessionId, focus?)` 是 `/compact` 的服务端入口（HTTP `POST /sessions/:id/compact`、CLI `/compact`、web "压缩"按钮三者共同调用）。忙闲分两条路：

- `#active` 有活动 run → **排队**：`compactor.deferManual(sessionId, focus)` 记下请求（只留最后一次的 focus，后来的覆盖先前的），立即返回 `{queued: true, message: "已排队：当前运行结束后自动压缩"}`（HTTP 200）。冲刷点在运行结束的收尾链上：内置钩子 `manual-compact-flush(15)` 在自动收尾压缩 `post-run-compaction(20)` 之前执行，取排队的 focus 以 `manual: true` 真正压缩——用户点的那次压缩先于自动压缩发生。排队记在内存里，daemon 重启即丢。排队的冲刷跳过忙碌/排队检查：它本来就在"运行结束后"执行，此刻队列里有消息是常态。
- `#active` 空、但 queue.jsonl 非空 → **仍拒绝** 409 `还有 N 条排队消息，先处理或取消`（排队消息会连开多个 run，压缩窗口无法预期，"先处理或取消排队"才是可行动的建议）。

会话空闲且无排队时按会话 meta 解析模型，以 `manual: true` 调 core `Compactor.compact`，跳过触发判断，其余流程（两次摘要调用、compaction 事件写入）与自动压缩完全一致。返回一句话：成功是 `压缩了 N 段，剩 X 条原文消息`，历史太短没有可压缩内容是 `无可压缩内容`（不产生任何状态变化）。手动压缩**不产生新消息**：总摘要经压缩视图的脉络项进请求，本次压缩的痕迹是一条 `compaction` 事件（`trigger: "manual"`，带 focus）。

### 自动命名（core session/autoname.ts）

`scheduleAutoname({sessions, llm, model, emit}, sessionId, firstText)`：

1. 前置：`meta.title === "新会话"` 才命名（已手动改名的不处理）。
2. 异步生成：`defaultTitle` 用 run 的同一个 llm 流式调用，system 为 `"你是标题生成助手，只输出一个不超过30字的会话标题。"`，user 为 `给这段对话起一个不超过30字的标题：
<firstText>`；拼接全部 `text_delta`。
3. 写回：`title.trim().slice(0, 30)`，空串放弃；**写回前重读 meta**——生成期间用户可能已手动改名，此时标题仍不是 `"新会话"` 则不再修改。
4. 更名成功才 `emit(makeEvent("session.renamed", { title }, { sessionId }))`（注入的是 `busEmit`）；失败静默（catch 空处理，保持默认标题）；不阻塞 run（`void scheduleAutoname(...)`，不 await）。

## 边界与出错

- **enqueue 的 promise 对 provider 错误不 reject**（`runAgent` 内部消化为 `run.failed` + `RunOutcome.stopReason:"error"`）。**错误帧只回给同步失败**：`submit` 抛错（队列满 / 会话不存在 / 处置字段非法）发生在 ack 之前，ws 层当场回 error 帧、无 ack。ack 之后 ws 层对 `submit().outcome` 是发出后不等待结果——run 级与持久化级的**迟到失败不再发迟到帧**，改经总线事件到达订阅客户端：run 级失败走循环的 `run.failed`；出队持久化失败与条目执行失败（循环的 `run.failed` 覆盖不到的两类）走 RunManager 补发的 `run.failed {error:{code:"queue_entry_failed", message 含 messageId 与原因}}`。
- **队列已满是同步拒绝**：`submit` 在入队前检查上限（排队 + steer 缓冲合计 10），超限直接抛 `队列已满（10 条）`，ws 层回 error 帧、无 ack——消息不会半入队。上限不分池：steer 与 wait 挤同一个池子，挤压风险由"steer 注入前可单条删除"化解（排队气泡可见、可删）。
- **排队取消是三态的**：命中删除 / `injected`（近期已注入，进了 JSONL 机器不删历史）/ `not_found`（无此条目，或已被当前会话队列淘汰）。判定依赖 `#injectedIds`——有界集合（容量 `QUEUE_LIMIT×2`，够覆盖一个满队列加直发余量），注入时登记；重启后集合清空，恢复条目尚未注入前取消仍是合法的。
- **附件路径的第二道检查会终止整条 run**：正常情况下 ws 帧层已经把越界的附件引用拦在入队之前；如果有越界路径绕过了帧层到达 `mountAttachments`（比如直接调用 enqueue 的代码没做检查），这里的抛错让本次 run 以异常收场——await 该 outcome 的调用方看到 reject，订阅客户端经 `queue_entry_failed` 事件看到失败（见下一条）。steer 注入时的同一检查失败不终止整条 run 的历史注入批次——`#drainSteer` 先构建后变更，任一条构建失败即整体留在缓冲区（异常走 `run.failed "steering_failed"`），条目仍可取消、可重试注入；注入前 run 先结束的，残余条目降级入队后走到同一出队执行路径，装配段同步抛出同样补 `queue_entry_failed`。
- **条目级失败有可见性事件（`queue_entry_failed`）**：两类失败发生时循环的 `run.failed` 覆盖不到——出队持久化失败（run 还没起）与条目执行在装配段的同步抛出（如降级后的坏附件，`mountAttachments`/读历史在 `runAgent` 之前就抛错；进入模型循环前的系统提示词审计写入 `appendSystem` 同属此类——写入失败即本次 run 失败，与消息写入失败的待遇一致，不做静默吞掉）。驱动器在这两条路径上补发 `run.failed {error:{code:"queue_entry_failed", message}}`（message 含 `messageId` 与原因，sessionId 级事件），已 ack `queued:true` 的消息不会无声消失；出队持久化失败还伴随条目退回队首（内存与 queue.jsonl 保持一致，等待重试）。
- **确认裁决不落任何队列**：`broker.resolve` 对已出结果/已过期的条目返回 false 并回 `unknown confirmation`，不记录"迟到的意见"。确认卡等待期间 steer 照常入缓冲区；run 在等确认期间不迭代，注入发生在确认解决后的下一个迭代边界——无特殊路径。
- **自动命名没有去重锁**：同一会话两次快速入队理论上可能并发两次命名，写回前的重读校验保证只有第一次生效（后到的发现标题已不是默认值即放弃）。
- **`resolveConfirmation` 测试注入点优先于 broker**：设置了它 broker 就只剩登记职责——生产路径不设置。
- **压缩与记账失败都不影响 run 的结果**：自动压缩的摘要调用或 meta 写入失败时以 failed 结局回答、运行照常继续（事件 `completed {result:"failed"}`；`kclaw compaction (<阶段>) failed:` 日志）；段索引写入与审计追加失败只留一行日志、压缩照常生效；用量记录失败只留一行日志（`kclaw usage record failed:`）；跟随检查排期失败静默（不打印、不阻塞）。以上任何一种失败 run 都照常返回 outcome。

## 有意的行为变更

队列机制上线时改变了四处既有行为，均为设计决定而非缺陷：

1. **`run.cancel` 只保留"中止当前 run"一个语义**：不再连带取消排队消息（旧实现 `#cancelQueued` 的"出队即取消"机制删除）。排队消息的取消一律走 `queue.cancel`（WS 命令 / CLI `/queue cancel` / Web 气泡取消按钮）。
2. **旧客户端的默认处置从"自动等待"变为"默认引导"**：不带 `disposition` 字段的 `send_message` 取会话覆盖 ?? `sessions.defaultDisposition`（缺省 steer）。旧版在会话忙时新消息自动排队等待；现在默认注入正在跑的 run（会话空闲时两种处置等价，行为不变）。
3. **job tick 消息同受队列上限约束**：旧实现在会话忙时无界排队；现在 job tick 的通知消息固定按 wait 入队，会话排满（10 条）时同样被拒。上限是有意设置的阻塞点：满了就明确报错，而不是无限积压。
4. **CLI 运行中输入的行立即按当前处置发送**：不再等当前 run 的提示符回归——运行中回车即发（steer 注入 / wait 排队 / `/interrupt` 中断），界面呈现由实时事件流驱动。

## 关联

- [agent-loop](../core/agent-loop.md)：runAgent 状态机、确认的循环侧超时等待、6 个 abort 检查点、attachment 块进模型视图的转换
- [permissions](../core/permissions.md)：ConfigPermissionGate 的判定链与 `conf_*` id 的签发；mode/decidedRules/readRoots 三处装配输入
- [realtime](./realtime.md)：send_message/confirmation.resolve/run.cancel/queue.cancel 的帧协议与 ack
- [memory](../core/memory.md)：两级注入（L2 认知常驻 + L1 情节 note）、写入管线与跟随门禁背后的实现
- [compaction](../core/compaction.md)：`Compactor.compact` 背后的触发/分界/摘要机制、审计记录格式与配置字段
- [skills](../core/skills.md)：技能目录每 run 扫描、技能清单注入系统提示、点名隐式包装（`skill-wrap` 钩子）
- [hooks](../core/hooks.md)：位置网格、HookChain 语义、内置钩子清单与用户文件契约
- [mcp](../core/mcp.md)：`extraTools` 的来源（MCP 工具适配器）
- [storage](../core/storage.md)：UsageStore 的用量记录实现（`usageStore.record` 背后）
- [http-api](./http-api.md)：GET /sessions/:id/queue、POST /sessions/:id/disposition 两个队列路由与写入 session meta model/mode 的既有路由
- [webui](../web/webui.md)：发送三选、排队气泡与重连对齐的消费侧
