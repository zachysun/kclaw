# memory — 记忆存储

## 职责

`MemorySystem`（`packages/core/src/memory/system.ts`）是记忆系统的唯一服务端入口（单类不拆；31 个公共方法按四类使用方拆成四个窄接口 `MemoryQuery`/`MemoryTriggers`/`MemoryScheduleBook`/`MemoryAdmin`——共 29 个，另有接口外的 `stop()` 与 `migrateV1Notes()`，调用方按需依赖其中一个面），它把三类文件级能力组装在一起：**L1 项目情节**（按项目分目录的主题线文件）、**L2 全局认知**（跨项目的画像/知识/规则文件）、以及两套**派生检索索引**（SQLite FTS5 全文索引 + 可选的向量索引）。一条记忆就是一份 markdown 文件，用户可以直接打开查看、修改、删除；索引永远只是派生物，删掉可以重建。

模型通过 `memory_save` / `memory_search` 两个工具读写（`packages/core/src/tools/memory.ts`）；run 组装（core `executeRun`）在每次 run 时做两级注入——L2 认知常驻系统提示、L1 情节作为 note 挂到用户消息上（见下文"检索与注入"）。daemon 的 `MemorySystem` 组装、旧版数据迁移、embedding 判定链都在 `packages/server/src/daemon.ts`。

v1 格式的旧数据（`memory/notes/*.md` + 单库 `memory/index.db`）由 daemon 启动时自动迁移，见文末"迁移说明"。

## 三层塔

记忆从"原始对话"到"可注入的长期记忆"分三层提炼：

```
         ┌──────────────────────────────────┐
   L2    │  全局认知 global/（persona/wiki/rule） │  ← 跨项目，token budget 内整文件注入系统提示
         ├──────────────────────────────────┤
   L1    │  项目情节 projects/<id>/（<topic>.md）│  ← 按项目分目录，检索 top-N 以 note 注入
         ├──────────────────────────────────┤
   L0    │  原始对话（会话目录 events.jsonl 里的 message 事件）│  ← 不在这里，见 [compaction](./compaction.md)
         └──────────────────────────────────┘
```

- **L0 原始对话**：每轮对话的消息历史，留在会话目录，不属于记忆系统（记忆系统只记"提取后的内容"；压缩/检索它的机制见 [compaction](./compaction.md)）。
- **L1 项目情节**：一次 run 收尾后，pipeline 从**触发会话**的新消息里**提取**出值得长期记住的"情节"（定时保底触发则对该项目每个会话逐个补），按主题（topic）追加到该项目的主题线文件里。项目即工作目录（workdir），项目 id 由目录名与绝对路径决定（见下节）。
- **L2 全局认知**：一条主题线被判定不再活跃（inactive）后，pipeline 把它的全部情节**沉淀**成跨项目的认知——用户画像（persona）、领域知识（wiki）、用户规则（rule）三类文件。全局认知按 `scope` 字段区分"全项目可见"与"仅某项目可见"。

## 设计决策

- **文件是权威数据，索引是派生物**：`<projectDir>/<topic>.md`（情节）与 `global/*.md`（认知）是唯一权威数据；`vectors.db`（FTS5 + 向量）任何时候删除都无损失，启动时 `reconcile()` 对全项目库与全局库重建索引（`packages/core/src/memory/pipeline.ts`），检索命中后也从线文件/认知文件回读正文。因此人工修改、删除文件始终生效，索引最多短暂滞后。
- **为什么 markdown 而不是只存 SQLite**：记忆的价值一半在于人工可维护——用户可以直接用编辑器修改、git 可以版本化、grep 可以检索。双轨的成本（维护两份数据的一致性）换来的是"人工写入与机器写入是同一份数据"。
- **机器只改不删**：写入 pipeline 只有追加、改写、停用三种动作，没有任何删除；删除只发生在人工路径（管理界面或直接删文件）。这一条贯穿生命周期（见下）。
- **防覆盖写**：任何一次机器写入（追加情节、沉淀认知）都以"当前磁盘上的最新内容"为基准重解析后合并（`writeThreadFile` / `writeCognitionFile`），人工改动先被重解析再合并、永不静默丢失；文件存在但不可解析（如人工手写无 frontmatter）时**抛错不覆盖**——宁可不写也不丢数据。
- **中文分词必须自己做**：FTS5 默认的 unicode61 分词器把连续中文当成一个不可拆的 token，查"上海"永远无法命中"用户在上海工作"。索引和查询共用一个自写分词器 `tokenize`（`packages/core/src/text/fts.ts`）：ASCII 字母数字串按整词（转小写），CJK 连续串拆成相邻两字组合（bigram），例如"用户在上海工作"拆成 `用户 户在 在上 上海 海工 工作`。一到两个字的中文查询本身就是合法 bigram，直接命中；更长的查询按 bigram 之间 OR 召回（`searchFts` 用 ` OR ` 连接，任一 bigram 命中即召回，bm25 把命中更多 token 的条目排更前）。检索是**召回优先**，模型侧二次判断，不是 AND 精确。每个 token 用引号包装后拼进 MATCH 串（`ftsQuery`），杜绝把用户输入当成检索语法注入。
- **两层索引同构**：项目库与全局库共用同一个 `VectorIndex`（`packages/core/src/memory/indexer.ts`）——`entries`（元数据）+ `entries_fts`（分词 token 串）+ `vectors`（可选向量）三张表，只是条目形状不同（情节条目 key = `topic#date#heading`，认知条目 key = `kind/name`）。连接的唯一所有者是 `MemoryPipeline`：写入路径（reindex/backfill）与检索路径（MemorySystem 的 searchAll/searchEpisodes 向它借句柄）共用同一份连接缓存，全库 `new VectorIndex` 只出现在 pipeline；停机时 `system.stop()` → `pipeline.close()` 一条链统一关闭。

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
    └── <id>/                    # 项目 id = <目录名>-<绝对路径 SHA-1 前 6 位>
      ├── workdir.txt          # 人可读的目录映射（项目首次产生记忆时写入）
      ├── MEMORY.md            # 主题线索引表（派生物，机器重建）
      ├── state.json           # 提取进度标记 + 跟随检查 + intervalLastRun（见"写入 pipeline"）
        ├── vectors.db           # L1 检索索引（FTS5 + 向量，派生物）
        └── <topic>.md           # 主题线文件（唯一权威情节数据）
```

项目 id 的生成规则（`packages/core/src/memory/layout.ts` 的 `projectIdFor`）：取工作目录的绝对路径做 SHA-1，用前 6 位十六进制，再拼上目录名（目录名为空时回退到 `project`），例如 `my-repo-a1b2c3`。确定性、可读、基本唯一——但注意它依赖绝对路径，**整个工作目录移动后 id 会变化、旧项目记忆不再自动跟随**（这是已知取舍，见"边界与出错"）。

`MEMORY.md` 是机器生成的线索引表（`renderMemoryMd`），每线一行：`| topic | 一句话 | 状态 | 最近活动 |`；它只是方便人与工具快速浏览，真正的内容在各 `<topic>.md`。

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

- frontmatter 字段：`topic`（线名，即文件名去 `.md`）、`title`（人可读一句话，仅在开新线时写入）、`status`（`active`/`inactive`）、`created`/`updated`（日期）。`## YYYY-MM-DD · 标题` 起始新小节，标题取提取动作的 `title`，默认时 `append`/`update` 回退到情节正文首行、`new-thread` 回退到线文件名——一律截断到 40 字封顶（超长在句读处收刀），与本文件已有小节撞名时加序号后缀，索引键 `主题#日期#标题` 因此不互覆。
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

`scope` 是自由字符串（默认 `global`）；只有 `global` 与 `project:<id>` 两种取值会参与常驻注入（`cognitionPrompt` 按此过滤），其它取值解析后仍保留在文件里、但不参与注入。`title` 默认用文件名；`kind`（persona/wiki/rule）由所在位置决定——`persona.md` 是固定文件，`wiki/`、`rule/` 下每个 `.md` 一个认知。

## 写入 pipeline（MemoryPipeline）

pipeline 位于 `packages/core/src/memory/pipeline.ts`，写入的触发入口是 `runTrigger(workdir, trigger, sessionId?)`（另有 `runNightly`/`consolidate` 与索引重建等维护入口，见 [http-api](../server/http-api.md) 的 `/memory` 路由族）。一次触发做四件事：

1. **选范围**：提取是**会话级**的——只看触发会话自己的增量窗口（"增量"以提取进度为界：每个会话记录一个"已提取到哪条消息"的标记，标记之后的消息才是新内容；该项目每个会话各有自己的提取进度标记。定时触发无显式归属，对该项目全部会话逐个补），见下节"提取进度标记与串行锁"；
2. **提取**：无工具 LLM 调用，把范围渲染成逐行文本 + 现有主题线清单（MEMORY.md 表格），交给固定 system 提示的提取器（`EXTRACT_SYSTEM_PROMPT`），要求只输出 JSON `{"actions":[...]}`。每个动作的字段名固定：判别字段 `op` 取 `append`（接到已有线）/`update`（修正已有线某小节）/`new-thread`（开新线）三值；**每个动作必填非空 `file`**（线文件名，kebab-case，`new-thread` 也不例外）、`content` 与 `title`（一句话短标题，30 字以内，小节标题的来源）；`update` 额外带 `section`，`new-thread` 额外带 `thread`；允许显式 `status:"inactive"`（明确的完成结论）；噪音直接跳过，无值得记的内容输出 `{"actions":[]}`。prompt 内含完整 JSON 示例。**线的身份唯一以 `file` 为准**：写入磁盘时 frontmatter `topic` 一律取 `file`，模型交回的 `thread` 字段仅兼容保留、不参与身份——否则文件名与内部 topic 分裂，MEMORY.md 行按 topic 显示、读/改/删按文件名定位，清单点开即 404；
3. **写入**：逐条应用动作（追加/改写/开线），期间不阻塞地广播 `memory.written` 事件（见"事件"）；
4. **收尾**：推进提取进度、闲置线在扫描时自动停用（见"生命周期"）、顺带沉淀检查、重建项目索引与 MEMORY.md。

提取用的模型取 `memory.extractModel`，为空回退到主对话模型；名字命中 provider 条目时走该条目自己的端点与协议（`createProviderClient` + 条目的 `model`），裸模型名走主端点（见 [provider](./provider.md)）。校验与提示词的分工：**模型只从 `EXTRACT_SYSTEM_PROMPT` 认识 JSON 结构，字段名必须与写入校验逐字一致**。响应不是合法 JSON 或解析结果非 `actions` 数组时**整批放弃**、只打日志，不做部分写入；单个动作字段不合法（缺 `file`/`content`、`op` 非三值）则**只丢该条**、其余照常写入。提取进度的推进要区分两种情况：**LLM 调用抛错（提取失败）提取进度不推进**，下一次触发重试同一范围；而**调用成功但动作被丢光（格式不合法）提取进度照常推进**——这段消息不会自动重试，属已知取舍（丢弃的来源是模型输出不合规，重试大概率同样不合规）。

### 五触发

| 触发 | 入口 | 范围 | 说明 |
|------|------|------|------|
| **immediate**（立即） | `memory_save` 工具 → `system.triggerImmediate(sessionId)` | 该会话自上次提取位置起的增量 | 模型在对话中主动要求"记下来"，当场处理；`memory.write.immediate=false` 时工具返回固定提示、内容留给后台触发写入 |
| **manual**（手动） | `MemorySystem.triggerManual(workdir)` | 取该会话自上次提取位置起的增量 | 用户通过 **`/memory save` 斜杠命令**（CLI 与 web 均有）触发当前项目的手动写入；CLI 取启动目录、web 取当前会话工作目录。归属会话默认回退到"项目最近活动会话"。开关 `memory.write.manual`（默认 true）关闭时路由返回 400 |
| **clear**（切会话） | `POST /sessions` 创建新会话时 → `system.triggerClear(workdir, 旧会话)` | 该会话自上次提取位置起的增量 | CLI `/clear`、`/new` 与 web 新建会话共用该路由，创建成功后**异步**触发对旧会话所在项目的提取（不阻塞建会话响应；失败只打日志，由提取进度防重复、下次触发补上）。归属会话取创建前的项目最近活动会话——此刻它必然是用户刚离开的旧会话；未组装记忆系统时不触发 |
| **interval**（定时） | `memory-scheduler`（默认每 60s 扫一次） | 该项目**全部会话**（不含 subagent 会话）逐个补各自增量 | 距上次定时触发满 `memory.write.intervalMinutes` 分钟就触发一次（0 关闭）；上次时间落在 `state.json` 的 `intervalLastRun`，未触发过则立刻首跑。无显式归属会话，对每个提取进度落后的会话各跑一批提取，单会话失败不阻塞其他会话 |
| **follow**（跟随） | run 收尾排一个检查 + 门禁判定 | 该会话自上次提取位置起的增量 | 每个 run 结束（任何 stopReason）由 run 组装（core `executeRun`）挂一个跟随检查；`end_turn` 之后满 `memory.write.idleMinutes` 分钟无新活动才真正触发（0 关闭），见下 |

**会话级增量**：提取进度**每会话各记一份**（interval/follow 两个标记），范围一律取"该会话两个标记中较靠后的那一条"之后的新消息（`advanceAll` 把该会话两个标记一并推进的只有 manual/immediate/clear，interval/follow 只推自己的）。任何一个先跑到，其余触发都不会重复提取同一段消息。首跑没有标记时该会话全量提取一次，此后只增不重。会话内标记指向的消息被删导致失配时按"宁可重提取不可漏提取"退化为该会话全量（见 `WriteLedger.since`）。

**跟随门禁**：run 收尾时 `scheduleFollowCheck` 把 `{sessionId, endTurnAt}` 写进该项目的 `state.json`（排下的检查写入磁盘，daemon 重启后由调度器首次扫描补查）。调度器每次扫描时对每个排下的检查判门禁：`now − endTurnAt ≥ idleMinutes` **且** `endTurnAt 之后项目无新活动`才算 due，due 才真正触发 follow 并清除检查；门禁不过但 `endTurnAt` 之后已有更新活动（用户切到别的会话继续对话、或该项目又跑了一轮）时，旧检查的锚点已被新活动取代，直接清掉，防止 `state.json` 的 followChecks 无界增长。这里的"项目最后活动时间"取**该项目全部会话 meta 的最大 `updatedAt`**（本实现选会话级聚合，无需新表）；空活动记录视作"end_turn 即最后活动"，保证重启后可补查。

### 提取进度标记与串行锁

`state.json` 每项目一本（`WriteLedger`，`packages/core/src/memory/ledger.ts`），内容：

> 读写收在 MemorySystem 的进度文件入口（写通道 `#ledgerForWrite`/读通道 `#ledgerPath`），且**每次调用现开现读**——WriteLedger 写时把内存状态整文件原子重写，跨调用缓存长命实例会把别人刚写入的字段覆盖掉（最后写者胜），禁止。

内容：

```json
{
  "watermarks": { "ses_01…": { "interval": "msg_01…", "follow": "msg_01…" },
                  "ses_02…": { "interval": "msg_02…" } },
  "followChecks": [ { "sessionId": "…", "endTurnAt": "…" } ],
  "intervalLastRun": "2026-08-30T00:00:00.000Z",
  "nightlyBaseline": "2026-08-30",
  "nightlyLastRun": "2026-08-31"
}
```

- **提取进度标记（watermark）每会话各记一份**：`{sessionId → {interval, follow}}`，值是该会话内最后一条已提取消息的 id；定时/跟随触发从该会话两个标记中较靠后的那个取增量（`WriteLedger.later`），任一触发先跑到，另一个都不再重复提取；标记指向的消息已被删除（会话截断等）时按"更旧"处理——`since` 退化为该会话全量，**宁可重提取不可漏提取**。旧版项目级进度标记（顶层 `interval`/`follow` 两个 `{sessionId, messageId}`）**不迁移**（遵循"历史数据不迁移"的一贯做法）：读到即视作空文件，首次触发对老会话全量重扫一遍，重复由提取去重 + 合并写入吸收。
- `nightlyBaseline`（UTC 日期）是夜间沉淀的判据基线（pipeline 读写）；`nightlyLastRun`（本地日期）是夜间沉淀的防同日重跑标记（调度器读写）——两个时区各管各的，见"沉淀"节。
- **串行锁**：项目级（`MemoryPipeline` 对同一项目维护一个 promise 链（`#locks`），同项目的触发（含沉淀）排队执行，避免两个触发并发读写同一批线文件）；全局级则在写 L2 认知文件时再套一层模块级全局锁（`withL2Lock`），跨项目并发沉淀撞同一认知文件也串行化。调度器的每次扫描本身不等待触发完成（发出后不等待结果 + 防重入）。

### 沉淀（consolidate）

沉淀有两条路，落到同一个实现（`#consolidateLocked`）：

- **停用顺带沉淀**：一条主题线被标记为 `inactive` 后，pipeline 顺带对它做一次沉淀总结；
- **夜间闲时沉淀**：调度器每天本地时间过了 `memory.consolidateHour`（默认凌晨 3 点）后对该项目触发一次（`MemorySystem.triggerNightly` → `pipeline.runNightly`）——对象是**自上次夜间沉淀以来有新情节的全部线（含 active）**，判据 `updated ≥ nightlyBaseline`（UTC 日期，与线文件 `updated` 同源，记在该项目 `state.json`）。活跃线的情节不再需要等线闲置转 inactive 才沉淀，每晚整理一次；daemon 凌晨未开时开机后首次扫描补跑（防同日重跑记本地日期，与沉淀判据的 UTC 日期各管各的）。首跑只沉淀当天更新的线，历史线不补（已由顺带沉淀覆盖）。

停用顺带沉淀的输入输出：无工具 LLM 调用，把线文件全部情节 + 现有认知文件内容交给固定 system 提示的沉淀器（`CONSOLIDATE_SYSTEM_PROMPT`），回答"从这条线的经历里理解到了什么"，输出 JSON `{"actions":[...]}`，动作按 `target` 三选一（目标名放 `name` 字段、**不拼进 target**）：

- `target:"persona"`：用户画像，连贯正文片段（`name` 省略）；
- `target:"wiki"` + `name`：领域知识，一个资源一个文件；
- `target:"rule"` + `name`：用户规则，清单式，每条规则一个小节。

新增用 `op:"append"`/`op:"create"`，已有认知被新经历印证的不动、与新经历不一致的就地改写（`op:"rewrite"`，不保留旧版）；每条新认知附来源注释 `<!-- 来源：<topic>#<date> -->`。解析校验：`target` 必须是三值之一、`wiki`/`rule` 必带非空 `name`，不合法的动作在解析层丢弃并记日志（`dropping malformed cognition action (target=…)`）——`#applyCognitionAction` 拿 `target` 拼目录路径，放行任意字符串会写出索引读不到的垃圾文件。`target:"skill"` 预留、当前未实现（解析层即丢弃，`#applyCognitionAction` 内保留防御分支）。拿不准落 `global` 还是项目时**倾向 global、宁小勿大**。沉淀受 `memory.consolidate` 开关（默认 true）控制（停用顺带与夜间闲时两路共用）；LLM 调用失败只打日志、不影响 run。除这两条自动路径外，`MemorySystem.consolidate(workdir, topic)` 也暴露了手动沉淀入口（目前同样无路由/工具暴露）。

## 检索与注入

记忆进入模型上下文有两条路，都是被动的——**模型从不主动遍历记忆目录，记忆也不会整库注入**：

### L2 常驻注入（系统提示）

`MemorySystem.cognitionPrompt(workdir)`（`packages/core/src/memory/system.ts`）在 run 组装系统提示时由 `system-before` 位置的内置 `system-materials` hook 调用（见 [hooks](./hooks.md)），返回的认知块作为第一个段落追加在 AGENTS.md 基础提示之后。规则：

1. **scope 过滤**：只收 `scope: "global"` 与 `scope: "project:<当前项目id>"` 的认知文件；
2. **token budget**：`memory.injectTokenBudget`（默认 1000）按 `estimateTokens(title + body)` 计数——**只约束 L2 认知常驻注入**，L1 情节检索的 top-5 是全量注入、不受此限；
3. **整文件取舍**：按 `rule > persona > wiki` 的优先级逐文件放入，**放不下的整文件跳过**（打一行 `kclaw memory cognition skipped (over inject budget)` 日志），绝不截断；
4. **块序**固定：`[关于用户]`（persona）→ `[项目认知]`（scope 为 `project:` 的文件）→ `[通用规则]`（全局的 rule/wiki）。

没有任何文件、或全部超出 budget 时返回空字符串，run 退回到纯基础提示；认知注入失败静默跳过，run 照常进行。认知段属于系统提示词的实时段（live，见 [hooks](./hooks.md) 的分段冻结）：每个 run 现算并与冻结基线逐段比对，认知文本一变该段就重新冻结、下一个 run 即时生效——不再等压缩边界；缓存命中的损失也只限于实时段之后，前面的稳定段前缀继续命中。

### L1 情节检索（用户消息 note）

run 组装（core `executeRun`）在构造用户消息骨架时调 `memory.searchEpisodes(workspace, userText.slice(0, 200), 5)`——用户消息**前 200 个字符**（`MEMORY_QUERY_CHARS`）作查询、取 **top-5**（`MEMORY_LIMIT`）。每条命中变成一个挂在用户消息上的 note 块：

```
相关经历（<线的一句话标题>）: <该小节情节正文>
```

note 的 `kind` 是 `"memory"`，与 job 来源 note 一起经 run-before hook 链（内置 memory-inject 检索收集 → user-message-land 统一追加进消息、持久化，见 [hooks](./hooks.md)）落进用户消息，并逐个广播 `note.emitted`（事件序：`run.started → message.created → note.emitted ×N → message.completed`，job note 在 memory note 之前）。检索抛错时静默跳过——记忆是加速手段，检索失败不能阻塞一次 run。情节正文从线文件**实时回读**（以线文件为准），线文件被删或不可解析时回退到索引里的正文。

### 混合打分

检索用**双路融合**打分（`packages/core/src/memory/scoring.ts`）：

```
fts   = normalizeFtsRank(bm25_rank)     // 1 − 1/(1−rank)，越相关越接近 1
vec   = cosine(query向量, 条目向量)       // 仅向量路打开时
fused = 0.5·fts + 0.5·vec               // 单边缺失降级为另一边，双边缺失为 0
score = fused × 1/(1 + 距今天数/30)      // 时效因子：30 天衰减一半；无日期不打折
```

先 FTS 召回 top-50（`FTS_RECALL`，token 间 OR），再对召回的每条算分，降序取 `limit`。向量路关闭时 `vec` 不参与、`fused = fts`（纯关键词）。

**embedding 判定链**（`daemon.ts`，共四步，任一步不通则向量路整体关闭、检索退化为纯 BM25，且这不是错误）：

1. `memory.embedding.model` 为空 → 不构造 embedding 客户端（向量路关闭）；
2. model 非空 → provider 取 `memory.embedding.provider`；为空回退到 `config.providers.default` 条目；
3. provider 条目存在 → 用该条目的 `baseUrl`/`apiKey` + 配置的 `model` 构造 OpenAI 兼容客户端（`POST /v1/embeddings`，**超时随 `config.providers.timeoutMs`**，组装时显式传入，默认 120s；客户端代码在 `packages/core/src/memory/embeddings.ts`）；
4. 条目不存在 → 打一行 `embedding provider not found, vector path disabled`，向量路关闭（不致命）。

向量路打开时：写入侧在 `reconcile()` 里对缺向量或正文变化的条目批量补算（`backfillVectors`），正文没变的条目**保留旧向量**（双路不退化）；embed 调用失败只打日志、该批降级为纯 FTS。

### 模型侧工具（`packages/core/src/tools/memory.ts`）

| 工具 | 参数 | 行为 |
|------|------|------|
| `memory_save` | `{text 必填}` | text 是"要记内容的提示"（多余字段忽略）；当场触发 `system.triggerImmediate` 处理当前这轮对话——真有提取批次（该会话自上次提取位置起有未处理的新消息）时输出 `已触发记忆写入（处理当前这轮对话）`，没有增量时如实输出 `该轮没有需要沉淀的新内容`（不谎报写入）；`memory.write.immediate=false` 时返回 `立即写入已关闭（memory.write.immediate=false），该内容将在后台定时/跟随触发时沉淀` |
| `memory_search` | `{query 必填, limit?}` | `system.searchAll` 跨**全部**项目库 + 全局库（每条先核对重索引再打分），默认 5、上限 20（`MAX_SEARCH_LIMIT`）；每个命中输出一行 `- [经历\|认知] [scope] 正文`（scope 如 `project:<id>` / `global`），无命中输出 `（没有相关记忆）` |

两个工具都是 `risk: "safe"` + `concurrency: "parallel"`：只访问记忆目录和索引、不修改工作区，调用免人工确认，也可与其他工具同批并发。

## 生命周期

线文件只有 **active / inactive** 两态，两条转换都是机器自动完成：

- **闲置自动转 inactive**：每次 pipeline 跑完，扫描该项目全部 `active` 线，`updated` 距今 ≥ `memory.threadInactiveDays`（默认 14 天）的自动转为 `inactive`（空批次也扫）；
- **复活**：`inactive` 线又有新情节（append）时自动恢复 `active`；提取器也可显式给动作加 `status:"inactive"`（明确的完成结论）。

转为 inactive 的线不再参与新情节的追加匹配，但**正文永不删除**——它的全部情节保留在原文件里（这也是"沉淀"的输入）。**机器只改不删**：删除只发生在人工路径（管理界面的删除按钮、或直接删文件）。

## 配置（`KclawConfig.memory`）

| 字段 | 默认 | 说明 |
|------|------|------|
| `memory.write.immediate` | `true` | `memory_save` 工具立即触发写入 |
| `memory.write.manual` | `true` | 手动触发开关：`/memory save`（CLI/web）走 `POST /memory/trigger-manual` 触发写入；`false` 时该路由返回 400 |
| `memory.write.intervalMinutes` | `30` | 定时保底触发的间隔分钟数（`0` = 关闭） |
| `memory.write.idleMinutes` | `10` | 跟随门禁的空闲分钟数（`0` = 关闭） |
| `memory.extractModel` | `""` | 提取/沉淀用的模型，空 = 回退到主对话模型；名字命中 provider 条目时用该条目自己的端点与协议（见 [provider](./provider.md)） |
| `memory.threadInactiveDays` | `14` | 线多少天无新情节自动转 inactive |
| `memory.consolidate` | `true` | 沉淀开关（停用顺带与夜间闲时共用） |
| `memory.consolidateHour` | `3` | 夜间闲时沉淀的本地小时（0-23；负值关闭） |
| `memory.embedding.provider` | `""` | embedding 的 provider 条目名，空 = 回退到 default 条目 |
| `memory.embedding.model` | `""` | embedding 模型名，空 = 向量路整体关闭（纯 BM25） |
| `memory.injectTokenBudget` | `1000` | L2 认知常驻注入的 token 上限（只约束常驻注入；L1 情节 top-5 全量注入不受此限） |
| `memory.autoExtract` | 无（废弃） | 不再生效：配置文件里写了不报错，读取处一律忽略 |

## 迁移说明

daemon 启动时按固定顺序做一次旧版目录 → 现结构的迁移与索引对齐（`daemon.ts`）：

1. **旧版 notes 三路分流**（`migrateV1Notes`）：`<home>/memory/notes/*.md` 逐条解析，正文含 `偏好/喜欢/希望` 的并入 `global/persona.md`、含 `必须/不要/决定` 的并入 `global/rule/general.md`、其余并入 `global/wiki/misc.md`（都是追加合并写）；不可解析的 note 跳过并打日志。迁移后整个 `notes/` 目录被删除。幂等——目录不存在或没有 `.md` 文件时直接返回。
2. **删除旧版派生索引**：`rmSync(<home>/memory/index.db)`（现版结构直接重建，旧索引无用）。
3. **全库对齐**（`memory.reconcile`）：对每个项目库重建 FTS 索引 + 后台补算向量，对全局库同样处理；单个项目/全局库处理失败只打日志跳过，不阻塞 daemon 启动。

## 管理界面

记忆提供三套人工管理入口，细节见各自文档：

- **HTTP `/memory` 路由族**（10 个，`packages/server/src/routes/memory.ts`）：项目/线/全局认知的读取、整文件覆写（PATCH）、删除（DELETE），外加手动触发 `POST /memory/trigger-manual`；persona 不可删除（400）；未组装记忆系统时全部 503。路由表见 [http-api](../server/http-api.md)。
- **CLI `/memory`**（`packages/cli/src/slash.ts`）：`/memory`（无参列项目）、`/memory <项目>`（列该项目的主题线）、`/memory <项目> <线>`（打印线文件原文）。只读。
- **Web 记忆页**（tab「记忆」，`packages/web/src/memory/MemoryView.tsx`）：全局认知常驻（顶部）+ 项目记忆按需选择（项目 → 主题线）+ 整文件编辑器；不存在会话级记忆，会话只通过 `memory_search` 检索记忆。见 [webui](../web/webui.md)。

### 事件：`memory.written`

写入 pipeline 每次实际写入文件（情节追加/改写/开线、或沉淀写出认知文件）时，经组装的 `emit` hook 广播 `memory.written` 事件（payload 见 [protocol](./protocol.md)）：

```ts
{ type: "memory.written", path: string,
  kind: "episode" | "cognition", topic?: string, scope?: string }
```

- `episode` 事件带 `topic`（线名），`cognition` 事件带 `scope`（新认知的 scope）；
- 事件不带 `sessionId`（项目级事务）；订阅端（CLI / web）把它当成"已写入"的轻提示，不驱动任何状态机。CLI 用暗色一行显示 `已写入记忆: <path>`，web 通知条显示同文案；web 的通知条**可点击**，跳转记忆页。`cognition` 事件按 path 反推 kind/name 自动打开对应认知文件；`episode` 事件不附带 `scope`（形状里只有 `topic`），而前端打开线文件的分支依赖 `scope` 字段，目前不会触发——点击只完成跳转，线文件不会自动打开。

### 事件流里的 memory 事件（审计）

除了上面"已写入"的实时提示，每次记忆写入还会在**触发会话**的事件流里追加一条 `memory` 事件（`MemorySystem` 的审计 hook 接 `SessionStore.appendEvent`，`packages/core/src/memory/system.ts`）——它是可回查的审计记录，与 `memory.written`（总线实时事件、项目级轻提示、带 path）是**两回事**，别混淆。事件形状：

```ts
{ type: "memory", at: string,
  trigger: "immediate" | "manual" | "interval" | "follow" | "clear" | "nightly" | "admin",
  kind: "episode" | "cognition",
  op: "append" | "update" | "new-thread" | "rewrite" | "create" | "overwrite" | "delete" | "inactivate",
  topic?: string, file?: string, scope?: string, source?: string }
```

- **归属规则**：memory 事件挂在**触发会话**的目录里：immediate（`memory_save` 工具）显式带会话；manual（`/memory save` 或 `POST /memory/trigger-manual`，HTTP 路由可选 `sessionId` 覆盖、CLI/web 命令不传）与 nightly 默认**回退到该项目最近活动会话**（`recentSessionId`，不选 subagent 会话）；interval **无显式归属**：pipeline 对全部会话（不含 subagent 会话）逐个补增量，各批次的 memory 事件挂**各自来源会话**；clear 挂**创建新会话前的项目最近活动会话**（即用户刚离开的旧会话，`POST /sessions` 路由在创建前取好传入）；follow 挂**发起该检查的会话**（check.sessionId；subagent run 不挂检查）；admin（记忆页的覆写/删除）挂"最近活动会话"：线文件操作挂该项目最近活动会话、全局认知操作挂**全局**最近活动会话。找不到归属会话时跳过（不落事件）。
- **subagent 会话完全隔离**（设计原则：把 subagent 当成工具，而不是对话者）：meta 带 `parentSessionId` 的会话不进任何提取路径——interval 扫描不列它、`recentSessionId`/`recentGlobalSessionId` 回退到不选它、follow-check 不为它挂检查（run 组装的 hook 直接跳过，见 [hooks](./hooks.md)）；subagent 的工具面也没有 `memory_save`。subagent 的过程不写入长期记忆（见 [subagents](./subagents.md)）。
- **事件体不带 `sessionId` 字段**：会话由事件所在目录决定，payload 里没有它。
- **不推进投影 `updatedAt`**：`applyEvent` 对 `memory` 事件不更新任何投影字段（见 [storage](./storage.md) 的 events.jsonl 一节）。
- 可通过 `GET /sessions/:id/events` 查询某会话的完整事件流（含 memory 事件），web 审计页把它们渲染成"记忆"行（见 [http-api](../server/http-api.md) 与 [webui](../web/webui.md)）。

## 边界与出错

- **工作目录移动后项目记忆不跟随**：项目 id 依赖绝对路径的 SHA-1 前缀，`mv` 目录后 id 变化、旧项目记忆不再被检索（旧文件仍躺在 `projects/<旧id>/`）。这是确定性 id 的固有代价。
- **单字中文查询基本无法命中**：单字查询会分词成一个单字 token，但索引里存的都是两字组合（除非正文里恰好有孤立的单字串），因此几乎不会命中。一到两字的查询本身构成合法 bigram，不受影响。这是分词策略的固有限制。
- **索引与文件短暂不一致**：写入是"写文件、写索引"两步，中间崩溃会留下未索引的新文件；下次 `reconcile()` 补齐。反向（索引有、文件无）同样由 `reconcile()` 清除。检索命中后实时回读文件正文，命中集合最多短暂滞后。
- **提取失败不丢消息**：LLM 调用失败提取进度不推进、下次触发重试同一范围；响应不可解析则整批放弃（只打日志），不做部分写入——宁可少记也不记错。
- **向量路是可选加速**：embedding 未配置、provider 缺失或调用失败时检索自动退化为纯 BM25，不影响任何写入与注入流程。
- **多进程不支持**：`vectors.db` 是 better-sqlite3 默认日志模式，单 daemon 进程同步访问下安全；多个进程并发写同一 `memory/` 目录是明确不支持的用法（与 jobs.db/usage.db 同规则）。
- **管理写入口无状态校验**：PATCH 是整文件覆写——传什么写什么，不校验 frontmatter；写后重新索引、重建 MEMORY.md，不可解析的文件会在检索里自然消失（但文件本体保留）。

## 关联

- [tools](./tools.md)：memory 工具在工具体系中的位置（safe/parallel 的含义）
- [storage](./storage.md)：`KclawPaths.memoryDir` 的位置与迁移前的 v1 目录（`memory/notes/`、`memory/index.db` 现为迁移输入/被删除对象）
- [agent-loop](./agent-loop.md)：note 块如何随消息持久化并发出 `note.emitted`
- [compaction](./compaction.md)：共享的消息渲染与压缩摘要输入、会话检索（session_search）
- [protocol](./protocol.md)：`memory.written` 事件的 payload 形状
- [run-manager](../server/run-manager.md)：L2 常驻注入与 L1 note 注入的 run 组装（core `executeRun`）、跟随门禁的排期侧
- [http-api](../server/http-api.md)：`/memory` 管理路由族
- [webui](../web/webui.md)：记忆管理页三区块
