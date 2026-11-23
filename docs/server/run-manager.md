# run-manager — 会话串行 run、消息队列与确认网关（服务端侧）

`send_message` 之后服务端的队列状态机：消息去向的三档决策、每会话一条队列、出队执行与取消。本篇讲队列、出队组装与确认网关；循环本身见 [agent-loop](../core/agent-loop.md)。

## 作用

`packages/server/src/run.ts` 的 `RunManager` 是 `send_message` 之后服务端的**队列状态机**：消息去向的三处置决策（引导/等待/中断，见下文 submit）、每会话一条显式排队队列与其驱动循环、入队执行（把出队条目连同 AbortController 与 steer 取走回调交接给引擎）、run 取消、排队取消、手动压缩入口与崩溃恢复。单条 run 的**组装**：附件挂载、模型解析、记忆注入（L2 认知常驻系统提示 + L1 情节 note，见组装第 4 步）、技能目录扫描与隐式包装（见组装第 6 步）、系统提示（双段冻结基线或拼装，每 run 一条 `system` 事件按 stable/live 记录，见组装第 11 步）、工具与权限组装、事件发送到总线、run 边界与裁决记录（`run.started`/`run.ended`/`permission.decided` 三事件）、消息持久化、token 用量记录，在 core 的 `executeRun`（`packages/core/src/agent/run-assembly.ts`，引擎侧）完成，经 `RunEngine`/`RunHandoff` 两个形状与队列交接。确认网关 `ConfirmationBroker`（`packages/core/src/permissions/broker.ts`）是人工裁决的服务端半边：等待中的裁决经 WS/CLI 的 `confirmation.resolve` 命令、等待中的问题经 `question.resolve` 命令在此完成（同一个对象、两类等待中的条目）。`packages/core/src/session/autoname.ts` 的 `scheduleAutoname` 在首条用户消息后异步生成会话标题并把更名广播为 `session.renamed` 事件。调度心跳（`scheduler-tick.ts`）触发的 cron run 也使用同一个入口。

## 设计决策

- **ack 与 run 解耦是结构性保证**：`ws.ts` 收到 `send_message` 后 `run.submit` 同步决策去向并立即回复 `send_message_ack`（附带 `messageId` 与 `queued`，不 await run），run 的进展全部以 `run.*` 事件流回订阅者，长任务永远不阻塞命令通道。
- **队列模型：queue.jsonl 持久化 + 内存副本 + 每会话驱动器**：排队消息属于"当前状态"，还没有成为"已执行历史"，因此持久化在独立文件 `queue.jsonl`（`QueueEntry[]`，整文件重写、原子写入磁盘，数组顺序即执行顺序），不进事件流（`events.jsonl`），所以 `readMessages` 的所有使用方（agent 历史、压缩范围、审计页）天然不含排队消息，崩溃恢复也只需读 queue.jsonl。内存侧 `#queues`（可执行条目 wait/interrupt）与 `#steerBuf`（steer 缓冲）是 queue.jsonl 在内存里的同步副本；`#drive` 为每会话一个循环：`run 结束 → 残余 steer 降级并入队尾 → 队列非空？出队执行 → 循环`，run 因任何原因结束都先降级残余 steer 再触发下一轮出队判定。每会话排队 + steering 缓冲合计上限 10 条（`RunManager.QUEUE_LIMIT`，写死不做配置项），超限 `submit` 抛出 `队列已满（10 条）`。
- **三种处置只决定消息何时被模型看到**：steer 注入正在运行的对话（在迭代边界注入，即模型完成一轮输出、要发起下一轮请求之间的间隙；不产生新 run）；wait 留在队列等当前 run 结束后出队；interrupt 立即中止当前 run 并插队首。三条路径最终都写进 JSONL，消息 id 在入队时预分配（`entry.messageId`）、出队/注入执行时用同一 id 构建消息，前端气泡从"排队态"原地升级。处置生效层级：单次请求显式指定 > 会话级覆盖（`SessionMeta.dispositionOverride`，CLI `/steer`/`/wait` 与 Web 三选的 steer/wait 写入；interrupt 是一次性动作、Web 与 CLI 均不写覆盖）> 配置默认 `sessions.defaultDisposition`（默认 steer）。
- **steer 缓冲与降级**：steer 消息不进执行队列，进当前 run 的 steering 缓冲区；run 在迭代边界经 `turn-boundary` 位置的 hook 链（内置 `steering-drain`）取走全部缓冲消息注入。会话**完全空闲**（无活动 run、无可执行条目、无驱动器）时消息不降级、直接开始运行（`queued:false`，不广播 `message.queued`）；只有"队列/驱动器在运转但无活动 run"时 steer 才降级为 wait 入队并按 wait 报告（`message.queued {disposition:"wait", position}`）。若 run 在取走缓冲前结束（end_turn/aborted/failed 任何原因），残余条目在驱动器的下一轮自动降级为 wait、按原顺序并入队尾，消息绝不丢失，队列里可执行的只有 wait 与 interrupt。
- **注入的取走是先构建后变更**（不变量）：`#drainSteer` 先在局部把全部缓冲条目构建成 user Message（附件挂载可能失败，如越界、文件被删），全部成功后才清空缓冲、重写 queue.jsonl 并把 id 登记进 `#injectedIds`（有界集合，容量 `QUEUE_LIMIT×2`，用于把排队取消请求区分为 `injected`（已写入事件流历史，系统不删除历史）与 `not_found`）；任一构建失败即整体不动，异常交给循环，以 `run.failed "steering_failed"` 结束。
- **cron 消息固定 wait 且同受上限约束**：服务器内部的入队（cron tick 的通知消息）按 wait 处置、不读 `defaultDisposition`。cron 的语义是"当前的事忙完后轮到我"，没有"引导正在运行的 run"的需要。上限对 cron 一视同仁：会话排满时 cron tick 的消息同样得到 `队列已满` 错误。
- **用户消息由引擎预制**：以纯 text 骨架（先建只含一个文本块的消息，note 块随后补全）经 `RunInput.userMessage` 传入，循环原样使用且不重复持久化；note 块（cron 来源 + 记忆）由 run-before hook 链（内置 `memory-inject` 收集 → `user-message-land` 统一追加）补全，事件序固定为 `run.started → message.created → note.emitted ×N → message.completed`，且持久化先于 note 事件（事件反映已持久化状态）。附件挂载同样在骨架构建时完成；越界路径在 `mountAttachments` 里抛出错误终止整条 run。
- **历史在追加用户消息之前读**：`runAgent` 自己会把用户消息拼在 `history` 之后（`[...input.history, userMsg]`），若 history 已含它会向 provider 重复发送同一段文本。
- **broker 只负责登记与汇合裁决，不发事件、不管理超时**：`confirmation.requested`/`confirmation.resolved` 由 agent 循环发（`packages/core/src/agent/loop.ts`），broker 若再发即造成线上重复；超时裁决也由循环的 `raceConfirmation` 完成。broker 的 `expiresAt` 只是登记信息。
- **两侧的超时裁决互相一致**：引擎侧（core run-assembly 的 `resolveConfirmation` 包装）与循环侧调用的是同一个 `raceConfirmation`（`permissions/broker.ts`），用**同一个** `confirmTimeoutMs` 同时等待同一个人工 promise，谁先出结果算谁的，两侧结论一致；迟到的人工裁决被已经出结果的等待丢弃，服务端再把条目标记为过期，晚到的 resolve 只能得到 `unknown confirmation`。
- **自动命名静默且不覆盖手动改名**：失败静默处理、两次校验默认标题（生成前、写回前），用户已手动改名就不修改。更名成功写回 meta 后，经注入的 emit hook（`busEmit`）广播 `session.renamed {title, source?}`（`source: "auto"`，与用户/路由改名的 manual 区分），订阅者立即收到通知。
- **模型解析：每 run 一次，四级优先级**：本轮用哪个模型，按 `input.model`（cron 配置的模型或客户端指定的）→ 会话 meta 的 `model`（POST `/sessions/:id/model` 写入的那个）→ 默认 provider 条目当前的 `model`（Model 页改动热生效，改完即用新值）→ daemon 启动时解析的模型（环境变量配置、没有 config 条目时的来源）的顺序取第一个非空的。整条链集中在 `resolveRunModelLine`（core `storage/config.ts`）一处，手动压缩路径走同一个函数；取到的裸模型名再经 `resolveRunModel` 做一次翻译：名字命中 config 里 provider 条目时换成该条目配置的线上模型名（比如条目名 `deepseek` → `deepseek-chat`），未命中则原样当作直接的 API 模型名通过。解析发生在每个 run 开始时，所以改完会话模型后下一次 run 即生效。
- **附件挂载：按文件类型分三种处理**：`mountAttachments` 把用户上传的文件转成用户消息上的 attachment 块。文本类文件（MIME 为 `text/*` 或扩展名是常见文本类型）且不超过 64KiB 时，读出正文内联进消息（超过 8192 字符截断，并加上 `\n…[已截断，完整内容可用 fs_read 读取 <附件路径>]`，模型据此读取后面的内容）；图片且不超过 5MiB 时转成 base64 内嵌（作为多模态内容段发给模型）；其余文件只在块里放 `{type:"file", path}` 路径信息，模型需要内容时自己用 fs_read 读。安全上有两道检查：ws 层在校验 send_message 帧时查过一次路径，这里再用 `realpathWithin` 复核一遍：引用越出本会话附件目录就直接抛出错误、终止整条 run。
- **用量记录失败不影响 run**：run 正常结束后向 `usageStore.record` 记一行（会话 id/run id/模型/输入输出 token/时刻，外加缓存读写字段：run 内所有 LLM 调用都携带该字段才求和，任一次缺失记 NULL=未知；字段经 run-after payload 的 `outcome.totalUsage` 传入，未知时整个字段不出现）。这行代码包在 try/catch 里，失败只打 `kclaw usage record failed:` 日志；daemon 没注入 usageStore 时整个步骤跳过。
- **记忆写入在 core 侧，run 路径只留注入与检查排期**：写入 pipeline 整体在 core 的 `MemoryPipeline`（`packages/core/src/memory/pipeline.ts`），由五触发驱动（`memory_save` 工具的 immediate、`/memory save` 的手动 manual、新建会话路由的 clear、定时 interval、跟随 follow，机制见 [memory](../core/memory.md)）。run 路径（core `executeRun`）只承担三项工作：每次 run 的两级注入（L2 认知常驻系统提示 + L1 情节 note，见组装第 4 步）；给 `createBuiltinTools` 传入 `memoryCtx.immediateEnabled = config.memory.write.immediate`（决定 `memory_save` 工具是否当场触发写入）；run 收尾时排一个跟随检查（`idleMinutes > 0` 时 `memory.scheduleFollowCheck`，写入 `<projectDir>/state.json`，daemon 重启后由记忆调度器补查，见下文组装第 13 步）。
- **上下文压缩（token 触发的分层摘要，五个触发点）**：压缩不发生在发送路径上：引擎直接以全量 `history` 起 run，用户发消息永远零压缩等待。五个触发点由 run 路径编排（机制细节与数据格式见 [compaction](../core/compaction.md)）：
  - **后台预压**：`compaction-check` 位置的内置 hook `background-precompact`（排在 `mid-run-panic` 之前）在每个迭代边界检查：上下文占用进入 [预压线, 红线) 区间且没有正在执行的压缩、无暂存结果、无取消标记时，`compactor.background(...)` 以非阻塞方式发起一次后台压缩（`Compactor.background` 登记为正在执行后立即返回，摘要调用在后台进行，不接 run 的中止信号）。成功后结果先写入元数据、视图暂存，由下一次迭代边界的 `mid-run-panic` 取用。
  - **收尾压缩**（主路径）：`runAgent` 返回且 stopReason 非 `aborted`/`error` 时，用 `estimateContextTokens(readMessages(sessionId))` 估算上下文占用（锚定最后一条助手消息记录的真实 `usage.inputTokens`，锚点之前的内容天然不计入，它们不在上一次请求里，所以直接对全量历史读数即可），上下文占用 ≥ `budget × (compactAtRatio ?? 0.80)` 就 `compactor.auto({phase:"post-run", signal})`。它在 `executeRun` 内 await、位于 token 用量记录之后（会话驱动器的串行化保证压缩期间新到的消息排队等待、不会并发写会话元数据；这窗口内收到的手动 /compact 也被"会话活跃"条件自然排队，下一轮 run 的收尾链执行它）。估算前若还有正在执行的后台压缩，先等它结束（循环已结束、没有下一次请求可应用暂存视图，取走丢弃即可，元数据已附带同一结果）再读数；等待后走正常黄线判断，auto 内部的活跃段细粒度判断自适应：后台结果已让活跃段降到线以下时，它自然不会再压缩。
  - **中途压缩**：`compaction-check` 位置的内置 hook `mid-run-panic`（见 [hooks](../core/hooks.md)）在每轮迭代边界触发。hook 内先查取消标记与 run 的中止信号（任一命中则返回 null、不压缩，暂存的后台结果也留到下一次运行再应用），未命中再取暂存的后台结果：有就直接采用为新压缩视图（占用通常已降回线以下，不必压缩第二次），然后计算上下文占用：≥ `budget × (compactPanicRatio ?? 0.90)` 才进入压缩分支。若此刻有正在执行的后台压缩则先等它结束，再按暂存视图的分界重估活跃段（重估读数受已有锚点影响偏高，安全方向），仍超红线才同步压缩（活跃段切不出边界就放弃强制压缩、应用暂存结果），否则直接应用暂存结果；压缩成功返回新的压缩视图 `{ upto, top }`，循环从下一次请求起应用（`upto` 之前的原文不再发送、压缩摘要项放在 `messages[0]`）；失败返回 null，运行不做补救、继续进行。
  - **超限急救**：`overflow-rescue` 位置的内置 hook `overflow-emergency` 在流式调用抛出上下文超限错误且零输出时触发：不看上下文占用，上下文已经超限就是事实。救援不能等待：先 `compactor.abortInFlight` 中止正在执行的后台压缩并等它结束（被中止的结果丢弃，原文无损；不用 `cancel`，它的取消标记会阻止紧随其后的急救本身），再 `compactor.auto({phase:"in-run", emergency:true, signal})`；成功则循环整次请求静默重发一次（最多一次），仍失败才走报错路径。
  - **手动 /compact**：`compactSession` 直调 core `Compactor.compact({manual:true, phase:"manual"})`，跳过触发线；会话忙时排队、不拒绝，运行结束的收尾链先执行它（见下文第 13 步），已有排队消息时仍拒绝。
  - `Compactor.auto`（core `session/compactor.ts`）是收尾/中途/超限三路的共用组装：为每次压缩建独立 AbortController 并登记在一张"正在进行中"的表里（后台预压也登记同一张表，`waitForSettled` 供同步路径等待），run 的中止信号联动过去（run 中止时顺带取消同步压缩），run 结束时清理；压缩自身的摘要调用经 `collectStreamResult` 带 `{ signal }`，取消信号触发时抛出 → `Compactor.compact` 走 cancelled 分支。`cancelCompaction`（WebUI 指示行取消按钮 → WS 帧 `compaction.cancel`）写会话级取消标记并取消正在进行的压缩（含后台预压）；标记在每次 run 组装（`executeRun`）开头清除，只压制本次运行内的自动压缩。
  - `Compactor.compact` 内部：按 `SessionMeta.compaction.upto` 切出 active 历史（标记在历史里找不到视为无标记），上下文占用过线后由 `chooseBoundary` 选出分界：从最新往回累加到 budget × `compactTargetRatio`（默认 0.33）为止，起点再退到最近的用户消息（保证段与保留部分都是完整轮次）。压缩是两次 `collectStreamResult` 调用（复用本轮 `runLlm` 与解析出的 model，`Compactor.auto` 内 await；返回文本与 `message_done` 的真实用量）：段摘要默认复用主 run 的 system、工具定义与缓存键（被压段原文直进请求，`renderSegment` 不参与）；手动 /compact、摘要模型换条目时的回退形状与第二次归并调用才是不带 tools 的独立请求。段摘要与旧总摘要归并出新总摘要，两种形状详见 [compaction](../core/compaction.md) 的"第一次调用"一节。**两次全部成功后**追加一条 `compaction` 事件（这是 `meta.compaction` 与压缩审计的唯一写入点，事件投影据此维护 `{ segments, top, upto }`，`trigger` 按 `manual`/`in-run`/`auto` 三值、超限急救带 `emergency`；审计记录另带 `tokensBefore`/`tokensAfter` 压缩前后上下文 token，口径见 [compaction](../core/compaction.md) 的"token 统计口径"）。事件：上下文占用过线且边界已定先发 `compaction.started {phase}`，之后无论成败/取消必发 `compaction.completed {segments, kept, phase, result}`（失败/取消时 segments/kept 为 0）；占用未过线则两个事件都不发。摘要调用或事件写入失败时 `Compactor.compact` 记一行 `kclaw compaction (<阶段>) failed:` 日志并以 failed 结果回答（`Compactor.auto` 把结果原样转发给触发 hook）。运行照常继续，下一次过线重新触发。总摘要不带 note，经循环的压缩视图以压缩摘要项进请求（见 [compaction](../core/compaction.md) 的"注入"）。

## 数据与接口

```ts
// packages/server/src/run.ts（RunManagerDeps 从引擎的 RunEngineDeps 派生：字段语义
// 以 core/src/agent/run-assembly.ts 的注释为准，server 不重复声明；EnqueueInput、
// LlmRetrySink、AttachmentRef 等输入形状也在 @kclaw/core，见下）
export type RunManagerDeps = Omit<RunEngineDeps, "broker" | "extraHooks"> & {
  broker?: ConfirmationBroker          // 注入的确认网关；不注入 → 内部新建，暴露为 manager.broker
  onSessionIdle?: (sessionId: string) => void
                                        // 队列侧空闲边缘：每会话队列排空时调一次
                                        // （team host 的 pump 与 goal host 的 onIdle 都注册这里，
                                        // 引擎本身看不到这个接入点）
}
// Omit 掉的两项：broker 在引擎侧是必填的已解析网关（manager 负责保证存在）；
// extraHooks 是引擎测试专用的注入点，不经 manager 流转

export interface EnqueueInput {
  userText: string
  trigger: "user" | "cron" | "process" | "agent" | "team" | "goal"
  model?: string       // 本 run 的模型覆盖（cron 配置的模型或客户端强制）；缺失 → 会话 meta → 默认
  attachments?: AttachmentRef[]  // 附到用户消息上的附件引用（调用方已校验，这里防御性复验）
  note?: QueueNote     // 机器来源说明（结构化：kind + text），写成用户消息上同 kind 的 note 块
                       // cron 触发=定时任务来源行；subagent kind=后台完成回投的"非用户发言"声明
  disposition?: "steer" | "wait" | "interrupt"
                        // 单次显式处置（层级最高）；默认 = 会话覆盖 ?? 配置默认；
                        // trigger:"cron"/"process"/"agent"/"goal" 固定 wait，不读默认
  uiAction?: UiActionRef
                        // UI 卡交互来源标记（按钮点击/表单提交）：随消息持久化，
                        // web 据此渲染卡的已选态、气泡与审计页徽标（只用于展示）
  subagentRole?: string          // subagent_run 派发携带的 role（仅 agent 触发的子会话调用）：
                                 // 拼进子会话系统提示词
  subagentToolAllow?: string[]   // subagent_run 派发携带的 toolAllow：只裁剪可用工具与线上请求形状
  messageId?: string   // 内部：驱动器出队执行时传入的预分配消息 id（ws 层不传）
}

/** submit 的同步决策结果：消息身份、是否入队与实际生效处置（降级后）。 */
export interface SubmitResult {
  messageId: string
  queued: boolean      // false = 空闲直发（不广播 message.queued，ack 里 queued:false）
  disposition: "steer" | "wait" | "interrupt"
                        // 实际生效处置：空闲直发时为原值；队列在运转但无活动 run 时 steer 降级为 wait 并按 wait 报告
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
                        // 其余入队（interrupt 伴随对活动 run 的 abort）。
                        // 拒绝时抛出错误：主会话连续机器唤醒超 budget 先抛出 WakeBudgetExhaustedError
                        //（先于队列满检查，语义见 subagents.md）；队列满抛出 Error
  enqueue(sessionId: string, input: EnqueueInput): Promise<RunOutcome>
                        // submit().outcome 的包装（cron tick 等只需要结果的调用方使用）
  queue(sessionId: string): QueueEntry[]
                        // queue.jsonl 的内存副本（可执行条目 + steer 缓冲），内容与之一致，
                        // 供 GET /sessions/:id/queue 与恢复使用
  queueCancel(sessionId: string, messageId?: string):
    | { ok: true; cancelled: string[] }
    | { ok: false; reason: "not_found" | "injected" }
                        // 排队取消：wait 随时、steer 注入前可取消；
                        // 不带 id = 清空全部可取消条目并广播 {all:true}；
                        // 被取消 wait 条目的 outcome 以拒绝结束（调用方不会一直等待）
  cancel(sessionId: string, messageId?: string): boolean
                        // 中止当前 run（停在下一个检查点，stopReason "aborted"）；
                        // false = 无活跃 run，或带 messageId 时活动 run 执行的
                        // 是另一条消息（发送方的取消可能晚于自己 run 的结束）
  stopAndClear(sessionId: string): { aborted: boolean; dropped: number }
                        // /stop 组合入口（IM 频道用）：cancel + queueCancel 全清，
                        // 返回"是否中止了活跃 run"与"丢弃条数"；普通 interrupt
                        // 处置只插到队首、不清空队列，实现不了"停止"（见 feishu-channel.md）
  awaitSettle(sessionId: string, timeoutMs: number): Promise<boolean>
                        // 有界等待活跃 run 结束（删除/清库路由用）：cancel 只是
                        // 协作式信号，被中止 run 的收尾追加还要走若干异步步骤；
                        // 超时返回 false，调用方自行决定是否继续
  recoverQueues(): void                // daemon 启动恢复：queue.jsonl 整体重排，steer/interrupt 降级 wait
  cancelCompaction(sessionId: string): boolean
                                        // 取消进行中的自动压缩：写会话级取消标记 + 取消压缩用的
                                        // controller；返回"是否有压缩正在进行"。标记只阻止本次运行内
                                        // 的自动压缩（中途/收尾），下一次运行开始时清除；手动 /compact 不查标记
  compactSession(sessionId: string, focus?: string): Promise<{ queued?: boolean; message: string }>
                                        // 手动压缩（HTTP/CLI/web 三入口共用）：队列非空仍拒绝
                                        // （409）；会话活跃时排队，返回
                                        // {queued:true}，运行结束的收尾链先执行它（manual-compact-flush）；
                                        // 无可压缩内容返回固定文案
}
```

```ts
// @kclaw/core — packages/core/src/permissions/broker.ts
export class ConfirmationBroker {
  create(confirmationId, toolCall, risk, timeoutMs, sessionId?): Promise<ConfirmationResolution>
  resolve(confirmationId, decision, by = "cli"): boolean   // 完结仍等待中的条目；未知/已决/过期 → false
  wait(confirmationId): Promise<ConfirmationResolution>    // 未知的 id 永不出结果（超时归循环管）
  expire(confirmationId): void                             // 标记过期（同时等待中超时/abort 先到时调用）
  pending(): ConfirmationRequestedPayload[]                 // 当前等待中的列表（供未来的 HTTP 列表端点）
}
```

关键常量（`MEMORY_QUERY_CHARS` 与 `MEMORY_LIMIT` 在 core `hooks/builtin.ts`，其余在 `agent/run-assembly.ts`；`DEFAULT_SYSTEM_PROMPT` 与两个压缩提示词在内置提示词文本的统一存放处 `prompts/` 目录，分别位于 `prompts/system.ts` 与 `prompts/compaction.ts`）：`MEMORY_QUERY_CHARS = 200`（用户文本前 200 字符做 L1 情节检索）、`MEMORY_LIMIT = 5`（最多注入 5 条情节 note）、`DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"`（AGENTS.md 缺失/为空时的回退提示）；附件挂载的 `TEXT_INLINE_MAX_BYTES = 64KiB`、`TEXT_INLINE_MAX_CHARS = 8192`、`IMAGE_INLINE_MAX_BYTES = 5MiB`。两个固化系统提示词（压缩用）：`SEGMENT_SUMMARY_PROMPT`（段摘要：固定五栏 markdown、不超过 800 字）、`MERGE_SUMMARY_PROMPT`（总摘要归并：同样五栏、保留新版本并注明被取代的旧版本）；主前缀复用形状末尾的摘要指令常量 `SEGMENT_TASK_INSTRUCTION`（正文与独立提示词同口径）与它们同在 `prompts/compaction.ts`。记忆提取与沉淀的提示词（`EXTRACT_SYSTEM_PROMPT`、`CONSOLIDATE_SYSTEM_PROMPT`）在同一目录的 `prompts/memory.ts`（机制见 [memory](../core/memory.md)）。压缩触发的五个比例不在 defaultConfig 里（`sessions` 段的 `contextTokens`/`compactPackRatio`/`compactAheadRatio`/`compactAtRatio`/`compactPanicRatio`/`compactTargetRatio`/`toolResultKeep` 均可选），五条默认值集中定义在 core `session/waterlines.ts` 的 `WATERLINE_DEFAULTS`（省略线 0.70 / 预压线 0.75 / 黄线 0.80 / 红线 0.90 / 目标 0.33），由 `resolveWaterlines` 按 budget 解析成一次 run 的完整阈值表：`executeRun` 在每个 run 开始时解析一次，压缩内置 hook 与压缩引擎 `Compactor` 使用的都是解析结果，各个读取处不单独写默认值。上下文 budget 的 128000 回退值在 `resolveContextTokens`（core `storage/config.ts`）。确认超时来自 `config.permissions.confirmTimeoutMs`，默认 `300_000`（300 秒，`packages/core/src/storage/config.ts` 的 defaultConfig）。

## 流程

### submit：三处置同步决策

```
submit(sessionId, input)
  meta 存在性检查；处置解析（显式 > 会话覆盖 > 配置默认；cron 固定 wait）
  queue.length + steerBuf.length >= 10 → throw 队列已满（10 条）
  空闲（无活动 run、无可执行条目、无驱动器）
    → 直发：条目入 #queues 并立即 #drive，返回 {queued:false}（不广播 message.queued）
  steer 且有活动 run
    → 入 #steerBuf，写 queue.jsonl，广播 message.queued {disposition:"steer"}（无 position）
    → outcome 随当前 run 结束而定（参考值）
  其余（wait / interrupt / 无活动 run 的 steer 降级 wait）
    → wait|降级：追加队尾；interrupt：插队首 + 对活动 run abort()
    → 写 queue.jsonl，广播 message.queued {disposition, position}
    → #drive 启动，返回 {queued:true}
```

`position` 是该条在可执行队列中的序位（从 0 开始计数）；steer 条目在缓冲区里、没有队列序位，故不带。事件序上 `message.queued` 在总线广播、`send_message_ack` 在命令通道回包，两条通路各自送达，客户端不应假设两者的先后（网络上 queued 可能先于 ack 到达）。

### retry：编辑重试与重新生成

`RunManager.retry(sessionId, fromMessageId, text, attachments?)`（`message.retry` 帧的服务端入口，WebUI 的「编辑」「重新生成」按钮共用）：校验通过后先写截断标记，再走普通 `submit` 路径：

```
retry(sessionId, fromMessageId, text, attachments?)
  meta 存在性检查；subagent 会话拒绝（只读）
  空闲校验：无活动 run、无驱动器、队列空、steer 缓冲空、无进行中压缩
    → 违反抛出「会话忙：等当前运行和压缩结束、清空队列后再重试」
    （parked 的后台压缩结果不阻塞：它的覆盖范围必在截断点之前）
  fromMessageId 必须是最后一条 user 消息的 id → 否则抛出「只能从最后一条用户消息重试」
  附件：调用方不带时从被丢弃消息的附件块重建（仅文件型附件可重建）
  无文本且无附件 → 抛出「重试内容为空（无文本也无附件）」
  appendMessageTruncated（events.jsonl 写入一条 message.truncated）+ 广播 message.truncated
  → submit(sessionId, { userText: text, trigger: "user", attachments? })
```

截断只发生在**空闲**会话上且只在**尾部**，已经发生过的历史永不改写。`message.truncated` 是唯一的可见性机制：事件流只追加这条标记、不改写任何历史行，聊天视图与 run 的 `readMessages` 从该消息起过滤（重试追加在其后的新消息不受旧起点约束；服务端与客户端经同一条广播收敛）。校验错误以 error 帧返回（无 ack），文案见 [realtime](./realtime.md)。

### 驱动器 #drive：每会话一个循环

```
#drive(sessionId)：已在运行则幂等返回
  循环：#demoteSteer（run 结束后残余 steer 降级 wait 并入队尾）
        → 队列空？删除 #queues/#drivers 记录，循环退出
        → 出队队首（queue.jsonl 同步删除，整文件重写）→ #executeEntry 执行 → 继续
```

出队执行的条目在 `#executeEntry` 里登记活动 controller（在任何 await 之前完成，取消所需的登记永远不晚于出队），并把本 run 的 outcome 记为 `#activeOutcomes`（steer 的参考 outcome 与降级时序依赖它）。出队阶段的意外失败（queue.jsonl 写入失败，如会话被删、磁盘已满）不允许出现两种故障形态：会话永久停滞（残留的驱动器登记让后续 submit 全部幂等返回，队列无人处理），或循环 promise 直接以异常结束、无人处理。处理方式：已出队条目的 outcome 以该错误拒绝，条目本身**放回队首**。写入抛出错误意味着 queue.jsonl 也没有写成，放回后内存与磁盘重新一致，条目留在队列等待下一次出队重试，不会被此后任何一次成功的持久化悄悄覆盖掉；同时补发条目级失败事件 `run.failed {error.code:"queue_entry_failed"}`（见"错误处理"）；`#drivers` 同步删除（下一次 submit 重新启动驱动器，自动恢复），错误日志只打印一次（`kclaw run queue driver … crashed:`）。

### #executeEntry → executeRun（core）：一次 run 的组装

队列侧的 `#executeEntry` 出队后构造 `RunHandoff { sessionId, input, controller, drainSteer }`，调用 core 的 `executeRun(engine, handoff)`（`packages/core/src/agent/run-assembly.ts`），以下组装步骤都在那里发生（`engine = { deps, compactor }`，deps 的权威声明就是引擎自己的 RunEngineDeps，manager 转发时把 broker 补成必填的已解析网关）：

1. **工作目录**：`sessionMeta.workdir ?? deps.workspace`，会话级设置覆盖全局设置。
2. **用户 hook 重新扫描**：`engine.deps.hooks`（daemon 级 `HookRegistry`）的 `refresh()` 重新扫描 `~/.kclaw/hooks/`，做到"放文件，下一轮生效"（与技能目录扫描同一套思路，机制见 [hooks](../core/hooks.md)）；新装载失败经 registry 按"文件名+mtime+错误"去重后发一次 `hook.failed {phase:"load"}` 事件。
3. **hook 链**：为本 run 建一个 `HookChain`（超时读 `config.hooks.timeoutMs` 默认 5s；skip 失败经 `onFailure` 发布到总线；`eventCtx` 惰性附带 runId；每条实际执行的钩子经 `onExecuted` 回调写一条 `hook` 审计事件到会话事件流，见 [hooks](../core/hooks.md)）。随后按序注册三批条目：`makeBuiltinHooks({...})` 的内置闭包（记忆检索、消息写入、自动命名、技能包装、重试可见、引导 drain、3 个压缩决策（后台预压、中途压缩、超限急救）、5 个收尾 hook、系统提示词材料，清单与次序见 [hooks](../core/hooks.md)；系统提示词审计不在链上，由组装层直接写入事件流）→ `hooks.snapshot()` 的用户文件条目（默认 order 1000）→ `deps.extraHooks` 的测试注入。循环只知道位置，所有行为都在这条链上。
4. **记忆注入**（两级，机制见 [memory](../core/memory.md)）：
   - **L2 常驻（系统提示）**：认知块由 `system-before` 位置的内置 `system-materials` hook 收集（`memory.cognitionPrompt(workspace)`，scope 过滤与 budget 取舍详见 memory.md；认知为空或抛出错误时省略该段，run 照常进行），与技能清单一起在系统提示词组装时追加（见第 11 步）。
   - **L1 情节（用户消息 note）**：由 run-before 位置的内置 `memory-inject` hook 检索（`memory.searchEpisodes(workspace, 首条文本前 200 字符, 5)`），命中变成 `kind:"memory"` note 块（文本 `相关经历（<线的一句话标题>）: <情节正文>`）；检索抛出错误则不带记忆继续（记忆只起辅助作用，不得阻塞 run）。
5. **读 history**（此刻用户消息尚未追加），构造纯 text 骨架 `userMessage`，`input.attachments` 经 `mountAttachments` 转成 attachment 块放进同一消息。**消息 id 采用 submit 时分配的 `input.messageId`**（`#executeEntry` 出队执行时从条目还原传入；空闲直发的条目同样经驱动器执行，也带这个 id），ack 返回的 messageId 就是这条用户消息的 id，前端气泡从"排队态"原地升级、id 不变。cron 触发的提示文案（`input.note`）也在此备成 `kind:"cron"` note 块，交由 run-before 链追加进消息。
6. **技能扫描与工具**：先 `scanSkillDirs({global: paths.skillsDir, project: join(workspace, ".kclaw", "skills")})` 扫描技能目录（全局 `<home>/skills` + 会话工作目录的项目级 `.kclaw/skills`，项目同名整目录覆盖；渐进披露第一层的数据源，机制见 [skills](../core/skills.md)）；同时计算好技能指定的隐式包装：`trigger: "user"` 时对用户原文做调用检测（`matchSkillInvocations`）并生成模型视图改写文本 `llmUserText`（交给 `llm-before` 位置的内置 `skill-wrap` hook 应用，同时记录到当轮用户消息的 `llmText` 标记、随消息持久化，之后的组装按标记重放同一字节，见 [agent-loop](../core/agent-loop.md) 的"包装标记重放"），`cron`/`agent` 触发不参与调用检测。随后 `createBuiltinTools({workspace, memory, tavilyApiKey, bash 超时/输出上限 + 沙箱包装器（可用才注入）, web 超时/私网开关, skills, processes?, cron?, todo?, goal?, skillCreate?, subagent?, ask?, childRun})`，把同一份扫描结果传给 `skill_read` 工具（渐进披露第二层，按需取正文）；`deps.subagents` 存在且本 run 非 subagent 时多注册 `subagent_run`（`run_in_background` 支持）与 `subagent_collect`（spawner/collector 与父会话 id 随行，机制见 [subagents](../core/subagents.md)）；每个 run 都注入 `ask`（`ask_user_questions` 工具：broker 与确认共用同一个网关对象、`timeoutMs` 取 `config.sessions.askTimeoutMs`、emit hook 给事件带 run 上下文，机制见 [tools](../core/tools.md)）；daemon 始终注入的还有四项能力：`processes`（后台进程注册表：bash 获得 `run_in_background` 与模型自定 `timeoutMs`，`process_list`/`process_output`/`process_kill` 三个工具加入清单）、`cron`（四个 cron 工具；`trigger:"cron"` 的 run 传 `writeTools:false` 只注册 `cron_list`，定时会话不能再创建定时任务）、`todo`（`todo_list_write`/`todo_list_read` 会话级清单）、`goal`（仅根会话注册 `create_goal`/`get_goal`/`update_goal` 三个工具）；会话 meta 带 `parentSessionId`（subagent run）时带 `childRun: true`，工具清单裁掉 `memory_save`、`subagent_run` 与 `subagent_collect`（单层委派），三个 goal 工具也不注册（目标循环是主线的职责），系统提示词换成精简的 subagent 提示词；`deps.tools` 的执行器按名称覆盖；`extraTools(workspace)` 每 run 求值一次（daemon 接 `mcpManager.toolsFor(workdir)`，工具清单跟随会话工作目录所在的项目组），defs 追加；名称冲突时记录日志 `kclaw tool name collision: <name> (adapter overrides builtin)`，适配器执行器生效。工具清单组好后做**披露分层**（tool_search）：存活清单按 core `tools/exposure.ts` 的静态表（未声明的默认 full；MCP 适配器工具恒入检索池）拆成全量层与检索池，池非空时注册 `tool_search` 工具（BM25 检索，命中的工具经执行器上下文的 `promote` 方法晋升进本 run 的可用工具集），层级清单与机制见 [reference/tools](../reference/tools.md) 的"工具披露分层"。
7. **权限**：在 `ConfigPermissionGate` 外再包一层负责登记确认的 gate。组装 gate 的输入一半来自会话、一半来自磁盘，每个 run 重新读取：`mode` 读会话 meta（`sessionMeta.mode`，默认 `default`，没有全局模式旗标，会话 meta 是唯一权威数据）；`decidedRules` 经 `loadDecidedRulesForRun` 每 run 重读已保存的规则文件（全局档恒载；项目档被 git 跟踪则跳过并告警，机制见 [permissions](../core/permissions.md)）；`workspace` 取会话 `workdir`（默认 `deps.workspace`），越界判定与项目档路径都以此为准；`readRoots` 传入附件目录与 spill 目录（`[paths.attachmentsDir, paths.spillDir]`）：附件目录里的文件是 daemon 自己收下的用户输入，spill 目录存放工具输出被截断时的完整副本（截断标记里的 fs_read 提示要能读到它们），fs_read/fs_list 读这两个目录不需要人工确认；`safeTools`/`toolFacts` 按内置工具注册的 risk 与参数 schema 字段名派生（引擎不持工具名单）。bash 沙箱在创建工具之前先检测一次可用性（`createBashSandbox`，结果写 daemon 日志当观察、不打断 run），检测结果同时提供给两个使用方：bash 工具的沙箱包装器（第 6 步）与 gate 的 `sandboxedTools`；沙箱启用但检测不可用时，gate 产生的 bash 确认请求带说明 `noteText`（"bash 沙箱不可用，本次操作需人工确认"）。gate 判定为 `confirm` 时，用 gate 签发的 id 调 `broker.create(confirmationId, toolCall, risk ?? "sensitive", confirmTimeoutMs, sessionId)` 登记。这一步只做登记，`confirmation.requested` 事件仍由循环发，全链路用的是同一个 id。
8. **resolveConfirmation**：`broker.wait(confirmationId)` 经共享的 `raceConfirmation(同 confirmTimeoutMs, controller.signal)`（`permissions/broker.ts` 导出，循环与组装用同一个函数）同时等待三方：人工裁决 / 超时 / abort，谁先到算谁。超时或 abort 先到时调用 `broker.expire`，晚到的人工 resolve 只会得到 `unknown confirmation`。人工确认得出结果（含超时，沉默也是"否"）时向会话事件流写一条 `permission.decided` 审计事件（裁决、裁决者 by、工具身份；abort 不算裁决，不写这条事件），与 `system` / `sandbox.checked` 同契约：只写事件流、不进投影、不推进 updatedAt、写失败即 run 失败（运行档案三事件之一，见第 12 步）。
9. **模型解析与 LLM 客户端**：模型行先解析：`resolveRunModelLine(config, { inputModel, sessionModel, launchModel })` 一次得出四项结果：线上模型 id（名字命中 provider 条目时取条目的 `model`，未命中则原样是裸模型名）、命中的条目名 `entryKey`（未命中回退到默认条目）、本 run 的上下文 budget（条目 `contextWindow` 与会话 budget 取较小值）、条目声明的 `maxOutput`。优先级链（显式 run 模型 → 会话模型 → 默认条目当前模型 → daemon 启动时解析的模型）集中在 `resolveRunModelLine` 一处，手动压缩路径走同一函数。随后 `llmForRun(onLlmRetry, entryKey)` 为本 run 构造带重试可见性的客户端，重试回调把 attempt 计数推进并触发 `llm-retry` 位置的 hook 链（内置 `retry-notify` 转 `llm.failed {willRetry:true}` 事件）；daemon 侧按 `entryKey` 取该条目自己的端点与协议客户端（共享 resolver 按签名缓存、配置变更通知整体清空，改配置下个 run 热生效，见 [provider](../core/provider.md)）；`runId` 从循环的第一个事件 `run.started` 捕获，`llmAttempt` 计数在 `llm.completed/failed` 后复位。
10. **压缩视图**：`RunInput.compaction` 传入会话 meta 里的压缩状态 `{ upto, top }`（无则 undefined），循环据此在请求开头放入压缩摘要项、跳过已压缩部分。`session_search` 的检索后端在此构造（`buildSessionSearch`：返回一个闭包，每次调用时重新读取该会话的事件流，交给 `createBuiltinTools`）。
11. **系统提示词（双段冻结基线 + hook 化组装）**：组装集中在 core `agent/system-prompt.ts` 的 `assembleSystemPrompt`。系统提示词分两段：**stable**（人设基础文本 + 注入约定，缓存冻结面）与 **live**（认知 + 技能清单，低频变化面），会话 meta 的 `systemBaseline` 为两段各存一份基线（提示词缓存冻结策略，见 [hooks](../core/hooks.md)）。每 run 两段都重新计算，再与基线逐段比对。stable 的组成：基础文本由 `resolveBasePrompt` 选定，主会话取 AGENTS.md（缺失或为空时回退 `DEFAULT_SYSTEM_PROMPT`），subagent run 换成 `subagentSystemPrompt` 精简提示词（带 role 时拼进角色小节，见 [subagents](../core/subagents.md)），团队组长在主提示词后追加组长协议，组员整套换成组员提示词（见 [agent-team](../core/agent-team.md) 的"身份与提示词"）；检索池非空时，基础文本末尾再拼"# 工具目录"段（directory 层工具每条列名字、描述首句和"可直接调用"的提示；内置 deferred 工具汇成一行，只列名字；有 MCP 工具时加一行固定说明，MCP 工具名单写在 tool_search 自己的描述里，名单变化时只有这段描述改变，stable 段文本保持不变）；最后拼注入约定段（`prompts/system.ts` 的 `SYSTEM_INJECTION_CONVENTION`：说明 `<system-reminder>` 标签内是系统自动注入的备注，`<compacted-summary>` 标签内是更早对话的压缩摘要，见 [agent-loop](../core/agent-loop.md)）。live 的组成：`system-before` 链产出的段落（内置 `system-materials` 给出 L2 认知与技能清单 `skillListPrompt(skills)`；subagent run 时该 hook 返回空列表，live 只剩用户文件 hook 追加的段落）。`system-before` 链每 run 都执行；两段都命中基线时直接用基线文本，`system-after` 链跳过；认知、技能或 AGENTS.md 改动后，对应段的文本随之变化，下一个 run 就重冻结该段。前缀缓存从头逐字节匹配，live 变化只让变化点之后的部分失效，stable 前缀继续命中。至少一段变化时，拼好的草稿经 `system-after` 链得出终稿（用户改写先于冻结执行）；改写发生时终稿整体固化进 stable 基线，下一个 run 的 stable 现算文本与基线不同，组装与改写因此每 run 重新执行，审计始终记录模型实际看到的那份。审计由**组装层直接写入事件流**（分段冻结需要分别持有 stable 与 live 两段文本，hook 只能看到基础文本或拼好的草稿）：`sessions.appendSystem` 写一条双段 `system` 事件进事件流，每 run 恰好一条、写失败即本次 run 失败；投影随之按段固化新基线：哪段文本变了就重冻结哪段，未变的保留 `frozenAt`（它记录这份文本成为基线的时刻）。压缩事件在投影里清除基线，下一个 run 重新组装并固化；压缩本来就让缓存全部失效，基线重置点设在这个冷启动处，没有额外成本。
12. **runAgent**：`hooks` 传第 3 步的链（循环的全部行为挂载点：run-before 写入消息、llm-before 改写视图、turn-boundary 接 `handoff.drainSteer` 的引导注入、compaction-check / overflow-rescue 两个压缩决策位经 `compactor.auto`/`compactor.background` 执行）；`signal` 接本 run 的 controller；`toolResultKeep` 从 `config.sessions.toolResultKeep`（默认 0 = 不按条数省略）传入、`tokenBudget` 传 `budget × compactPackRatio`（省略线 0.70 扣除固定开销），共同驱动构造请求时按 budget 省略工具输出。两个持久化回调统一放在 deps 上：
    - `onEvent`：捕获 runId / 复位 attempt → 按事件类型把 run 边界写入会话档案（`run.started` 经 `appendRunStarted` 写入，连同起点携带的 `model` / `provider` / `permissionMode` 配置快照一起写入；`run.completed`/`run.failed` 经 `appendRunEnded` 写入：失败的 run 也写终点，有起点必有终点，与 `system`/`sandbox.checked` 同契约：写失败即 run 失败）→ `bus.emit`（再包一层 try/catch，单个异常订阅者不会中断 run）。
    - `onMessage`：assistant/tool 消息持久化（用户消息的持久化由 run-before 链的 `user-message-land` 负责，不经这里）。
13. **run-after 链**：`runAgent` 返回后串行执行收尾链，首个是内置 `usage-ledger(10)`（有 usageStore 就记一行用量，含缓存读写字段（run 级按字段聚合，未知记为 NULL），失败只记日志；subagent run 记到父会话名下，`usageSessionId` = `meta.parentSessionId ?? 自身`）→ 任何排其后的用户/注入条目 → 内置 `manual-compact-flush(15)`（运行忙时排队的 /compact 在这里执行：取排队的 focus，直调 `Compactor.compact({manual:true, phase:"manual"})`；没有暂存就零开销跳过）→ 内置 `post-run-compaction(20)`（stopReason 非 `aborted`/`error` 且上下文占用 ≥ `budget × compactAtRatio` 时 `compactor.auto({phase:"post-run", signal})`；估算前有正在执行的后台压缩则先等它结束（等到的结果通常已把占用降到线以下）。此 hook 声明 skip：压缩失败经 `Compactor.auto` 以 failed 结果返回、只进事件流，不影响 run 收尾。这个等待发生在活动登记清除之前。驱动器串行化让压缩期间新消息排队，手动 /compact 此时也被"会话活跃"条件自然排到下一轮）→ 内置 `follow-check(30)`（`config.memory.write.idleMinutes > 0` 时排一个跟随检查，写入该项目 `state.json`，daemon 重启后由记忆调度器补查；subagent run 不排；失败静默）→ 内置 `skill-follow-check(40)`（技能进化的零成本粗查：`skills.evolution.enabled` 且 `idleMinutes > 0` 时，对范围内卷入技能的 run 排一个提炼空闲检查（粗查失败静默，不影响 run），写入该项目 `.proposals/state/<projectId>.json`，daemon 重启后由技能调度器补查；subagent run 不排；机制见 [skills](../core/skills.md)）。最后 `#executeEntry` 在 finally 里清理 `#active`/`#activeOutcomes` 中属于本 run 的登记（登记仍属于本 run 时才删除，防止误删后继 run 的登记）。

调度心跳的 cron run 使用同一入口：`run.enqueue(session.id, {userText: cron.prompt, trigger: "cron", note: {kind: "cron", text: "本会话由定时任务「<name>」触发"}})`（`packages/server/src/scheduler-tick.ts`），cron 触发的 run 跳过自动命名。

### 引导注入口（#drainSteer）与 steer 的一生

steer 条目被 `submit` 放进 `#steerBuf` 后，目标 run 在**迭代边界**（工具批次完成后、下一次 `llm.stream` 前）经 `turn-boundary` 位置的内置 `steering-drain` hook 调用 `#drainSteer` 取走全部缓冲消息：循环对每条按序广播 `message.created` → 经 `onMessage` 写入磁盘 → `message.completed` → `message.steered {messageId}`（事件级 `runId` 标识注入的 run）。模型在下一轮自然看到，流式输出不打断、不产生新 run。注入或写入抛出错误与用户消息写入同一语义：run 以 `run.failed "steering_failed"` 终止。若 run 在取走缓冲前先结束（任何 stopReason），驱动器的下一轮把残余条目降级为 wait 并入队尾（见上文 steer 缓冲与降级），下轮出队照常执行，两条路径都保证消息写入 JSONL。

### 确认网关时序（服务端视角）

```
循环：gate.check(toolCall) → {type:"confirm", confirmationId:"conf_…"}
      （命令类工具无规则命中且 bash 沙箱可用时 gate 直接 allow {reason:"sandboxed"}，不经确认，
       见 [permissions](../core/permissions.md) 第 7 节）
      ↓（引擎组装的包装 gate 同步登记）
      broker.create(conf_…, toolCall, risk, 300s, sessionId)
循环：广播 confirmation.requested {confirmationId, toolCall, risk, expiresAt}
      （沙箱启用但不可用的回退到确认带 noteText，CLI 暗色一行 / WebUI 卡片注明）
      ↓ 等待 resolveConfirmation：三方同时等待，谁先到算谁
      ├─ WS/CLI：confirmation.resolve {confirmationId, decision, client}
      │    → ws.ts 只认领裁决方（client 字段，默认 cli）→ broker.resolve → true；
      │      ws.ts 回 confirmation.resolved_ack；循环发 confirmation.resolved
      │      （裁决的全部后果：project/global 的沉淀规则写文件、写审计记录、once 授权、
      │      auto 归纳，都集中在 run 组装的 resolveConfirmation 一处，见
      │      [permissions](../core/permissions.md) 的「人工确认流程」一节；once/reject/未知 id 不写文件）
      ├─ 300s 超时：循环按拒绝处理（note「确认超时，操作未执行」）；
      │    引擎侧同超时 → broker.expire → 条目作废
      └─ run.cancel 的 abort：循环不发 confirmation.resolved（取消≠超时拒绝），
           引擎侧 expire；tool 结果补 "run aborted before execution"
裁决 once/project/global（非 reject/timeout）→ 循环在 tool 消息上记 grantedBy:"confirmed"
     （`packages/core/src/agent/loop.ts`：entry.grantedBy = "confirmed"，
      最终汇成 ToolMessage.grantedBy: Record<callId, GrantedBy> 持久化）
```

裁决来源 `by`：WS 命令的 `client` 字段（`"cli"|"web"`，默认 cli）决定 `by`；超时为 `"timeout"`。审计以持久化在 tool 消息上的 `grantedBy` 为准；裁决本身另外写入一条 `permission.decided` 会话事件（谁、何时、批准了什么，见第 8 步）。

### 运行中提问（ask_user_questions 的服务端半边）

`question.resolve` 命令走与 `confirmation.resolve` 同一个网关对象（`ConfirmationBroker` 的一个对象、两类等待中的条目）：ws.ts 收到命令后 `broker.resolveQuestion(questionId, answers, actor)`，成功时回复 `question.resolved_ack`；`question.resolved` **事件**由工具执行器自己发（它知道哪边先返回），daemon 不发。未知/已过期的 questionId 回复 `unknown question`。

### run.cancel 的 aborted 路径（只中止当前 run）

`cancel(sessionId, messageId?)` 只做一件事：`#active` 有 controller → `abort()`、返回 true；没有 → false（ws 层回复 `no active run`）。带 `messageId` 时只有活动 run 执行的正是这条消息才中止，否则同样返回 false：发送方的取消可能晚于自己 run 的结束，此时活动的已经是排在后面的别人的 run。abort 后循环在下一个检查点以 `run.completed {stopReason:"aborted"}` 终止，确认等待中的 abort 不算超时拒绝。ack（`run_cancel_ack`）在处理完成后立即返回，终态事件随后经总线到达。

**run.cancel 只中止当前 run，不连带排队消息**。排队中的 wait 条目原封不动，当前 run 停止后由驱动器照常出队执行；排队消息的取消一律走 `queueCancel`。CLI 的三段 Ctrl+C、Web 的"当前回复停止"都建立在这个只中止当前 run 的语义上。

### queueCancel：排队取消

`queueCancel(sessionId, messageId?)` 的取消范围：

- **带 messageId**：先查可执行队列（wait 条目随时可取消），再查 steer 缓冲（注入前可取消：长工具批次期间注入窗口可达数分钟，这段时间里条目占用着共享上限的名额）。命中即从内存与 queue.jsonl 删除、广播 `message.queue_cancelled {messageId}`、返回 `{ok:true, cancelled:[id]}`；都不在时按 `#injectedIds` 区分两种失败：近期已注入 → `{ok:false, reason:"injected"}`（已写入事件流历史，系统不删除历史），否则 `{ok:false, reason:"not_found"}`。ws 层把两者分别映射为错误文案 `已注入` 与 `not found`。
- **不带 messageId**：清空全部可取消条目（全部 wait + 全部未注入 steer），广播 `message.queue_cancelled {all:true, messageIds}`，`messageIds` 列出实际撤回的条目。

被取消的 wait 条目，其 `outcome` promise 以拒绝（`排队消息已取消`）结束：`enqueue()` 的调用方在等待它，静默丢弃会让 promise 永远得不到结果；steer 条目没有独立的 outcome（沿用活动 run 的 outcome），随活动 run 的终态一起结束。

`queue.cancel` 与注入取走在同一 daemon 进程的同一个线程内天然互斥（先到先得）：取消先到则条目被删、注入再也取不到；注入先到则条目已登记 `#injectedIds`、取消请求得到 `injected`。

### recoverQueues：崩溃恢复

daemon 启动时对每个 queue.jsonl 非空的会话调用：整体重排为内存队列并重新启动驱动器。**steer 与 interrupt 条目一律降级为 wait**：它们针对的对象（某个正在运行的 run）已不存在，降级重排是唯一合理的语义；恢复后的队列在审计意义上无损（消息都还在），仅在"原本想引导/中断"的意图上有损失，这是重启的固有代价。每条恢复条目重新广播 `message.queued {disposition:"wait", position:i}`，让重连的客户端重建排队气泡。

### compactSession：手动压缩（忙时排队执行，发消息的排队仍拒绝）

`compactSession(sessionId, focus?)` 是 `/compact` 的服务端入口（HTTP `POST /sessions/:id/compact`、CLI `/compact`、web "压缩"按钮三者共同调用）。忙闲分两条路：

- `#active` 有活动 run → **排队**：`compactor.deferManual(sessionId, focus)` 记下请求（只留最后一次的 focus，后来的覆盖先前的），立即返回 `{queued: true, message: "已排队：当前运行结束后自动压缩"}`（HTTP 200）。执行点在运行结束的收尾链上：内置 hook `manual-compact-flush(15)` 在自动收尾压缩 `post-run-compaction(20)` 之前执行，取排队的 focus 以 `manual: true` 执行压缩，用户请求的那次压缩先于自动压缩发生。排队记在内存里，daemon 重启即丢失。排队的执行跳过忙碌/排队检查：它本来就在"运行结束后"执行，此刻队列里有消息是常态。
- `#active` 空、但 queue.jsonl 非空 → **仍拒绝** 409 `还有 N 条排队消息，先处理或取消`（排队消息会连续开启多个 run，压缩时机无法预期，"先处理或取消排队"是用户能照做的建议）。

会话空闲且无排队时按会话 meta 解析模型，以 `manual: true` 调 core `Compactor.compact`，跳过触发判断，其余流程（两次摘要调用、compaction 事件写入）与自动压缩完全一致。返回一句话：成功是 `压缩了 N 段，剩 X 条原文消息`，历史太短没有可压缩内容是 `无可压缩内容`（不产生任何状态变化）。手动压缩**不产生新消息**：总摘要经压缩视图的压缩摘要项进请求，本次压缩的痕迹是一条 `compaction` 事件（`trigger: "manual"`，带 focus）。

### 自动命名（core session/autoname.ts）

`scheduleAutoname({sessions, resolveLlm, titleFor?, emit?, recordChoreUsage?}, sessionId, firstText)`：

1. 前置：`meta.title === "新会话"` 才命名（已手动改名的不处理）。
2. 异步生成：没有注入 `titleFor` 时，`defaultTitle` 经 `resolveLlm` 获取后台调用的模型通道（daemon 注入的是 `memory.extractModel` 解析链，空值回退到主对话模型，与压缩摘要、记忆提取同一条；没有注入时用本 run 的 llm 与模型）流式调用，这次调用的用量经 `recordChoreUsage` 记为 `autoname` 后台调用；system 为 `"你是标题生成助手，只输出一个不超过30字的会话标题。"`，user 为 `给这段对话起一个不超过30字的标题：
<firstText>`；拼接全部 `text_delta`。
3. 写回：`title.trim().slice(0, 30)`，空串放弃；**写回前重新读取 meta**：生成期间用户可能已手动改名，此时标题已经变成 `"新会话"` 以外的值，就放弃写回。
4. 更名成功才 `emit(makeEvent("session.renamed", { title, source: "auto" }, { sessionId }))`（注入的是 `busEmit`）；失败静默（catch 空处理，保持默认标题）；不阻塞 run（`void scheduleAutoname(...)`，不 await）。

## 限制

- **确认裁决不进入任何队列**：`broker.resolve` 对已出结果或已过期的条目返回 false 并回复 `unknown confirmation`，不记录迟到的意见。确认卡等待期间 steer 照常入缓冲区；run 在等确认期间不迭代，注入发生在确认解决后的下一个迭代边界。
- **自动命名没有去重锁**：同一会话两次快速入队理论上可能并发两次命名，写回前重新读取并校验，保证只有第一次生效（后到的一次发现标题已经改成默认值以外的内容，就放弃）。
- **`resolveConfirmation` 测试注入点优先于 broker**：设置后 broker 只负责登记；生产环境不设置这个注入点。

## 错误处理

- **enqueue 的 promise 对 provider 错误不 reject**（`runAgent` 内部转换为 `run.failed` 与 `stopReason:"error"`）。**错误帧只用于同步失败**：`submit` 抛出错误（队列满、会话不存在、subagent 只读、唤醒 budget 耗尽）发生在 ack 之前，ws 层当场返回 error 帧、无 ack；处置字段非法在更早的 ws 帧校验就被拒掉，同样是同步 error 帧。ack 之后，ws 层不等待 `submit().outcome`（发出即返回），run 级与持久化级的迟到失败不发迟到帧，经总线事件到达订阅客户端：run 级失败走循环的 `run.failed`；出队持久化失败与条目执行失败（循环的 `run.failed` 覆盖不到的两类）走 RunManager 补发的 `run.failed {error:{code:"queue_entry_failed", message 含 messageId 与原因}}`。
- **队列已满是同步拒绝**：`submit` 在入队前检查上限（排队与 steer 缓冲合计 10），超限直接抛出 `队列已满（10 条）`，ws 层返回 error 帧、无 ack，被拒绝的消息不会留在队列里。上限不分池：steer 与 wait 共用同一个名额池，steer 占满名额的风险由"steer 注入前可单条删除"解决（排队气泡可见、可删）。
- **排队取消是三态的**：命中删除、`injected`（近期已注入，已写入 JSONL，系统不删除历史）、`not_found`（无此条目，或它的注入记录已从有界集合中移出）。判定依赖 `#injectedIds`：全部会话共用的一个有界集合，注入时登记，超过 `QUEUE_LIMIT×2`（20 条）时移除最早的记录；重启后集合清空，恢复条目尚未注入前取消仍是合法的。
- **附件路径的第二道检查会终止整条 run**：正常情况下 ws 帧层已经在入队之前拒绝越界的附件引用；如果有越界路径绕过了帧层到达 `mountAttachments`，这里抛出的错误让本次 run 以异常结束：await 该 outcome 的调用方看到 reject，订阅客户端经 `queue_entry_failed` 事件看到失败。steer 注入走的是另一条失败路径：`#drainSteer` 先构建后变更，任一条构建失败即整批留在缓冲区、没有一部分先进入历史（异常沿 hook 链传播，run 以 `run.failed "steering_failed"` 按正常流程失败），缓冲区里的条目仍可取消、可重试注入；注入前 run 先结束的，残余条目降级入队后走到同一出队执行路径，组装段同步抛出错误时同样补发 `queue_entry_failed`。
- **条目级失败有可见性事件（`queue_entry_failed`）**：两类失败发生时循环的 `run.failed` 覆盖不到：出队持久化失败（run 还没开始）与条目执行在组装段同步抛出的错误（如降级后的坏附件，`mountAttachments` 与读历史在 `runAgent` 之前就抛出错误；进入模型循环前的系统提示词审计写入 `appendSystem` 同属此类）。驱动器在这两条路径上补发 `run.failed {error:{code:"queue_entry_failed", message}, messageId}`（sessionId 级事件；run 没有开始，事件不带 runId，等待结果的发送方根据 payload 的 `messageId` 识别这次失败），已 ack `queued:true` 的消息不会悄无声息地消失；出队持久化失败还伴随条目退回队首（内存与 queue.jsonl 保持一致，等待重试）。
- **压缩与用量记录失败都不影响 run 的结果**：自动压缩的摘要调用或 meta 写入失败时以 failed 结果返回、运行照常继续（事件 `completed {result:"failed"}`；`kclaw compaction (<阶段>) failed:` 日志）；段索引写入与审计追加失败只留一行日志、压缩照常生效；用量记录失败只留一行日志（`kclaw usage record failed:`）；跟随检查排期失败静默（不打印、不阻塞）。以上任何一种失败 run 都照常返回 outcome。

## Reference

- [agent-loop](../core/agent-loop.md)：runAgent 状态机、确认的循环侧超时等待、6 个 abort 检查点、attachment 块进模型视图的转换
- [permissions](../core/permissions.md)：ConfigPermissionGate 的判定链与 `conf_*` id 的签发；mode/decidedRules/readRoots 三处组装输入
- [realtime](./realtime.md)：send_message/confirmation.resolve/run.cancel/queue.cancel 的帧协议与 ack
- [memory](../core/memory.md)：两级注入（L2 认知常驻 + L1 情节 note）、写入 pipeline 与跟随检查背后的实现
- [compaction](../core/compaction.md)：`Compactor.compact` 背后的触发/分界/摘要机制、审计记录格式与配置字段
- [skills](../core/skills.md)：技能目录每 run 扫描、技能清单注入系统提示、调用隐式包装（`skill-wrap` hook）
- [hooks](../core/hooks.md)：位置网格、HookChain 语义、内置 hook 清单与用户文件契约
- [mcp](../core/mcp.md)：`extraTools` 的来源（MCP 工具适配器）
- [storage](../core/storage.md)：UsageStore 的用量记录实现（`usageStore.record` 背后）
- [http-api](./http-api.md)：GET /sessions/:id/queue、POST /sessions/:id/disposition 两个队列路由与写入 session meta model/mode 的既有路由
- [webui](../web/webui.md)：发送三选、排队气泡与重连同步的处理侧
