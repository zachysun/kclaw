# memory — 记忆存储（v2）

## 职责

`MemorySystem`（`packages/core/src/memory/system.ts`）是记忆系统 v2 的唯一服务端门面，它把三类文件级能力装配在一起：**L1 项目情节**（按项目分目录的主题线文件）、**L2 全局认知**（跨项目的画像/知识/规则文件）、以及两套**派生检索索引**（SQLite FTS5 全文索引 + 可选的向量索引）。一条记忆就是一份 markdown 文件，用户可以直接打开查看、修改、删除；索引永远只是派生物，删掉可以重建。

模型通过 `memory_save` / `memory_search` 两个工具读写（`packages/core/src/tools/memory.ts`）；daemon 在每次 run 时做两级注入——L2 认知常驻系统提示、L1 情节作为 note 挂到用户消息上（见下文"检索与注入"）。daemon 的 `MemorySystem` 装配、v1 迁移、embedding 判定链都在 `packages/server/src/daemon.ts`。

本页是 v2 的完整说明。v1（`memory/notes/*.md` + 单库 `memory/index.db`、`memory_save` 直接存正文、注入用前 200 字符检索 top-5）已被取代；旧数据的迁移路径见文末"迁移说明"。

## 三层塔

记忆从"原始对话"到"可注入的长期记忆"分三层沉淀（spec 2.1）：

```
         ┌──────────────────────────────────┐
   L2    │  全局认知 global/（persona/wiki/rule） │  ← 跨项目，token 预算内整文件注入系统提示
         ├──────────────────────────────────┤
   L1    │  项目情节 projects/<id>/（<topic>.md）│  ← 按项目分目录，检索 top-N 以 note 注入
         ├──────────────────────────────────┤
   L0    │  原始对话（会话目录 messages.jsonl）  │  ← 不在这里，见 [compaction](./compaction.md)
         └──────────────────────────────────┘
```

- **L0 原始对话**：每轮对话的消息历史，留在会话目录，不属于记忆系统（记忆塔只记"提取后的沉淀"；压缩/检索它的机制见 [compaction](./compaction.md)）。
- **L1 项目情节**：一次 run 收尾后，管线从该项目全部会话的新消息里**提取**出值得长期记住的"情节"，按主题（topic）追加到该项目的主题线文件里。项目即工作目录（workdir），项目 id 由目录名与绝对路径决定（见下节）。
- **L2 全局认知**：一条主题线被判定"已收束"（inactive）后，管线把它的全部情节**内化**成跨项目的认知——用户画像（persona）、领域知识（wiki）、用户规则（rule）三类文件。全局认知按 `scope` 字段区分"全项目可见"与"仅某项目可见"。

## 设计决策

- **文件是真相，索引是派生物**：`<projectDir>/<topic>.md`（情节）与 `global/*.md`（认知）是唯一权威数据；`vectors.db`（FTS5 + 向量）任何时候删除都无损失——daemon 启动时 `reconcile()` 对全项目库与全局库重建索引（`packages/core/src/memory/pipeline.ts`），检索命中后也从线文件/认知文件回读正文。因此人工修改、删除文件始终生效，索引最多短暂滞后。这与 v1 的"文件是真相"一脉相承，只是文件结构与索引粒度变了。
- **为什么 markdown 而不是只存 SQLite**：记忆的价值一半在于人工可维护——用户可以直接用编辑器修改、git 可以版本化、grep 可以检索。双轨的成本（维护对账）换来的是"人工写入与机器写入是同一份数据"。
- **机器只改不删**：写入管线只有追加、改写、收束三种动作，没有任何删除；删除只发生在人工路径（管理界面或直接删文件）。这一条贯穿生命周期（见下）。
- **防覆盖写**：任何一次机器写入（追加情节、内化认知）都以"当前磁盘上的最新内容"为基准重解析后合并（`writeThreadFile` / `writeCognitionFile`），人工改动先被重解析再合并、永不静默丢失；文件存在但不可解析（如人工手写无 frontmatter）时**抛错不覆盖**——宁可不写也不丢数据。
- **中文分词必须自己做**：FTS5 默认的 unicode61 分词器把连续中文当成一个不可拆的 token，查"上海"永远无法命中"用户在上海工作"。索引和查询共用一个自写分词器 `tokenize`（`packages/core/src/text/fts.ts`）：ASCII 字母数字串按整词（转小写），CJK 连续串拆成相邻两字组合（bigram）——"用户在上海工作"拆成 `用户 户在 在上 上海 海工 工作`。一到两个字的中文查询本身就是合法 bigram，直接命中；更长的查询按 bigram 之间 OR 召回（`searchFts` 用 ` OR ` 连接，任一 bigram 命中即召回，bm25 把命中更多 token 的条目排更前）——检索是**召回优先**，模型侧二次判断，不是 AND 精确。每个 token 用引号包裹后拼进 MATCH 串（`ftsQuery`），杜绝把用户输入当成检索语法注入。
- **两层索引同构**：项目库与全局库共用同一个 `VectorIndex`（`packages/core/src/memory/indexer.ts`）——`entries`（元数据）+ `entries_fts`（分词 token 串）+ `vectors`（可选向量）三张表，只是条目形状不同（情节条目 key = `topic#date#heading`，认知条目 key = `kind/name`）。

## 目录布局与文件格式

```
<home>/memory/
├── global/                      # L2 全局认知（跨项目）
│   ├── persona.md               # 用户画像（单文件；管理界面不可删除，只能清空正文）
│   ├── wiki/                    # 领域知识，一个主题一个文件
│   │   └── <name>.md
│   ├── rule/                    # 用户规则，一个域一个文件
│   │   └── <name>.md
│   └── vectors.db               # L2 检索索引（FTS5 + 向量，派生物，可删可重建）
└── projects/
    └── <id>/                    # 项目 id = <目录名>-<绝对路径 SHA-1 前 6 位>（spec 2.1）
        ├── workdir.txt          # 人可读的目录映射（项目首次产生记忆时落盘）
        ├── MEMORY.md            # 主题线索引表（派生物，机器重建）
        ├── state.json           # 水位账本 + 跟随检查 + intervalLastRun（见"写入管线"）
        ├── vectors.db           # L1 检索索引（FTS5 + 向量，派生物）
        └── <topic>.md           # 主题线文件（唯一权威情节数据）
```

项目 id 的生成规则（`packages/core/src/memory/layout.ts` 的 `projectIdFor`）：取工作目录的绝对路径做 SHA-1，用前 6 位十六进制，再拼上目录名（目录名为空时回落 `project`），例如 `my-repo-a1b2c3`。确定性、可读、基本唯一——但注意它依赖绝对路径，**整个工作目录移动后 id 会变化、旧项目记忆不再自动跟随**（这是已知取舍，见"边界与出错"）。

`MEMORY.md` 是机器生成的线索引表（`renderMemoryMd`），每行一列：`| topic | 一句话 | 状态 | 最近活动 |`；它只是方便人与工具快速浏览，真正的内容在各 `<topic>.md`。

### 主题线文件（L1）

线文件是"一条主题线的全部情节"，frontmatter 后按日期分小节（`parseThreadFile` / `renderThreadFile`，`packages/core/src/memory/threads.ts`）：

```markdown
---
topic: deploy
title: 部署流程
status: active
created: 2026-08-28
updated: 2026-08-30
---

## 2026-08-28 · 首次上线

（情节正文：做了什么 / 结果 / 说了什么 / 有何要求）

## 2026-08-30 · 扩容

（追加的新情节）
```

- frontmatter 字段：`topic`（线名，即文件名去 `.md`）、`title`（人可读一句话）、`status`（`active`/`inactive`）、`created`/`updated`（日期）。`## YYYY-MM-DD · 标题` 起始新小节，标题取自情节正文首行。
- 解析宽容：首行不是 `---`、frontmatter 未闭合或 yaml 解析失败的文件视为"不是线文件"（不进索引、不参与检索）；`status` 非 `inactive` 一律按 `active` 读。
- 追加（`appendSection`）：新建小节不覆盖历史；修正（`updateSection`）：就地改写指定小节、找不到时退化为追加。

### 认知文件（L2）

```markdown
---
title: 画像
scope: global
created: 2026-08-28
updated: 2026-08-30
---

（正文）
```

`scope` 只有两种取值：`global`（所有项目可见）与 `project:<id>`（仅注入到该项目）。`title` 缺省用文件名；`kind`（persona/wiki/rule）由所在位置决定——`persona.md` 是固定文件，`wiki/`、`rule/` 下每个 `.md` 一个认知。

## 写入管线（MemoryPipeline）

管线位于 `packages/core/src/memory/pipeline.ts`，对外只暴露一个入口 `runTrigger(workdir, trigger)`。一次触发做四件事：

1. **选范围**：取该项目全部会话在"水位"之后的新消息（见下节"水位账本"）；
2. **提取**：无工具 LLM 调用，把范围渲染成逐行文本 + 现有主题线清单（MEMORY.md 表格），交给固定 system 提示的提取器（`EXTRACT_SYSTEM_PROMPT`），要求只输出 JSON `{"actions":[...]}`——动作三选一：`append`（接到已有线）、`update`（修正已有线某小节）、`new-thread`（开新线），并允许显式 `status:"inactive"`（明确的完成结论）；噪音直接跳过，无值得记的内容输出 `{"actions":[]}`；
3. **落盘**：逐条应用动作（追加/改写/开线），期间不阻塞地广播 `memory.written` 事件（见"事件"）；
4. **收尾**：推进水位、扫描时间自动收束（见"生命周期"）、顺带内化检查、重建项目索引与 MEMORY.md。

提取用的模型取 `memory.extractModel`，为空回落主对话模型；响应不是合法 JSON 或解析结果非 `actions` 数组时**整批放弃**、只打日志，不做部分写入。**提取失败水位不推进**——下一次触发会重试同一范围（spec 11）。

### 四触发

| 触发 | 入口 | 范围 | 说明 |
|------|------|------|------|
| **immediate**（立即） | `memory_save` 工具 → `system.triggerImmediate(sessionId)` | 覆盖到当前时刻 | 模型在对话中主动要求"记下来"，当场处理当前这轮对话；`memory.write.immediate=false` 时工具返回固定提示、内容留给后台触发沉淀 |
| **manual**（手动） | `MemorySystem.triggerManual(workdir)` | 覆盖到当前时刻 | 目前**没有用户入口**——CLI `/memory` 只做只读查看、web 记忆页只做文件编辑，`triggerManual` 在 core 层预留、尚未被任何路由/工具暴露（见"已知取舍"） |
| **interval**（定时） | `memory-scheduler`（默认每 60s 扫一次） | 两个水位中较靠后的增量 | 距上次定时触发满 `memory.write.intervalMinutes` 分钟就触发一次（0 关闭）；上次时间落在 `state.json` 的 `intervalLastRun`，未触发过则立刻首跑 |
| **follow**（跟随） | run 收尾挂起检查 + 门禁判定 | 两个水位中较靠后的增量 | 每个 run 结束（任何 stopReason）由 RunManager 挂一个跟随检查；`end_turn` 之后满 `memory.write.idleMinutes` 分钟无新活动才真正触发（0 关闭），见下 |

**手动/立即覆盖到当前时刻**（`advanceAll` 把两个水位一并推进），定时/跟随只取增量——任何一个先跑到，另一个都不会重复提取同一段消息（spec 4.1）。

**跟随门禁**（spec 4.2）：run 收尾时 `scheduleFollowCheck` 把 `{sessionId, endTurnAt}` 写进该项目的 `state.json`（挂起检查落盘，spec 11——daemon 重启后由调度器首次 sweep 补查）。调度器每次扫描时对每个挂起检查判门禁：`now − endTurnAt ≥ idleMinutes` **且** `endTurnAt 之后项目无新活动`才算 due，due 才真正触发 follow 并清除检查；门禁不过但 `endTurnAt` 之后已有更新活动（用户切到别的会话继续对话、或该项目又跑了一轮）时，旧检查的锚点已被新活动取代，直接清掉，防止 `state.json` 的 followChecks 无界增长。这里的"项目最后活动时间"取**该项目全部会话 meta 的最大 `updatedAt`**（spec 允许 daemon 记最后活动时间，本实现选会话级聚合，无需新表）；空活动记录视作"end_turn 即最后活动"，保证重启后可补查。

### 水位账本与串行锁

`state.json` 每项目一本（`WriteLedger`，`packages/core/src/memory/ledger.ts`），内容：

```json
{
  "watermarks": { "interval": { "sessionId": "…", "messageId": "…" },
                  "follow":   { "sessionId": "…", "messageId": "…" } },
  "followChecks": [ { "sessionId": "…", "endTurnAt": "…" } ],
  "intervalLastRun": "2026-08-30T00:00:00.000Z"
}
```

- **水位（watermark）**是 `{sessionId, messageId}` 游标：定时/跟随触发从两个水位中较靠后的那个取增量（`laterWatermark`），任一触发先跑到，另一个都不再重复提取；水位所在的会话或消息已被删除时按"更旧"处理——`messagesSince` 对删掉的会话退化为全量，**宁可重提取不可漏提取**。
- **串行锁**：项目级——`MemoryPipeline` 对同一项目维护一个 promise 链（`#locks`），同项目的触发（含内化）排队执行，避免两个触发并发读写同一批线文件；全局级——写 L2 认知文件时再套一层模块级全局锁（`withL2Lock`），跨项目并发内化撞同一认知文件也串行化。调度器的每次扫描本身不等待触发完成（fire-and-forget + 防重入）。

### 内化（consolidate）

一条主题线被收束为 `inactive` 后，管线顺带对它做一次**内化总结**（spec 6）：无工具 LLM 调用，把线文件全部情节 + 现有认知文件内容交给固定 system 提示的内化器（`CONSOLIDATE_SYSTEM_PROMPT`），回答"从这条线的经历里理解到了什么"，输出 JSON `{"actions":[...]}`，动作目标三选一：

- `persona`：用户画像，连贯正文片段；
- `wiki`（`target:"wiki"` + `name`）：领域知识，一个资源一个文件；
- `rule`（`target:"rule"` + `name`）：用户规则，清单式，每条规则一个小节。

新增用 `op:"append"`/`op:"create"`，已有认知被新经历印证的不动、被推翻的就地改写（`op:"rewrite"`，不保留旧版）；每条新认知附来源注释 `<!-- 来源：<topic>#<date> -->`。`target:"skill"` 预留、本期不实现（命中时打日志跳过，spec 2.3）。拿不准落 `global` 还是项目时**倾向 global、宁小勿大**。内化受 `memory.consolidate` 开关（默认 true）控制；LLM 调用失败只打日志、不影响 run。除"inactive 顺带内化"外，`MemorySystem.consolidate(workdir, topic)` 也暴露了手动内化入口（目前同样无路由/工具暴露）。

## 检索与注入

记忆进入模型上下文有两条路，都是被动的——**模型从不主动遍历记忆目录，记忆也不会整库注入**：

### L2 常驻注入（系统提示，spec 7.1）

`MemorySystem.cognitionPrompt(workdir)`（`packages/core/src/memory/system.ts`）在每次 run 装配系统提示时调用，返回的认知块拼在 AGENTS.md 基础提示之后（`run.ts` 的 `#systemWithCognition`）。规则：

1. **scope 过滤**：只收 `scope: "global"` 与 `scope: "project:<当前项目id>"` 的认知文件；
2. **token 预算**：`memory.injectTokenBudget`（默认 1000）按 `estimateTokens(title + body)` 记账；
3. **整文件取舍**：按 `rule > persona > wiki` 的优先级逐文件放入，**放不下的整文件跳过**（打一行 `kclaw memory cognition skipped (over inject budget)` 日志），绝不截断；
4. **块序**固定：`[关于用户]`（persona）→ `[项目认知]`（scope 为 `project:` 的文件）→ `[通用规则]`（全局的 rule/wiki）。

没有任何文件、或全部超出预算时返回空字符串，run 回落到纯基础提示；认知注入失败静默跳过，run 照常进行。

### L1 情节检索（用户消息 note，spec 7.2）

`RunManager.#execute` 在构造用户消息骨架时调 `memory.searchEpisodes(workspace, userText.slice(0, 200), 5)`——用户消息**前 200 个字符**（`MEMORY_QUERY_CHARS`）作查询、取 **top-5**（`MEMORY_LIMIT`）。每条命中变成一个挂在用户消息上的 note 块：

```
相关经历（<线的一句话标题>）: <该小节情节正文>
```

note 的 `kind` 是 `"memory"`，与 job 来源 note 一起在 `onUserMessage` 钩子里追加进消息、持久化，并逐个广播 `note.emitted`（事件序：`run.started → message.created → note.emitted ×N → message.completed`）。检索抛错时静默跳过——记忆是加速手段，检索失败不能阻塞一次 run。情节正文从线文件**实时回读**（文件是真相），线文件被删或不可解析时回落索引里的正文。

### 混合打分（spec 7.2）

检索用**双路融合**打分（`packages/core/src/memory/scoring.ts`）：

```
fts   = normalizeFtsRank(bm25_rank)     // 1 − 1/(1−rank)，越相关越接近 1
vec   = cosine(query向量, 条目向量)       // 仅向量路打开时
fused = 0.5·fts + 0.5·vec               // 单边缺失降级为另一边，双边缺失为 0
score = fused × 1/(1 + 距今天数/30)      // 时效因子：30 天衰减一半；无日期不打折
```

先 FTS 召回 top-50（`FTS_RECALL`，token 间 OR），再对召回的每条算分，降序取 `limit`。向量路关闭时 `vec` 缺省、`fused = fts`（纯关键词）。

**embedding 判定链**（`daemon.ts`，共四步，任一步不通则向量路整体关闭、检索退化为纯 BM25，且这不是错误）：

1. `memory.embedding.model` 为空 → 不构造 embedding 客户端（向量路关闭）；
2. model 非空 → provider 取 `memory.embedding.provider`；为空回落 `config.providers.default` 条目；
3. provider 条目存在 → 用该条目的 `baseUrl`/`apiKey` + 配置的 `model` 构造 OpenAI 兼容客户端（`POST /v1/embeddings`，30s 超时，`packages/core/src/memory/embeddings.ts`）；
4. 条目不存在 → 打一行 `embedding provider not found, vector path disabled`，向量路关闭（不致命）。

向量路打开时：写入侧在 `reconcile()` 里对缺向量或正文变化的条目批量补算（`backfillVectors`），正文没变的条目**保留旧向量**（双路不退化）；embed 调用失败只打日志、该批降级为纯 FTS。

### 模型侧工具（`packages/core/src/tools/memory.ts`）

| 工具 | 参数 | 行为 |
|------|------|------|
| `memory_save` | `{text 必填}` | text 是"要记内容的提示"（v1 的 `tags` 已删，多余字段忽略）；当场触发 `system.triggerImmediate` 处理当前这轮对话，成功输出 `已触发记忆写入（处理当前这轮对话）`；`memory.write.immediate=false` 时返回 `立即写入已关闭（memory.write.immediate=false），该内容将在后台定时/跟随触发时沉淀` |
| `memory_search` | `{query 必填, limit?}` | `system.searchAll` 跨**全部**项目库 + 全局库（每条先对账重索引再打分），默认 5、上限 20（`MAX_SEARCH_LIMIT`）；每个命中输出一行 `- [经历\|认知] [scope] 正文`（scope 如 `project:<id>` / `global`），无命中输出 `（没有相关记忆）` |

两个工具都是 `risk: "safe"` + `concurrency: "parallel"`：只访问记忆目录和索引、不修改工作区，调用免人工确认，也可与其他工具同批并发。

## 生命周期（spec 5）

线文件只有 **active / inactive** 两态，两条转换都是机器自动完成：

- **时间自动收束**：每次管线跑完，扫描该项目全部 `active` 线，`updated` 距今 ≥ `memory.threadInactiveDays`（默认 14 天）的自动转为 `inactive`（空批次也扫）；
- **复活**：`inactive` 线又有新情节（append）时自动恢复 `active`；提取器也可显式给动作加 `status:"inactive"`（明确的完成结论）。

被收束的线不再参与新情节的追加匹配，但**正文永不删除**——它的全部情节保留在原文件里（这也是"内化"的输入）。**机器只改不删**：删除只发生在人工路径（管理界面的删除按钮、或直接删文件）。

## 配置（§10，`KclawConfig.memory`）

| 字段 | 默认 | 说明 |
|------|------|------|
| `memory.write.immediate` | `true` | `memory_save` 工具立即触发写入 |
| `memory.write.manual` | `true` | 手动触发开关（当前无用户入口，core 预留 `triggerManual`） |
| `memory.write.intervalMinutes` | `30` | 定时兜底触发的间隔分钟数（`0` = 关闭） |
| `memory.write.idleMinutes` | `10` | 跟随门禁的空闲分钟数（`0` = 关闭） |
| `memory.extractModel` | `""` | 提取/内化用的模型，空 = 回落主对话模型 |
| `memory.threadInactiveDays` | `14` | 线多少天无新情节自动转 inactive |
| `memory.consolidate` | `true` | 内化开关 |
| `memory.embedding.provider` | `""` | embedding 的 provider 条目名，空 = 回落 default 条目 |
| `memory.embedding.model` | `""` | embedding 模型名，空 = 向量路整体关闭（纯 BM25） |
| `memory.injectTokenBudget` | `1000` | 每轮注入（认知常驻 + 情节检索）的 token 上限 |
| `memory.autoExtract` | （v1 遗留） | 已废弃，被四触发取代；仅容忍存在，读处一律忽略 |

## 迁移说明（spec 2.6）

daemon 启动时按固定顺序做一次 v1 → v2 迁移与对账（`daemon.ts`）：

1. **v1 notes 三路分流**（`migrateV1Notes`）：`<home>/memory/notes/*.md` 逐条解析，正文含 `偏好/喜欢/希望` 的并入 `global/persona.md`、含 `必须/不要/决定` 的并入 `global/rule/general.md`、其余并入 `global/wiki/misc.md`（都是追加合并写）；不可解析的 note 跳过并打日志。迁移后整个 `notes/` 目录被删除。幂等——目录不存在或没有 `.md` 文件时直接返回。
2. **删除 v1 派生物**：`rmSync(<home>/memory/index.db)`（v2 结构直接重建，旧索引无用）。
3. **全库对账**（`memory.reconcile`）：对每个项目库重建 FTS 索引 + 后台补算向量，对全局库同样处理；单个项目/全局库对账失败只打日志跳过，不阻塞 daemon 启动。

## 管理界面

v2 提供三套人工管理面，全部落在既有文档：

- **HTTP `/memory` 路由族**（9 个，`packages/server/src/routes/memory.ts`）：项目/线/全局认知的读取、整文件覆写（PATCH）、删除（DELETE）；persona 不可删除（400）；未装配记忆系统时全部 503。路由表见 [http-api](../server/http-api.md)。
- **CLI `/memory`**（`packages/cli/src/slash.ts`）：`/memory`（无参列项目）、`/memory <项目>`（列该项目的主题线）、`/memory <项目> <线>`（打印线文件原文）。只读。
- **Web 记忆页**（tab「记忆」，`packages/web/src/memory/MemoryView.tsx`）：项目线列表 + 全局认知两个清单 + 整文件编辑器，三区块见 [webui](../web/webui.md)。

### 事件：`memory.written`

写入管线每次实际落盘（情节追加/改写/开线、或内化写出认知文件）时，经装配的 `emit` 钩子广播 `memory.written` 事件（payload 见 [protocol](./protocol.md)）：

```ts
{ type: "memory.written", path: string,
  kind: "episode" | "cognition", topic?: string, scope?: string }
```

- `episode` 事件带 `topic`（线名），`cognition` 事件带 `scope`（新认知的 scope）；
- 事件不带 `sessionId`（项目级事务）；订阅端（CLI / web）把它当成"已落盘"的轻提示，不驱动任何状态机——CLI dim 一行 `已写入记忆: <path>`，web 在通知条显示同文案。

## 边界与出错

- **工作目录移动后项目记忆不跟随**：项目 id 依赖绝对路径的 SHA-1 前缀，`mv` 目录后 id 变化、旧项目记忆不再被检索（旧文件仍躺在 `projects/<旧id>/`）。这是确定性 id 的固有代价。
- **单字中文查询基本无法命中**：单字查询会分词成一个单字 token，但索引里存的都是两字组合（除非正文里恰好有孤立的单字串），因此几乎不会命中。一到两字的查询本身构成合法 bigram，不受影响。这是分词策略的固有限制。
- **索引与文件短暂不一致**：写入是"写文件、写索引"两步，中间崩溃会留下未索引的新文件；下次 `reconcile()` 补齐。反向（索引有、文件无）同样由 `reconcile()` 清除。检索命中后实时回读文件正文，命中集合最多短暂滞后。
- **提取失败不丢消息**：LLM 调用失败水位不推进、下次触发重试同一范围；响应不可解析则整批放弃（只打日志），不做部分写入——宁可少记也不记错。
- **向量路是可选加速**：embedding 未配置、provider 缺失或调用失败时检索自动退化为纯 BM25，不影响任何写入与注入流程。
- **多进程不支持**：`vectors.db` 是 better-sqlite3 默认日志模式，单 daemon 进程同步访问下安全；多个进程并发写同一 `memory/` 目录是明确不支持的用法（与 jobs.db/usage.db 同规则）。
- **管理写入口无状态校验**：PATCH 是"人即是真相"的整文件覆写——传什么写什么，不校验 frontmatter；写后重新索引、重建 MEMORY.md，不可解析的文件会在检索里自然消失（但文件本体保留）。

## 关联

- [tools](./tools.md)：memory 工具在工具体系中的位置（safe/parallel 的含义）
- [storage](./storage.md)：`KclawPaths.memoryDir` 的位置与迁移前的 v1 目录（`memory/notes/`、`memory/index.db` 现为迁移输入/被删除对象）
- [agent-loop](./agent-loop.md)：note 块如何随消息持久化并发出 `note.emitted`
- [compaction](./compaction.md)：共享的分词器与消息渲染的另一方（会话段索引、压缩摘要输入）
- [protocol](./protocol.md)：`memory.written` 事件的 payload 形状
- [run-manager](../server/run-manager.md)：L2 常驻注入与 L1 note 注入的服务端组装、跟随门禁的挂起侧
- [http-api](../server/http-api.md)：`/memory` 管理路由族
- [webui](../web/webui.md)：记忆管理页三区块
