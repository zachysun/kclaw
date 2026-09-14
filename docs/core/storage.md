# storage — 路径、配置与会话持久化

## 职责

`packages/core/src/storage/` 是所有持久化（把数据写入磁盘长期保存）的基础：`paths.ts` 解析 kclaw 的根目录与目录树（`KCLAW_HOME` 环境变量可整体重定向）；`config.ts` 读写 `config.yaml`（用户配置与默认值深合并）；`jsonl.ts` 提供 JSONL 文件（一行一个 JSON 对象的文本格式）的追加、读取与崩溃修复，是会话事件流 `events.jsonl`（唯一真相）与运行态队列 `queue.jsonl` 的底层。会话目录结构与 `meta.json` 由 `SessionStore`（`packages/core/src/session/store.ts`）负责；`daemon.json` 和 `token` 两个文件由 server 侧产生，本文一并说明用途。

---

## 设计决策

- **单一根目录容纳全部状态。** 配置、会话、记忆、任务、附件、日志全在同一个根目录下，根目录可以整体重定向——解析顺序是：显式参数 > `KCLAW_HOME` 环境变量 > `~/.kclaw`。环境变量的空白字符串视为未设置：用 `??` 判断时，空串会被当成有效值，导致所有路径变成相对当前目录而不是回退到 `~/.kclaw`；这条规则来自一次实际故障的修正（`envHome()`）。
- **只建目录，不建文件。** `resolvePaths` 用 `mkdirSync(recursive)` 创建目录树，但 `config.yaml`、`jobs.db` 等文件只是路径字符串，不在这里创建——文件由各自的所有者在首次写入时产生（`SessionStore`/`MemorySystem`/`JobScheduler` 的构造函数建目录并初始化自己的数据库）。
- **配置深合并，默认值永不被污染。** `loadConfig` 把文件内容深合并到默认值上，且两个分支都从 `structuredClone(defaultConfig)` 开始——否则返回值会与导出的 `defaultConfig` 共享嵌套引用，调用方任意一处 `cfg.permissions.allow.push()` 都会改掉进程级的默认值。合并规则（`deepMerge`）：普通对象按键递归合并，数组与标量整体替换，`undefined` 跳过，两个输入都不被修改。
- **配置无效时报错，而不是静默回退。** `config.yaml` 解析失败直接抛错（`invalid yaml in <path>: ...`），文件内容不是对象映射也抛错。不做静默回退——悄悄改用默认值意味着用户配置的权限规则在无提示的情况下失效，比启动失败更危险。文件缺失或内容为空则返回默认值，这是首次使用的正常路径。
- **会话事件流只追加，且容忍崩溃。** 事件只追加、从不改写历史行（运行态队列 `queue.jsonl` 是例外——整文件重写，见下文）。崩溃可能留下的残缺是「最后一行只写了一半」（torn line，断尾行）：读取时丢弃断尾行（崩溃产物，最多丢一条事件）；写新行之前先修复断尾，否则新行会拼接在半行后面，读取时两条会一起被丢弃。

---

## 目录树（`KclawPaths`）

```ts
// packages/core/src/storage/paths.ts
export function resolvePaths(home?: string): KclawPaths
```

| 路径 | 用途 | 写入方 |
|------|------|--------|
| `<home>/config.yaml` | 全部配置（见下节） | CLI 向导 `saveConfig`；用户手编 |
| `<home>/permissions.yaml` | 全局权限规则——在人工确认里选「总是允许」后保存下来的收紧 allow 规则；项目档在工作区 `.kclaw/permissions.yaml`（见下文「保存的权限规则」一节） | run 装配的确认缝合层（`packages/core/src/agent/run-assembly.ts` 的 `resolveConfirmation`，global 裁决时写入）；用户手编亦可 |
| `<home>/AGENTS.md` | agent 人格设定，非空则作为系统提示的一部分（stable 段基座）；每次运行拼装的完整系统提示以 `system` 事件按 stable/live 两段全量记录 | 用户手编；daemon 启动时读 |
| `<home>/memory/global/` | L2 全局认知（persona.md、wiki/、rule/ 的 markdown，文件即真相） | MemorySystem / 用户手编 |
| `<home>/memory/projects/<id>/` | L1 项目情节（`<topic>.md` 主题线、workdir.txt、MEMORY.md、state.json、vectors.db） | MemorySystem / 用户手编 |
| `<home>/memory/notes/`、`<home>/memory/index.db` | 旧版记忆目录的遗留：前者是迁移输入（daemon 启动时读取后删除）、后者是旧版派生索引（已直接删除） | 仅 daemon 启动迁移（见 [memory](./memory.md)） |
| `<home>/skills/` | 全局技能包目录（每个子目录是一个技能，含 `SKILL.md`；软链接穿透加载；`.links.json` 旁挂文件记录复用链接与自定义探测目录；项目级技能在工作区 `.kclaw/skills/`，见 [skills](./skills.md)） | 用户手编或经技能页复用写入；每个 run 重新扫描读取 |
| `<home>/hooks/` | 用户钩子目录（每个文件是一个钩子，`export const hook` + default 函数；见 [hooks](./hooks.md)） | 用户手编；每个 run 重新扫描读取 |
| `<home>/sessions/<id>/` | 每会话一个目录（events.jsonl + meta.json + queue.jsonl，分工见下节） | SessionStore（events.jsonl 是唯一真相、meta.json 是派生摘要、queue.jsonl 是运行态、整文件重写） |
| `<home>/jobs.db` | 定时任务表 | JobScheduler |
| `<home>/usage.db` | 每次 LLM 运行的 token 用量记录 | UsageStore |
| `<home>/attachments/<id>/` | 附件外存目录（每会话一个子目录） | server 上传路由 `routes/attachments.ts`；运行时只读挂载 |
| `<home>/spill/` | 工具输出溢出目录：exec / web_fetch 截断输出时，把捕获到的全量输出写到这里，给模型的截断视图附带 fs_read 定位行 | core `tools/spill.ts`（单文件上限 10 MiB，超出部分不保留）；目录在权限引擎 readRoots 内，`fs_read` 可直接读 |
| `<home>/logs/` | 日志目录 | 预留：目录会创建，当前代码没有写入方 |
| `<home>/daemon.json` | daemon 存活标识（server 侧） | `launchDaemon` |
| `<home>/token` | daemon 鉴权 token（server 侧） | `loadOrCreateToken` |

补充三点：`logs` 目录在当前源码中只有路径创建、没有写入方，如实记为预留。`attachments` 由上传路由写入，由权限引擎的 readRoots 与附件挂载读取，见 [run-manager](../server/run-manager.md)。`spill` 是尽力而为的写入：写入失败时静默退化为纯截断输出；溢出文件是普通文件，可随时手动清理（目前没有自动过期清理）。

---

## config.yaml 全量字段

`KclawConfig`（`packages/core/src/storage/config.ts`）与 `defaultConfig` 默认值：

| 字段 | 默认值 | 含义与消费方 |
|------|--------|--------------|
| `providers.default` | `""` | 默认 provider 名，指向 entries 里的一条 |
| `providers.entries` | `{}` | `Record<名, { baseUrl, apiKey, model, contextWindow?, maxOutput? }>`；daemon 启动时解析（config 优先，`KCLAW_LLM_BASE_URL` / `KCLAW_LLM_API_KEY` / `KCLAW_LLM_MODEL` 环境变量补空）。`contextWindow` 参与压缩预算的 min 解析、`maxOutput` 随请求下发 max_tokens（见 [compaction](./compaction.md)） |
| `providers.timeoutMs` | `120000` | 单次 LLM 请求超时（`DEFAULT_LLM_TIMEOUT_MS`）；可选字段仅为兼容旧配置文件 |
| `permissions.allow` / `deny` | `[]` / `["exec:sudo*", "exec:rm -rf*"]` | 权限规则，见 [permissions](./permissions.md) |
| `permissions.confirmTimeoutMs` | `120000` | 人工确认的等待上限，超时按拒绝处理 |
| `permissions.sessionGrants` | `true` | 会话内「仅本次允许」的记忆是否生效（run 级，见 [permissions](./permissions.md) 第 11 节） |
| `permissions.autoLearnThreshold` | `3` | auto 模式的归纳阈值：同一操作被连续 `once` 批准多少次后，自动保存为项目档规则；`0` 关闭归纳（auto 模式的判定链保留） |
| `permissions.defaultMode` | `"default"` | 新会话的初始权限模式。daemon 创建的新会话——HTTP `POST /sessions` 与定时任务调度建会话——在创建时固化为 `meta.mode`；改这个值只影响之后新建的会话。非法值回落 `"default"` 并告警 |
| `memory.write.{immediate, manual, intervalMinutes, idleMinutes}` | `true` / `true` / `30` / `10` | 记忆写入的触发开关（五个触发器：immediate/manual/clear/interval/follow；clear 挂在 `POST /sessions` 上，无独立开关）：immediate = `memory_save` 工具当场触发；manual = 手动触发开关（`/memory save`（CLI/web）走 `POST /memory/trigger-manual`，为 `false` 时该路由返回 400）；intervalMinutes = 定时保底间隔（0 关闭）；idleMinutes = 跟随触发的空闲分钟数（0 关闭）。完整语义见 [memory](./memory.md) |
| `memory.extractModel` / `threadInactiveDays` / `consolidate` / `consolidateHour` | `""` / `14` / `true` / `3` | 提取/内化用的模型（空则回落主对话模型）、主题线闲置多少天自动转 inactive、内化开关、夜间闲时内化的本地小时（负值关闭） |
| `memory.embedding.{provider, model}` | `""` / `""` | 向量检索：`model` 为空则向量这条路整体关闭（只用 BM25 关键词检索）；provider 为空回落 default 条目 |
| `memory.injectTokenBudget` | `1000` | 每轮 L2 认知常驻注入的 token 上限（只约束常驻注入；L1 情节前 5 条全量注入不受此限） |
| `memory.autoExtract` | 无（废弃） | 旧版字段，已被五触发取代，不再生效：配置文件里写了不报错，但读取处一律忽略 |
| `web.tavilyApiKey` | `""` | web_search 工具的 Tavily 密钥 |
| `web.timeoutMs` | `20000` | 每次网络抓取（搜索与网页）的 AbortSignal 超时，卡死的主机不能拖住一个 run |
| `web.allowPrivateNetworks` | `false` | 设为 `true` 时豁免 web_fetch 对私网/回环目标的拒绝（SSRF 防护，例如允许抓取本机 Ollama 端点），由 run 装配传入工具 |
| `usage.prices` | `{}` | 模型 → `{inputPerM?, outputPerM?}`：每百万 token 的美元单价，用量记录算成本用；没有价格条目的模型成本按 0 计 |
| `mcp.servers` | `{}` | 外部 MCP server 配置的遗留位置（stdio/http 两种形态），读取时与 `mcp.json` 按名合并（mcp.json 优先）；首次从 WebUI 保存后整节迁入 `mcp.json` 并从此文件摘除（见 [mcp](./mcp.md)） |
| `exec.timeoutMs` / `maxOutputBytes` | `60000` / `102400`（100 KiB） | exec 工具的超时与输出截断上限 |
| `sandbox.enabled` / `writeRoots` / `network` | `true` / `[]` / `"allow"` | exec 沙箱的整体开关、追加写白名单（realpath 形态）与沙箱内网络开关（deny 时 exec 子进程断网，web 工具不受影响），见 [sandbox](./sandbox.md)；可选字段仅为兼容旧配置文件 |
| `sessions.recycleBinTtlMs` | `2592000000`（30 天） | 回收站保留期，scheduler tick 周期清理用（见 [jobs](./jobs.md)） |
| `sessions.contextTokens` / `compactPackRatio` / `compactAheadRatio` / `compactAtRatio` / `compactPanicRatio` / `compactTargetRatio` / `toolResultKeep` | `128000` / `0.70` / `0.75` / `0.80` / `0.90` / `0.33` / `8` | 上下文压缩（见 [compaction](./compaction.md)）：token 预算、省略线（发送时工具输出省略的预算比例）、预压线（估算发送量达预算 × 0.75 且未过红线时在迭代边界派后台压缩）、黄线（估算发送量达预算 × 0.80 即触发收尾压缩）、红线（运行中占用达预算 × 0.90 时在迭代边界触发中途压缩）、压缩后保留部分的目标比例（预算 × 0.33）、发送时保留原文的最近工具结果条数。七个字段均可选：缺省值、加载校验与"预算 × 比例 → 绝对 token 阈值"的解析集中在压缩水位线模块 `session/waterlines.ts`——触发四线（预压/黄/红/目标）越出 (0,1] 或次序不满足"目标 < 预压 < 黄 < 红"整组回落默认并告警，省略线单独校验、独立回落；每次 run 由 `resolveWaterlines` 解析出绝对阈值供触发钩子与压缩引擎使用（`contextTokens` 的读取在 `resolveContextTokens`） |
| `sessions.toolLoopMaxRepeats` | `5` | 工具死循环守卫：同一工具调用（同名同参数）连续执行达 N 次后，该次结果附加 `<system-reminder kind="loop-guard">` 提醒模型换策略（跨工具回合计数，结果改变即重置）；`0` 关闭（见 [agent-loop](./agent-loop.md)） |
| `sessions.defaultDisposition` | `"steer"` | 不带 disposition 的 send_message 的默认处置（见 [run-manager](../server/run-manager.md)）；单个会话可经 `meta.dispositionOverride` 覆盖 |
| `sessions.askTimeoutMs` | `600000`（10 分钟） | ask_user_questions 工具等待用户回答的上限，超时按"未回答"落结果、run 继续（见 [tools](./tools.md)）；可选字段，缺省值在工具构建处补齐 |
| `sessions.compactThreshold` / `compactKeep` | 无（废弃） | 旧版压缩的字段（当时是 40 条消息触发、保留 25 条），已废弃不生效：配置文件里写了不报错，但没有任何消费方 |
| `subagents.maxConcurrent` | `4` | 每个主会话同时存活的**阻塞**子代理上限（按父会话计数，超限的派发立即返回 error、不建会话，见 [subagents](./subagents.md)）；可选字段，缺省值在 spawner 构建处补齐 |
| `subagents.maxBackground` | `4` | 每个主会话同时存活的**后台**子代理上限（`run_in_background` 派发，与阻塞上限分别计数、互不挤占；超限同样立即返回 error，见 [subagents](./subagents.md)）；可选字段，缺省值在 spawner 构建处补齐 |
| `notify.channels` | `[]` | 定时任务终态通知渠道列表；为空即关闭（零开销）。条目 `{ name?, type, url, template? }`，`type` 三种：`bark`（POST JSON `{title, body}`）、`serverchan`（POST 表单 `title`+`desp`）、`webhook`（POST JSON，正文含 title/body 及全部 job 字段）。`template` 占位符：`{{job}}` `{{statusText}}` `{{status}}` `{{summary}}` `{{sessionId}}` `{{sessionUrl}}`，未知占位符渲染为空串 |
| `notify.timeoutMs` | `10000` | 单次推送请求超时；推送失败只记日志、不重试 |
| `hooks.timeoutMs` | `5000` | 单个钩子处理函数的执行预算（毫秒），超时按失败处理（用户钩子 skip、内置钩子 fatal，见 [hooks](./hooks.md)）；可选字段，缺省值在钩子链构建处补齐 |
| `workspace` | `process.cwd()` | 工具的工作目录；daemon 的 cwd 由启动方决定，单个会话可经 `meta.workdir` 覆盖 |

读（`loadConfig(paths)`）：文件缺失或为空 → 返回默认值的克隆；YAML 语法错误或非映射结构 → 抛错；其余 → `deepMerge(默认值克隆, 文件内容)`。**没有结构校验**：多余字段原样保留，字段类型写错要到消费方使用时才暴露。

写（`saveConfig(paths, config)`）：把 config 整个序列化成 YAML，整文件原子重写——`writeFileAtomic(paths.config, stringify(config), 0o600)`（`storage/atomic.ts`：先写 `<path>.tmp` 再 rename，POSIX 同目录 rename 是原子的；文件权限 0600，因为里面含明文 API key）。CLI 向导保存后仍保留一次显式 `chmodSync(0o600)`，双保险（见 [onboarding](../cli/onboarding.md)）。

---

## 接口

```ts
// packages/core/src/storage/paths.ts
export interface KclawPaths {
  home: string; config: string; agentsMd: string
  skillsDir: string               // <home>/skills —— 全局技能包目录（见 skills.md）
  memoryDir: string; memoryNotesDir: string; memoryIndexDb: string
  sessionsDir: string; jobsDb: string; usageDb: string
  attachmentsDir: string; spillDir: string; logsDir: string
}

// packages/core/src/storage/config.ts
export function loadConfig(paths: KclawPaths): KclawConfig
export function saveConfig(paths: KclawPaths, config: KclawConfig): void

// packages/core/src/storage/jsonl.ts
export function repairTornTail(file: string): void
export function appendJsonlLine(file: string, value: unknown): void
export function readJsonl(file: string): unknown[]
```

`KclawPaths` 每个字段的用途见上文目录树。`memoryDir` 是记忆塔的根（MemorySystem 在它下面建 `global/` 与 `projects/`，见 [memory](./memory.md)）；`memoryNotesDir` / `memoryIndexDb` 是旧版记忆目录的遗留路径——daemon 启动时把 `notes/` 当作迁移输入读取后删除、`index.db` 直接删除，两者都不再有写入方。

---

## 会话目录与 events.jsonl

每个会话一个目录 `<sessionsDir>/<id>/`，固定三个文件，由 `SessionStore`（`packages/core/src/session/store.ts`）统一管理。三个文件的分工：**events.jsonl 是唯一真相，meta.json 是从它推导出来的快速读取摘要，queue.jsonl 是运行态的排队消息。**

- **`events.jsonl`（唯一真相）**：只追加的事件流，一行一个 `SessionEvent`（JSON 序列化），共 14 种事件——
  - 会话生命周期 5 种：`session.created`（含创建时固化的初始权限模式 `mode`；子代理会话还带 `parentSessionId`）、`session.renamed`、`session.deleted`、`session.restored`、`session.set`（model / mode / disposition 的会话级设置；旧的 `readonly` 布尔字段是历史遗留，读取时映射为 mode）。
  - 内容类 6 种：`message`（一条消息）、`message.truncated`（编辑重试/重新生成的截断标记——从 `fromMessageId` 起的所有消息退出对话视图；事件流只追加这条标记、不改写任何历史行，可见性是读取端投影）、`compaction`（一次压缩的审计）、`memory`（一次记忆写入的审计）、`system`（一条系统提示词审计——每次对话运行落一条，携带 stable/live 两段拼装文本）、`sandbox.checked`（一条沙箱状态审计——每次对话运行探测后落一条 `{enabled, available, unavailableReason?}`）。
  - 运行档案 3 种：`run.started` / `run.ended`（每 run 一对，把该 run 的消息事件夹成一轮边界；失败 run 也落 `run.ended`，起点必有终点）、`permission.decided`（每次人工确认裁决的留痕；被中止的确认不落）。<br>运行档案与 `system` / `sandbox.checked` 一样只写事件流、不进 meta 投影、不推进 `updatedAt`。`message.truncated` 不同——它是用户可见的会话动作，会推进 `updatedAt`；且当截断起点越过压缩锚点（`compactedUpto` / `compaction.upto`）时，部分已压缩的历史被丢弃，压缩投影随之一并清除（摘要无法再代替被隐藏的消息；尾部截断——常规路径——不碰压缩投影）。

  所有写入都先追加事件，再把事件汇入 meta.json 摘要（见下）。
- **`meta.json`（派生摘要）**：类型 `SessionMeta`，由事件流经 `applyEvent` 逐条推导得出。它是「摘要」而非真相：删除或损坏都能从事件流完整重建（`meta()` 发现缺失或损坏时自动 `rebuildMeta`）。崩溃恢复时允许它暂时落后于事件流（落后不会丢数据）；但落后不会被后续写入自动追平——`appendEvent` 先读当前摘要、只汇入新事件——只有 meta.json 缺失或损坏时才经 `rebuildMeta` 重放整条事件流。meta.json 整文件原子重写（`updateMeta` 合并 patch，`undefined` 键表示删除；`message` / `message.truncated` / `compaction` 事件会推进摘要的 `updatedAt`，`memory` / `system` / `sandbox.checked` 事件不推进——审计类事件不算会话「更新」）。两条特殊的推导规则：`system` 事件把全文 upsert 进摘要的 `systemBaseline`（系统提示词的冻结基线，见下文），`compaction` 事件把 `systemBaseline` 清除（压缩改写了消息历史，提示词缓存必然全部失效，正是重新装配、重新冻结的时机）；`message.truncated` 在截断起点越过压缩锚点（`compactedUpto` / `compaction.upto`）时一并清除压缩投影（部分被压缩的历史已随截断丢弃，摘要不能再代替它们）。
- **`queue.jsonl`（运行态）**：排队中的消息（`{ messageId, disposition, text, trigger, attachments?, note?, enqueuedAt }`，顺序即执行顺序，见 [run-manager](../server/run-manager.md) 的消息队列）。与事件流不同，`replaceQueue` 每次整文件重写、不是追加；不参与 meta.json。

`meta.json` 的全部字段：

| 字段 | 含义 |
|------|------|
| `id` / `title` / `createdAt` / `updatedAt` | 会话标识、标题、创建/更新时间 |
| `jobId?` | 创建本会话的定时任务；普通会话没有 |
| `workdir?` | 会话的工作目录覆盖 |
| `model?` | 会话级模型覆盖；空或缺省回落 daemon 默认 |
| `mode?` | 会话权限模式，`"readonly" \| "default" \| "acceptEdits" \| "trusted" \| "auto"` 五档，缺省 default。旧的 `readonly` 布尔字段读出时映射为 `mode:"readonly"` 并删除布尔键，写入端只写 `mode`（见 [permissions](./permissions.md)） |
| `parentSessionId?` | 子代理会话的父会话标识；普通会话没有。引擎侧一切子代理特化行为都从它派生（见 [subagents](./subagents.md)） |
| `compaction?` | 分层压缩状态 `{ segments, top, upto }`（语义见 [compaction](./compaction.md)），由 `compaction` 事件推导（每次压缩把新段汇入 `segments`；`updateMeta` 不再直接改它） |
| `compactedSummary?` / `compactedUpto?` | 旧版压缩的遗留字段——不再被清除，但运行侧读压缩视图时 `compaction` 优先（压缩引擎 `Compactor` 的 `compact` 里 `prev` 先读 `compaction`，见 [compaction](./compaction.md)）；两者并存没有功能影响 |
| `dispositionOverride?` | 会话级发送处置覆盖（`"steer" \| "wait" \| "interrupt"`），优先于 `sessions.defaultDisposition`。服务端路由仍接受三个值的写入，但客户端当前只写 steer/wait——interrupt 在 Web 与 CLI 都是一次性动作、不写会话级覆盖，`"interrupt"` 值只会来自历史遗留（见 [webui](../web/webui.md) 与 [run-manager](../server/run-manager.md)） |
| `systemBaseline?` | 冻结的系统提示词基线，双段独立 `{ stable: {text, frozenAt}, live?: {text, frozenAt} }`。作用：每 run 两段现算、与基线逐段比对——哪段文本变了就重冻结哪段（`frozenAt` 记录这份文本成为基线的时刻），没变的沿用基线，`system-before` / `system-after` 组装链只在至少一段变化时才跑（提示词缓存的稳定性策略，详见 [hooks](./hooks.md)）。推导规则：`system` 事件按段 upsert（legacy 单文本事件读作 stable）、`compaction` 事件清除（压缩改写了消息历史，缓存必然全量失效，正是基线重置的边界），都不推进 `updatedAt` |

`Message`（`packages/core/src/protocol/messages.ts`）的基础字段是 `{ id, sessionId, role: "user" \| "assistant" \| "tool", blocks, createdAt }`；assistant 消息额外带 `{ model, usage, stopReason }`，tool 消息额外带 `{ grantedBy? }`（callId → 放行原因）。id 前缀 `msg_` / `ses_`，ULID 格式。会话的消息列表和压缩列表如今都是事件流的只读视图：`readMessages` 从事件流过滤出 `message` 事件并按 `message.truncated` 标记隐藏被截断的消息（编辑重试/重新生成的过滤点，见下）、`readCompactions` 过滤出 `compaction` 事件，`readQueue` 读 `queue.jsonl`。

崩溃容忍由两个策略函数承担（`packages/core/src/storage/jsonl.ts`），事件流与队列共用：

- `readJsonl(file)`：文件缺失返回 `[]`；去掉末尾空行后逐行 `JSON.parse`；**最后一行**解析失败视为断尾崩溃产物，丢弃并停止；**中间任何一行**解析失败则抛错——崩溃不可能制造中间坏行，出现即意味着 bug 或外部破坏，静默跳过等于掩盖问题。
- `readJsonlFrom(file, since)`：`readJsonl` 的尾部读变体，供增量拉取（`SessionStore.readEventsFrom` / 审计页 `?since=`）。文件仍整体读入（JSONL 没有行偏移索引），但下标 `< since` 的行**不解析、不构建**，增量开销只随返回条数增长、与流的总长无关；已解析区域的损坏语义与 `readJsonl` 一致，跳过区的损坏不可见。`readJsonl` 就是 `readJsonlFrom(file, 0)`。
- `repairTornTail(file)` + `appendJsonlLine(file, value)`：每次追加前检查文件的最后一个字节——是 `\n` 说明上次干净结束；否则**先截断到上一个换行再追加**。截断点按**字节偏移**找（`Buffer.lastIndexOf(0x0a)`）：UTF-8 的多字节序列内部不会出现 0x0a（续字节都 ≥ 0x80），所以单字节探测可靠；如果改用解码后字符串的 indexOf，得到的是 UTF-16 码元下标，切点可能落在多字节字符中间，反而破坏上一行。文件不存在时修复是空操作。

会话的删除语义在 `SessionStore`：`delete()` 软删除（追加 `session.deleted` 事件，摘要置 `deleted: true, deletedAt`），`restore()` 恢复（追加 `session.restored` 事件），`purge()` 物理删除整个目录，`purgeExpired(ttlMs)` 清理过期的软删除会话（由 scheduler tick 周期调用）。

一条消息的完整持久化路径：

1. agent 循环产出消息 → run 装配（core `executeRun`）的 `onMessage` 钩子调 `sessions.appendMessage(sessionId, m)`。
2. `appendMessage` 经 `appendEvent` 往 events.jsonl 追加一条 `message` 事件：先 `repairTornTail`（末字节不是 `\n` 就按字节截断到上一个换行），再 `appendFileSync(JSON.stringify(event) + "\n")`，随后把事件汇入 meta.json 摘要（`applyEvent`）。
3. 回读时 `readMessages` 读全部事件后过滤出 `message` 事件，并**按 `message.truncated` 标记倒序收缩**：从流尾向前走，最近的截断标记就是"该消息之后第一个截断"，消息 id 不小于它即被丢弃（重试追加在标记之后的新消息不受旧起点约束）——这是唯一的过滤点，聊天视图、run 上下文组装、压缩与记忆提取全部继承同一份可见历史。`readMessages` 先丢弃断尾行，逐行解析成 `Message` 数组，作为下次运行的历史（run 装配在追加用户消息**之前**读历史，避免同一条消息发送两次）。

---

## 保存的权限规则（decided-rules）

用户在人工确认里选「总是允许」后保存下来的**收紧 allow 规则**（收紧与保存机制见 [permissions](./permissions.md)），**独立于会话目录**，落在两个 YAML 文件（`packages/core/src/storage/decided-rules.ts`）：

| 文件 | 作用域 | 写入方 |
|------|--------|--------|
| `<home>/permissions.yaml` | 全局档，任何工作区生效 | run 装配的确认缝合层（`packages/core/src/agent/run-assembly.ts` 的 `resolveConfirmation`，global 裁决时写入） |
| `<workspace>/.kclaw/permissions.yaml` | 项目档，只对该工作区的会话生效；首次保存时自动建 `.kclaw` 目录、把 `.kclaw/permissions.yaml` 追加进工作区 `.gitignore`（重复执行无副作用） | 同上（project 裁决）；auto 模式归纳的 `source:"auto"` 规则也在 run 装配层写入同一文件 |

格式（每条是一个 `DecidedRuleEntry`）：

```yaml
rules:
  - rule: "exec:git push*"        # 收紧后的规则（exec = 首词+子命令前缀；路径工具 = realpath 精确路径；其余 = 工具级）
    decidedAt: "2026-09-07T08:00:00.000Z"   # ISO-8601
    origin:                        # 触发裁决的出处
      tool: "exec"
      argsJson: '{"command":"git push origin main"}'
      sessionId: "ses_…"
    source: "auto"                 # 可选：auto 模式归纳（缺省/缺失 = 人工「总是允许」）
```

文件权限 0600、`writeFileAtomic` 原子写入；程序**从不写 config.yaml**（config.yaml 保持纯手写）。`source` 字段区分规则的两种来源——人工选「总是允许」（manual，缺省）与 auto 模式连续 `once` 裁决后的自动归纳（auto，见 [permissions](./permissions.md) 第 5 节）——它只是溯源标记，规则引擎不读它，加载与生效路径和手工规则完全一致。每个 run 由 `loadDecidedRulesForRun` 读入并合并成规则串数组传给权限 gate：全局档总是加载；项目档只在工作区已定义、文件存在且**未被 git 跟踪**时加载（`isGitTracked` 用 `git ls-files --error-unmatch` 探测，被 git 跟踪即整体忽略并在 daemon 日志告警——防止克隆来的仓库夹带一份预授权清单）。删掉文件里的条目（或整个文件）即收回授权，对下一个 run 立即生效。管理入口：`GET`/`DELETE /permissions/rules`（见 [http-api](../server/http-api.md)）与 WebUI「权限」页。

---

## 用量记录（`storage/usage.ts`）

`UsageStore` 是一张只追加、不修改的 SQLite 记录表（`<home>/usage.db`，表 `usage` + `at` 列索引）：daemon 每结束一个 run 就记一行 `{sessionId, runId, model, inputTokens, outputTokens, at}`，行主键为 `u_<sessionId>_<runId>`。记账发出后不等结果：RunManager 调用它时包了 try/catch，记录失败只打一行日志，用量统计永远不影响 run 本身。

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
- **成本公式**（`costUsd(row, model, prices)`）：`(input/1e6)·inputPerM + (output/1e6)·outputPerM`，价格表来自 `config.usage.prices`（美元 / 百万 token）；**模型没有价格条目时成本恒为 0**（token 数照常显示）。桶内成本逐行累加——每行用它自己模型的价格，即使桶的分组键是日期或会话。

HTTP 出口与展示见 [http-api](../server/http-api.md) 的 `GET /usage` 与 [webui](../web/webui.md) 的用量页。

---

## daemon.json 与 token（`packages/server/src/daemon.ts` / `auth.ts`）

- **`<home>/daemon.json`**：启动第一步以 `wx` 独占模式认领（先写占位 `{ port: 0, pid, startedAt, starting: true }`；发现存活 pid 就拒绝二次启动，发现死 pid 就回收文件重新认领），监听成功后回填真实 `{ port, pid, startedAt }`（startedAt 不变，移除 `starting`）。它是「该 home 下存在一个运行中的 daemon 及其端口」的存活标识。`stop()` 正常结束时删除；若某个停机步骤超时（默认 `DEFAULT_STOP_TIMEOUT_MS = 60000`），`stop()` 抛错且 daemon.json **保留**——进程还在运行，一条如实的记录比干净的目录更有用（CLI 靠它判断 daemon 状态，见 [daemon](../server/daemon.md)）。
- **`<home>/token`**：daemon 的 Bearer token（HTTP/WS 鉴权用；Bearer token 是放在请求头 `Authorization: Bearer <值>` 里的访问令牌）。`loadOrCreateToken` 读它，不存在则生成一个新 UUID 写入，**文件权限 0600（仅属主可读写）**。跨重启复用同一个 token——它是 daemon 的稳定身份，重启后已登录的客户端无需重新走引导流程。校验用 `timingSafeEqual` 常数时间比较（`bearerMatches`），不泄露比较耗时信息（防时序侧信道）。

---

## 边界与出错

- **meta.json 原子写**：`writeMeta` 经 `writeFileAtomic`（临时文件 + rename）写入，meta.json 本身不会被截断；崩溃最坏残留一个 `<meta.json>.tmp` 孤儿文件，不影响读取。
- **config 无结构校验**：见上文；写错类型（如 `confirmTimeoutMs: "30s"`）要到运行时才以意外方式失败。
- **SQLite 未开 WAL**：jobs.db、记忆的 `vectors.db`（每项目 + 全局各一个）与 usage.db 都用默认日志模式。单 daemon 进程同步访问（better-sqlite3）下安全；多进程并发写同一个 home 是明确不支持的用法。进程内的同一个 vectors.db 也只有 MemoryPipeline 一个连接（检索方借用句柄）。
- **KCLAW_HOME 只在 `resolvePaths` 读取一次**：核心层不缓存，但各调用方持有自己的解析结果；daemon 启动后改环境变量不影响已创建的路径。

---

## 关联

- [jobs](./jobs.md)：jobs.db 的表结构与轮询
- [compaction](./compaction.md)：压缩状态的存放位置（meta.compaction 摘要 + 事件流里的 compaction 事件）与压缩配置字段
- [memory](./memory.md)：memory 目录的两层塔布局（文件是真相、vectors.db 是派生物）与旧版迁移
- [protocol](./protocol.md)：Message / Block 的完整定义（message 事件的内容就是一个 Message）
- [daemon](../server/daemon.md)：daemon.json 的写入时机与停机流程、token 的鉴权链路
