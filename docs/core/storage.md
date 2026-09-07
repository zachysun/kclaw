# storage — 路径、配置与会话持久化

## 职责

`packages/core/src/storage/` 是所有持久化的基础：`paths.ts` 解析 kclaw 的根目录与目录树（`KCLAW_HOME` 可整体重定向）；`config.ts` 读写 `config.yaml`（默认值深合并）；`jsonl.ts` 提供 append-only JSONL 文件（JSONL：一行一个 JSON 对象的文本格式）的追加/读取与崩溃修复，是会话事件流 `events.jsonl`（唯一真相）与运行态队列 `queue.jsonl` 的底层机制。会话目录结构与 `meta.json` 由 `SessionStore`（`packages/core/src/session/store.ts`）负责，daemon.json / token 两个文件由 server 侧产生，本文一并说明它们的用途。

---

## 设计决策

- **单一根目录容纳全部状态**：所有状态（配置、会话、记忆、任务、附件、日志）都在同一个根目录下，根目录可整体重定向——解析顺序是：显式参数 > `KCLAW_HOME` 环境变量 > `~/.kclaw`。环境变量**空白字符串视为未设置**：用 `??` 判断时空串会被当成有效值，所有路径变成相对当前目录而不是回退到 `~/.kclaw`；这一规则源于一次实际故障的修正（`envHome()`）。
- **只建目录，不建文件**：`resolvePaths` 用 `mkdirSync(recursive)` 创建目录树，但 `config.yaml`、`jobs.db` 等文件只是路径字符串，不在这里创建——文件由各自的所有者在首次写入时产生（`SessionStore`/`MemorySystem`/`JobScheduler` 构造函数建目录并初始化自己的数据库）。
- **配置深合并、默认值永不污染**：`loadConfig` 把文件内容深合并到默认值上，且两个分支都从 `structuredClone(defaultConfig)` 开始——否则返回值与导出的 `defaultConfig` 共享嵌套引用，调用方任意一处 `cfg.permissions.allow.push()` 都会污染进程级默认值。合并规则（`deepMerge`）：普通对象按键递归，数组与标量整体替换，`undefined` 跳过，两个输入都不被修改。
- **配置无效时报错而非静默回退**：`config.yaml` 解析失败直接抛错（`invalid yaml in <path>: ...`），文件不是对象映射也抛错；**不做静默回退**——静默使用默认值意味着用户配置的权限规则在不提示的情况下失效，比启动失败更危险。文件缺失或内容为空则返回默认值（首次使用的正常路径）。
- **会话事件流 append-only + 崩溃容忍**：事件只追加、从不改写历史行（运行态队列 `queue.jsonl` 例外——整文件重写，见下节）。崩溃窗口在"最后一行写到一半"（torn line，断尾行）：读取时丢弃断尾行（崩溃产物，最多丢失一条事件）；写新行之前先修复断尾，否则新行会拼接在半行之后，读取时**两条会一起被丢弃**。

---

## 目录树（`KclawPaths`）

```ts
// packages/core/src/storage/paths.ts
export function resolvePaths(home?: string): KclawPaths
```

| 路径 | 用途 | 写入方 |
|------|------|--------|
| `<home>/config.yaml` | 全部配置（见下节） | CLI 向导 `saveConfig`；用户手编 |
| `<home>/permissions.yaml` | 全局沉淀权限规则（人工确认里选"总是允许"落盘的收窄 allow 规则；项目档在工作区 `.kclaw/permissions.yaml`，见下节） | server 的 WS 确认入口 `ws.ts`；用户手编亦可 |
| `<home>/AGENTS.md` | agent 人格，非空则作为系统提示；每次运行拼装的完整系统提示以 `system` 事件全量留痕 | 用户手编；daemon 启动时读 |
| `<home>/memory/global/` | L2 全局认知（persona.md、wiki/、rule/ 的 markdown，真相） | MemorySystem / 用户手编 |
| `<home>/memory/projects/<id>/` | L1 项目情节（`<topic>.md` 主题线、workdir.txt、MEMORY.md、state.json、vectors.db） | MemorySystem / 用户手编 |
| `<home>/memory/notes/`、`<home>/memory/index.db` | v1 遗留：前者是迁移输入（daemon 启动读后删除）、后者是被删除的 v1 派生物索引 | 仅 daemon 启动迁移（见 [memory](./memory.md)） |
| `<home>/skills/` | 全局技能包目录（每个子目录是一个技能，含 `SKILL.md`；项目级技能在工作区 `.kclaw/skills/`，见 [skills](./skills.md)） | 用户手编；每次 run 现扫读取 |
| `<home>/hooks/` | 用户钩子目录（每个文件是一个钩子，`export const hook` + default 函数；见 [hooks](./hooks.md)） | 用户手编；每次 run 现扫读取 |
| `<home>/sessions/<id>/` | 每会话一目录（events.jsonl + meta.json + queue.jsonl，分工见下节） | SessionStore（events.jsonl 为唯一真相、meta.json 为派生投影、queue.jsonl 为运行态整文件重写） |
| `<home>/jobs.db` | 定时任务表 | JobScheduler |
| `<home>/usage.db` | 每次 LLM 运行的 token 用量台账 | UsageStore |
| `<home>/attachments/<id>/` | 附件外存目录（每会话一个子目录） | server 上传路由 `routes/attachments.ts`；运行时只读挂载 |
| `<home>/logs/` | 日志目录 | 预留：目录会创建，当前代码无写入方 |
| `<home>/daemon.json` | daemon 存活标识（server 侧） | `launchDaemon` |
| `<home>/token` | daemon 鉴权 token（server 侧） | `loadOrCreateToken` |

`logs` 目录在当前源码中只有路径创建、没有写入方——如实记录为预留；`attachments` 由上传路由写入、由权限引擎的 readRoots 与附件挂载读取，见 [run-manager](../server/run-manager.md)。

---

## config.yaml 全量字段

`KclawConfig`（`packages/core/src/storage/config.ts`）与 `defaultConfig` 默认值：

| 字段 | 默认值 | 含义 / 消费方 |
|------|--------|---------------|
| `providers.default` | `""` | 默认 provider 名，指向 entries 里的一条 |
| `providers.entries` | `{}` | `Record<名, { baseUrl, apiKey, model }>`；daemon 启动时解析（config 优先，`KCLAW_LLM_BASE_URL` / `KCLAW_LLM_API_KEY` / `KCLAW_LLM_MODEL` 环境变量补空） |
| `providers.timeoutMs` | `120000` | 单次 LLM 请求超时（`DEFAULT_LLM_TIMEOUT_MS`）；可选字段仅为兼容旧配置文件 |
| `permissions.allow` / `deny` | `[]` / `["exec:sudo*", "exec:rm -rf*"]` | 权限规则，见 [permissions](./permissions.md) |
| `permissions.confirmTimeoutMs` | `120000` | 人工确认等待上限，超时按拒绝处理 |
| `permissions.sessionGrants` | `true` | 会话内"本次允许"记忆是否生效 |
| `memory.write.{immediate, manual, intervalMinutes, idleMinutes}` | `true` / `true` / `30` / `10` | 记忆写入触发开关（immediate/manual/clear/interval/follow 五触发，clear 挂在 `POST /sessions` 无独立开关）：immediate = `memory_save` 工具当场触发；manual = 手动触发开关（`/memory save`（CLI/web）走 `POST /memory/trigger-manual`，`false` 时该路由返回 400）；intervalMinutes = 定时兜底间隔（0 关闭）；idleMinutes = 跟随门禁空闲分钟（0 关闭）。完整语义见 [memory](./memory.md) |
| `memory.extractModel` / `threadInactiveDays` / `consolidate` / `consolidateHour` | `""` / `14` / `true` / `3` | 提取/内化用的模型（空回落主对话模型）、线闲置多少天自动转 inactive、内化开关、夜间闲时内化的本地小时（负值关闭） |
| `memory.embedding.{provider, model}` | `""` / `""` | 向量检索判定链：`model` 空则向量路整体关闭（纯 BM25）；provider 空回落 default 条目 |
| `memory.injectTokenBudget` | `1000` | 每轮 L2 认知常驻注入的 token 上限（只约束常驻注入，L1 情节 top-5 全量注入不受此限） |
| `memory.autoExtract` | 无（废弃） | v1 字段，被五触发取代，已废弃不生效：配置文件里存在时不报错，但读处一律忽略 |
| `web.tavilyApiKey` | `""` | web_search 的 Tavily 密钥 |
| `web.timeoutMs` | `20000` | 每次网络抓取（搜索与网页）的 AbortSignal 超时，卡死的主机不能拖住一个 run |
| `web.allowPrivateNetworks` | `false` | `true` 时豁免 web_fetch 的私网/回环目标拒绝（SSRF 防护，如允许抓本机 Ollama 端点），由 run 装配传入工具 |
| `usage.prices` | `{}` | 模型 → `{inputPerM?, outputPerM?}`：每百万 token 的美元单价，用量台账算成本用；缺条目的模型成本按 0 |
| `mcp.servers` | `{}` | 外部 MCP server 配置表（stdio/http 两种形态），daemon 启动时据此装配 McpManager（见 [mcp](./mcp.md)） |
| `exec.timeoutMs` / `maxOutputBytes` | `60000` / `102400`（100 KiB） | exec 工具超时与输出截断上限 |
| `sandbox.enabled` / `writeRoots` | `true` / `[]` | exec 沙箱整体开关与追加写白名单（realpath 形态），见 [sandbox](./sandbox.md)；可选字段仅为兼容旧配置文件 |
| `sessions.recycleBinTtlMs` | `2592000000`（30 天） | 回收站保留期，scheduler tick 清理用（见 [jobs](./jobs.md)） |
| `sessions.contextTokens` / `compactAtRatio` / `compactPanicRatio` / `compactTargetRatio` / `toolResultKeep` | `128000` / `0.66` / `0.85` / `0.33` / `8` | 上下文压缩 v2/v3（见 [compaction](./compaction.md)）：token 预算、触发线（估算发送量达预算 × 0.66 即压缩）、红线（运行中水位达预算 × 0.85 时在迭代边界触发中途压缩）、压缩后保留部分目标（预算 × 0.33）、发送时保留最近几个工具结果原文。五个字段均可选，缺省值在读取处兜底（前四个在 run 装配 core `executeRun`，`compactTargetRatio` 在压缩引擎 `Compactor`） |
| `sessions.defaultDisposition` | `"steer"` | 不带 disposition 的 send_message 的默认处置（见 [run-manager](../server/run-manager.md)）；会话可经 `meta.dispositionOverride` 覆盖 |
| `sessions.compactThreshold` / `compactKeep` | 无（废弃） | v1 压缩（40 条触发、保留 25 条）的字段，已废弃不生效：配置文件里存在时不报错，但没有任何消费方 |
| `notify.channels` | `[]` | job 终态通知渠道列表；为空即关闭（零开销）。条目 `{ name?, type, url, template? }`，`type` 三种：`bark`（POST JSON `{title, body}`）、`serverchan`（POST 表单 `title`+`desp`）、`webhook`（POST JSON，正文含 title/body 及全部 job 字段）。`template` 占位符：`{{job}}` `{{statusText}}` `{{status}}` `{{summary}}` `{{sessionId}}` `{{sessionUrl}}`，未知占位符渲染为空串 |
| `notify.timeoutMs` | `10000` | 单次推送请求超时；推送失败仅记日志、不重试 |
| `hooks.timeoutMs` | `5000` | 单个钩子 handler 的执行预算（毫秒），超时按失败处理（用户钩子 skip、内置 fatal，见 [hooks](./hooks.md)）；可选字段，缺省值在钩子链构建处兜底 |
| `workspace` | `process.cwd()` | 工具的工作目录；daemon 由启动方决定 cwd，会话可经 `meta.workdir` 覆盖 |

读（`loadConfig(paths)`）：缺失/空文件 → 默认值的克隆；YAML 语法错误或非映射结构 → 抛错；其余 → `deepMerge(defaults 克隆, 文件内容)`。**没有结构校验**：多余字段原样保留，字段类型错误在消费方才暴露。

写（`saveConfig(paths, config)`）：把 config 整个序列化成 YAML **整文件原子重写**——`writeFileAtomic(paths.config, stringify(config), 0o600)`（`storage/atomic.ts`：先写 `<path>.tmp` 再 rename，POSIX 同目录 rename 原子；mode 0600，因文件含明文 API key）。CLI 向导保存后仍保留一次显式 `chmodSync(0o600)`（双保险，见 [onboarding](../cli/onboarding.md)）。

---

## 接口

```ts
// packages/core/src/storage/paths.ts
export interface KclawPaths {
  home: string; config: string; agentsMd: string
  skillsDir: string               // <home>/skills —— 全局技能包目录（见 skills.md）
  memoryDir: string; memoryNotesDir: string; memoryIndexDb: string
  sessionsDir: string; jobsDb: string; usageDb: string
  attachmentsDir: string; logsDir: string
}

// packages/core/src/storage/config.ts
export function loadConfig(paths: KclawPaths): KclawConfig
export function saveConfig(paths: KclawPaths, config: KclawConfig): void

// packages/core/src/storage/jsonl.ts
export function repairTornTail(file: string): void
export function appendJsonlLine(file: string, value: unknown): void
export function readJsonl(file: string): unknown[]
```

`KclawPaths` 每个字段的用途见上节目录树；`memoryDir` 是 v2 记忆塔的根（MemorySystem 在它下面建 `global/` 与 `projects/`，见 [memory](./memory.md)）；`memoryNotesDir` / `memoryIndexDb` 是 v1 遗留路径——daemon 启动时把 `notes/` 当作迁移输入读取后删除、`index.db` 直接删除，不再有写入方。

---

## 会话目录与 events.jsonl

每个会话一个目录 `<sessionsDir>/<id>/`，三个文件，由 `SessionStore`（`packages/core/src/session/store.ts`）统一管理：

- `events.jsonl`：**唯一真相**，append-only 事件流，一行一个 `SessionEvent`（JSON 序列化）。共 9 种事件：会话生命周期 `session.created` / `session.renamed` / `session.deleted` / `session.restored` / `session.set`（model / mode / disposition 的会话级设置；旧 `readonly` 布尔字段是 legacy，读取时映射为 mode），外加内容类 `message`（一条消息）、`compaction`（一次压缩审计）、`memory`（一次记忆落盘审计）、`system`（一条系统提示词审计，每次对话运行落一条拼装完成的全文）。所有写入都先落事件，再把事件折进 meta.json 投影（见下）。
- `meta.json`：**派生投影**（`SessionMeta`），由事件流经 `applyEvent` 逐条折叠得出；meta.json 缺失或损坏时 `meta()` 自动从事件流重建（`rebuildMeta`），任何时候删掉它也能重建。崩溃恢复时允许它滞后于事件流（meta 只是投影、非真相，不会丢数据）；滞后不会被后续写入自动追平——`appendEvent` 先读当前投影、只折入新事件——仅在 meta.json 缺失或损坏时经 `rebuildMeta` 重放整条事件流整流。整文件原子重写（`updateMeta` 合并 patch、`undefined` 键删除；`message` / `compaction` 事件会推进投影的 `updatedAt`，`memory` / `system` 事件不推进）。
- `queue.jsonl`：**运行态**排队消息（`{ messageId, disposition, text, trigger, attachments?, note?, enqueuedAt }`，顺序即执行顺序，见 [run-manager](../server/run-manager.md) 的消息队列）。与事件流不同——`replaceQueue` 每次**整文件重写**，不是 append-only；不参与 meta.json。

`meta.json` 字段：`SessionMeta { id, title, createdAt, updatedAt, jobId?, workdir?, model?, mode?, deleted?, deletedAt?, compactedSummary?, compactedUpto?, compaction?, dispositionOverride? }`，其中 `model` 为会话级模型覆盖（空/缺省回落 daemon 默认）、`mode` 为会话权限模式（`"readonly" | "default" | "acceptEdits"`，缺省 default；旧 `readonly` 布尔读出时映射为 `mode:"readonly"` 并删除布尔键，写入端只产 `mode`，见 [permissions](./permissions.md)）；`compaction` 是分层压缩状态 `{ segments, top, upto }`（语义见 [compaction](./compaction.md)），由 `compaction` 事件投影（每次压缩把新段折进 `segments`，`updateMeta` 不再直接合并它）；`compactedSummary`/`compactedUpto` 是 v1 压缩的遗留字段——不再被清除，但运行侧读压缩视图时 `compaction` 优先（压缩引擎 `Compactor` 的 `compact` 里 `prev` 先读 `compaction`，见 [compaction](./compaction.md)），两者并存无功能影响；`dispositionOverride` 是会话级处置覆盖（`"steer" | "wait" | "interrupt"`，优先于 `sessions.defaultDisposition`；服务端路由仍接受三值写入，但客户端当前只写 steer/wait——interrupt 在 Web 与 CLI 都是一次性动作、不落覆盖，`"interrupt"` 值只会来自历史遗留，见 [webui](../web/webui.md) 与 [run-manager](../server/run-manager.md)）。

`Message`（`packages/core/src/protocol/messages.ts`）基础字段 `{ id, sessionId, role: "user" | "assistant" | "tool", blocks, createdAt }`；assistant 消息额外带 `{ model, usage, stopReason }`，tool 消息额外带 `{ grantedBy? }`（callId → 放行原因）。id 前缀 `msg_` / `ses_`，ULID。`messages` / `compactions` 现在是事件流的**只读投影视图**：`readMessages` 从事件流过滤出 `message` 事件、`readCompactions` 过滤出 `compaction` 事件，`readQueue` 读 `queue.jsonl`。

崩溃容忍的两个策略函数（`packages/core/src/storage/jsonl.ts`），事件流与队列共用：

- `readJsonl(file)`：缺失文件返回 `[]`；去掉完整追加留下的末尾空行后逐行 `JSON.parse`；**最后一行**解析失败视为断尾崩溃产物，丢弃并停止；**中间任何一行**解析失败则抛错——崩溃不可能制造中间坏行，那是 bug 或外部破坏，静默跳过等于掩盖问题。
- `repairTornTail(file)` + `appendJsonlLine(file, value)`：每次追加前检查最后一个字节，是 `\n` 说明上次干净结束；否则**先截断到上一个换行再追加**。截断点是**字节偏移**（`Buffer.lastIndexOf(0x0a)`）：UTF-8 的多字节序列内部不会出现 0x0a（续字节都 ≥ 0x80），所以单字节探测可靠；若用解码字符串的 indexOf 得到的是 UTF-16 码元下标，切点可能落在多字节字符中间，恰好破坏上一行。文件不存在时修复是 no-op。

会话的删除语义在 `SessionStore`：`delete()` 软删除（追加 `session.deleted` 事件，投影置 `deleted: true, deletedAt`），`restore()` 恢复（追加 `session.restored` 事件），`purge()` 物理删除整个目录，`purgeExpired(ttlMs)` 清理过期软删除会话（由 scheduler tick 周期调用）。

一条消息的持久化路径（每条消息都经过这一流程）：

1. agent 循环产出消息 → run 装配（core `executeRun`）的 `onMessage` 钩子调 `sessions.appendMessage(sessionId, m)`。
2. `appendMessage` 经 `appendEvent` 落一条 `message` 事件到 events.jsonl：先 `repairTornTail`（末字节非 `\n` 则字节级截断到上一换行），再 `appendFileSync(JSON.stringify(event) + "\n")`，随后把事件折进 meta.json 投影（`applyEvent`）。
3. 回读时 `readMessages` → `readEvents` 后过滤 `message` 事件：丢弃断尾行，逐行解析成 `Message` 数组，作为下次运行的历史（run 装配 core `executeRun` 在追加用户消息**之前**读历史，避免重复发送）。

---

## 沉淀权限规则文件（decided-rules）

人工在确认里选"总是允许"后落盘的**收窄 allow 规则**（机制见 [permissions](./permissions.md)），**独立于会话容器**，两个 YAML 文件（`packages/core/src/storage/decided-rules.ts`）：

| 文件 | 作用域 | 写入方 |
|------|--------|--------|
| `<home>/permissions.yaml` | 全局档，任何工作区生效 | server 的 WS 确认入口（`packages/server/src/ws.ts`，global 裁决） |
| `<workspace>/.kclaw/permissions.yaml` | 项目档，只对该工作区的会话生效；首次落盘自动建 `.kclaw` 目录、把 `.kclaw/permissions.yaml` 追加进工作区 `.gitignore`（幂等） | 同上（project 裁决） |

格式（每条是一个 `DecidedRuleEntry`）：

```yaml
rules:
  - rule: "exec:git push*"        # 收窄后的规则（exec = 首词+子命令前缀；路径工具 = realpath 精确路径；其余 = 工具级）
    decidedAt: "2026-09-07T08:00:00.000Z"   # ISO-8601
    origin:                        # 触发裁决的出处
      tool: "exec"
      argsJson: '{"command":"git push origin main"}'
      sessionId: "ses_…"
```

文件权限 0600、`writeFileAtomic` 原子写入；程序**从不写 config.yaml**（config.yaml 保持纯手写面）。每 run 由 `loadDecidedRulesForRun` 读入合并为规则串数组传给权限 gate：全局档恒载；项目档仅当工作区已定义、文件存在且**未被 git 跟踪**时载入（`isGitTracked` 用 `git ls-files --error-unmatch` 探测，tracked 即整体忽略并在 daemon 日志告警——克隆来的仓库无法夹带一份预授权清单）。删除文件里的条目（或整个文件）即收回授权，对下一个 run 立即生效。管理入口：`GET`/`DELETE /permissions/rules`（见 [http-api](../server/http-api.md)）与 WebUI「权限」页。

---

## 用量台账（`storage/usage.ts`）

`UsageStore` 是一张只追加、不修改的 SQLite 台账（`<home>/usage.db`，表 `usage` + `at` 列索引）：daemon 每结束一个 run 就记一行 `{sessionId, runId, model, inputTokens, outputTokens, at}`，行主键为 `u_<sessionId>_<runId>`。记账发出后不等结果：RunManager 调用它时包了 try/catch，记录失败只打一行日志，用量统计永远不影响 run 本身。

```ts
export interface UsageAgg { key: string; inputTokens: number; outputTokens: number; costUsd: number }

class UsageStore {
  record(row: Omit<UsageRow, "id">): void
  aggregate(by: "day" | "session" | "model", prices, from?, to?): UsageAgg[]
  total(prices, from?, to?): { inputTokens; outputTokens; costUsd }
  close(): void
}
```

- **三种聚合桶**：`day`（`at` 的本地日历日 `YYYY-MM-DD`）、`session`（sessionId）、`model`；区间 `[from, to)` 对 ISO `at` 字符串做比较，结果按 key 升序。
- **成本公式**（`costUsd(row, model, prices)`）：`(input/1e6)·inputPerM + (output/1e6)·outputPerM`，价格表来自 `config.usage.prices`（美元 / 百万 token）；**模型无价格条目时成本恒为 0**（token 照常显示）。桶内成本逐行累加——每行用自己模型的价格，即便桶键是日期或会话。

HTTP 出口与展示见 [http-api](../server/http-api.md) 的 `GET /usage` 与 [webui](../web/webui.md) 的用量页。

---

## daemon.json 与 token（`packages/server/src/daemon.ts` / `auth.ts`）

- **`<home>/daemon.json`**：启动第一步以 `wx` 独占认领（占位 `{ port: 0, pid, startedAt, starting: true }`；存活 pid 拒绝二次启动，死 pid 回收重认领），listen 成功后回填真实 `{ port, pid, startedAt }`（同一 startedAt，`starting` 移除），是"该 home 下存在一个运行中的 daemon 及其端口"的存活标识。`stop()` 正常结束时删除；若某个停机步骤超时（默认 `DEFAULT_STOP_TIMEOUT_MS = 60000`），`stop()` 抛错且 daemon.json **保留**——进程仍在运行，一条如实的记录比干净的目录更有用（CLI 靠它判断 daemon 状态，见 [daemon](../server/daemon.md)）。
- **`<home>/token`**：daemon 的 Bearer token（HTTP/WS 鉴权，Bearer token 是放在请求头 `Authorization: Bearer <值>` 里的令牌）。`loadOrCreateToken` 读它，不存在则生成一个新 UUID 写入，**文件权限 0600（仅属主可读写）**。跨重启复用同一个 token——它是 daemon 的稳定身份，重启后已登录的客户端无需重新执行引导流程。校验用 `timingSafeEqual` 常数时间比较（`bearerMatches`），不泄露比较耗时信息。

---

## 边界与出错

- **meta.json 原子写**：`writeMeta` 经 `writeFileAtomic`（临时文件 + rename）落盘，meta.json 本身不会被截断；崩溃最坏残留 `<meta.json>.tmp` 孤儿文件，不影响读取。
- **config 无结构校验**：见上；写错类型（如 `confirmTimeoutMs: "30s"`）在运行时才以意外方式失败。
- **SQLite 未开 WAL**：jobs.db、memory 的 `vectors.db`（每项目 + 全局各一个）与 usage.db 都是默认日志模式。单 daemon 进程同步访问（better-sqlite3）下安全；多进程并发写同一 home 是明确不支持的用法。进程内的同一 vectors.db 也只有 MemoryPipeline 一个连接（检索方借句柄）。
- **KCLAW_HOME 只在 `resolvePaths` 读取一次**：核心层不缓存，但调用方各自持有解析结果；daemon 启动后改环境变量不影响已创建的路径。

---

## 关联

- [jobs](./jobs.md)：jobs.db 的表结构与轮询
- [compaction](./compaction.md)：压缩状态的落点（meta.compaction 投影 + 事件流里的 compaction 事件）与 v2 配置字段
- [memory](./memory.md)：memory 目录的三层塔布局（文件是真相、vectors.db 是派生物）与 v1 迁移
- [protocol](./protocol.md)：Message / Block 的完整定义（message 事件即一个 Message）
- [daemon](../server/daemon.md)：daemon.json 的写入时机与停机流程、token 的鉴权链路
