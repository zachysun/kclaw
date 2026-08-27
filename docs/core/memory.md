# memory — 记忆存储

## 职责

`MemoryStore`（`packages/core/src/memory/store.ts`）实现长期记忆：一条记忆是一个 markdown 文件，用户可以直接打开查看、修改、删除；同时维护一个 SQLite FTS5 全文检索索引（FTS5 是 SQLite 的全文检索扩展，按词建倒排，支持中文需要自定分词），供机器快速检索。模型通过 `memory_save` / `memory_search` 两个工具读写（`packages/core/src/tools/memory.ts`）；daemon 在每次运行前自动检索相关记忆注入上下文（`packages/server/src/run.ts`）。

---

## 设计决策

- **文件是真相，索引是派生物**：`memory/notes/*.md` 是唯一权威数据；`memory/index.db` 任何时候删除都无损失——daemon 启动时 `reconcile()` 扫描目录重建（`packages/server/src/daemon.ts`）。检索命中后也是重新读文件返回正文，因此手动修改、删除文件始终生效，索引最多短暂滞后。
- **为什么 markdown 而不是只存 SQLite**：记忆的价值一半在于人工可维护——用户可以直接用编辑器修改、git 可以版本化、grep 可以检索。双轨的成本（维护对账）换来的是"人工写入与机器写入是同一份数据"。
- **中文分词必须自己做**：FTS5 默认的 unicode61 分词器把连续中文当成一个不可拆的 token，查"上海"永远无法命中"用户在上海工作"。索引和查询共用一个自写分词器 `tokenize`（`packages/core/src/text/fts.ts`，与压缩的会话检索索引共享，见 [compaction](./compaction.md)）：ASCII 字母数字串按整词（转小写），CJK 连续串拆成相邻两字组合（bigram）——"用户在上海工作" 拆成 `用户 户在 在上 上海 海工 工作`。一到两个字的中文查询本身就是合法 bigram，直接命中；更长的查询按 bigram 逐个 AND。每个 token 用引号包裹后拼进 MATCH 串（`ftsQuery`），token 内不含 FTS 运算符（标点被丢弃），杜绝把用户输入当成检索语法注入。
- **先查后写（merge-aware）**：`save` 前先用新文本找相似笔记（取前 `MERGE_QUERY_CHARS = 100` 个字符做 OR 检索取前 10 条，逐条算 token 集合的 Jaccard 相似度——两个集合交集除以并集，越接近 1 越相似——最高分 ≥ `MERGE_SIMILARITY = 0.5` 即视为同一条），命中则原位更新，否则同一事实会被反复存储、检索 top-5 全是重复条目。更新保留 `created`、刷新 `updated`，不产生新文件。
- **来源三分类**：`MemorySource = "model" | "auto" | "human"`——模型工具保存 / 自动提取管线 / 人工手写，写进 frontmatter，检索与合并均可识别来源。

---

## 目录布局与文件格式

```
~/.kclaw/memory/
├── notes/          # 每条记忆一个 <id>.md，id 形如 "mem_" + ULID
└── index.db        # SQLite 索引，纯派生物，可删可重建
```

一个记忆文件的完整格式（`renderMarkdown` 序列化，yaml frontmatter + 空行 + 正文）：

```markdown
---
id: mem_01J...
tags:
  - 偏好
created: "2026-08-22T00:00:00.000Z"
updated: "2026-08-22T00:00:00.000Z"
source: model
---
用户偏好中文回复
```

解析（`parseNoteFile`）刻意宽容，使人工书写不易出错：

- `id` 缺省用文件名（去 `.md`）
- `source` 缺省或非法按 `human`
- `tags` 写成单个字符串按一个标签的列表
- `created`/`updated` 缺省用当前时间

以下文件被视为"不是记忆"、不进索引：读不到；首行不是 `---`；frontmatter 没有闭合的 `---`；yaml 解析失败。

索引侧两张表（`SCHEMA`）：

```sql
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, tags TEXT NOT NULL,
  source TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(text);
```

`notes` 存元数据（tags 以逗号连接的字符串），`notes_fts` 只存一列——分词后空格连接的 token 串；两表靠 SQLite rowid 对应。

---

## 接口

```ts
// packages/core/src/memory/store.ts
export interface MemoryNote {
  id: string; path: string; tags: string[]; source: MemorySource
  created: string; updated: string; text: string   // created/updated 为 ISO-8601
}
export interface MemoryStoreOptions { notesDir: string; indexDb: string }

class MemoryStore {
  reconcile(): { added: number; removed: number }
  save(input: SaveNoteInput): Promise<MemoryNote>       // { text, tags?, source? }
  search(query: string, limit = 5): Promise<MemoryNote[]>
}
```

- `reconcile()`：让索引对齐磁盘。新文件入索引；磁盘上消失（或变得不可解析）的条目移除；仍在但内容变化的重新索引（比较已索引的 token 串——手动修改通常不改动 frontmatter，因此以正文 token 判断变化）。返回 `{added, removed}`（重索引的不计入）。
- `save()`：先 `findSimilar` 判合并，然后**整文件覆写** + 更新索引。默认 `source: "auto"`（工具调用会显式传 `"model"`）。
- `search()`：FTS5 MATCH 按相关度排序取 `limit` 条，逐条**从文件重新读正文**；文件已删或无法解析的命中自然淘汰。空查询（分词后无 token）返回 `[]`。

---

## 模型侧工具（`packages/core/src/tools/memory.ts`）

| 工具 | 参数 | 行为 |
|------|------|------|
| `memory_save` | `{text 必填, tags?}` | `store.save({..., source: "model"})`；成功输出 `saved memory <id>` |
| `memory_search` | `{query 必填, limit?}` | `store.search`，默认 5、上限 20（`MAX_SEARCH_LIMIT`）；每个命中输出一行 `- <正文>`，无命中输出 `(no memories)` |

两个工具都是 `risk: "safe"` + `concurrency: "parallel"`：只访问记忆目录和索引、不修改工作区，调用免人工确认，也可与其他工具同批并发（better-sqlite3 是同步接口，"并发"只是调度上不强制排队）。

---

## 与 agent 上下文的关系

记忆进入上下文只有两条路，都是被动的——**模型从不主动遍历记忆目录，记忆也不会整库注入系统提示**：

1. **运行前自动注入**（`packages/server/src/run.ts` 的 `#execute`）：用户消息的**前 200 个字符**（`MEMORY_QUERY_CHARS = 200`）作为查询调 `memory.search`，取 **top-5**（`MEMORY_LIMIT = 5`）。命中每条变成用户消息上的一个 note 块：`{ type: "note", kind: "memory", text: "相关记忆: <正文>" }`，在 `onUserMessage` 钩子里追加进消息、持久化，并逐个广播 `note.emitted` 事件。检索抛错时静默跳过——记忆是加速手段，检索失败不能阻塞一次运行。
2. **模型主动检索**：运行中模型随时可调 `memory_search` 按需查，结果作为工具输出进入下一轮上下文；用 `memory_save` 写入新记忆。

`config.yaml` 的 `memory.autoExtract` / `memory.extractModel` 两个字段（默认 `false` / 空）控制**写入侧的自动提取管线**（见下节）。

### 自动提取（`memory.autoExtract`）

写入侧还有第三条路——**运行后自动提取**（`packages/server/src/run.ts` 的 `#execute` / `#extractMemory`）：当一次运行以 `end_turn` 正常结束且 `config.memory.autoExtract` 为 `true` 时，服务端 fire-and-forget 地发起一次**不带工具**的 LLM 调用：模型取 `memory.extractModel`（为空回落到主对话模型的同一解析），system prompt 固定要求"只输出 JSON 字符串数组"，user 内容是整轮对话的逐行渲染（`renderSegment`，`packages/core/src/session/compaction.ts`，与压缩摘要输入共用同一构造，每行截 2000 字符）。解析时容忍可选的 ```json 围栏；响应不是合法 JSON、或解析结果非字符串数组（含非 string 元素）→ 整批放弃，只 `console.error`，不部分写入；空数组 → 无写入。每条事实以 `source: "auto"` 调 `save()`（复用 findSimilar 去重替换），单条 save 抛错记日志后继续下一条。提取完全异步——不 await、不影响运行结果；`aborted` / `error` 等非 `end_turn` 结束的运行不触发。

---

## 边界与出错

- **单字中文查询基本无法命中**：单字查询会分词成一个单字 token，但索引里存的都是两字组合（除非正文里恰好有孤立的单字串），因此几乎不会命中。一到两字的查询本身构成合法 bigram，不受影响。这是分词策略的固有限制。
- **索引与文件短暂不一致**：`save` 是"写文件、再写索引"两步，中间崩溃会留下未索引的新文件；下次 `reconcile()` 补齐。反向（索引有、文件无）同样由 `reconcile()` 清除。
- **`reconcile()` 只在 daemon 启动时执行**：daemon 运行期间在编辑器里修改记忆文件，要等下次重启才会重索引（`search` 读正文是实时的，只是命中集合可能滞后）。
- **文件写入是整文件覆写**：没有部分更新，也没有原子替换（writeFileSync 直写）；单文件很小，风险可接受。
- **多进程**：多个 MemoryStore 实例（如 CLI 与 daemon 同时）打开同一个 index.db 各自写入，better-sqlite3 同步接口下单个操作是原子的，但没有跨实例的缓存失效——以 daemon 为唯一常驻写入方最为稳妥。

---

## 关联

- [tools](./tools.md)：memory 工具在工具体系中的位置（safe/parallel 的含义）
- [storage](./storage.md)：memory 目录在 `KclawPaths` 中的位置与 `autoExtract` 字段定义
- [agent-loop](./agent-loop.md)：note 块如何随消息持久化并发出 `note.emitted`
- [compaction](./compaction.md)：共享的分词器与消息渲染的另一方（会话段索引、压缩摘要输入）
- [run-manager](../server/run-manager.md)：注入查询的 200 字符 / top-5 常量所在的服务端组装
