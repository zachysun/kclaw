# storage — 路径、配置与会话持久化

## 职责

`packages/core/src/storage/` 是所有持久化的基础：`paths.ts` 解析 kclaw 的根目录与目录树（`KCLAW_HOME` 可整体重定向）；`config.ts` 读写 `config.yaml`（默认值深合并）；`jsonl.ts` 提供 append-only JSONL 文件（JSONL：一行一个 JSON 对象的文本格式）的追加/读取与崩溃修复，是会话日志 `messages.jsonl` 的底层机制。会话目录结构与 `meta.json` 由 `SessionStore`（`packages/core/src/session/store.ts`）负责，daemon.json / token 两个文件由 server 侧产生，本文一并说明它们的用途。

---

## 设计决策

- **单一根目录容纳全部状态**：所有状态（配置、会话、记忆、任务、附件、日志）都在同一个根目录下，根目录可整体重定向——解析顺序是：显式参数 > `KCLAW_HOME` 环境变量 > `~/.kclaw`。环境变量**空白字符串视为未设置**：用 `??` 判断时空串会被当成有效值，所有路径变成相对当前目录而不是回退到 `~/.kclaw`；这一规则源于一次实际故障的修正（`envHome()`）。
- **只建目录，不建文件**：`resolvePaths` 用 `mkdirSync(recursive)` 创建目录树，但 `config.yaml`、`jobs.db` 等文件只是路径字符串，不在这里创建——文件由各自的所有者在首次写入时产生（`SessionStore`/`MemoryStore`/`JobScheduler` 构造函数建目录并初始化自己的数据库）。
- **配置深合并、默认值永不污染**：`loadConfig` 把文件内容深合并到默认值上，且两个分支都从 `structuredClone(defaultConfig)` 开始——否则返回值与导出的 `defaultConfig` 共享嵌套引用，调用方任意一处 `cfg.permissions.allow.push()` 都会污染进程级默认值。合并规则（`deepMerge`）：普通对象按键递归，数组与标量整体替换，`undefined` 跳过，两个输入都不被修改。
- **配置无效时报错而非静默回退**：`config.yaml` 解析失败直接抛错（`invalid yaml in <path>: ...`），文件不是对象映射也抛错；**不做静默回退**——静默使用默认值意味着用户配置的权限规则在不提示的情况下失效，比启动失败更危险。文件缺失或内容为空则返回默认值（首次使用的正常路径）。
- **会话日志 append-only + 崩溃容忍**：消息只追加、从不改写历史行。崩溃窗口在"最后一行写到一半"（torn line，断尾行）：读取时丢弃断尾行（崩溃产物，最多丢失一条消息）；写新行之前先修复断尾，否则新行会拼接在半行之后，读取时**两条会一起被丢弃**。

---

## 目录树（`KclawPaths`）

```ts
// packages/core/src/storage/paths.ts
export function resolvePaths(home?: string): KclawPaths
```

| 路径 | 用途 | 写入方 |
|------|------|--------|
| `<home>/config.yaml` | 全部配置（见下节） | CLI 向导 `saveConfig`；用户手编 |
| `<home>/AGENTS.md` | agent 人格，非空则作为系统提示 | 用户手编；daemon 启动时读 |
| `<home>/memory/notes/` | 记忆 markdown，真相 | MemoryStore / 用户手编 |
| `<home>/memory/index.db` | 记忆 FTS5 索引，派生物 | MemoryStore |
| `<home>/sessions/<id>/` | 每会话一目录（meta.json + messages.jsonl） | SessionStore |
| `<home>/jobs.db` | 定时任务表 | JobScheduler |
| `<home>/attachments/<id>/` | 大附件外存目录 | v1 预留：目录会创建，当前代码无写入方 |
| `<home>/logs/` | 日志目录 | v1 预留：同上 |
| `<home>/daemon.json` | daemon 存活标识（server 侧） | `launchDaemon` |
| `<home>/token` | daemon 鉴权 token（server 侧） | `loadOrCreateToken` |

`attachments` 与 `logs` 两个目录在当前源码中只有路径创建、没有写入方——如实记录为预留。

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
| `memory.autoExtract` / `extractModel` | `false` / `""` | 预留：当前无消费方（见 [memory](./memory.md)） |
| `web.tavilyApiKey` | `""` | web_search 的 Tavily 密钥 |
| `exec.timeoutMs` / `maxOutputBytes` | `60000` / `102400`（100 KiB） | exec 工具超时与输出截断上限 |
| `sessions.recycleBinTtlMs` | `2592000000`（30 天） | 回收站保留期，scheduler tick 清理用（见 [jobs](./jobs.md)） |
| `workspace` | `process.cwd()` | 工具的工作目录；daemon 由启动方决定 cwd，会话可经 `meta.workdir` 覆盖 |

读（`loadConfig(paths)`）：缺失/空文件 → 默认值的克隆；YAML 语法错误或非映射结构 → 抛错；其余 → `deepMerge(defaults 克隆, 文件内容)`。**没有结构校验**：多余字段原样保留，字段类型错误在消费方才暴露。

写（`saveConfig(paths, config)`）：把 config 整个序列化成 YAML **整文件重写**（不是增量修改）。权限现状如实记录：`saveConfig` 不设置文件 mode（跟随系统默认，通常 0644 可被同机其他用户读取）；而 config.yaml 含 API key，所以 CLI 向导在 `saveConfig` 之后显式 `chmodSync(paths.config, 0o600)`（`packages/cli/src/wizard.ts`）——直接调用 `saveConfig` 的代码需要自行处理这一点。

---

## 接口

```ts
// packages/core/src/storage/paths.ts
export interface KclawPaths {
  home: string; config: string; agentsMd: string
  memoryDir: string; memoryNotesDir: string; memoryIndexDb: string
  sessionsDir: string; jobsDb: string; attachmentsDir: string; logsDir: string
}

// packages/core/src/storage/config.ts
export function loadConfig(paths: KclawPaths): KclawConfig
export function saveConfig(paths: KclawPaths, config: KclawConfig): void

// packages/core/src/storage/jsonl.ts
export function repairTornTail(file: string): void
export function appendJsonlLine(file: string, value: unknown): void
export function readJsonl(file: string): unknown[]
```

`KclawPaths` 每个字段的用途见上节目录树；`memoryDir` 本身无直接写入方（`memoryNotesDir` / `memoryIndexDb` 才是实际路径）。

---

## 会话目录与 messages.jsonl

每个会话一个目录 `<sessionsDir>/<id>/`，两个文件（`SessionStore`）：

- `meta.json`：`SessionMeta { id, title, createdAt, updatedAt, jobId?, workdir?, deleted?, deletedAt? }`，整文件重写更新（`updateMeta` 合并 patch、`undefined` 键删除、总是刷新 `updatedAt`）。
- `messages.jsonl`：一行一条 `Message`，append-only。追加消息时顺带重写 meta.json 刷 `updatedAt`。

`Message`（`packages/core/src/protocol/messages.ts`）基础字段 `{ id, sessionId, role: "user" | "assistant" | "tool", blocks, createdAt }`；assistant 消息额外带 `{ model, usage, stopReason }`，tool 消息额外带 `{ grantedBy? }`（callId → 放行原因）。id 前缀 `msg_` / `ses_`，ULID。

崩溃容忍的两个策略函数（`packages/core/src/storage/jsonl.ts`）：

- `readJsonl(file)`：缺失文件返回 `[]`；去掉完整追加留下的末尾空行后逐行 `JSON.parse`；**最后一行**解析失败视为断尾崩溃产物，丢弃并停止；**中间任何一行**解析失败则抛错——崩溃不可能制造中间坏行，那是 bug 或外部破坏，静默跳过等于掩盖问题。
- `repairTornTail(file)` + `appendJsonlLine(file, value)`：每次追加前检查最后一个字节，是 `\n` 说明上次干净结束；否则**先截断到上一个换行再追加**。截断点是**字节偏移**（`Buffer.lastIndexOf(0x0a)`）：UTF-8 的多字节序列内部不会出现 0x0a（续字节都 ≥ 0x80），所以单字节探测可靠；若用解码字符串的 indexOf 得到的是 UTF-16 码元下标，切点可能落在多字节字符中间，恰好破坏上一行。文件不存在时修复是 no-op。

会话的删除语义在 `SessionStore`：`delete()` 软删除（`deleted: true, deletedAt`），`restore()` 恢复，`purge()` 物理删除整个目录，`purgeExpired(ttlMs)` 清理过期软删除会话（由 scheduler tick 周期调用）。

一条消息的持久化路径（每条消息都经过这一流程）：

1. agent 循环产出消息 → `RunManager` 的 `onMessage` 调 `sessions.appendMessage(sessionId, m)`（`packages/server/src/run.ts`）。
2. `appendMessage` 经 `appendJsonlLine`：先 `repairTornTail`（末字节非 `\n` 则字节级截断到上一换行），再 `appendFileSync(JSON.stringify(message) + "\n")`。
3. 回读时 `readMessages` → `readJsonl`：丢弃断尾行，逐行解析成 `Message` 数组，作为下次运行的历史（`packages/server/src/run.ts` 的 `#execute` 在追加用户消息**之前**读历史，避免重复发送）。

---

## daemon.json 与 token（`packages/server/src/daemon.ts` / `auth.ts`）

- **`<home>/daemon.json`**：daemon 开始监听后写入 `{ port, pid, startedAt }`，是"该 home 下存在一个运行中的 daemon 及其端口"的存活标识。`stop()` 正常结束时删除；若某个停机步骤超时（默认 `DEFAULT_STOP_TIMEOUT_MS = 60000`），`stop()` 抛错且 daemon.json **保留**——进程仍在运行，一条如实的记录比干净的目录更有用（CLI 靠它判断 daemon 状态，见 [daemon](../server/daemon.md)）。
- **`<home>/token`**：daemon 的 Bearer token（HTTP/WS 鉴权，Bearer token 是放在请求头 `Authorization: Bearer <值>` 里的令牌）。`loadOrCreateToken` 读它，不存在则生成一个新 UUID 写入，**文件权限 0600（仅属主可读写）**。跨重启复用同一个 token——它是 daemon 的稳定身份，重启后已登录的客户端无需重新执行引导流程。校验用 `timingSafeEqual` 常数时间比较（`bearerMatches`），不泄露比较耗时信息。

---

## 边界与出错

- **meta.json 重写非原子**：写一半崩溃会留下截断的 meta.json，`meta()` 解析失败返回 undefined，该会话从列表消失（消息仍在 messages.jsonl 里，目录还在）——可接受的降级，v1 未做临时文件替换。
- **config 无结构校验**：见上；写错类型（如 `confirmTimeoutMs: "30s"`）在运行时才以意外方式失败。
- **SQLite 未开 WAL**：jobs.db 与 memory/index.db 都是默认日志模式。单 daemon 进程同步访问（better-sqlite3）下安全；多进程并发写同一 home 是 v1 明确不支持的用法。
- **KCLAW_HOME 只在 `resolvePaths` 读取一次**：核心层不缓存，但调用方各自持有解析结果；daemon 启动后改环境变量不影响已创建的路径。

---

## 关联

- [jobs](./jobs.md)：jobs.db 的表结构与轮询
- [memory](./memory.md)：memory 目录双轨与索引重建
- [protocol](./protocol.md)：Message / Block 的完整定义（messages.jsonl 每行即一个 Message）
- [daemon](../server/daemon.md)：daemon.json 的写入时机与停机流程、token 的鉴权链路
