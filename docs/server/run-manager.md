# run-manager — 会话串行 run 与确认网关（服务端侧）

## 职责

`packages/server/src/run.ts` 的 `RunManager` 负责 `send_message` 之后服务端的全部处理：入队、同会话串行执行、附件挂载、模型解析、记忆注入、系统提示、工具与权限装配、事件发送到总线、消息持久化、token 台账记录、run 取消。`packages/server/src/confirm.ts` 的 `ConfirmationBroker` 是确认网关的服务端半边：挂起的人工裁决经 WS/CLI 的 `confirmation.resolve` 命令在此完成裁决。`packages/server/src/autoname.ts` 的 `scheduleAutoname` 在首条用户消息后异步生成会话标题并把更名广播为 `session.renamed` 事件。调度心跳（`scheduler-tick.ts`）触发的 job run 也使用同一个 `enqueue` 入口。

## 设计决策

- **ack 与 run 解耦是结构性保证**：`ws.ts` 收到 `send_message` 先返回 `send_message_ack` 再入队（不 await），run 的进展全部以 `run.*` 事件流回订阅者——长任务永远不阻塞命令通道。
- **同会话串行、跨会话并发**：每个会话一条 promise 链（`#chains: Map<sessionId, Promise<void>>`），新消息接在链尾；不同会话的链互不等待。链尾忽略成败（`then(() => undefined, () => undefined)`）——一次失败的 run 不影响该会话的下一次入队。
- **用户消息由 RunManager 预制**：以纯 text 骨架（先建只含一个文本块的消息，note 块随后补全）经 `RunInput.userMessage` 传入，循环原样使用且不重复持久化；note 块（job 来源 + 记忆）在 `onUserMessage` 钩子里追加——事件序固定为 `run.started → message.created → note.emitted ×N → message.completed`，且持久化先于 note 事件（事件反映已持久化状态）。
- **历史在追加用户消息之前读**：`runAgent` 自己会把用户消息拼在 `history` 之后（`[...input.history, userMsg]`），若 history 已含它会向 provider 重复发送同一段文本。
- **broker 只做桥接，不发事件、不管理超时**：`confirmation.requested`/`confirmation.resolved` 由 agent 循环发（`packages/core/src/agent/loop.ts`），broker 若再发即造成线上重复；超时裁决也由循环的 `raceConfirmation` 完成。broker 的 `expiresAt` 只是登记信息。
- **双重竞速镜像**：RunManager 侧的 `raceResolution` 与循环侧的 `raceConfirmation` 用**同一个** `confirmTimeoutMs` 竞速同一个人工 promise——两侧结论一致；迟到的人工裁决被已 settle 的 race 丢弃，服务端再 `expire` 掉条目，晚到的 resolve 只能得到 `unknown confirmation`。
- **自动命名静默且不覆盖手动改名**：失败静默处理、两次校验默认标题（生成前、写回前），用户已手动改名则不再修改。更名成功写回 meta 后，经注入的 emit 钩子（`busEmit`）广播 `session.renamed {title}`——订阅者立即收到通知。
- **模型解析：每 run 一次，三级优先级**：本轮用哪个模型，按 `input.model`（job 配置的模型或客户端指定的）→ 会话 meta 的 `model`（POST `/sessions/:id/model` 写入的那个）→ daemon 默认模型的顺序取第一个非空的。取到的值再经 `resolveEntry` 做一次翻译：如果它是 config 里 provider 条目的名字（比如 `deepseek`），就换成该条目配置的线上模型名（比如 `deepseek-chat`）；如果本来就是一个直接的 API 模型名则原样通过。解析发生在每个 run 开始时，所以改完会话模型后下一次 run 即生效。
- **附件挂载：按文件类型分三种处理**：`mountAttachments` 把用户上传的文件转成用户消息上的 attachment 块。文本类文件（MIME 为 `text/*` 或扩展名是常见文本类型）且不超过 64KiB 时，读出正文内联进消息（超过 8000 字符截断并加 `\n…[已截断]`）；图片且不超过 5MiB 时转成 base64 内嵌（作为多模态内容段发给模型）；其余文件只在块里放 `{type:"file", path}` 路径信息，模型需要内容时自己用 fs_read 读。安全上有两道检查：ws 层在校验 send_message 帧时查过一次路径，这里再用 `realpathWithin` 复核一遍——引用越出本会话附件目录就直接抛错、终止整条 run。
- **用量记录失败不影响 run**：run 正常结束后向 `usageStore.record` 记一行（会话 id/run id/模型/输入输出 token/时刻）。这行代码包在 try/catch 里，失败只打 `kclaw usage record failed:` 日志；daemon 没注入 usageStore 时整个步骤跳过。
- **自动记忆提取：发出请求后不等结果**：run 以 `end_turn` 干净收场且 `config.memory.autoExtract === true` 时，调度 `#extractMemory` 后不 await 它——这是一次不带工具的 LLM 调用，从整轮对话里提取"值得长期记住的用户个人事实"（要求返回 JSON 字符串数组），逐条调 `memory.save({source:"auto"})` 存入记忆库。响应解析失败就整批放弃、只打日志；某一条保存失败不影响其余条目。记忆注入那一侧的机制不变。
- **上下文压缩 v2（token 触发的分层摘要）**：每轮 run 开始前，`#compactV2` 按 `SessionMeta.compaction.upto` 切出 active 历史（旧会话回落 `compactedUpto`，标记在历史里找不到视为无标记）并估算"active + 本轮用户文本"的 token——`estimateContextTokens` 以最后一条助手消息记录的真实 `usage.inputTokens` 为基准（天然含系统提示与工具定义的固定开销），其后按字符粗算。估算达到 `config.sessions.contextTokens`（默认 128000）× `compactAtRatio`（默认 0.66）即压缩；分界由 `chooseBoundary` 选出——从最新往回累加到预算 × `compactTargetRatio`（默认 0.33）为止，起点再对齐到最近的用户消息（保证段与保留部分都是完整轮次）。压缩是两次无 tools 的 `collectStreamText` 调用（复用本轮 `runLlm` 与解析出的 model，发生在 runAgent 之前）：新段经 `renderSegment`（每行一条消息、工具调用与结果以缩写进入、排除旧摘要 note、单行截 2000 字符）生成固定五栏的段摘要，再与旧总摘要归并出新总摘要；**两次全部成功后**才一次 `updateMeta` 写入 `{ segments, top, upto }` 并删除旧字段 `compactedSummary`/`compactedUpto`。落盘之后还有两个 best-effort 动作：段文本与段摘要写入会话检索索引（`index.db`，失败记 `kclaw segment index … write failed:` 日志）、向 `compactions.jsonl` 追加一行审计（失败记 `kclaw compaction audit … append failed:` 日志），两者都不影响压缩生效。runAgent 收到切片后的 history，总摘要以 kind `"compact"` note（文案 `早期对话已压缩为 N 段（保留最近 X 条原文；可用 session_search 检索早期细节）。摘要：…`，note 顺序 job → compact → memory）挂在用户消息上经 `onUserMessage` 管线广播——没触发新压缩的轮次，已有总摘要也每轮照常附带。模型调用或 meta 写入抛错时打一行 `kclaw compaction failed:` 日志并回退：不切片、不注 note，带全量历史继续跑，下一轮重新触发。机制细节与数据格式见 [compaction](../core/compaction.md)。

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
}

/** 一条已上传附件文件的引用（挂载为 attachment 块）。 */
export interface AttachmentRef {
  path: string
  name: string
  size: number
  mimeType: string
}

export class RunManager {
  get broker(): ConfirmationBroker
  enqueue(sessionId: string, input: EnqueueInput): Promise<RunOutcome>
  cancel(sessionId: string): boolean   // false = 该会话当前无活跃 run
  compactSession(sessionId: string, focus?: string): Promise<{ message: string }>
                                        // 手动压缩（HTTP/CLI/web 三入口共用）：跳过触发线立即压缩一次；
                                        // 会话有活跃或排队 run 时抛"会话正在运行"，无可压缩内容返回固定文案
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

关键常量（`run.ts`）：`MEMORY_QUERY_CHARS = 200`（用户文本前 200 字符做记忆检索）、`MEMORY_LIMIT = 5`（最多注入 5 条）、`DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"`；附件挂载的 `TEXT_INLINE_MAX_BYTES = 64KiB`、`TEXT_INLINE_MAX_CHARS = 8000`、`IMAGE_INLINE_MAX_BYTES = 5MiB`。三个固化系统提示词：`SEGMENT_SUMMARY_PROMPT`（段摘要：固定五栏 markdown、不超过 800 字）、`MERGE_SUMMARY_PROMPT`（总摘要归并：同样五栏、保留新版本并注明被推翻的旧版本）、`EXTRACT_SYSTEM_PROMPT`（记忆提取：只输出 JSON 字符串数组）。压缩触发的三个比例不在 defaultConfig 里（`sessions` 段的 `contextTokens`/`compactAtRatio`/`compactTargetRatio`/`toolResultKeep` 均可选），缺省值在读取处兜底（128000 / 0.66 / 0.33 / 8）。确认超时来自 `config.permissions.confirmTimeoutMs`，默认 `120_000`（120 秒，`packages/core/src/storage/config.ts` 的 defaultConfig）。

## 核心流程

### enqueue：入队与串行

```
enqueue(sessionId, input)
  prev = #chains.get(sessionId) ?? 已完成的空 promise
  run  = prev.then(() => #execute(sessionId, input))       // 排在同会话上一个 run 之后
  tail = run.then(忽略成败)                                  #chains.set(sessionId, tail)
  tail 结束且仍是链尾 → #chains.delete(sessionId)            // 空闲会话不占内存
  return run                                                 // 调用方获得 RunOutcome（ws.ts 不 await 它）
```

`#active: Map<sessionId, AbortController>` 记录正在执行的 run，`#cancelQueued: Set<sessionId>` 登记"被取消但还在排队"的会话。controller 在出队后的**第一个动作**就注册（早于任何 await）——否则取消命令会在"已出队未注册"的窗口里误答 `no active run`。

### #execute：一次 run 的装配

1. **注册 controller 与排队取消**：新建 controller 立即写入 `#active`；若会话在 `#cancelQueued` 里则移除标记并当场 abort——被取消的排队 run 不做任何工作就以 aborted 收场。
2. **工作目录**：`sessionMeta.workdir ?? deps.workspace`——会话级覆盖全局。
3. **记忆注入**：`memory.search(userText.slice(0, 200), 5)`，每条命中变成 `kind:"memory"` note 块（文本 `相关记忆: <hit>`）；检索抛错则不带记忆继续（记忆是加速器，不得阻塞 run）。
4. **读 history**（此刻用户消息尚未追加），构造纯 text 骨架 `userMessage`，`input.attachments` 经 `mountAttachments` 挂成 attachment 块放进同一消息。
5. **工具**：`createBuiltinTools({workspace, memory, tavilyApiKey, exec 超时/输出上限, web 超时/私网开关})`；`deps.tools` 的执行器按名覆盖；`extraTools()` 每 run 求值一次，defs 追加、撞名打 `kclaw tool name collision: <name> (adapter overrides builtin)` 且适配器执行器胜出。
6. **权限**：在 `ConfigPermissionGate` 外再包一层负责登记确认的 gate。装配 gate 时有三处值得注意：`readRoots` 传入附件目录 `paths.attachmentsDir`——上传目录里的文件是 daemon 自己收下的用户输入，fs_read/fs_list 读它们不需要人工确认；`readonly` 取 daemon 级旗标与会话开关的逻辑或，任一为真本 run 就是只读；safeTools 仍按内置工具里标 safe 的集合计算。gate 判出 `confirm` 时，用 gate 签发的 id 调 `broker.create(confirmationId, toolCall, risk ?? "sensitive", confirmTimeoutMs, sessionId)` 登记——这一步只做登记，`confirmation.requested` 事件仍由循环发，全链路用的是同一个 id。
7. **resolveConfirmation**：`broker.wait(confirmationId)` 经 `raceResolution(同 confirmTimeoutMs, controller.signal)` 竞速——人工裁决 / 超时 / abort 三方。非人工胜出（超时或 abort）即 `broker.expire`，晚到的人工 resolve 只会得到 `unknown confirmation`。
8. **模型解析与 LLM 客户端**：`llmForRun(onLlmRetry)` 为本 run 构造带重试可见性的客户端，provider 层每次重试变成 `llm.failed {willRetry:true}` 事件；`runId` 从循环的第一个事件 `run.started` 捕获，`llmAttempt` 计数在 `llm.completed/failed` 后复位。随后三级解析模型：`resolveEntry(input.model ?? sessionMeta?.model ?? defaultModel)`。
9. **上下文压缩**：见设计决策（失败回退全量历史继续跑）。`session_search` 的检索后端也在此懒构造（`#buildSessionSearch`：返回一个首次调用才打开/重建 `index.db` 的闭包，交给 `createBuiltinTools`）。
10. **runAgent**：`system` 取 `paths.agentsMd`（`~/.kclaw/AGENTS.md`）非空内容，否则默认提示词；`signal` 接本 run 的 controller；`toolResultKeep` 从 `config.sessions.toolResultKeep`（默认 8）传入，驱动请求构造时的工具输出省略。四个钩子：
    - `onUserMessage`：追加 job note + compact note + 记忆 note 块 → `appendMessage` 持久化 → （`trigger !== "job"` 时）异步 `scheduleAutoname` → 逐块发 `note.emitted`。
    - `onEvent`：捕获 runId / 复位 attempt → `bus.emit`（再包一层 try/catch，单个异常订阅者不会中断 run）。
    - `onMessage`：assistant/tool 消息持久化。
11. **收尾记账**：run 结束后做两件不影响结果的事——干净 `end_turn` 且配置开启了 autoExtract 时调度自动记忆提取（不等它完成）；有 usageStore 就在 try/catch 里记一行用量。最后在 finally 里删除 `#active` 中属于本 run 的 controller（仍是自己才删，防止误删后继 run 的）。

调度心跳的 job run 使用同一入口：`run.enqueue(session.id, {userText: job.prompt, trigger: "job", note: "本会话由定时任务「<name>」触发"})`（`packages/server/src/scheduler-tick.ts`），job 触发的 run 跳过自动命名。

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

### run.cancel 的 aborted 路径

`cancel(sessionId)` 三态：`#active` 有 controller → `abort()`、返回 true；无活跃 run 但 `#chains` 还有排队的 → 把会话记入 `#cancelQueued`、同样返回 true——该 run 出队的第一件事就是查此集合并当场 abort，不做任何工作；两者皆无 → false（ws 层回 `no active run`）。abort 后循环在下一个检查点以 `run.completed {stopReason:"aborted"}` 终止（不是 run.failed），确认等待中的 abort 不算超时拒绝。ack（`run_cancel_ack`）在处理完成后立即返回，终态事件随后经总线到达。

### compactSession：手动压缩

`compactSession(sessionId, focus?)` 是 `/compact` 的服务端入口（HTTP `POST /sessions/:id/compact`、CLI `/compact`、web "压缩"按钮三者共同调用）：先检查会话是否正忙——`#active` 有 controller **或** `#chains` 还有链都算忙，抛"会话正在运行"（压缩要读全量历史、写会话元数据，与运行中的写入并发会互相破坏；HTTP 层把它映射为 409）；再按会话 meta 解析模型；然后以 `manual: true` 调 `#compactV2`，跳过触发判断，其余流程（两次摘要调用、meta 写入、索引、审计）与自动压缩完全一致。返回一句话：成功是 `压缩了 N 段，剩 X 条原文消息`，历史太短没有可压缩内容是 `无可压缩内容`（不产生任何状态变化）。手动压缩**不产生新消息**：总摘要挂在下一条用户消息上注入，本次压缩的痕迹在 `compactions.jsonl`（`trigger: "manual"`，带 focus）。

### 自动命名（autoname.ts）

`scheduleAutoname({sessions, llm, model, emit}, sessionId, firstText)`：

1. 前置：`meta.title === "新会话"` 才命名（已手动改名的不处理）。
2. 异步生成：`defaultTitle` 用 run 的同一个 llm 流式调用，system 为 `"你是标题生成助手，只输出一个不超过30字的会话标题。"`，user 为 `给这段对话起一个不超过30字的标题：
<firstText>`；拼接全部 `text_delta`。
3. 写回：`title.trim().slice(0, 30)`，空串放弃；**写回前重读 meta**——生成期间用户可能已手动改名，此时标题仍不是 `"新会话"` 则不再修改。
4. 更名成功才 `emit(makeEvent("session.renamed", { title }, { sessionId }))`（注入的是 `busEmit`）；失败静默（catch 空处理，保持默认标题）；不阻塞 run（`void scheduleAutoname(...)`，不 await）。

## 边界与出错

- **enqueue 的 promise 对 provider 错误不 reject**（`runAgent` 内部消化为 `run.failed` + `RunOutcome.stopReason:"error"`）；但存储层失败（如磁盘写入失败）会 reject——`ws.ts` 在 ack 之后把错误作为 error 帧发给发起消息的那条 socket。
- **取消排队 run 是打标记，不是从队列移除**：被取消的排队 run 仍占着链上的位置，要等前一个 run 跑完、轮到它出队时才在第一步被 abort。所以取消活跃 run 立即生效；取消排在后面的 run，效果要等前序跑完才体现。
- **附件路径的第二道检查会终止整条 run**：正常情况下 ws 帧层已经把越界的附件引用拦在入队之前；如果有越界路径绕过了帧层到达 `mountAttachments`（比如直接调用 enqueue 的代码没做检查），这里的抛错会让本次 enqueue 以异常收场，错误经 ack 之后的 error 帧送达发起方。
- **确认裁决不落任何队列**：`broker.resolve` 对已 settle/过期条目返回 false 并回 `unknown confirmation`，不记录"迟到的意见"。
- **自动命名没有去重锁**：同一会话两次快速 enqueue 理论上可能并发两次命名，写回前的重读校验保证只有第一次生效（后到的发现标题已不是默认值即放弃）。
- **`resolveConfirmation` 测试缝优先于 broker**：设置了它 broker 就只剩登记职责——生产路径不设置。
- **压缩与记账失败都不影响 run 的结果**：上下文压缩的模型调用或 meta 写入失败时退回全量历史照常运行（`kclaw compaction failed:`）；段索引写入与审计追加失败只留一行日志、压缩照常生效；用量记录和自动记忆提取失败只留一行日志（`kclaw usage record failed:` / `kclaw memory extraction failed:`）。以上任何一种失败 run 都照常返回 outcome。

## 关联

- [agent-loop](../core/agent-loop.md)：runAgent 状态机、确认的循环侧竞速、6 个 abort 检查点、attachment 块进模型视图的转换
- [permissions](../core/permissions.md)：ConfigPermissionGate 的判定链与 `conf_*` id 的签发；readRoots/readonly 两处装配
- [realtime](./realtime.md)：send_message/confirmation.resolve/run.cancel 的帧协议与 ack
- [memory](../core/memory.md)：search 的实现（SQLite FTS5）
- [compaction](../core/compaction.md)：`#compactV2` 背后的触发/分界/摘要机制、审计记录格式与配置字段
- [mcp](../core/mcp.md)：`extraTools` 的来源（MCP 工具适配器）
- [storage](../core/storage.md)：UsageStore 的台账实现（`usageStore.record` 背后）
- [http-api](./http-api.md)：写入 session meta model/readonly 的两个路由
