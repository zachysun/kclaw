# hooks — 钩子系统：把 run 的行为扩展点开成固定位置

## 职责

`packages/core/src/hooks/` 实现钩子系统：`types.ts`（位置网格与每位置的 ctx/result 契约）、`runner.ts`（`HookChain`，唯一执行路径）、`loader.ts`（用户钩子文件装载）、`registry.ts`（`HookRegistry`，daemon 级装载记录）、`builtin.ts`（引擎内置行为的钩子化形态）、`positions.ts`（位置的运行时清单）。

它回答的问题是"给 run 加一个行为，最少要动多少东西"。答案分两档：**引擎自己的行为**是一批注册在固定位置上的内置钩子（与用户钩子走同一条链、同一个文件契约，只是闭包了 run 资源、允许声明 fatal）；**外部新增行为**是一个放进 `~/.kclaw/hooks/` 的 js/ts 文件，下一轮 run 即生效，不重启 daemon、不改一行源码。循环本身（`agent/loop.ts`）只知道"位置"——它调用 `hooks.run("位置", 上下文)`，别的都不知情。

---

## 设计决策

- **位置网格是封闭枚举**：`HookPosition` 是 14 个命名位置的联合类型。位置只开在"真实存在改动需求的地方"——改写用户消息、改写模型视图、注入引导、压缩判定……没有改动需求的地方不开位置。加一个位置 = 更新 `HookContextMap`/`HookResultMap` 两张契约表，编译器会走查每一个消费方（封闭原则）。
- **注册接口是唯一挂载入口**：内置闭包、用户文件、测试注入，全部经 `HookChain.register` 进链。引擎不区分"自己人"和"外人"——它自己就是这套机制的第一批用户。
- **失败时怎么办由文件自己声明，默认放行**：用户文件可声明 `failure: "skip"`（默认，失败即跳过、只发一条 `hook.failed`，run 照常继续）或 `"deny"`（失败时否决所在闸门——`tool-before` 位置上就是该工具不执行，fail-closed 自选档）；声明 `"fatal"` 的用户文件拒绝装载（用户代码没有杀死整个 run 的权力）。引擎内置钩子在原行为抛错传播的地方保留 `fatal`（如用户消息持久化），语义与改成钩子形态之前完全一致。
- **改写权只开在四处**：`run-before`（用户消息）、`llm-before`（模型视图）、`system-before`（系统提示词追加段落）、`system-after`（系统提示词终稿）。其余位置是观察（返回值忽略）或内置独占的决策位（`compaction-check`/`overflow-rescue`：压缩判定闭包着压缩引擎，用户钩子不注册）。
- **权限与确认不进钩子链**：工具执行前的权限裁决保持循环的控制流（`tool-before` 位置观察 + deny 否决权，见上）。把"允许/拒绝/确认"做成可改写钩子等于把安全边界交给目录里的文件，收益配不上风险；`deny` 档给的是"钩子失败宁可不放行"的表达力，不是主动裁决权。
- **每个 run 重新扫描，文件即真相**：用户钩子目录在每次 run 开始时重扫（与技能同一套思路），改文件下一轮生效、不重启 daemon。装载失败按"文件名+mtime+错误"去重后发一次 `hook.failed {phase:"load"}` 事件——管理接口持续显示失败，事件流不被刷屏。
- **hook 名即文件名**：用户钩子的身份是文件基名，同名文件重复扫描整体替换（后扫的版本胜出）。

---

## 位置网格（14 个）

| 位置 | 时机 | ctx | 返回 | 语义 |
|------|------|-----|------|------|
| `run-before` | 用户消息 `message.created` 之后、持久化之前 | `{ message }` | `Message` | 改写用户消息（内置：记忆检索 + 持久化 + 自动命名） |
| `run-after` | `runAgent` 返回之后 | `{ outcome, model }` | 忽略 | 观察收尾（内置：用量记录、收尾压缩、跟随门禁） |
| `llm-before` | 每次模型调用前、provider 视图装配后 | `{ messages }` | `ProviderMessage[]` | 改写模型视图（内置：技能与 `@` 文件点名的合并包装） |
| `llm-after` | 一次模型调用完成后 | `{ usage, stopReason, latencyMs }` | 忽略 | 观察调用 |
| `llm-retry` | provider 层重试时（withRetry 回调） | `{ attempt, error }` | 忽略 | 重试可见性（内置：转 `llm.failed {willRetry:true}`） |
| `tool-before` | 工具执行前、权限裁决之前 | `{ toolCall }` | 忽略 | 观察 + 闸门：`failure:"deny"` 的钩子失败时该工具被拒绝（权限裁决本身保持引擎控制流） |
| `tool-after` | 单个工具执行完成后 | `{ toolCall, result }` | 忽略 | 观察结果 |
| `turn-boundary` | 迭代边界（工具批次后、下一轮调用前） | `{}` | `Message[]` | 注入消息（内置：引导缓冲 drain） |
| `compaction-check` | 迭代边界的中途压缩判定（内置独占） | `{}` | `ActiveSummary \| null` | 决策位：返回新视图 = 压缩生效 |
| `overflow-rescue` | 上下文超限急救（内置独占） | `{ error }` | `ActiveSummary \| null` | 决策位：返回新视图 = 换视图整次重发 |
| `compaction-after` | 一次压缩完成后 | `{ phase, result }` | 忽略 | 观察压缩结局（`result` 为 ok/failed/cancelled，如实转发；压缩没发生时静默） |
| `think-after` | 思考块完成后 | `{ block }` | 忽略 | 观察思考 |
| `system-before` | 系统提示词组装前 | `{ base }` | `string[]` | 追加段落（内置：认知 + 技能清单），**多钩子累积** |
| `system-after` | 系统提示词终稿（两段拼装之后、装配层冻结基线之前） | `{ system }` | `string` | 改写终稿（用户改写随后被装配层整体固化进 stable 基线并审计） |

用户钩子默认 order 1000——落在内置钩子（10–99）之后。system-after 上用户改写排在前面，装配层最后把终稿冻结为基线（见下），所以用户对系统提示词的改写永远在被审计的那份里。

**冻结基线（提示词缓存策略，双段独立）**：系统提示词分两段——**stable**（人设基座 + 注入约定，缓存冻结面）在前，**live**（认知 + 技能清单，低频变化面）在后。会话 meta 的 `systemBaseline`（见 [storage](./storage.md)）为两段各存一份基线 `{ text, frozenAt }`：每 run 两段现算、与基线逐段比对——哪段文本变了就重冻结哪段，没变的沿用基线（`frozenAt` 记录的是"这份文本成为基线的时刻"）。前缀缓存按从头逐字节相同匹配，live 变化只失效变化点之后，stable 前缀继续命中；装一个新技能、夜间认知刷新在下一个 run 即时生效，不再等压缩边界。`system-before` 链每 run 都执行（live 段由它现算，文本与基线逐字相等时不重冻结）；两段全命中时 `system-after` 链**整体不跑**（用户 system-after 钩子改写的段落同样冻结，文本未变则沿用基线）；至少一段变化时走 `system-after` 链，用户改写发生时终稿整体固化进 stable 基线——改写每 run 重新生效，审计恒记录模型实际看到的那份。基线由上一 run 的 `system` 审计事件按段固化，压缩清除后下一个 run 重新装配（见 [compaction](./compaction.md)）。

---

## HookChain 语义（runner.ts）

- **排序**：`meta.order` 升序，同序按名字稳定排序（改写链依赖确定性）。
- **真链式改写**：改写位置的返回值回填进 ctx 的改写字段（`run-before` 的 `message`、`llm-before` 的 `messages`、`system-after` 的 `system`），下一个 handler 看到的是改写后的值——这保证"用户改写在前、内置持久化在后"时，持久化落的是改写后的消息。调用方传入的 ctx 对象本身不被改动。
- **追加型位置**：`system-before` 的返回值是段落**数组**，多个钩子的段落累积拼接而不是互相覆盖。
- **失败分派**：抛错/超时按 `meta.failure` 分派——`fatal` 让整次 `run()` 拒绝（循环既有的各位置 catch 路径接管，错误码保持原样：`user_message_failed`、`steering_failed` 等）；`skip` 发 `hook.failed {phase:"run"}` 后继续下一个 handler；`deny` 同样发事件并继续跑完链（后面的观察者不丢），但经 `runGate` 出口把首个失败记为**否决**——`tool-before` 位置上循环据此给该工具写拒绝结果（错误结果 + `denied` note，工具不执行，run 继续）。
- **超时**：每个 handler 与 `config.hooks.timeoutMs`（默认 5000ms）同时计时，超时的一方算失败，走同样的 fatal/skip/deny 分派。条目可用 `meta.timeoutMs` 覆盖链预算（`Infinity` = 不限时）：五个内置压缩钩子（background-precompact / mid-run-panic / overflow-emergency / manual-compact-flush / post-run-compaction）声明了不限时——它们的函数体是两次 provider 调用，时长由 LLM 决定；时长上限由 provider 单请求超时与 run 中止信号保底。
- **空位置零开销**：没有注册任何 handler 的位置同步短路返回 `undefined`，`has()` 为 false（循环据此判断要不要走进某个分支，如 overflow-rescue）。

---

## 用户钩子文件契约

一个钩子是一个文件，放 `~/.kclaw/hooks/`（`paths.hooksDir`）：

```js
// ~/.kclaw/hooks/echo-every-tool.js
export const hook = {
  position: "tool-after",   // 必填：14 个位置之一
  description: "记录每个工具的产出",   // 可选
  enabled: true,            // 可选，默认 true
  order: 1000,              // 可选，默认 1000
  failure: "skip",          // 可选："skip"（默认，失败跳过）| "deny"（失败否决闸门，如工具不执行）；"fatal" 仅内置可用，写了拒绝装载
}
export default async (ctx) => {
  console.log(ctx.toolCall.name, ctx.result.status)
}
```

装载规则（`scanUserHooks`）：

- 扩展名 `.js` / `.mjs` / `.ts`（`.ts` 依赖 Node 24+ 的原生类型剥离；低版本 Node 会在 import 时得到明确报错）。其余扩展名忽略。
- 文件用绝对 URL 加 `?t=<mtimeMs>` 动态 import——同一路径改文件后必重新执行（编辑即生效）；不解析裸说明符依赖（第三方包不支持）。
- 损坏形态（语法错误、未知 position、缺 `hook` 导出或 default 函数、声明 `failure: "fatal"` 或非法 failure 值）成为**装载失败条目**，不会拖垮目录里其他文件，也不会弄崩 daemon。
- `enabled: false` 的文件照常载入元数据（管理接口可见）但不进执行链。

---

## 内置钩子（builtin.ts）

由引擎原本写死在循环与装配里的行为改造而来，行为零变化由既有测试保证。order 即执行次序：

| order | 名字 | 位置 | failure | 行为 |
|-------|------|------|---------|------|
| 10 | `memory-inject` | run-before | skip | 检索记忆库、收集相关经历 note（收集不落位） |
| 20 | `user-message-land` | run-before | fatal | 追加 job/记忆 note → `appendMessage` 持久化 → 逐块 `note.emitted` |
| 30 | `autoname` | run-before | skip | 新会话首条消息的后台自动命名 |
| 10 | `skill-wrap` | llm-before | skip | 技能与 `@` 文件点名的隐式包装（只改模型视图；run 装配把两份包装文本合并成一份 `llmUserText`） |
| 10 | `retry-notify` | llm-retry | skip | 把 provider 重试转成 `llm.failed {willRetry:true}` 事件 |
| 10 | `steering-drain` | turn-boundary | fatal | 取走队列的引导缓冲并注入对话 |
| 5 | `background-precompact` | compaction-check | skip | 预压区间的后台压缩派发（非阻塞，见 [compaction](./compaction.md) 机制四） |
| 10 | `mid-run-panic` | compaction-check | skip | 红线阈值触发的中途压缩判定（`null` = 不压）；先应用暂存的后台成果，遇正在执行的后台压缩先等 |
| 10 | `overflow-emergency` | overflow-rescue | skip | 超限急救压缩（换视图整次重发）；先掐掉正在执行的后台压缩 |
| 10 | `usage-ledger` | run-after | skip | 记录本次 run 的用量 |
| 15 | `manual-compact-flush` | run-after | skip | 冲刷运行忙时排队的 /compact（在自动收尾压缩之前） |
| 20 | `post-run-compaction` | run-after | skip | 上下文到达黄线时触发的收尾压缩（估算前等正在执行的后台压缩结束；压缩失败只记日志，不影响 run 收尾） |
| 30 | `follow-check` | run-after | skip | 排一个记忆空闲检查（调度器补查） |
| 10 | `system-materials` | system-before | skip | 收集 L2 认知与技能清单两个提示词段（即 live 段） |

两个值得知道的次序：run-before 上 `memory-inject(10)` 只收集记忆 note，`user-message-land(20)` 统一把 job note（在前）与记忆 note 追加进消息、持久化并广播——这与改成钩子形态之前的块顺序、`note.emitted` 次序完全一致。system-after 上用户改写（默认 1000）排在前面，随后装配层把终稿（用户改写或原稿）按段冻结进基线并写 `system` 审计事件——**系统提示词的审计留痕不是钩子**：`system` 事件的双段写入（stable/live）由 run 装配层直接写入事件流（写失败即 run 失败），因为分段冻结需要 stable/live 两段文本，而它们位于钩子链之上（见 [run-manager](../server/run-manager.md) 装配第 11 步）。

**子代理 run 的派生跳过**：会话 meta 带 `parentSessionId` 时，run 装配给内置钩子链带 `childRun: true`（同一个事实派生，无独立开关，见 [subagents](./subagents.md)），四个内置钩子直接让位——`memory-inject` 不检索不收集（子代理不注入记忆 note）、`autoname` 跳过（标题已带"子代理 · "前缀）、`follow-check` 不挂检查（子会话不进记忆的任何提取路径）、`system-materials` 返回空段（系统提示词整体换成精简的 `subagentSystemPrompt`，不带认知与技能清单）。`usage-ledger` 照常记账，但记到 `usageSessionId`（= 父会话 id）名下——子代理的 token 消耗归因到派它的主对话。

---

## 管理接口

`GET /hooks`（`packages/server/src/routes/hooks.ts`，Bearer 保护）返回 `{ builtin, user }`：`builtin` 是 14 条内置钩子定义（名字/位置/描述/failure，不依赖运行态，从 `BUILTIN_HOOK_SPECS` 单一真相投影而来）；`user` 是 `HookRegistry.list()` 的用户侧视图（健康、禁用、装载失败三类都在，失败条目 `position:"?"` 且带 `error` 原因）。CLI 与 WebUI 的钩子管理页共用这份只读快照。

---

## 与循环的关系

位置在循环里的确切触发时机、每次触发的事件序、fatal 失败对应哪个错误码，见 [agent-loop](./agent-loop.md)；压缩两个决策位的阈值规则见 [compaction](./compaction.md)；`hook.failed` 事件的 payload 见 [protocol](./protocol.md)。

## 关联

- [agent-loop](./agent-loop.md)：各位置在 run 时间线上的触发点与错误语义
- [skills](./skills.md)：同一套"放文件，下一轮生效"的思路（`skill-wrap` 钩子是其内置使用者）
- [run-manager](../server/run-manager.md)：装配把内置闭包、registry 快照与测试注入注册进同一条链
- [http-api](../server/http-api.md)：`GET /hooks` 的协议细节
- [storage](./storage.md)：`~/.kclaw/hooks/` 目录与 `config.hooks.timeoutMs`
