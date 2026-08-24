# run-manager — 会话串行 run 与确认网关（服务端侧）

## 职责

`packages/server/src/run.ts` 的 `RunManager` 负责 `send_message` 之后服务端的全部处理：入队、同会话串行执行、记忆注入、系统提示、工具与权限装配、事件发送到总线、消息持久化、run 取消。`packages/server/src/confirm.ts` 的 `ConfirmationBroker` 是确认网关的服务端半边：挂起的人工裁决经 WS/CLI 的 `confirmation.resolve` 命令在此完成裁决。`packages/server/src/autoname.ts` 的 `scheduleAutoname` 在首条用户消息后异步生成会话标题。调度心跳（`scheduler-tick.ts`）触发的 job run 也使用同一个 `enqueue` 入口。

## 设计决策

- **ack 与 run 解耦是结构性保证**：`ws.ts` 收到 `send_message` 先返回 `send_message_ack` 再入队（不 await），run 的进展全部以 `run.*` 事件流回订阅者——长任务永远不阻塞命令通道。
- **同会话串行、跨会话并发**：每个会话一条 promise 链（`#chains: Map<sessionId, Promise<void>>`），新消息接在链尾；不同会话的链互不等待。链尾忽略成败（`then(() => undefined, () => undefined)`）——一次失败的 run 不影响该会话的下一次入队。
- **用户消息由 RunManager 预制**：以纯 text 骨架（先建只含一个文本块的消息，note 块随后补全）经 `RunInput.userMessage` 传入，循环原样使用且不重复持久化；note 块（job 来源 + 记忆）在 `onUserMessage` 钩子里追加——事件序固定为 `run.started → message.created → note.emitted ×N → message.completed`，且持久化先于 note 事件（事件反映已持久化状态）。
- **历史在追加用户消息之前读**：`runAgent` 自己会把用户消息拼在 `history` 之后（`[...input.history, userMsg]`），若 history 已含它会向 provider 重复发送同一段文本。
- **broker 只做桥接，不发事件、不管理超时**：`confirmation.requested`/`confirmation.resolved` 由 agent 循环发（`packages/core/src/agent/loop.ts`），broker 若再发即造成线上重复；超时裁决也由循环的 `raceConfirmation` 完成。broker 的 `expiresAt` 只是登记信息。
- **双重竞速镜像**：RunManager 侧的 `raceResolution` 与循环侧的 `raceConfirmation` 用**同一个** `confirmTimeoutMs` 竞速同一个人工 promise——两侧结论一致；迟到的人工裁决被已 settle 的 race 丢弃，服务端再 `expire` 掉条目，晚到的 resolve 只能得到 `unknown confirmation`。
- **自动命名静默且不覆盖手动改名**：失败静默处理、两次校验默认标题（生成前、写回前），用户已手动改名则不再修改。
- **上下文压缩（滚动摘要）**：每轮 run 开始前，`#compact` 先按 `SessionMeta.compactedUpto` 标记切出 active 窗口（标记失效视为无标记）；active 长度 ≥ `sessions.compactThreshold`（默认 60）时，把最老一段（`active.slice(0, -compactKeep)`，默认保留最近 25 条原文）经一次无 tools 的 `collectStreamText` 调用（复用本轮 `runLlm`，发生在 runAgent 之前）压成中文摘要并 `updateMeta` 落盘 `compactedSummary`/`compactedUpto`；已有旧摘要时以「旧摘要 + 需并入的最新被压缩对话（`renderConversation` 渲染，每条一行、单条截断 2000 字符）」滚动合并。压缩成功后 runAgent 收到切片后的 history，摘要以 kind `"compact"` note（文案 `早期对话已压缩（保留最近 N 条原文）。摘要：…`，note 顺序 job → compact → memory，每轮持续注入）挂在用户消息上经 `onUserMessage` 管线广播。压缩调用或落盘抛错则一行 `console.error` 回退现状：不切片、不注 note，循环内 window(40) 截断继续兜底。

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
}

export interface EnqueueInput {
  userText: string
  trigger: "user" | "job"
  note?: string        // job 来源行，落在用户消息的 kind:"job" note 块
}

export class RunManager {
  get broker(): ConfirmationBroker
  enqueue(sessionId: string, input: EnqueueInput): Promise<RunOutcome>
  cancel(sessionId: string): boolean   // false = 该会话当前无活跃 run
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

关键常量（`run.ts`）：`MEMORY_QUERY_CHARS = 200`（用户文本前 200 字符做记忆检索）、`MEMORY_LIMIT = 5`（最多注入 5 条）、`DEFAULT_SYSTEM_PROMPT = "你是 kclaw，一个务实的个人助理。"`。确认超时来自 `config.permissions.confirmTimeoutMs`，默认 `120_000`（120 秒，`packages/core/src/storage/config.ts` 的 defaultConfig）。

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

`#active: Map<sessionId, AbortController>` 只记录**正在执行**的 run；排队中的 run 在轮到时才新建自己的 controller——`cancel` 无法作用于尚未开始的 run。

### #execute：一次 run 的装配

1. **工作目录**：`sessionMeta.workdir ?? deps.workspace`——会话级覆盖全局。
2. **记忆注入**：`memory.search(userText.slice(0, 200), 5)`，每条命中变成 `kind:"memory"` note 块（文本 `相关记忆: <hit>`）；检索抛错则不带记忆继续（记忆是加速器，不得阻塞 run）。
3. **读 history**（此刻用户消息尚未追加），构造纯 text 骨架 `userMessage`。
4. **工具**：`createBuiltinTools({workspace, memory, tavilyApiKey, exec 超时/输出上限})`；`deps.tools` 的执行器按名覆盖。
5. **权限**：`ConfigPermissionGate` 外再包一层 gate——`check` 返回 `confirm` 决定时，以 gate 签发的 `confirmationId` 调 `broker.create(confirmationId, toolCall, risk, confirmTimeoutMs, sessionId)`（纯登记；`confirmation.requested` 事件仍由循环发，id 全链一致——客户端在事件中看到的 id 即用于 resolve 的 id）。
6. **resolveConfirmation**：`broker.wait(confirmationId)` 经 `raceResolution(同 confirmTimeoutMs, controller.signal)` 竞速——人工裁决 / 超时 / abort 三方。非人工胜出（超时或 abort）即 `broker.expire`，晚到的人工 resolve 只会得到 `unknown confirmation`。
7. **重试可见性**：`llmForRun(onLlmRetry)` 为本 run 构造一个客户端，provider 层每次重试通知变成 `llm.failed {willRetry:true}` 事件（携带本 run 的 sessionId/runId）；`runId` 从循环的第一个事件 `run.started` 捕获，`llmAttempt` 计数在 `llm.completed/failed` 后复位。
8. **runAgent**：`system` 取 `paths.agentsMd`（`~/.kclaw/AGENTS.md`）非空内容，否则默认提示词；`signal` 接本 run 的 controller。三个钩子：
   - `onUserMessage`：追加 job note + 记忆 note 块 → `appendMessage` 持久化 → （`trigger !== "job"` 时）异步 `scheduleAutoname` → 逐块发 `note.emitted`。
   - `onEvent`：捕获 runId / 复位 attempt → `bus.emit`（再包一层 try/catch，单个异常订阅者不会中断 run）。
   - `onMessage`：assistant/tool 消息持久化。
9. **finally**：`#active` 中仍是本 controller 时才删除。

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

`cancel(sessionId)`：`#active` 有 controller → `abort()`、返回 true；无 → false（ws 层回 `no active run`）。abort 后循环在下一个检查点以 `run.completed {stopReason:"aborted"}` 终止（不是 run.failed），确认等待中的 abort 不算超时拒绝。ack（`run_cancel_ack`）在 abort 发出后立即返回，终态事件随后经总线到达。

### 自动命名（autoname.ts）

`scheduleAutoname({sessions, llm, model}, sessionId, firstText)`：

1. 前置：`meta.title === "新会话"` 才命名（已手动改名的不处理）。
2. 异步生成：`defaultTitle` 用 run 的同一个 llm 流式调用，system 为 `"你是标题生成助手，只输出一个不超过30字的会话标题。"`，user 为 `给这段对话起一个不超过30字的标题：
<firstText>`；拼接全部 `text_delta`。
3. 写回：`title.trim().slice(0, 30)`，空串放弃；**写回前重读 meta**——生成期间用户可能已手动改名，此时标题仍不是 `"新会话"` 则不再修改。
4. 失败静默（catch 空处理，保持默认标题）；不阻塞 run（`void scheduleAutoname(...)`，不 await）。

## 边界与出错

- **enqueue 的 promise 对 provider 错误不 reject**（`runAgent` 内部消化为 `run.failed` + `RunOutcome.stopReason:"error"`）；但存储层失败（如磁盘写入失败）会 reject——`ws.ts` 在 ack 之后把错误作为 error 帧发给发起消息的那条 socket。
- **cancel 只作用于活跃 run**：排队中的消息无法撤销（没有"从队列移除"命令），它会在前一个结束后照常执行。
- **确认裁决不落任何队列**：`broker.resolve` 对已 settle/过期条目返回 false 并回 `unknown confirmation`，不记录"迟到的意见"。
- **自动命名没有去重锁**：同一会话两次快速 enqueue 理论上可能并发两次命名，写回前的重读校验保证只有第一次生效（后到的发现标题已不是默认值即放弃）。
- **`resolveConfirmation` 测试缝优先于 broker**：设置了它 broker 就只剩登记职责——生产路径不设置。

## 关联

- [agent-loop](../core/agent-loop.md)：runAgent 状态机、确认的循环侧竞速、6 个 abort 检查点
- [permissions](../core/permissions.md)：ConfigPermissionGate 的判定链与 `conf_*` id 的签发
- [realtime](./realtime.md)：send_message/confirmation.resolve/run.cancel 的帧协议与 ack
- [memory](../core/memory.md)：search 的实现（SQLite FTS5）
