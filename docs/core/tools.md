# tools — 内置工具体系与注册

## 职责

`packages/core/src/tools/` 实现 15 个内置工具（12 个常驻 + 3 个按装配条件注册），并把它们装配成两份对齐的产物：`tools`（名字 → 执行器，供循环调用）与 `toolDefs`（JSON Schema 定义，传给模型）。工具只做"执行一个动作并返回结果"；参数解析时机、callId 配对、并发调度、权限检查都在循环层（见 [agent-loop](./agent-loop.md)）。

---

## 设计决策

- **统一执行接口**：内置工具、MCP 适配器（`mcp__<server>__<tool>`，见 [mcp](./mcp.md)）实现同一个 `ToolExecutor`——循环不区分工具来源。`risk` 与 `concurrency` 是声明性元数据：前者驱动权限检查（safe 的工具集可自动放行；sensitive 在只读模式被无条件拒绝），后者驱动同批调用的调度。权限引擎需要的其余待遇（路径归一、工作目录边界、读豁免、规则匹配取哪个参数）不要求工具声明——由引擎从 `risk` 加参数 schema 的字段名派生（见 [permissions](./permissions.md) 的待遇派生节）：写参数按惯例命名 `path`、命令参数命名 `command`，就自动被规则引擎识别。
- **注册表与定义同源**：`createBuiltinTools` 把执行器和 ToolDefinition 放在同一条 entries 列表里，`tools` 的键集合与 `toolDefs` 的名字集合天然一致（`registry.test.ts` 双向断言这一点），不会出现"模型可见但循环无法执行"的名字。
- **schema 面向模型，校验为手写实现**：parameters 字段是 JSON Schema（描述 JSON 参数结构的规范格式），随请求传给模型引导其生成参数；运行时不加载 schema 校验库，而是用 `shared.ts` 里的手写校验函数（`requireString` / `optInt` / `optStringArray`）逐个字段检查——失败抛 `ToolError`，由 `makeTool` 统一转成 `{status:"error"}` 结果，异常永远不逃出执行器。
- **fs 工具不做工作目录越界拦截**：路径只经 `path.resolve(workspace, p)` 解析，越界与否交给权限网关判定（越界会变成一次可由人批准的确认）——如果工具层先拒绝，人工批准后的调用仍会失败，确认就失去意义。
- **output 与 data 分离**：`output` 是面向模型的纯文本（进入下一轮请求的上下文）；`data` 是给前端渲染用的原始结构化数据（只持久化在块上，从不传给模型）。两者职责不同，避免"为渲染保留结构"污染模型上下文。
- **argsJson 原文保留**：工具调用参数的原始 JSON 字符串原样存在 `ToolCallBlock.argsJson` 上——即使解析失败，审计时仍能看到模型的原始输出。

---

## 接口

```ts
// packages/core/src/agent/tools.ts
export interface ToolExecutor {
  risk: "safe" | "sensitive"          // sensitive 默认需要人工确认
  concurrency: "parallel" | "serial"  // serial 在一批调用中最后逐个执行，不与任何工具重叠
  execute(args: unknown, ctx: {
    signal?: AbortSignal
    onOutput(delta: string): void     // 执行中流式回传部分输出
  }): Promise<{ status: "ok" | "error"; output: string; data?: unknown }>
}

// packages/core/src/tools/index.ts
export function createBuiltinTools(opts: {
  workspace: string
  memoryCtx: { system: MemorySystem; sessionId: string; workdir: string; immediateEnabled: boolean }
  // 记忆系统 v2 门面 + 当前会话上下文；immediateEnabled 决定 memory_save 是否当场触发写入
  tavilyApiKey: string
  exec?: Partial<{ timeoutMs: number; maxOutputBytes: number; sandbox: ExecSandboxSpawn; spillDir: string }>
  // sandbox = exec 沙箱包装器：run 装配仅在沙箱可用时传入（见 sandbox.md），
  // exec 工具本身不探测平台；缺省 = 裸跑，即沙箱功能不存在前的行为
  // spillDir = <home>/spill：截断时全量输出写入磁盘 + 模型视图附 fs_read 定位行（见 tools/spill.ts）
  web?: Partial<{ timeoutMs: number; allowPrivateNetworks: boolean; spillDir: string }>
  sessionSearch?: SessionSearchFn    // session_search 的检索后端（server 每 run 注入）；缺席时工具仍注册、返回"(无可检索内容)"
  skills?: SkillRecord[]             // 技能目录扫描结果：skill_read 按名加载正文（见 skills.md）
  subagent?: { spawner: SubagentSpawner; parentSessionId: string; collector?: SubagentCollector }
  // 子代理派发后端（server 侧 spawner，见 subagents.md）；缺席时 subagent_run 不注册；
  // collector 随行时追加 subagent_collect（后台子代理的答复按需取回，issue #22）
  ask?: { broker: ConfirmationBroker; timeoutMs?: number; emit: QuestionEventEmitter }
  // 运行中提问（issue #21）：broker 与确认共用同一个网关对象；缺席时 ask_user_questions 不注册。
  // run 装配对每个 run 都注入——主线与子代理一样（子代理的转发卡沿确认先例）
  childRun?: boolean                 // 本 run 自身是子代理（meta.parentSessionId 派生）：裁掉 memory_save 与 subagent_run
  fetchImpl?: typeof fetch
}): { tools: Map<string, ToolExecutor>; toolDefs: ToolDefinition[] }

// packages/core/src/tools/shared.ts
export class ToolError extends Error {}
export function makeTool<N extends string>(
  name: N, risk: "safe" | "sensitive", concurrency: "parallel" | "serial",
  fn: (args: unknown) => ToolResult | Promise<ToolResult>,
): ToolExecutor & { name: N }
```

`makeTool` 包装行为：`fn` 抛出的 `ToolError` → `{status:"error", output: "<name>: <message>"}`；其它异常同样转为 error 结果（消息不附加 ToolError 前缀，统一带工具名）。

---

## 15 个内置工具

| 名称 | 职责 | risk / concurrency |
|------|------|--------------------|
| `exec` | 在工作目录执行 shell 命令 | sensitive / serial |
| `fs_read` | 读工作目录内 UTF-8 文本文件（≤1 MiB） | safe / parallel |
| `fs_list` | 列目录 | safe / parallel |
| `fs_write` | 新建/覆写文件（自动建父目录） | sensitive / serial |
| `fs_edit` | 字面替换文件中恰好一处文本 | sensitive / serial |
| `web_search` | Tavily 搜索 | safe / parallel |
| `web_fetch` | 抓取网页正文 | safe / parallel |
| `memory_save` | 写入长期记忆 | safe / parallel |
| `memory_search` | 全文检索记忆 | safe / parallel |
| `session_search` | 全文检索当前会话已压缩的早期对话 | safe / parallel |
| `skill_read` | 按名字加载一个技能（skill）的完整规程正文 | safe / parallel |
| `skill_list` | 列出模型可见的技能（名字 + 描述），可选关键词过滤——系统提示词清单可能被截断、子代理没有清单，用来自助发现 | safe / parallel |
| `subagent_run` | 派出一个子代理独立执行一段自包含任务（可后台），结题答复即工具结果 | safe / parallel |
| `subagent_collect` | 按子会话 id 取回后台子代理的完整结题答复 | safe / parallel |
| `ask_user_questions` | 向用户提出 1–5 个需要当场拍板的问题，回答即工具结果 | safe / parallel |

前 12 个**常驻注册**（注册与否不随会话状态变化；可见性例外有两个——readonly 模式把 risk 为 sensitive 的工具整个移出该 run 的模型工具面，见 [permissions](./permissions.md)；子代理 run 会裁掉 `memory_save`，见 [subagents](./subagents.md)）；`subagent_run`/`subagent_collect` 仅在 daemon 装配了子代理派发后端时注册（子代理自己的 run 两者都不注册——单层委派、不能再派孙代理），`ask_user_questions` 每个 run 都注册（见下文各自的"注册是条件性的"说明）。

### exec（`tools/exec.ts`）

`spawn(command, {shell: true, cwd: workspace, detached: POSIX 下为 true})`——cwd 固定在工作目录；`detached` 让子进程成为进程组（一组一起调度/发信号的进程）组长。关键约束：

- **沙箱注入**：构造参数可选带 `sandbox`（`ExecSandboxSpawn`，一个 `spawn(command, {cwd}) → ChildProcess`）。注入时命令改经沙箱包装器运行（其内部负责再经 `/bin/sh -c` 与进程组语义，见 [sandbox](./sandbox.md)）；缺省裸跑即沙箱功能不存在前的行为。run 装配只在沙箱可用时注入，与权限引擎的 `sandboxedTools` 同源。

- **超时**：默认 `timeoutMs = 60_000`（`config.yaml` 的 `exec.timeoutMs` 同为 60s 默认值）。超时先 `process.kill(-pid, "SIGKILL")` 终止整个进程组（连带 shell 的子进程，如 `sleep`；Windows 无进程组，退回只终止直接子进程），然后返回 `{status:"error", output: "command timed out after 60000ms\n<部分输出>"}`——已产生的输出仍然返回。
- **输出截断**：流式累计到 `maxOutputBytes`（默认 100 KiB，即 `100 * 1024`）即停止积累——头部保留，之后的 chunk 只计字节数不再转发；到达上限那一刻发一条截断提示 delta（`...[output truncated, further output dropped]...`），结束时在尾部附 `...[dropped N bytes]...` 字节数标记。`truncateMiddle` 只对头部超出上限 ≤1 chunk 的部分微裁剪（插 `\n...[truncated N bytes]...\n` 标记）。按 UTF-8 字节计数，多字节字符在切点被拆开会解码成 U+FFFD 替换字符，属可接受损失。
- **输出溢出存盘（spill）**：run 装配传入 `spillDir`（`<home>/spill`）后，流式读取把全量输出另存一份（上限 `SPILL_MAX_BYTES = 10 MiB`，超出即停、存盘副本标注"仅保留前 10MB"）；发生截断时模型视图在 `dropped` 标记后追加一行 `[完整输出已存盘: <路径>；需要更多内容时用 fs_read 读取该文件]`——spill 目录在权限引擎 readRoots 内，`fs_read` 无需确认即可读。存盘尽力而为：写失败静默退化为纯截断；未传 `spillDir`（如部分测试）则行为与无 spill 时完全一致。
- **退出码**：0 → ok；非 0 → error，输出带 `exit code N` 首行；stdout 与 stderr 合并，到达即经 `ctx.onOutput` 流式回传。
- 空/非字符串 `command` 直接返回 error（`args.command must be a non-empty string`）。

### fs 工具（`tools/fs.ts`）

统一边界：`sandboxed(p) = path.resolve(workspace, p)`，无越界拒绝（见设计决策）。

- **fs_read**：先 `statSync`——目录报 `not a file`，超过 `maxReadBytes`（默认 1 MiB，`1024 * 1024`）报 `file too large: <p> is <size> bytes (max 1048576)`；然后整体以 UTF-8 读出。
- **fs_list**：子目录带尾部 `/`；文件显示字节数（对符号链接 stat 目标，指向目录的也按目录列出；stat 失败标 `broken symlink`）；空目录输出 `(empty directory)`。
- **fs_write**：`content` 允许空串；`mkdirSync(recursive)` 补齐父目录；成功输出 `wrote <N> bytes to <解析后绝对路径>`。
- **fs_edit**：`old` 必须在文件中**恰好出现一次**（0 次或多次都报错并给出实际次数）；替换是纯字面匹配（非正则），写回用函数式 replacer（`content.replace(old, () => new)`）——字符串 replacer 会解释 `$&`、`$1` 等 $ 模式，导致文件内容被意外改写。**拒绝二进制编辑**：解码后含 U+FFFD 替换字符或 NUL 字节的文件直接报 `fs_edit only supports text files (binary content detected)`——把二进制内容按文本写回会以乱码覆盖原始字节。

### web 工具（tools/web.ts）

两个工具的每次请求都带 `AbortSignal.timeout(timeoutMs)`（默认 20 秒，`config.yaml` 的 `web.timeoutMs`）——卡死的远端主机不能拖住一个 run。

- **web_search**：POST `https://api.tavily.com/search`，体为 `{api_key, query, max_results}`；`maxResults` 默认 5、钳制在 [1, 10]。目标是固定的公网 Tavily 域名，**不走私网检查**。`output` 是给模型的 markdown 列表（`- [title](url)：content`），无结果输出 `(no results)`；`data` 携带原始三元组 `{results: [{title, url, content}]}` 供渲染。
- **web_fetch**：只接受 http(s) URL。内置一层 SSRF（Server-Side Request Forgery，服务端请求伪造——诱导服务器自己去访问内网地址的攻击）防护：不使用 fetch 的自动跟随重定向，而是手工循环（至多 `DEFAULT_MAX_REDIRECTS = 5` 跳），每一跳的目标——初始 URL 与每个 `Location`——都在真正请求前经 DNS 解析（字面 IP 直接判定）并按拒绝名单核查：loopback/未指定/链路本地/私网地址（127/8、0.0.0.0、::1、`::ffff:` 映射、10/8、172.16–31、192.168/16、169.254/16、fc00::/7、fe80::/10）一律拒绝，除非 config 里 `web.allowPrivateNetworks: true` 显式豁免（如允许抓本机 Ollama 端点）。非 2xx 报 `HTTP <status> <statusText> for <url>`。HTML 经 linkedom 解析 + Readability（Mozilla 的正文提取库）取文章正文，失败回退为移除 `script/style/noscript/template/svg` 后的 body 文本（对原始 HTML 重新解析，避免污染），仍为空则 `(no extractable text content)`；非 HTML 内容按纯文本返回。响应体经流式读取、**越过 `maxFetchBytes`（默认 512 KiB）即 cancel 连接**——上限施加于 DOM 解析之前，超大页面无法借解析阶段膨胀内存；截断附 `...[truncated, dropped N bytes]...` 标记。装配了 `spillDir` 时读取上限放宽到 10 MiB（spill 天花板），被截掉的原始正文存盘，字节数标记保留、fs_read 定位行追加其后（与 exec 同一输出形状；spill 写失败时定位行为空，只剩字节数标记）。

### memory 工具（`tools/memory.ts`）

是 `MemorySystem` 门面的薄封装（主题线 markdown 为准、FTS5 + 向量为派生索引，见 [memory](./memory.md)）。

- **memory_save** `{text}`：text 是"要记内容的提示"（旧版的 `tags` 已删，多余字段忽略）；当场触发 `system.triggerImmediate` 处理当前这轮对话——真有提取批次（该会话自上次提取位置起有未处理的新消息）时输出 `已触发记忆写入（处理当前这轮对话）`，没有增量时如实输出 `该轮没有需要沉淀的新内容`（不谎报写入，记忆重复写入事故的教训）；`memory.write.immediate=false` 时返回 `立即写入已关闭（memory.write.immediate=false），该内容将在后台定时/跟随触发时沉淀`——此时不写入，内容留给后台触发时处理。
- **memory_search** `{query, limit?}`：`system.searchAll` 跨**全部**项目库 + 全局库的混合检索（关键词 + 向量，打分见 [memory](./memory.md)），`limit` 默认 5、最大 20；每个命中一行 `- [经历|认知] [scope] 正文`（scope 如 `project:<id>` / `global`），无命中输出 `（没有相关记忆）`。

两个工具 safe + parallel：只访问记忆目录与索引，不修改工作目录本身（"parallel" 只表示调度器不强制排序）。

### session 工具（`tools/session.ts`）

**session_search** `{query, limit?}`：检索**当前会话**已压缩段的内容（`limit` 默认 5、最大 20；检索机制见 [compaction](./compaction.md)——每次调用现读会话事件流，按压缩段的 `upto` 取增量段区间做朴素文本匹配）。每个命中输出两行——`- <段摘要>` 加缩进的匹配位置文本片段；会话没有压缩段（或 server 未注入检索后端）时输出 `(无可检索内容)`。safe + parallel，与 memory 工具同类：只读访问会话目录下的事件流。

工具**始终注册**（工具列表不随会话状态变化）：`createSessionTools(search?)` 的 search 参数缺席时工具仍在，只是查询一律返回"(无可检索内容)"——模型看到的工具集合稳定，不会因会话有没有压缩历史而变。

### skill 工具（`tools/skills.ts`）

**skill_read** `{name}`：按名字加载一个技能（skill）的完整规程正文（`SKILL.md` 的 Markdown 正文，机制与字段见 [skills](./skills.md)）。safe + parallel——只读 daemon 每次 run 扫描过的技能目录，不碰工作目录本身；同名技能的项目级副本胜出（与 `scanSkillDirs` 的覆盖规则一致）。技能不在已扫描集合时报 `没有叫 <name> 的技能（可用 skill_list 列出已装技能，或 /skill 查看）`；正文为空报错不加载。

**skill_list** `{query?}`：列出模型可见的技能（每行 `- 名字: 描述`，按名字排序），`query` 可选——按名字与描述子串过滤（大小写不敏感）。可见口径与系统提示词清单一致（`disable-model-invocation` 的不出现）。存在的原因：提示词清单有字符预算、技能多时截断，子代理更是不注入清单——`skill_list` 是模型的自助发现入口（先 list 找到名字，再 skill_read 取正文）。safe + parallel，与 skill_read 同源同一份扫描结果。

工具描述里带一句软性指引：优先用系统提示词"可用技能"列表里的技能，不在列表中的（`disable-model-invocation`）只有用户明确点名时才应加载——可见性规则骑在描述上、不是硬门禁，用户点名是隐藏档位的合法入口。

### 与 skill 机制的衔接

skill_read 的输入是 `createBuiltinTools` 的 `skills` 选项——server 每 run 重新扫描技能目录后传入同一份结果（渐进披露第二层），系统提示词里的技能清单用同一份扫描结果（第一层）。点名包装等其余机制见 [skills](./skills.md)。

### subagent 工具（`tools/subagent.ts`）

**subagent_run** `{task, label?, run_in_background?}`：派一个子代理执行一段自包含任务，默认阻塞等待其结题答复作为工具结果（完整机制、生命周期与结果整形见 [subagents](./subagents.md)）。执行器是薄壳——校验 `task` 非空字符串、`label` 与 `run_in_background` 为相应类型后调一次 spawner，会话创建/run 提交/状态转发都在 server 侧实现。`run_in_background: true` 时派发立即返回子会话 id（不阻塞父 run，生命周期挂到父**会话**而不是父 run——父 run 结束或中止不会取消它），子代理完成后父会话收到一条完成通知消息，届时用 `subagent_collect` 取完整答复。`risk: "safe"`：派出动作本身不碰敏感资源，子 run 自己的工具调用照常过自己的权限门；`concurrency: "parallel"`：一批多个 `subagent_run` 并发执行即并行路径。子代理的 `childSessionId` 经结果的 `data` 字段随块持久化（web 的"查看子代理审计"链接读它）。

**subagent_collect** `{childSessionId}`：按子会话 id 取回后台子代理的最终结题答复（头尾截断，与阻塞结果同一形状）。只能取**本会话**派出的子代理——collector 校验 `parentSessionId` 归属，别人的子代理与未知 id 都是 error 结果。`risk: "safe"`、`concurrency: "parallel"`。

注册是**条件性**的（与 session/skill 工具的"始终注册"不同）：`subagent` 选项缺席（daemon 未装配 spawner）或本 run 自身是子代理（单层委派）时不注册 `subagent_run` 与 `subagent_collect`；子代理的工具面同时裁掉 `memory_save`（记忆隔离）。

### ask 工具（`tools/ask.ts`）

**ask_user_questions** `{questions: [{text, options?, multiSelect?}]}`：向用户提出 1–5 个需要当场拍板的问题（选项单选/多选或自由文本），等待用户回答后把答案文本作为工具结果返回（每个问题一行 `N. <问题>\n   → <回答>`；选项题按选项文案拼接、自由题按输入文本，未回答显示"（未回答）"；应答按问题序对齐，缺位补空、越位丢弃）。描述里带一条软性指引：只在关键分叉点用——信息缺失会导致方案走偏、或不可逆操作前必须用户拍板时；能从上下文或文件里推断的信息不要问。等待走与人工确认**同一个**三方竞速（`racePending`，`permissions/broker.ts`）：人工回答 / `sessions.askTimeoutMs` 超时（默认 10 分钟）/ run 中止，谁先到算谁——超时是合法结局（返回 `ok`，附"用户未在限时内回答，不要重复调用，基于合理假设继续"的说明，模型必须学会处理空回答），中止不是（错误结果、不发 `question.resolved`，与确认流的规则一致）。`risk: "safe"`：提问本身不碰敏感资源；`concurrency: "parallel"`。

---

## callId 配对生命周期

工具调用与结果靠 `callId`（provider 给的调用 id，如 OpenAI 的 `tool_calls[].id`）配对，全程四个节点（块定义在 `packages/core/src/protocol/blocks.ts`）：

1. **创建**：流中 `tool_call_started` 帧到达 → 循环建 `ToolCallBlock {callId, name, args: undefined, argsJson: ""}`；`argsJson` 随 `tool_call_delta` 逐段拼接——**流未结束时参数不完整**，因此解析必须等待流结束。
2. **定稿**：流结束后 `JSON.parse(argsJson || "{}")`（无参数流的调用按空对象处理）；解析失败 → 该调用得到 error result（`invalid tool args json`），**永不执行**，但原文块照常持久化。provider 请求回传时用的也是 `argsJson` 原文（`function.arguments`），不重新序列化。
3. **配对**：执行产出 `ToolResultBlock {callId, status, output, data?, durationMs}`，与调用块的 `callId` 一一对应。
4. **不变量**：历史中每个 assistant 的 `tool_call` 块之后必须存在同 `callId` 的 `tool_result`——OpenAI 兼容 API 对无配对调用的下一轮请求回 400。流中途中断（abort/错误）时循环为悬空调用合成 error result；组装 provider 视图时（`packages/core/src/agent/context.ts` 的 `toProviderMessages`）无配对的 `tool_call` 与孤儿 tool 消息都会被剔除。

---

## output 与 data 的分流

- **进模型上下文的只有 `output`**：`toProviderMessages` 把 `tool_result` 转成 `{role:"tool", toolCallId, content: output}`（error 结果加 `[error] ` 前缀）；`data` 字段在这个转换里不存在。
- **`data` 只随块持久化、仅供渲染**：循环在结果完成时 `block.data = res.data`（`packages/core/src/agent/loop.ts`），JSONL 会话日志与事件流携带它，前端（如 web_search 的结果卡片）按结构渲染。这使模型上下文保持纯文本、可控大小，渲染信息又不丢失。

---

## 边界与出错

- **执行器永不抛异常**：`makeTool` 把一切异常转为 `{status:"error"}`；循环对执行器抛异常（Promise 拒绝）也统一转为 error result（保证异常也产出结果）。
- **参数校验失败/未知工具名**：在权限检查**之前**就被拦截为 error result，不会进权限判定，也不会执行。
- **fs_read/fs_list 仅支持 UTF-8 文本**：二进制文件的读取结果为替换字符，判断交给上层（fs_edit 有显式二进制拦截）。
- **网络工具的失败即结果**：web_search/web_fetch 的网络错误、非 2xx、JSON 解析失败都是 error result 文本，模型可以看到并决定下一步；不带自动重试。
- **exec 与 web 的限制都可配**：daemon 从 `config.yaml` 传入 `exec.timeoutMs` / `exec.maxOutputBytes` 与 `web.timeoutMs` / `web.allowPrivateNetworks`（run 装配 core `executeRun` 传入），两处默认值与工具内默认一致（60s / 100 KiB；20s / false）。
- **私网目标默认拒绝**：web_fetch 的 SSRF 防护意味着默认抓不到 `http://127.0.0.1:*` 这类本机服务；需要时在 config 显式 `web.allowPrivateNetworks: true`——这是有意的双门设计，不是缺陷。

---

## 关联

- [agent-loop](./agent-loop.md)：调用时机、并发调度与 callId 配对的执行侧
- [permissions](./permissions.md)：`risk` 如何变成 allow/confirm 判定
- [provider](./provider.md)：`ToolDefinition` 如何进入请求体
- [memory](./memory.md)：memory 工具背后的存储与检索
- [compaction](./compaction.md)：session_search 检索的索引来源（压缩段）与工具输出省略
- [skills](./skills.md)：skill_read 背后的技能包机制（渐进披露、双作用域、点名包装）
- [subagents](./subagents.md)：subagent_run / subagent_collect 背后的子会话生命周期、并发上限、后台模式与结果整形
- [permissions](./permissions.md)：ask_user_questions 与人工确认共用的三方竞速网关（`racePending`）
- [mcp](./mcp.md)：同一 ToolExecutor 契约的另一种工具来源
