# storage — 路径、配置与会话持久化

## 职责

`packages/core/src/storage/` 是所有持久化（把数据写入磁盘长期保存）的基础：`paths.ts` 解析 kclaw 的根目录与目录树（`KCLAW_HOME` 环境变量可整体重定向）；`config.ts` 读写 `config.json`（用户配置与默认值深合并）；`jsonl.ts` 提供 JSONL 文件（一行一个 JSON 对象的文本格式）的追加、读取与崩溃修复，是会话事件流 `events.jsonl`（唯一权威数据）与运行态队列 `queue.jsonl` 的底层。会话目录结构与 `meta.json` 由 `SessionStore`（`packages/core/src/session/store.ts`）负责；`daemon.json` 和 `token` 两个文件由 server 侧产生，本文一并说明用途。

---

## 设计决策

- **单一根目录容纳全部状态。** 配置、会话、记忆、任务、附件、日志全在同一个根目录下，根目录可以整体重定向——解析顺序是：显式参数 > `KCLAW_HOME` 环境变量 > `~/.kclaw`。环境变量的空白字符串视为未设置：用 `??` 判断时，空串会被当成有效值，导致所有路径变成相对当前目录而不是回退到 `~/.kclaw`；这条规则来自一次实际故障的修正（`envHome()`）。
- **只建目录，不建文件。** `resolvePaths` 用 `mkdirSync(recursive)` 创建目录树，但 `config.json`、`jobs.db` 等文件只是路径字符串，不在这里创建——文件由各自的所有者在首次写入时产生（`SessionStore`/`MemorySystem`/`JobScheduler` 的构造函数建目录并初始化自己的数据库）。
- **配置深合并，默认值永不被污染。** `loadConfig` 把文件内容深合并到默认值上，且两个分支都从 `structuredClone(defaultConfig)` 开始——否则返回值会与导出的 `defaultConfig` 共享嵌套引用，调用方任意一处 `cfg.permissions.allow.push()` 都会改掉进程级的默认值。合并规则（`deepMerge`）：普通对象按键递归合并，数组与标量整体替换，`undefined` 跳过，两个输入都不被修改。
- **配置无效时报错，而不是静默回退。** `config.json` 解析失败直接抛错（`invalid json in <path>: ...`），文件内容不是对象映射也抛错。不做静默回退——悄悄改用默认值意味着用户配置的权限规则在无提示的情况下失效，比启动失败更危险。文件缺失或内容为空则返回默认值，这是首次使用的正常路径。
- **`config.json` 是唯一配置文件。** 读取只认 `config.json`；写入（CLI wizard、WebUI 保存）也只落 `config.json`，权限 0600（含明文 API key）。
- **会话事件流只追加，且兼容崩溃。** 事件只追加、从不改写历史行（运行态队列 `queue.jsonl` 是例外——整文件重写，见下文）。崩溃可能留下的残缺是「最后一行只写了一半」（torn line，断尾行）：读取时丢弃断尾行（崩溃产物，最多丢一条事件）；写新行之前先修复断尾，否则新行会拼接在半行后面，读取时两条会一起被丢弃。

---

## 目录树（`KclawPaths`）

```ts
// packages/core/src/storage/paths.ts
export function resolvePaths(home?: string): KclawPaths
```

| 路径 | 用途 | 写入方 |
|------|------|--------|
| `<home>/config.json` | 全部配置（见下节） | CLI wizard 与 WebUI Model 页的 provider 管理路由（均经 `saveConfig`）；用户手写 |
| `<home>/permissions.yaml` | 全局权限规则——在人工确认里选「总是允许」后保存下来的收紧 allow 规则；项目档在工作区 `.kclaw/permissions.yaml`（见下文「保存的权限规则」一节） | run 组装的 `resolveConfirmation`（`packages/core/src/agent/run-assembly.ts`，global 裁决时写入）；用户手写亦可 |
| `<home>/mcp.json` | 全局层的 MCP server 配置（WebUI 的 MCP 页增删改落在这里）；项目层在工作区 `.kclaw/mcp.json`（见 [mcp](./mcp.md) 与下文「项目层 mcp.json」一节） | daemon 的 McpManager persist（global 归拢写）；用户手写亦可 |
| `<home>/AGENTS.md` | agent 人格设定，非空则作为系统提示的一部分（stable 段基座）；每次运行拼装的完整系统提示以 `system` 事件按 stable/live 两段全量记录 | 用户手写；daemon 启动时读 |
| `<home>/memory/global/` | L2 全局认知（persona.md、wiki/、rule/ 的 markdown，以文件为准） | MemorySystem / 用户手写 |
| `<home>/memory/projects/<id>/` | L1 项目情节（`<topic>.md` 主题线、workdir.txt、MEMORY.md、state.json、vectors.db） | MemorySystem / 用户手写 |
| `<home>/skills/` | 全局技能目录（每个子目录是一个技能，含 `SKILL.md`；软链接穿透加载；`.links.json` 旁挂文件记录复用链接与自定义检测目录；项目级技能在工作区 `.kclaw/skills/`，见 [skills](./skills.md)） | 用户手写或经技能页复用写入；每个 run 重新扫描读取 |
| `<home>/hooks/` | 用户 hook 目录（每个文件是一个 hook，`export const hook` + default 函数；见 [hooks](./hooks.md)） | 用户手写；每个 run 重新扫描读取 |
| `<home>/sessions/<id>/` | 每会话一个目录（events.jsonl + meta.json + queue.jsonl，分工见下节） | SessionStore（events.jsonl 是唯一权威数据、meta.json 是派生摘要、queue.jsonl 是运行态、整文件重写） |
| `<home>/jobs.db` | 定时任务表 | JobScheduler |
| `<home>/usage.db` | 每次 LLM 运行的 token 用量记录 | UsageStore |
| `<home>/attachments/<id>/` | 附件外存目录（每会话一个子目录） | server 上传路由 `routes/attachments.ts`；运行时只读挂载 |
| `<home>/spill/` | 工具输出溢出目录：exec / web_fetch 截断输出时，把捕获到的全量输出写到这里，给模型的截断视图附带 fs_read 定位行 | core `tools/spill.ts`（单文件上限 10 MiB，超出部分不保留）；目录在权限引擎 readRoots 内，`fs_read` 可直接读 |
| `<home>/logs/` | 日志目录 | 预留：目录会创建，当前代码没有写入方 |
| `<home>/daemon.json` | daemon 存活标识（server 侧） | `launchDaemon` |
| `<home>/token` | daemon 鉴权 token（server 侧） | `loadOrCreateToken` |

补充三点：`logs` 目录在当前源码中只有路径创建、没有写入方，如实记为预留。`attachments` 由上传路由写入，由权限引擎的 readRoots 与附件挂载读取，见 [run-manager](../server/run-manager.md)。`spill` 是尽力而为的写入：写入失败时静默退化为纯截断输出；溢出文件是普通文件，可随时手动清理（目前没有自动过期清理）。

---

## config.json 全量字段

`KclawConfig`（`packages/core/src/storage/config.ts`）与 `defaultConfig` 默认值：

| 字段 | 默认值 | 含义与使用方 |
|------|--------|--------------|
| `providers.default` | `""` | 默认 provider 名，指向 entries 里的一条 |
| `providers.entries` | `{}` | `Record<名, { format?, baseUrl, apiKey, model, contextWindow?, maxOutput? }>`。一个条目是一个可直连的端点加它服务的那个模型：`format` 选 API 协议（`openai` = OpenAI 兼容 chat-completions，默认；`anthropic` = Anthropic Messages，见 [provider](./provider.md)），`baseUrl` 是端点根、`apiKey` 为空表示端点免鉴权（不发鉴权头）、`model` 是请求里下发的模型 id。daemon 启动时解析默认条目（config 优先，`KCLAW_LLM_BASE_URL` / `KCLAW_LLM_API_KEY` / `KCLAW_LLM_MODEL` 环境变量补空）。`contextWindow` 参与压缩 budget 的 min 解析、`maxOutput` 随请求下发 max_tokens（见 [compaction](./compaction.md)） |
| `providers.timeoutMs` | `120000` | 单次 LLM 请求超时（`DEFAULT_LLM_TIMEOUT_MS`） |
| `permissions.allow` / `deny` | `[]` / `["exec:sudo*", "exec:rm -rf*"]` | 权限规则，见 [permissions](./permissions.md) |
| `permissions.confirmTimeoutMs` | `120000` | 人工确认的等待上限，超时按拒绝处理 |
| `permissions.sessionGrants` | `true` | 会话内「仅本次允许」的记忆是否生效（run 级，见 [permissions](./permissions.md) 第 11 节） |
| `permissions.autoLearnThreshold` | `3` | auto 模式的归纳阈值：同一操作被连续 `once` 批准多少次后，自动保存为项目档规则；`0` 关闭归纳（auto 模式的判定链保留） |
| `permissions.defaultMode` | `"default"` | 新会话的初始权限模式。daemon 创建的新会话（HTTP `POST /sessions` 与定时任务调度建会话）在创建时固化为 `meta.mode`；改这个值只影响之后新建的会话。非法值回退到 `"default"` 并告警 |
| `memory.write.{immediate, manual, intervalMinutes, idleMinutes}` | `true` / `true` / `30` / `10` | 记忆写入的触发开关（五个触发器：immediate/manual/clear/interval/follow；clear 挂在 `POST /sessions` 上，无独立开关）：immediate = `memory_save` 工具当场触发；manual = 手动触发开关（`/memory save`（CLI/web）走 `POST /memory/trigger-manual`，为 `false` 时该路由返回 400）；intervalMinutes = 定时保底间隔（0 关闭）；idleMinutes = 跟随触发的空闲分钟数（0 关闭）。完整语义见 [memory](./memory.md) |
| `memory.extractModel` / `threadInactiveDays` / `consolidate` / `consolidateHour` | `""` / `14` / `true` / `3` | 提取/沉淀用的模型（空则回退到主对话模型）、主题线闲置多少天自动转 inactive、沉淀开关、夜间闲时沉淀的本地小时（负值关闭） |
| `memory.embedding.{provider, model}` | `""` / `""` | 向量检索：`model` 为空则向量这条路整体关闭（只用 BM25 关键词检索）；provider 为空回退到 default 条目 |
| `memory.injectTokenBudget` | `1000` | 每轮 L2 认知常驻注入的 token 上限（只约束常驻注入；L1 情节前 5 条全量注入不受此限） |
| `web.tavilyApiKey` | `""` | web_search 工具的 Tavily 密钥 |
| `web.timeoutMs` | `20000` | 每次网络抓取（搜索与网页）的 AbortSignal 超时，卡死的主机不能拖住一个 run |
| `web.allowPrivateNetworks` | `false` | 设为 `true` 时豁免 web_fetch 对私网/回环目标的拒绝（SSRF 防护，例如允许抓取本机 Ollama 端点），由 run 组装传入工具 |
| `usage.prices` | `{}` | 模型 → `{inputPerM?, outputPerM?}`：每百万 token 的美元单价，用量记录算成本用；没有价格条目的模型成本按 0 计 |
| `exec.timeoutMs` / `maxOutputBytes` | `60000` / `102400`（100 KiB） | exec 工具的超时与输出截断上限 |
| `sandbox.enabled` / `writeRoots` / `network` | `true` / `[]` / `"allow"` | exec 沙箱的整体开关、追加写白名单（realpath 形态）与沙箱内网络开关（deny 时 exec 子进程断网，web 工具不受影响），见 [sandbox](./sandbox.md) |
| `sessions.recycleBinTtlMs` | `2592000000`（30 天） | 回收站保留期，scheduler tick 周期清理用（见 [jobs](./jobs.md)） |
| `sessions.contextTokens` / `compactPackRatio` / `compactAheadRatio` / `compactAtRatio` / `compactPanicRatio` / `compactTargetRatio` / `toolResultKeep` | `128000` / `0.70` / `0.75` / `0.80` / `0.90` / `0.33` / `8` | 上下文压缩（见 [compaction](./compaction.md)）：token budget、省略线（发送时工具输出省略的 budget 比例）、预压线（估算发送量达 budget × 0.75 且未过红线时在迭代边界派后台压缩）、黄线（估算发送量达 budget × 0.80 即触发收尾压缩）、红线（运行中占用达 budget × 0.90 时在迭代边界触发中途压缩）、压缩后保留部分的目标比例（ budget × 0.33）、发送时保留原文的最近工具结果条数。七个字段均可选：默认值、加载校验与" budget × 比例 → 绝对 token 阈值"的解析集中在压缩阈值线模块 `session/waterlines.ts`——触发四线（预压/黄/红/目标）越出 (0,1] 或次序不满足"目标 < 预压 < 黄 < 红"整组回退到默认并告警，省略线单独校验、独立回退到默认；每次 run 由 `resolveWaterlines` 解析出绝对阈值供触发 hook 与压缩引擎使用（`contextTokens` 的读取在 `resolveContextTokens`） |
| `sessions.toolLoopMaxRepeats` | `5` | 工具死循环守卫：同一工具调用（同名同参数）连续执行达 N 次后，该次结果附加 `<system-reminder kind="loop-guard">` 提醒模型换策略（跨工具回合计数，结果改变即重置）；`0` 关闭（见 [agent-loop](./agent-loop.md)） |
| `sessions.defaultDisposition` | `"steer"` | 不带 disposition 的 send_message 的默认处置（见 [run-manager](../server/run-manager.md)）；单个会话可经 `meta.dispositionOverride` 覆盖 |
| `sessions.askTimeoutMs` | `600000`（10 分钟） | ask_user_questions 工具等待用户回答的上限，超时按"未回答"落结果、run 继续（见 [tools](./tools.md)）；可选字段，默认值在工具构建处补齐 |
| `subagents.maxConcurrent` | `4` | 每个主会话同时存活的**阻塞**subagent 上限（按父会话计数，超限的派发立即返回 error、不建会话，见 [subagents](./subagents.md)）；可选字段，默认值在 spawner 构建处补齐 |
| `subagents.maxBackground` | `4` | 每个主会话同时存活的**后台**subagent 上限（`run_in_background` 派发，与阻塞上限分别计数、互不挤占；超限同样立即返回 error，见 [subagents](./subagents.md)）；可选字段，默认值在 spawner 构建处补齐 |
| `team.maxMembers` | `8` | 团队组员名单上限（含失败的添加） |
| `team.maxActive` | `4` | 同时运行的组员上限；满员时新信在收信箱排队等空闲边投递 |
| `team.mailbox.maxUnreadPerTarget` / `maxMessageBytes` | `64` / `65536` | 单个收信箱未读上限 / 单条信字节上限，超限投递方收到 error 结果 |
| `team.taskBoard.maxTasks` | `64` | 任务板总量上限（含终态任务），超限建任务报错 |
| `server.port` | 无（临时端口） | daemon 的固定监听端口（1-65535）：固定后 WebUI 地址跨重启稳定，不配则每次启动由操作系统分配临时端口。bin 的 `--port` 旗标优先于此字段；固定端口被占用是硬错误（报一行原因退出，绝不静默换端口——地址悄悄漂移正是固定端口要消灭的），非法值回退到临时端口并告警。见 [daemon](../server/daemon.md) |

| `notify.channels` | `[]` | 定时任务终态通知渠道列表；为空即关闭（零开销）。条目 `{ name?, type, url, template? }`，`type` 三种：`bark`（POST JSON `{title, body}`）、`serverchan`（POST 表单 `title`+`desp`）、`webhook`（POST JSON，正文含 title/body 及全部 job 字段）。`template` 占位符：`{{job}}` `{{statusText}}` `{{status}}` `{{summary}}` `{{sessionId}}` `{{sessionUrl}}`，未知占位符渲染为空串 |
| `notify.timeoutMs` | `10000` | 单次推送请求超时；推送失败只记日志、不重试 |
团队协作的状态目录在工作区 `.kclaw/teams/<队名>/`（团队记录 + 组员名单 + 收信箱）与 `.kclaw/tasks/<队名>/`（任务快照 + 进行中锁），与项目档权限规则共用 `.kclaw` 根；目录结构、对账与崩溃恢复语义见 [agent-team](./agent-team.md)。
| `hooks.timeoutMs` | `5000` | 单个 hook 处理函数的执行 budget（毫秒），超时按失败处理（用户 hook skip、内置 hook fatal，见 [hooks](./hooks.md)）；可选字段，默认值在 hook 链构建处补齐 |
| `workspace` | `process.cwd()` | 工具的工作目录；daemon 的 cwd 由启动方决定，单个会话可经 `meta.workdir` 覆盖 |

读（`loadConfig(paths)`）：`config.json` 存在 → 按 JSON 解析；缺失或内容为空 → 返回默认值的克隆。解析失败抛错（`invalid json in <path>: ...`），内容不是对象映射也抛错；其余 → `deepMerge(默认值克隆, 文件内容)`。**除两处外没有结构校验**：`permissions.defaultMode` 非五档时回退到 `"default"` 并告警、压缩阈值线四线经 `validateWaterlineConfig` 校验（见 [permissions](./permissions.md) 与 [compaction](./compaction.md)）；其余字段不校验——多余字段原样保留，字段类型写错要到使用方使用时才暴露。

写（`saveConfig(paths, config)`）：把**深合并后的整份 config**（含全部默认字段，首次生成的 `config.json` 不是用户最小集）序列化成 JSON，整文件原子重写——`writeFileAtomic(paths.configJson, JSON.stringify(config, null, 2) + "\n", 0o600)`（`storage/atomic.ts`：先写 `<path>.tmp` 再 rename，POSIX 同目录 rename 是原子的；文件权限 0600，因为里面含明文 API key）。MCP server 不经 `saveConfig` 写入——唯一管理源是全局层 `mcp.json` 与项目层 `.kclaw/mcp.json`（见 [mcp](./mcp.md)）。CLI wizard 保存后仍保留一次显式 `chmodSync(0o600)`，双保险（见 [onboarding](../cli/onboarding.md)）。

---

## 接口

```ts
// packages/core/src/storage/paths.ts
export interface KclawPaths {
  home: string; config: string; agentsMd: string
  skillsDir: string               // <home>/skills —— 全局技能目录（见 skills.md）
  hooksDir: string                // <home>/hooks —— 用户 hook 目录（见 hooks.md）
  memoryDir: string; memoryNotesDir: string; memoryIndexDb: string
  sessionsDir: string; jobsDb: string; usageDb: string
  attachmentsDir: string; spillDir: string; logsDir: string
}

// packages/core/src/storage/config.ts
export function loadConfig(paths: KclawPaths): KclawConfig
export function saveConfig(paths: KclawPaths, config: KclawConfig): void
export function renameProviderEntry(config: KclawConfig, from: string, to: string): void
// 条目改名统一入口：挪动 entries 的键，并把 PROVIDER_ENTRY_REFERENCES 里
// 指向旧名的配置级引用（providers.default、memory.extractModel、
// memory.embedding.provider）一并改写；会话级引用保持旧名、下个 run 改用默认条目

// packages/core/src/storage/config-notifier.ts
export type ConfigSection = "providers" | "mcp" | "channels"
export interface ConfigNotifier {
  publish(section: ConfigSection): void
  subscribe(section: ConfigSection, listener: () => void): () => void
}
export function createConfigNotifier(): ConfigNotifier
// 配置分节变更的进程内通知：provider 管理路由在持久化后 publish("providers")，
// 长命消费者（daemon 的 resolver）订阅后清自己的缓存。同步、逐监听者隔离
//（一个监听者抛错不影响其余），mcp/channels 是留给其他子系统的占位取值

// packages/core/src/storage/jsonl.ts
export function repairTornTail(file: string): void
export function appendJsonlLine(file: string, value: unknown): void
export function readJsonl(file: string): unknown[]
```

`KclawPaths` 每个字段的用途见上文目录树。`memoryDir` 是记忆系统的根（MemorySystem 在它下面建 `global/` 与 `projects/`，见 [memory](./memory.md)）。

---

## 会话目录与 events.jsonl

每个会话一个目录 `<sessionsDir>/<id>/`，固定三个文件，由 `SessionStore`（`packages/core/src/session/store.ts`）统一管理。三个文件的分工：**events.jsonl 是唯一权威数据，meta.json 是从它推导出来的快速读取摘要，queue.jsonl 是运行态的排队消息。**

- **`events.jsonl`（唯一权威数据）**：只追加的事件流，一行一个 `SessionEvent`（JSON 序列化），共 22 种事件——
  - 会话生命周期 5 种：`session.created`（含创建时固化的初始权限模式 `mode`；subagent 会话还带 `parentSessionId`）、`session.renamed`、`session.deleted`、`session.restored`、`session.set`（model / mode / disposition 的会话级设置）。
  - 内容类 7 种：`message`（一条消息）、`message.truncated`（编辑重试/重新生成的截断标记：从 `fromMessageId` 起的所有消息退出对话视图；事件流只追加这条标记、不改写任何历史行，可见性是读取端投影）、`compaction`（一次压缩的审计）、`memory`（一次记忆写入的审计）、`skill`（一条技能提案审计——提案的产生与治理状态流转各落一条，只做记录、权威数据在 `.proposals/` 的提案文件，见 [skills](./skills.md)）、`system`（一条系统提示词审计，每次对话运行落一条，附带 stable/live 两段拼装文本）、`sandbox.checked`（一条沙箱状态审计——每次对话运行检测后落一条 `{enabled, available, unavailableReason?}`）。
  - 运行档案 3 种：`run.started` / `run.ended`（每 run 一对，把该 run 的消息事件夹成一轮边界；失败 run 也落 `run.ended`，起点必有终点）、`permission.decided`（每次人工确认裁决的记录；被中止的确认不落）。<br>运行档案与 `system` / `sandbox.checked` 一样只写事件流、不进 meta 投影、不推进 `updatedAt`。`message.truncated` 不同（它是用户可见的会话动作，会推进 `updatedAt`；且当截断起点越过压缩锚点（`compaction.upto`）时，部分已压缩的历史被丢弃，压缩投影随之一并清除（摘要无法再代替被隐藏的消息；尾部截断）常规路径——不碰压缩投影）。
  - 协作 7 种（`team.created` / `team.member.provisioned` / `team.member.settled` / `team.message.queued` / `team.message.delivered` / `team.task.created` / `team.task.updated`）：agent 团队协作的审计记录，只追加在**组长**的事件流上（以团队目录为准，见 [agent-team](./agent-team.md)）；尽力而为（写失败降为警告、团队操作照常），与运行档案一样不进投影、不推进 `updatedAt`。

  所有写入都先追加事件，再把事件汇入 meta.json 摘要（见下）。
- **`meta.json`（派生摘要）**：类型 `SessionMeta`，由事件流经 `applyEvent` 逐条推导得出。它是「摘要」而非权威数据：删除或损坏都能从事件流完整重建（`meta()` 发现缺失或损坏时自动 `rebuildMeta`）。崩溃恢复时允许它暂时落后于事件流（落后不会丢数据）；但落后不会被后续写入自动追平（`appendEvent` 先读当前摘要、只汇入新事件）。只有 meta.json 缺失或损坏时才经 `rebuildMeta` 重放整条事件流。meta.json 整文件原子重写（`updateMeta` 合并 patch，`undefined` 键表示删除；`message` / `message.truncated` / `compaction` 事件会推进摘要的 `updatedAt`，`memory` / `skill` / `system` / `sandbox.checked` 事件不推进——审计类事件不算会话「更新」）。两条特殊的推导规则：`system` 事件把全文 upsert 进摘要的 `systemBaseline`（系统提示词的冻结基线，见下文），`compaction` 事件把 `systemBaseline` 清除（压缩改写了消息历史，提示词缓存必然全部失效，正是重新组装、重新冻结的时机）；`message.truncated` 在截断起点越过压缩锚点（`compaction.upto`）时一并清除压缩投影（部分被压缩的历史已随截断丢弃，摘要不能再代替它们）。
- **`queue.jsonl`（运行态）**：排队中的消息（`{ messageId, disposition, text, trigger, attachments?, note?, enqueuedAt }`，顺序即执行顺序，见 [run-manager](../server/run-manager.md) 的消息队列）。与事件流不同，`replaceQueue` 每次整文件重写、不是追加；不参与 meta.json。

`meta.json` 的全部字段：

| 字段 | 含义 |
|------|------|
| `id` / `title` / `createdAt` / `updatedAt` | 会话标识、标题、创建/更新时间 |
| `jobId?` | 创建本会话的定时任务；普通会话没有 |
| `workdir?` | 会话的工作目录覆盖 |
| `model?` | 会话级模型覆盖；空或默认回退到 daemon 默认 |
| `mode?` | 会话权限模式，`"readonly" \| "default" \| "acceptEdits" \| "trusted" \| "auto"` 五档，默认 default（见 [permissions](./permissions.md)） |
| `parentSessionId?` | subagent 会话的父会话标识；普通会话没有。引擎侧一切 subagent 特化行为都从它派生（见 [subagents](./subagents.md)） |
| `compaction?` | 分层压缩状态 `{ segments, top, upto }`（语义见 [compaction](./compaction.md)），由 `compaction` 事件推导（每次压缩把新段汇入 `segments`；`updateMeta` 不再直接改它） |
| `dispositionOverride?` | 会话级发送处置覆盖（`"steer" \| "wait" \| "interrupt"`），优先于 `sessions.defaultDisposition`。服务端路由接受三个值的写入；Web 与 CLI 的 interrupt 都是一次性动作、不写会话级覆盖（见 [webui](../web/webui.md) 与 [run-manager](../server/run-manager.md)） |
| `systemBaseline?` | 冻结的系统提示词基线，双段独立 `{ stable: {text, frozenAt}, live?: {text, frozenAt} }`。作用：每 run 两段现算、与基线逐段比对——哪段文本变了就重冻结哪段（`frozenAt` 记录这份文本成为基线的时刻），没变的沿用基线，`system-before` / `system-after` 组装链只在至少一段变化时才跑（提示词缓存的稳定性策略，详见 [hooks](./hooks.md)）。推导规则：`system` 事件按段 upsert、`compaction` 事件清除（压缩改写了消息历史，缓存必然全量失效，正是基线重置的边界），都不推进 `updatedAt` |

`Message`（`packages/core/src/protocol/messages.ts`）的基础字段是 `{ id, sessionId, role: "user" \| "assistant" \| "tool", blocks, createdAt }`；assistant 消息额外带 `{ model, usage, stopReason }`，tool 消息额外带 `{ grantedBy? }`（callId → 放行原因）。id 前缀 `msg_` / `ses_`，ULID 格式。会话的消息列表和压缩列表如今都是事件流的只读视图：`readMessages` 从事件流过滤出 `message` 事件并按 `message.truncated` 标记隐藏被截断的消息（编辑重试/重新生成的过滤点，见下）、`readCompactions` 过滤出 `compaction` 事件，`readQueue` 读 `queue.jsonl`。

崩溃安全由两个策略函数承担（`packages/core/src/storage/jsonl.ts`），事件流与队列共用：

- `readJsonl(file)`：文件缺失返回 `[]`；去掉末尾空行后逐行 `JSON.parse`；**最后一行**解析失败视为断尾崩溃产物，丢弃并停止；**中间任何一行**解析失败则抛错——崩溃不可能制造中间坏行，出现即意味着 bug 或外部破坏，静默跳过等于掩盖问题。
- `readJsonlFrom(file, since)`：`readJsonl` 的尾部读变体，供增量拉取（`SessionStore.readEventsFrom` / 审计页 `?since=`）。文件仍整体读入（JSONL 没有行偏移索引），但下标 `< since` 的行**不解析、不构建**，增量开销只随返回条数增长、与流的总长无关；已解析区域的损坏语义与 `readJsonl` 一致，跳过区的损坏不可见。`readJsonl` 就是 `readJsonlFrom(file, 0)`。
- `repairTornTail(file)` + `appendJsonlLine(file, value)`：每次追加前检查文件的最后一个字节——是 `\n` 说明上次干净结束；否则**先截断到上一个换行再追加**。截断点按**字节偏移**找（`Buffer.lastIndexOf(0x0a)`）：UTF-8 的多字节序列内部不会出现 0x0a（续字节都 ≥ 0x80），所以单字节检测可靠；如果改用解码后字符串的 indexOf，得到的是 UTF-16 码元下标，切点可能落在多字节字符中间，反而破坏上一行。文件不存在时修复是空操作。

会话的删除语义在 `SessionStore`：`delete()` 软删除（追加 `session.deleted` 事件，摘要置 `deleted: true, deletedAt`），`restore()` 恢复（追加 `session.restored` 事件），`purge()` 物理删除整个目录，`purgeExpired(ttlMs)` 清理过期的软删除会话（由 scheduler tick 周期调用）。

一条消息的完整持久化路径：

1. agent 循环产出消息 → run 组装（core `executeRun`）的 `onMessage` hook 调 `sessions.appendMessage(sessionId, m)`。
2. `appendMessage` 经 `appendEvent` 往 events.jsonl 追加一条 `message` 事件：先 `repairTornTail`（末字节不是 `\n` 就按字节截断到上一个换行），再 `appendFileSync(JSON.stringify(event) + "\n")`，随后把事件汇入 meta.json 摘要（`applyEvent`）。
3. 回读时 `readMessages` 读全部事件后过滤出 `message` 事件，并**按 `message.truncated` 标记倒序收缩**：从流尾向前走，最近的截断标记就是"该消息之后第一个截断"，消息 id 不小于它即被丢弃（重试追加在标记之后的新消息不受旧起点约束）——这是唯一的过滤点，聊天视图、run 上下文组装、压缩与记忆提取全部继承同一份可见历史。`readMessages` 先丢弃断尾行，逐行解析成 `Message` 数组，作为下次运行的历史（run 组装在追加用户消息**之前**读历史，避免同一条消息发送两次）。

---

## 保存的权限规则（decided-rules）

用户在人工确认里选「总是允许」后保存下来的**收紧 allow 规则**（收紧与保存机制见 [permissions](./permissions.md)），**独立于会话目录**，落在两个 YAML 文件（`packages/core/src/storage/decided-rules.ts`）：

| 文件 | 作用域 | 写入方 |
|------|--------|--------|
| `<home>/permissions.yaml` | 全局档，任何工作区生效 | run 组装的 `resolveConfirmation`（`packages/core/src/agent/run-assembly.ts`，global 裁决时写入） |
| `<workspace>/.kclaw/permissions.yaml` | 项目档，只对该工作区的会话生效；首次保存时自动建 `.kclaw` 目录、把 `.kclaw/permissions.yaml` 追加进工作区 `.gitignore`（重复执行无副作用） | 同上（project 裁决）；auto 模式归纳的 `source:"auto"` 规则也在 run 组装层写入同一文件 |

格式（每条是一个 `DecidedRuleEntry`）：

```yaml
rules:
  - rule: "exec:git push*"        # 收紧后的规则（exec = 首词+子命令前缀；路径工具 = realpath 精确路径；其余 = 工具级）
    decidedAt: "2026-09-07T08:00:00.000Z"   # ISO-8601
    origin:                        # 触发裁决的出处
      tool: "exec"
      argsJson: '{"command":"git push origin main"}'
      sessionId: "ses_…"
    source: "auto"                 # 可选：auto 模式归纳（默认/缺失 = 人工「总是允许」）
```

文件权限 0600、`writeFileAtomic` 原子写入。沉淀规则只落在这两个 permissions.yaml；配置文件（`config.json`）的写入只发生在 CLI wizard 与 Model 页 provider 管理路由（均经 `saveConfig`），规则的增删与配置文件互不相干。`source` 字段区分规则的两种来源：人工选「总是允许」记 `manual`（默认），auto 模式连续 `once` 裁决后的自动归纳记 `auto`（见 [permissions](./permissions.md) 第 5 节）。它只是溯源标记，规则引擎不读它，加载与生效路径和手工规则完全一致。每个 run 由 `loadDecidedRulesForRun` 读入并合并成规则串数组传给权限 gate：全局档总是加载；项目档只在工作区已定义、文件存在且**未被 git 跟踪**时加载（`isGitTracked` 用 `git ls-files --error-unmatch` 检测，被 git 跟踪即整体忽略并在 daemon 日志告警——防止克隆来的仓库夹带一份预授权清单）。删掉文件里的条目（或整个文件）即收回授权，对下一个 run 立即生效。管理入口：`GET`/`DELETE /permissions/rules`（见 [http-api](../server/http-api.md)）与 WebUI「权限」页。

---

## 项目层 mcp.json（`storage/mcp-config.ts`）

项目层的 MCP server 配置落在工作区 `.kclaw/mcp.json`，与全局层 `mcp.json` 按名合并（展开顺序 global < project，同名条目项目层整体覆盖，见 [mcp](./mcp.md)）：

- **读**（`loadProjectMcpServers(workspace)`）：文件缺失或形状不对读作 `{}`（与全局 `loadMcpJson` 同一永不抛错契约，损坏文件告警后忽略）；**被 git 跟踪时整体忽略并告警**——克隆来的仓库不能自带一份会在连接时执行本地进程的 MCP 配置（与 decided-rules 的 `isGitTracked` 防御同一动机，复用同一个检测函数）。
- **写**（`saveProjectMcpJson(workspace, servers)`）：0600 原子写；首次写入前跑出生防御（`ensureProjectMcpDefenses`）——建 `.kclaw` 目录、把 `.kclaw/mcp.json` 追加进工作区 `.gitignore`（幂等），文件从此本地私有。
- **热生效**：daemon 用 `createProjectMcpWatch` 监视 `.kclaw/mcp.json`，手工编辑经 `McpManager.reconcile` 重新对齐生效集（机制见 [mcp](./mcp.md) 与 [daemon](../server/daemon.md)）。


---

## 用量记录（`storage/usage.ts`）

`UsageStore` 是一张只追加、不修改的 SQLite 记录表（`<home>/usage.db`，表 `usage` + `at` 列索引）：daemon 每结束一个 run 就记一行 `{sessionId, runId, model, inputTokens, outputTokens, at}`，行主键为 `u_<sessionId>_<runId>`。记录发出后不等结果：RunManager 调用它时包了 try/catch，记录失败只打一行日志，用量统计永远不影响 run 本身。

```ts
export interface UsageAgg { key: string; inputTokens: number; outputTokens: number; costUsd: number }

class UsageStore {
  record(row: Omit<UsageRow, "id">): void
  aggregate(by: "day" | "session" | "model", prices, from?, to?): UsageAgg[]
  total(prices, from?, to?): { inputTokens; outputTokens; costUsd }
  close(): void
}
```

- **三种聚合口径**：`day`（按 `at` 的本地日历日 `YYYY-MM-DD`）、`session`（按 sessionId）、`model`（按模型名）；时间区间 `[from, to)` 对 ISO 格式的 `at` 字符串做比较，结果按 key 升序。
- **成本公式**（`costUsd(row, model, prices)`）：`(input/1e6)·inputPerM + (output/1e6)·outputPerM`，价格来自 `config.usage.prices`（美元 / 百万 token）；**模型没有价格条目时成本恒为 0**（token 数照常显示）。每组成本逐行累加——每行用它自己模型的价格，即使分组键是日期或会话。

HTTP 出口与展示见 [http-api](../server/http-api.md) 的 `GET /usage` 与 [webui](../web/webui.md) 的用量页。

---

## daemon.json 与 token（`packages/server/src/daemon.ts` / `auth.ts`）

- **`<home>/daemon.json`**：启动第一步以 `wx` 独占模式认领（先写占位 `{ port: 0, pid, startedAt, starting: true }`；发现存活 pid 就拒绝二次启动，发现死 pid 就回收文件重新认领），监听成功后回填真实 `{ port, pid, startedAt }`（startedAt 不变，移除 `starting`）。它是「该 home 下存在一个运行中的 daemon 及其端口」的存活标识。`stop()` 正常结束时删除；若某个停机步骤超时（默认 `DEFAULT_STOP_TIMEOUT_MS = 60000`），`stop()` 抛错且 daemon.json **保留**——进程还在运行，一条如实的记录比干净的目录更有用（CLI 靠它判断 daemon 状态，见 [daemon](../server/daemon.md)）。
- **`<home>/token`**：daemon 的 Bearer token（HTTP/WS 鉴权用；Bearer token 是放在请求头 `Authorization: Bearer <值>` 里的访问令牌）。`loadOrCreateToken` 读它，不存在则生成一个新 UUID 写入，**文件权限 0600（仅属主可读写）**。跨重启复用同一个 token，daemon 的稳定身份，重启后已登录的客户端无需重新走引导流程。校验用 `timingSafeEqual` 常数时间比较（`bearerMatches`），不泄露比较耗时信息（防时序侧信道）。

---

## 边界与出错

- **meta.json 原子写**：`writeMeta` 经 `writeFileAtomic`（临时文件 + rename）写入，meta.json 本身不会被截断；崩溃最坏残留一个 `<meta.json>.tmp` 临时文件，不影响读取。
- **config 校验是分字段的，不是整体 schema**：文件级语法错（JSON 解析失败、根不是映射）启动即抛错；少数进事件流或影响存亡的字段在加载时逐字段校验（`permissions.defaultMode`、压缩阈值线整组、`team.*`、`server.port`——非法值回退到默认并告警一行）；其余字段不做结构校验，写错类型要到运行时的读取处才以意外方式失败。
- **SQLite 未开 WAL**：jobs.db、记忆的 `vectors.db`（每项目 + 全局各一个）与 usage.db 都用默认日志模式。单 daemon 进程同步访问（better-sqlite3）下安全；多进程并发写同一个 home 是明确不支持的用法。进程内的同一个 vectors.db 也只有 MemoryPipeline 一个连接（检索方借用句柄）。
- **KCLAW_HOME 只在 `resolvePaths` 读取一次**：核心层不缓存，但各调用方持有自己的解析结果；daemon 启动后改环境变量不影响已创建的路径。

---

## 关联

- [jobs](./jobs.md)：jobs.db 的表结构与轮询
- [compaction](./compaction.md)：压缩状态的存放位置（meta.compaction 摘要 + 事件流里的 compaction 事件）与压缩配置字段
- [memory](./memory.md)：memory 目录的两层塔布局（文件是权威数据、vectors.db 是派生物）
- [protocol](./protocol.md)：Message / Block 的完整定义（message 事件的内容就是一个 Message）
- [daemon](../server/daemon.md)：daemon.json 的写入时机与停机流程、token 的鉴权链路
