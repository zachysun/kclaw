# tools — 内置工具清单（39 个）

> 权威来源：`packages/core/src/tools/` 下各工具模块（每个模块的 `createXxxToolEntries` 工厂把执行器与模型侧 JSON Schema 成对打包，参数校验与行为同居一处）与 `packages/core/src/tools/index.ts`（注册表组装：路由组装参数、汇成 entries 列表）。机制见 [tools](../core/tools.md)，权限判定链见 [permissions](../core/permissions.md)。

每个工具在注册时声明两个属性，权限与调度全部从这两个属性派生：

## 核心源码

```ts
/** tools/shared.ts — makeTool 的签名 */
makeTool(name, risk: "safe" | "sensitive", concurrency: "parallel" | "serial", fn)
```

- **risk**：`safe`（只读，权限链直接放行）/ `sensitive`（有副作用，走权限裁决）
- **concurrency**：`parallel`（一个工具批次内可并发执行）/ `serial`（串行执行）

## 参数约定

模型看到的参数定义（JSON Schema：类型、必填、描述）在各工具模块的 entries 工厂里声明；执行器收到参数后再做一轮运行时校验（`tools/shared.ts`）。全部工具共用四条约定：

- 必填参数缺失或类型不对，返回 `args.<key> must be ...` 形式的错误结果。
- 字符串参数拒绝空串与纯空白；少数正文类参数允许空串，在各自条目里标明。
- 整数参数只收整数，超出范围按上下限截取（不是报错），不传取条目标注的默认值。
- 模型多传的未知字段一律忽略。

## 常驻工具（18 个）

每个 run 都注册（childRun 例外见下）：

| 名称 | 一句话 | risk | concurrency |
|------|--------|------|-------------|
| `bash` | 在工作目录执行 shell 命令（stdout/stderr 合并，超长截断保头尾） | sensitive | serial |
| `fs_read` | 读工作目录内 UTF-8 文本文件（≤ 1 MiB） | safe | parallel |
| `fs_list` | 列目录（子目录带尾斜杠，文件带字节数） | safe | parallel |
| `fs_write` | 新建或覆写文件（自动建父目录） | sensitive | serial |
| `fs_edit` | 字面替换文件中恰好一处文本（0 处或多处报错） | sensitive | serial |
| `grep` | 正则内容搜索（遵循 .gitignore，跳过二进制，结果截断+spill） | safe | parallel |
| `glob` | 文件名模式匹配（与 grep 同一套枚举） | safe | parallel |
| `web_search` | Tavily 网页搜索 | safe | parallel |
| `web_fetch` | 抓取 http(s) URL 的正文（HTML 抽取为文章文本，≤ 512 KiB） | safe | parallel |
| `memory_save` | 立即把当前轮对话沉淀进长期记忆 | safe | parallel |
| `memory_search` | 跨项目经历与全局认知的混合检索 | safe | parallel |
| `session_search` | 全文检索本会话已被压缩的早期对话 | safe | parallel |
| `history_search` | 全文检索全部历史会话的原始消息（含未压缩部分） | safe | parallel |
| `skill_read` | 按名字加载一个技能的完整规程正文 | safe | parallel |
| `skill_list` | 列出模型可见的技能（可按关键词过滤） | safe | parallel |
| `todo_list_write` | 整单替换会话级任务清单（全量快照，后写胜出） | safe | serial |
| `todo_list_read` | 读回当前清单（跨 run、跨压缩存活） | safe | parallel |
| `ui_render` | 为用户产出一张交互式 UI 卡（25 种组件，经结果 data 通道渲染、不进上下文） | safe | parallel |

### bash

`sensitive` · `serial`。shell 命令经 `shell: true` 执行，工作目录固定为 workspace 根；配置了沙箱且可用时在沙箱内运行（见 [sandbox](../core/sandbox.md)）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | 要执行的 shell 命令 |

行为要点：

- stdout 与 stderr 合并返回。
- 输出上限由配置 `bash.maxOutputBytes` 决定（默认 512 KiB）：超限保留头部，结尾带 `...[dropped N bytes]...` 丢弃标记；配置了 spill 目录时完整输出同时写入 `<home>/spill`，返回里附一条 fs_read 定位行，模型可自己读回全量。
- 超时由配置 `bash.timeoutMs` 决定（默认 300 秒）：到时整个进程组被 SIGKILL（shell 的子孙进程一起结束），返回错误并附带已产生的部分输出。SIGKILL 之后留 2 秒宽限等 close 事件：子进程的退出信息与管道里已缓冲的尾部输出仍被收集完才收尾（超时是出错返回，不是静默丢弃）。
- 退出码非 0 返回错误，输出以 `exit code N` 开头。
- 执行结果在 `data` 字段附结构化退出码 `{exitCode: N}`（超时与进程启动失败为 `null`），web 聊天页的工具卡据此显示 exit 徽标。
- 每次执行注入两个环境变量：`KCLAW_SESSION_ID`（当前会话 id）与 `KCLAW_WORKSPACE`（工作目录），供命令行工具自识别；其余环境继承 daemon 进程。

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
- 先读后改守卫：目标文件必须在本 run 内被 `fs_read` 读过、且读后未被外部修改（size+mtime 比对），否则报错提示先读/重读；新建文件不受守卫约束。`fs_write` 覆写既有文件走同一条守卫。

### grep

`safe` · `parallel`。内容搜索与 glob 共享一套文件枚举：git 仓库内用 `git ls-files`（已跟踪 + 未跟踪未忽略，遵循 .gitignore，NUL 分隔保中文文件名）；git 外回退目录遍历（跳过隐藏目录与 node_modules）。候选文件上限 20000，超出报错并建议缩小搜索范围。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | 是 | 正则表达式（JS RegExp 语法） |
| `path` | string | 否 | 限定搜索范围的工作区相对目录或文件 |
| `glob` | string | 否 | 文件名 glob 过滤（如 `**/*.ts`） |
| `maxResults` | integer | 否 | 返回条数，范围 1–200，不传取 50 |

- 输出行格式 `path:lineNo: 行内容`（单行截 400 字符）。
- 二进制文件（含 NUL 字节）跳过；单文件命中 1000 行后停止扫描该文件。
- 超出 maxResults 截断并带 `...[truncated, N more matches]` 标记；配置了 spill 目录时完整命中清单写入 spill 并附 fs_read 定位行。无命中返回 `(no matches)`。

### glob

`safe` · `parallel`。文件名模式匹配，与 grep 同一套枚举与 .gitignore 规则。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | 是 | 标准 glob 模式（如 `**/*.ts`） |
| `path` | string | 否 | 限定搜索范围的工作区相对目录 |

- 返回匹配文件路径列表，上限 500；超限截断并带标记，配置了 spill 目录时完整清单写入 spill 并附定位行。
- 无命中返回 `(no matches)`。
- 已知限制（grep/glob 共有）：实现是同步扫描（候选上限 20000、单文件 1 MiB 保底），超大仓库可能短暂阻塞 daemon 事件循环；异步化等真实痛点出现再做。

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
- 单次请求 60 秒超时（配置 `web.timeoutMs`）。

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

### history_search

`safe` · `parallel`。与 `session_search` 互补：那个检索压缩摘要，这个检索所有会话的原始消息全文（user/assistant 的文本块，工具输出不收）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 要在全部历史会话的原始消息里找什么（关键词，中文友好） |
| `limit` | integer | 否 | 返回条数上限，范围 1–20，不传取 5 |
| `session_id` | string | 否 | 只检索这一个会话 |

- 检索的数据存在 `~/.kclaw/search.db`（SQLite FTS5，中文按二字元切分），daemon 边收到消息边写入，消息被编辑重试截断、会话删除时同步镜像清理，启动时对缺失的旧会话补一次回填。
- 每条命中一行原文（会话标题、角色、时间，行尾带 `（session: <会话id>）`）；没有命中返回 `(没有匹配的历史消息)`；索引未组装（独立 core 场景）返回 `(历史检索不可用)`。
- 同一份数据经 HTTP `GET /search?q=` 暴露给 WebUI（见 [http-api](../server/http-api.md)）。

### skill_read

`safe` · `parallel`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 技能目录名（见系统提示词的可用技能列表，或用 skill_list 查询） |

- 返回该技能 SKILL.md 的规程正文；同名技能项目层优先。
- 设了 `disable-model-invocation` 的技能不在系统提示词清单里，但仍可按名加载：用户在对话里指名是这类技能的唯一入口。
- 名字不存在或正文为空报错。

### skill_list

`safe` · `parallel`。系统提示词里的"可用技能"清单有长度上限、技能多时会被截断，subagent 更是没有清单；这里是完整的自助入口。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 否 | 过滤子串，对名字与描述做大小写不敏感匹配；不传则列出全部 |

- 只列模型可见技能（与系统提示词清单同一口径，`disable-model-invocation` 的不出现），按名字排序。
- 找到后用 skill_read 加载正文。

### ui_render

`safe` · `parallel`。为用户产出一张交互式 UI 卡（表格、条形图、按钮、表单、时间轴、树、折叠面板等 25 种组件），卡片经工具结果的 `data` 字段随块持久化、由 web 聊天页渲染成可交互组件——**不占模型上下文**（进入上下文的只有一行文字回执）。适合呈现结构化结果（对照表、进度、选项菜单）与收集参数的表单；纯文本能说清的内容不必用它。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `card` | object | 是 | 组件描述，`kind` 字段判别 25 种组件 |

- 25 种组件分三层：**展示组件** 12 种（button、link、table、list、tag、badge、timeline、tree、quote、icon、chart、form）可单独成卡；**容器组件** 5 种（card/tabs/collapse/drawer/carousel）把展示组件组合出布局（标签页、折叠、抽屉、轮播），容器里不能再嵌容器（类型层封死，运行时校验再拦一道）；**表单字段** 8 种（input、textarea、radio、checkbox、segmented、slider、date、time）挂在 form 组件的 `fields` 里。
- 运行时校验逐字段报错，错误信息带字段路径（如 `card.fields[0].min: 必须小于 max`）；护栏：文本 ≤500 字符、标题 ≤100、表格 ≤50 行 8 列、树 ≤200 节点、轮播 ≤10 页、表单 ≤20 字段、选项 ≤8 项、单卡 ≤32 KB。
- 校验通过返回一行回执（如"已渲染表格《xx》（3 行）"）作为工具结果进入上下文；失败返回错误并提示改用 Markdown。
- 交互回传：按钮点击与表单提交格式化成用户消息走普通发送链路（排队、中止、审计语义全部继承），发送帧带 `uiAction` 来源标记（见 [messages](./messages.md) 与 [wire](./wire.md)）；web 据此在卡上渲染持久已选态（刷新、重进会话都不复活）。
- `exposure: directory`（见下节）：25 组件的完整 schema 有数千 token，不适合进每个请求——目录节一行描述教何时用，`tool_search` 返回完整 schema 教怎么写，校验错误回执教怎么改。

## 条件注册工具（22 个）

只在对应能力被组装进 run 时加入注册表：

| 名称 | 一句话 | risk | concurrency | 注册条件 |
|------|--------|------|-------------|----------|
| `process_list` | 列出本会话的后台进程（命令、状态、退出码、输出文件） | safe | parallel | 组装了后台进程注册表（daemon 恒有） |
| `process_output` | 按字节偏移增量读后台进程输出（可短暂阻塞等新输出） | safe | parallel | 同上 |
| `process_kill` | 终止后台进程（SIGKILL 整个进程组） | safe | serial | 同上 |
| `cron_create` | 创建定时任务（cron 表达式或 delayMinutes 一次性，二选一） | sensitive | serial | 组装了调度器（daemon 恒有）；cron 触发的 run 不带 |
| `cron_list` | 列出全部定时任务（调度、状态、上次结果） | safe | parallel | 同上（cron 触发的 run 保留） |
| `cron_update` | 部分字段更新（改 cron/delayMinutes 即换形态并重排） | sensitive | serial | 同 cron_create |
| `cron_delete` | 删除定时任务 | sensitive | serial | 同 cron_create |
| `create_goal` | 设定目标循环（armed + 首轮入队） | sensitive | serial | 根会话且组装了 goal host（daemon 恒有；subagent 没有） |
| `get_goal` | 读当前目标视图（状态/轮位/budget/最近判定） | safe | parallel | 同上 |
| `update_goal` | 目标动作（complete=请求判定 / pause / resume / stop） | sensitive | serial | 同上 |
| `tool_search` | 检索未全量列出的工具（返回完整工具卡，命中即加入本 run 可用集） | safe | parallel | 检索池非空（有目录/deferred 层工具时） |
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

### bash 的后台模式与 process 三件

`bash` 增加两个可选参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `timeoutMs` | integer | 否 | 模型自定超时（毫秒），clamp 1_000–600_000；不传取配置 `bash.timeoutMs`（默认 300 秒） |
| `run_in_background` | boolean | 否 | true = 后台启动：立即返回进程 id 与输出文件路径，不受前台超时约束 |

注意：bash 的模型侧 JSON Schema 目前只声明 `command` 一个参数——上表两个参数由执行器直接接受并生效，但没有写进 schema，模型无法从工具清单得知它们的存在，需要在对话里明确告知参数名才能用上。

- 后台输出流式写入 spill 文件（`<home>/spill/proc-<id>.txt`），文件字节偏移就是读游标，内存不积压。
- 完成自动通知：进程结束后经队列以 `trigger:"process"` 的 run 投递到属主会话（note kind `process`），忙会话排队、闲会话唤醒——工具描述明确写有"不要轮询或 sleep 等待"。
- 未送达通知持久化在 `<home>/process-notices.jsonl`，daemon 重启后补发；启动时对记录的进程组做存活检测，活的重进注册表、死的补发通知。
- 单会话并发后台进程上限 8；注册表按会话隔离，process 三件只看得到本会话的进程。
- 沙箱可用时后台命令同样在沙箱内运行（与前台同一条 spawn 路径）。

**process 三件**（safe；list/output parallel、kill serial）：

- `process_list {}`：本会话后台进程清单，最新在前，上限 50 条。
- `process_output { processId, offset?, wait?, timeoutMs? }`：从 `offset` 字节起读增量输出，返回 `nextOffset` 作下次游标；`wait:true` 阻塞等新输出或终态（timeoutMs 默认 30 秒、上限 600 秒）；`data` 带状态与退出码。
- `process_kill { processId }`：SIGKILL 整个进程组；杀已结束的进程不报错。

### goal 三件

模型面 goal 控制，与两家对标实现同形（create/get/update）。全部是既有 GoalLoopHost 路径的投影，goal 引擎零改动；run 边界的独立判定器仍是终态唯一写入者（ADR-0003）。`create_goal`/`update_goal` **sensitive**——审批卡就是"用户明说"的机制化；`get_goal` safe。仅根会话注册（subagent 不能设目标）；已有活跃目标时 create 拒绝（单目标，防嵌套）。

| 工具 | 参数 | 说明 |
|------|------|------|
| `create_goal` | `text` 必填；`acceptance?`（字符串数组） | 落 `GoalLoopHost.set`（armed + 首轮入队），与 `/goal <text> verify:` 同路径；带验收命令时沿用沙箱 fail-closed 检查 |
| `get_goal` | 无参 | 当前目标视图：状态、轮位、budget 消耗、最近判定意见、验收命令、armed |
| `update_goal` | `action`（complete/pause/resume/stop）必填；`note?` | **complete 只请求立即判定**（判定器裁决 met 才落终态，not_met 带意见续跑——模型永不自判完成）；pause=去 armed；resume=重新 armed+立即检查；stop=映射 userStop（掐活跃 run、清队列） |

### todo 两件

`safe`（清单是模型自有的草稿状态，不是能力边界；write `serial`、read `parallel`）。会话级持久：每次写入落一条 `todo.written` 事件（全量快照、后写胜出），投影 `meta.todo`，审计页有 todo 行；跨 run 存活、压缩后可用 `todo_list_read` 读回（压缩摘要会提示）。主线与 subagent 都注册，各会话各清单。与团队任务板（协作）、/goal（用户目标循环）是三个东西。

| 工具 | 参数 | 说明 |
|------|------|------|
| `todo_list_write` | `todos`（TodoItem 数组：`content` + `status`）必填 | **整单替换**（无条目 id，后写胜出）；空数组=清空；返回条数摘要供自查漏行 |
| `todo_list_read` | 无参 | 读回当前清单（未写入过或已清空时返回空态文案） |

- 上限：50 条、单条 200 字符、总 4000 字符，超限拒绝并说明。
- 默认同时只允许一条 `in_progress`（清单如实反映当前动作）；配置 `todo.allowParallelInProgress: true` 松开（并行 subagent 流的逃生口）。

### cron 模型面四件

模型面是既有调度器的投影（与 HTTP `/cron` 路由、WebUI cron 页同域同表）。三个写件 **sensitive**——审批卡上完整可见 name/prompt/调度，用户批准=明说（既定纪律：用户没开口，模型绝不建定时任务）；`cron_list` safe。

| 工具 | 参数 | 说明 |
|------|------|------|
| `cron_create` | `name`、`prompt` 必填；`cron`（标准 5 段）与 `delayMinutes`（1–525600）**恰好二选一** | 触发即新建会话以 prompt 为用户消息，prompt 描述明确要求自包含 |
| `cron_list` | 无参 | 全量列表：id、调度形态、启用、下次运行、上次结果 |
| `cron_update` | `id` + 至少一个字段（`name`/`prompt`/`cron`/`delayMinutes`/`enabled`） | 改 `cron` 或 `delayMinutes` 即转换形态并从现在重排；停用不删记录 |
| `cron_delete` | `id` | 物理删除（与 HTTP DELETE 同语义） |

- **delayMinutes 一次性形态**：`kind:"delay"` 落表（存相对分钟数），触发一次后自动 `enabled=false` 保留记录、永不重排——相对通道是防"模型自算绝对 cron、刚过去的一次性时刻静默滚一年"坑的硬约束（两家对标 harness 源码立规实证）。
- **防递归**：`trigger:"cron"` 的 run（定时触发的会话）只注册 `cron_list`——定时会话不能再给自己安排后继。
- **不带 model 参数**：单条调度用哪个模型是花钱的事，留给用户经 HTTP/CLI 配置。
- 无效 cron 表达式：返回 cron-parser 原始错误（与 HTTP 400 同文案）。

### subagent_run

`safe` · `parallel`。派一个独立的短期 agent 会话执行单个任务，结题答复作为工具结果返回。一批多个 `subagent_run` 并发执行。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | string | 是 | 自包含的任务描述（子会话看不到本对话的任何内容，路径、约束、定义都要写全） |
| `label` | string | 否 | 展示用短名，出现在状态行与确认卡里 |
| `role` | string | 否 | 角色补充说明（如"只做代码评审的审查员"），追加进子会话系统提示词的"角色补充"节，最长 2000 字符 |
| `tools` | string[] | 否 | 工具白名单：只保留列出的工具（内置与 MCP 适配器工具都会被过滤，白名单外的名字忽略），只能减少不能增加；不传继承全部 |
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

## 工具披露分层（tool_search）

工具在注册声明（risk/concurrency）之外还有第三个属性 `exposure`（`tools/exposure.ts` 的正本表，默认 full）：

| 层 | 形态 | 放什么 |
|----|------|--------|
| **full** | 完整 schema 进每请求的 tools 数组 | bash、fs 四件、grep/glob、ask、skill 两件、todo 两件、tool_search 本体 |
| **directory** | 系统提示词"工具目录"节：名字+一行描述；**可直呼**（运行时参数校验保底），参数拿不准用 tool_search 查 | web 两件、memory 两件、session/history 检索、subagent 两件、process 三件、cron 四件、goal 三件、skill_create、ui_render |
| **deferred** | **只列名字**：内置低频工具的名字进系统提示词目录节的一行名单（稳定文本）；MCP 工具名字列在 `tool_search` 自己的描述里（设计好的唯一缓存断点）。描述与 schema 一律不给，经 `tool_search` 查询后调用 | 团队七件 + **全部 MCP 工具**（连接增删不再动 tools 数组与稳定提示段，前缀缓存全程稳定） |

- **tool_search**（safe/parallel）：Okapi BM25（k1 1.2/b 0.75）索引=名字拆词+描述+顶层参数名（schema 正文不算）；精确名直配第一；稀有词门+长查询覆盖率门防误召回；CJK 二元切分（中文友好）。返回完整工具卡（名字+描述+全参 schema+来源）。
- **真提升**：命中的 defs 经执行器上下文的 promote 缝注入本 run 活跃集——下一请求的 tools 数组带上，模型直呼、可并行、逐调用审计照旧（不走折叠转发的桥）。
- 名字调用的边界：完全未注册的名字报 `unknown tool` 错误，附编辑距离最近的可调用名提示（活跃集与检索池里的名字都算候选）；directory 名字直呼有效。引擎里有按层拦截未提升 deferred 调用的分支（`agent/loop.ts`），但其判定条件恒为假（可调用集合包含了执行器表的全部键），实际不拦截——deferred 名字直呼同样会执行；"先检索后调用"目前靠系统提示词与工具描述引导，不由引擎强制。
- **分层清单是静态的、人工评审的**：调用频率持续记录，但层级只在批次评审中调整——tools 数组与目录节都是前缀缓存成分，即时重排等于反复断缓存。
- **目录节按注册表顺序渲染**：directory 层的名字直接取注册表 entries 过滤后的顺序，不做排序。这段文字属于冻结的提示词基线，在 `tools/index.ts` 里移动某个模块的展开位置（例如把 skills 家族挪到条件组之前）会改变基线字节，所有会话的这段缓存随之失效——注册表里 skills 家族排在条件组之后，就是为了保住 skill_create 在目录节中的既有位置。wire 面 tools 数组不受此约束，每请求按名排序（见 [agent-loop](../core/agent-loop.md)）。
- readonly 裁剪与 subagent 白名单先于分层投影（先来的裁剪永远赢）。

## 工具可见性裁剪

| 场景 | 裁剪 |
|------|------|
| subagent 的 run（`childRun`） | 删 `memory_save`（记忆是主线的职责）；永不带 `subagent_run`（单层委派） |
| readonly 权限模式 | 删全部 sensitive 工具（`bash` / `fs_write` / `fs_edit`）；可见范围缩小，但权限判定仍是边界 |

团队工具的注册条件按身份分化：`lead` 身份（含未建队的主线会话，即"预备组长"，见 [agent-team](../core/agent-team.md)）注册全部七个；`member` 身份注册 `send_message` / `list_agents` / `task_*` 五个（不含建队/添加）；不在团队里的会话（cron 会话、非组员的 subagent 会话）一个都没有。

## MCP 工具

外部 MCP server 的工具不在此清单：每个 run 经 RunManager 的 `extraTools(workdir)` 动态注入（取该会话工作目录所在项目组的工具清单），名字与 schema 来自 server 侧（见 [mcp](../core/mcp.md)）。
