# tools — 内置工具清单（23 个）

> 权威来源：`packages/core/src/tools/index.ts`（注册表：执行器与模型侧 JSON Schema 成对声明）与 `tools/` 下各实现文件（参数校验与行为）。机制见 [tools](../core/tools.md)，权限判定链见 [permissions](../core/permissions.md)。

每个工具在注册时声明两个属性，权限与调度全部从这两个属性派生：

```ts
/** tools/shared.ts — makeTool 的签名 */
makeTool(name, risk: "safe" | "sensitive", concurrency: "parallel" | "serial", fn)
```

- **risk**：`safe`（只读，权限链直接放行）/ `sensitive`（有副作用，走权限裁决）
- **concurrency**：`parallel`（一个工具批次内可并发执行）/ `serial`（串行执行）

## 参数约定

模型看到的参数定义（JSON Schema：类型、必填、描述）在注册表里声明；执行器收到参数后再做一轮运行时校验（`tools/shared.ts`）。全部工具共用四条约定：

- 必填参数缺失或类型不对，返回 `args.<key> must be ...` 形式的错误结果。
- 字符串参数拒绝空串与纯空白；少数正文类参数允许空串，在各自条目里标明。
- 整数参数只收整数，超出范围按上下限截取（不是报错），不传取条目标注的默认值。
- 模型多传的未知字段一律忽略。

## 常驻工具（12 个）

每个 run 都注册（childRun 例外见下）：

| 名称 | 一句话 | risk | concurrency |
|------|--------|------|-------------|
| `exec` | 在工作目录执行 shell 命令（stdout/stderr 合并，超长截断保头尾） | sensitive | serial |
| `fs_read` | 读工作目录内 UTF-8 文本文件（≤ 1 MiB） | safe | parallel |
| `fs_list` | 列目录（子目录带尾斜杠，文件带字节数） | safe | parallel |
| `fs_write` | 新建或覆写文件（自动建父目录） | sensitive | serial |
| `fs_edit` | 字面替换文件中恰好一处文本（0 处或多处报错） | sensitive | serial |
| `web_search` | Tavily 网页搜索 | safe | parallel |
| `web_fetch` | 抓取 http(s) URL 的正文（HTML 抽取为文章文本，≤ 512 KiB） | safe | parallel |
| `memory_save` | 立即把当前轮对话沉淀进长期记忆 | safe | parallel |
| `memory_search` | 跨项目经历与全局认知的混合检索 | safe | parallel |
| `session_search` | 全文检索本会话已被压缩的早期对话 | safe | parallel |
| `skill_read` | 按名字加载一个技能的完整规程正文 | safe | parallel |
| `skill_list` | 列出模型可见的技能（可按关键词过滤） | safe | parallel |

### exec

`sensitive` · `serial`。shell 命令经 `shell: true` 执行，工作目录固定为 workspace 根；配置了沙箱且可用时在沙箱内运行（见 [sandbox](../core/sandbox.md)）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | 要执行的 shell 命令 |

行为要点：

- stdout 与 stderr 合并返回。
- 输出上限由配置 `exec.maxOutputBytes` 决定（默认 100 KiB）：超限保留头部，结尾带 `...[dropped N bytes]...` 丢弃标记；配置了 spill 目录时完整输出同时写入 `<home>/spill`，返回里附一条 fs_read 定位行，模型可自己读回全量。
- 超时由配置 `exec.timeoutMs` 决定（默认 60 秒）：到时整个进程组被 SIGKILL（shell 的子孙进程一起结束），返回错误并附带已产生的部分输出。
- 退出码非 0 返回错误，输出以 `exit code N` 开头。

### fs_read

`safe` · `parallel`。fs 四件套的路径都先按 workspace 解析（相对或绝对均可）；目标越出 workspace 不在工具层拒绝，是否放行由权限判定链裁决，人工确认后可读写（见 [permissions](../core/permissions.md)）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 要读的文件路径 |

- 只支持 UTF-8 文本，超过 1 MiB 报错；目标是目录时报错。

### fs_list

`safe` · `parallel`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 要列的目录路径 |

- 子目录带尾斜杠输出，文件显示字节数。
- 符号链接按链接目标 stat：指向目录的按目录列，断链标注 `(broken symlink)`。
- 空目录返回 `(empty directory)`。

### fs_write

`sensitive` · `serial`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 目标文件路径 |
| `content` | string | 是 | 完整文件内容，允许空串 |

- 整体覆写（不是追加）；父目录不存在时递归创建。
- 返回写入的字节数。

### fs_edit

`sensitive` · `serial`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 目标文件路径 |
| `old` | string | 是 | 要替换的原文，必须在文件中恰好出现一次 |
| `new` | string | 是 | 替换后的文本，允许空串（等于删除 `old`） |

- 字面替换，不做正则展开：`new` 里的 `$&` 这类序列原样写入文件。
- `old` 出现 0 次或多于 1 次都报错，不写入。
- 二进制内容直接报错：解码出 U+FFFD 或含 NUL 字节的文件不写入，防止把二进制文件写坏。

### web_search

`safe` · `parallel`。走 Tavily 搜索接口。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索词 |
| `maxResults` | integer | 否 | 返回条数，范围 1–10，不传取 5 |

- 返回 markdown 列表（`- [标题](URL)：内容` 每行一条）；原始三元组 `{title, url, content}` 在结果的 `data` 里，供前端渲染。
- 目标固定是 Tavily 公网域名，不做 web_fetch 那套私网地址检查。

### web_fetch

`safe` · `parallel`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | 绝对 http(s) URL |

- 重定向最多跟 5 跳，每一跳的目标（初始 URL 与每个 Location）都先查私网/回环地址黑名单（SSRF 防护），命中即拒绝；配置 `web.allowPrivateNetworks: true` 可放行私网访问（例如本地 Ollama）。
- 非 2xx 返回错误并带状态码。
- HTML 用 Readability 抽文章正文（script/style 不会保留）；抽不出时退化为去掉脚本与样式后的正文文本；非 HTML 内容类型按纯文本返回。
- 正文上限默认 512 KiB，超限截断并带标记；配置了 spill 目录时附 fs_read 定位行。上限作用在解析前的原始字节上，超大页面不会撑大内存。
- 单次请求 20 秒超时（配置 `web.timeoutMs`）。

### memory_save

`safe` · `parallel`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 一句话说明这轮有什么值得沉淀（仅作提示用途） |

- 当场触发当前会话的记忆写入 pipeline，处理的是当前整轮消息；`text` 本身不直接写入记忆。
- 配置 `memory.write.immediate: false` 时返回固定错误文案（写入改由后台定时/跟随触发完成）。
- 本轮没有新增内容时如实返回"该轮没有需要沉淀的新内容"，不谎报写入。

### memory_search

`safe` · `parallel`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 要在长期记忆里找什么 |
| `limit` | integer | 否 | 返回条数上限，范围 1–20，不传取 5 |

- 跨项目经历与全局认知的混合检索（关键词 + 向量）。
- 每条命中带 `[经历]`/`[认知]` 与 `[project:<id>]`/`[global]` 标注；无命中返回"（没有相关记忆）"。

### session_search

`safe` · `parallel`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 要在早期对话里找什么 |
| `limit` | integer | 否 | 返回条数上限，范围 1–20，不传取 5 |

- 全文检索本会话已被压缩的早期对话（中文友好）。
- 每条命中返回段摘要和匹配位置的原文片段；没有可检索内容时返回 `(无可检索内容)`。

### skill_read

`safe` · `parallel`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 技能目录名（见系统提示词的可用技能列表，或用 skill_list 查询） |

- 返回该技能 SKILL.md 的规程正文；同名技能项目层优先。
- 设了 `disable-model-invocation` 的技能不在系统提示词清单里，但仍可按名加载：用户在对话里点名是这类技能的唯一入口。
- 名字不存在或正文为空报错。

### skill_list

`safe` · `parallel`。系统提示词里的"可用技能"清单有长度上限、技能多时会被截断，subagent 更是没有清单；这里是完整的自助入口。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 否 | 过滤子串，对名字与描述做大小写不敏感匹配；不传则列出全部 |

- 只列模型可见技能（与系统提示词清单同一口径，`disable-model-invocation` 的不出现），按名字排序。
- 找到后用 skill_read 加载正文。

## 条件注册工具（11 个）

只在对应能力被组装进 run 时加入注册表：

| 名称 | 一句话 | risk | concurrency | 注册条件 |
|------|--------|------|-------------|----------|
| `subagent_run` | 派 subagent 独立执行自包含任务（可后台） | safe | parallel | 主线 run 且组装了派发器（daemon 恒有；子会话没有） |
| `subagent_collect` | 按子会话 id 取回后台 subagent 的结题答复 | safe | parallel | 同上，且组装了收集器 |
| `skill_create` | 把一段经验固化为技能提案（提案制，不经确认不生效） | safe | parallel | daemon 组装了技能进化系统（恒有）；`skills.evolution.enabled: false` 时工具仍在、调用返回固定关闭文案 |
| `create_team` | 建立本会话的 agent 团队、本会话成为组长 | safe | serial | 仅组长身份 |
| `spawn_teammate` | 添加一个组员（持久子会话 + 模型快照） | safe | serial | 仅组长身份 |
| `send_message` | 给组长或组员写信（经持久收信箱投递） | safe | parallel | 团队身份（组长或组员） |
| `list_agents` | 列出组员名单（状态、忙闲、当前任务） | safe | parallel | 团队身份 |
| `task_create` | 在团队任务板上建任务（依赖、指派） | safe | serial | 团队身份 |
| `task_update` | 按 revision 更新任务状态/认领（CAS 比对交换） | safe | serial | 团队身份 |
| `task_list` | 列出任务板全貌 | safe | parallel | 团队身份 |
| `ask_user_questions` | 向用户提 1–5 个当场拍板的问题 | safe | parallel | 组装了 ask 网关（run 组装恒注入，子 run 也带） |

### subagent_run

`safe` · `parallel`。派一个独立的短期 agent 会话执行单个任务，结题答复作为工具结果返回。一批多个 `subagent_run` 并发执行。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | string | 是 | 自包含的任务描述（子会话看不到本对话的任何内容，路径、约束、定义都要写全） |
| `label` | string | 否 | 展示用短名，出现在状态行与确认卡里 |
| `run_in_background` | boolean | 否 | true = 立即返回子会话 id，完成后有通知、用 subagent_collect 取结果；不传取 false（阻塞等结题） |

- 子会话不能回话、不能提问、不能再派 subagent（单层委派）。
- 阻塞式派发挂父 run 的中止信号（父 run 停，子也停）；后台派发的生命周期挂父会话（父 run 结束不取消后台子会话）。
- 结题答复与阻塞结果一样做保头保尾截断。

### subagent_collect

`safe` · `parallel`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `childSessionId` | string | 是 | 子会话 id（来自后台派发的返回或完成通知） |

- 只能取回本会话自己派出的子会话；答复按阻塞结果同样的规则截断。

### skill_create

`safe` · `parallel`。把一段可复用经验固化为技能提案：不直接安装，提案进入待确认列表，用户在 WebUI 审阅后才可能生效。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 技能目录名：小写字母、数字、连字符（如 deploy-runbook） |
| `content` | string | 是 | 完整的 SKILL.md 文件内容：YAML frontmatter（含 description）+ Markdown 正文 |
| `rationale` | string | 否 | 为什么这段经验值得沉淀为技能 |

- 新增还是修订、落全局还是落项目由系统按已装技能自动判定，模型不传这两个字段。
- `skills.evolution.enabled: false` 时调用返回固定关闭文案。

### create_team

`safe` · `serial`。建立本会话的 agent 团队，本会话成为组长。一个会话只能有一个团队；建队后才能 `spawn_teammate` / `task_create`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 否 | 团队展示名，不传默认取会话标题 |

### spawn_teammate

`safe` · `serial`。添加一个持久组员：独立子会话，初始任务投递后自主开工，完成后留在团队里，可继续给它派活或发消息。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 组员名：小写字母开头，只含小写字母/数字/连字符，最长 32 字符；预留名 `lead` 不可用；名字永久占用不复用 |
| `task` | string | 是 | 自包含的初始任务（组员从空白历史启动） |
| `role` | string | 否 | 一句话角色说明，展示在团队面板 |
| `model` | string | 否 | 指定 provider/model，让个别组员用不同模型；不传沿用当前路由，spawn 时快照固定 |

### send_message

`safe` · `parallel`。经持久收信箱投递，引擎自动送达（运行中注入或唤醒收信方），收信方无需轮询。发件人固定为本会话身份，不能冒名。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `to` | string | 否 | 收信人：组员名或 `"lead"`。组员不传默认发组长；组长必须指名组员 |
| `text` | string | 是 | 消息正文 |

### list_agents

`safe` · `parallel`。无参数。返回组员名单：名字、生命周期状态、忙闲、当前任务，可能附角色、模型、失败原因。

### task_create

`safe` · `serial`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `subject` | string | 是 | 短标题 |
| `detail` | string | 否 | 完整描述：背景、路径、验收标准，写成自包含 |
| `dependencies` | integer[] | 否 | 前置任务 id 列表，全部完成后本任务才能被认领 |
| `assignee` | string | 否 | 直接指派给某组员（仅组长） |

- 未指派且依赖已就绪的任务，会被空闲组员自动认领。

### task_update

`safe` · `serial`。推进或修改任务板上的任务。完成任务会解锁依赖它的任务。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | integer | 是 | 任务 id |
| `expected_revision` | integer | 是 | 上次读到的 revision：对不上说明有人改过，写入被拒绝，用 task_list 重读后再试（CAS 比对交换） |
| `attempt_id` | string | 否 | 自己当前的 attempt id（来自任务派发输入）；完成或失败自己开工的任务时必须带 |
| `status` | string | 否 | 新状态：`in_progress` / `completed` / `failed` / `cancelled` |
| `subject` | string | 否 | 改标题 |
| `detail` | string | 否 | 改描述 |
| `assignee` | string 或 null | 否 | 改派（仅组长）；传 null 清空指派。指派对象必须在组员名单里，且一个组员同时只能持有一项未完成任务 |
| `dependencies` | integer[] | 否 | 整体替换依赖列表 |

### task_list

`safe` · `parallel`。无参数。返回任务板全貌：id、标题、状态、归属、依赖、revision（供 `task_update` 的 `expected_revision` 使用）。

### ask_user_questions

`safe` · `parallel`。向用户提一到几个需要当场确认的问题：等待期间 run 暂停，回答后工具返回答案文本。仅在关键分叉点使用（信息缺失会导致方案走偏、或不可逆操作前必须用户拍板）；能从上下文或文件里推断的信息不要问。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `questions` | object[] | 是 | 1–5 个问题，每项字段见下 |

`questions` 数组每项的字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `.text` | string | 是 | 问题本身，要能独立读懂 |
| `.options` | string[] | 否 | 不少于 2 个选项；不传则自由文本作答 |
| `.multiSelect` | boolean | 否 | 配合 options 允许多选；不传取单选 |

- 等待上限默认 10 分钟：超时返回"用户未在限时内回答"，并提示不要重复调用、信息仍不可缺时基于合理假设继续并说明假设。
- run 中止时返回错误（中止不算回答）；正常返回按题号列答案，没答的题标注（未回答）。

## 工具可见性裁剪

| 场景 | 裁剪 |
|------|------|
| subagent 的 run（`childRun`） | 删 `memory_save`（记忆是主线的职责）；永不带 `subagent_run`（单层委派） |
| readonly 权限模式 | 删全部 sensitive 工具（`exec` / `fs_write` / `fs_edit`）；可见范围缩小，但权限判定仍是边界 |

团队工具的注册条件按身份分化：`lead` 身份（含未建队的主线会话，即"预备组长"，见 [agent-team](../core/agent-team.md)）注册全部七个；`member` 身份注册 `send_message` / `list_agents` / `task_*` 五个（不含建队/添加）；不在团队里的会话（job 会话、非组员的 subagent 会话）一个都没有。

## MCP 工具

外部 MCP server 的工具不在此清单：每个 run 经 RunManager 的 `extraTools` 动态注入，名字与 schema 来自 server 侧（见 [mcp](../core/mcp.md)）。
