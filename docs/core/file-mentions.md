# file-mentions — @ 文件引用

## 职责

在用户消息里用 `@路径` 引用项目文件（如「把 @src/main.ts 的逻辑讲给我听」），让模型在回答前先读取该文件的完整内容。实现分三层：纯函数层（core `packages/core/src/mentions.ts`——提取、候选补全与模型侧包装文本，无 Node API，浏览器构建可直接引用）、运行装配层（core `run-assembly.ts` 的 `resolveFileMentions`——把 token 解析成工作区里的真实文件）、数据源层（server `GET /fs/files`——提供抽屉的候选清单）。WebUI 的输入框用同一套纯函数做联想抽屉；手打与抽屉补全的引用走完全相同的解析路径，行为一致。

## 设计决策

- **只改模型看到的输入，持久化与气泡保持原文**：与技能点名同一原则（见 [skills](./skills.md)）——`message` 事件、events.jsonl 与聊天气泡存的是用户输入的原文；只有发给 provider 的那份文本追加了读取指示。用户看到什么、发的是什么，系统里就存什么。
- **边界规则：`@` 只在行首或空白之后才开引用**。邮箱地址（`foo@bar.com`）和词中间的 `@`（`@abc` 前面的字符不是空白）不进入提取——这条规则在纯函数提取与抽屉打开两处一致，手打和补全的行为天然对齐。
- **逃出工作区的 token 留在原文、不产生指示**：解析按权限引擎同一口径（realpath、跟随符号链接——工作区内的链接指向外部即逃逸），引用解析不到文件（已删除、从未存在、是目录）也保留原文，但指示文本里会明说该引用无效，让模型不要尝试读取、向用户说明。
- **只有用户消息参与点名**：`trigger:"user"` 才做包装；job 提示是 daemon 生成的内部指令，不参与点名（与技能点名同一开关）。
- **清单有上限**：`FILE_LIST_CAP = 5000` 条——仓库大到截断时响应带 `truncated: true`，WebUI 抽屉尾部显示一行提示（避免用户以为仓库里就这些文件）。

## 提取与解析（core `mentions.ts` + `run-assembly.ts`）

### 纯函数（`packages/core/src/mentions.ts`）

- **`extractFileMentions(text)`**：按边界规则扫描全文，把每个 `@` 到下一个空白之间的 token 提取出来；重复 token 合并、扫描顺序保留。只做语法——存在性与工作区边界在运行装配层判断（那里才知道工作区在哪）。
- **`fileMentionCompletions(input, files)`**：抽屉候选——输入**最后一个空白分隔的片段**以 `@` 开头才返回候选（`@` 在词中间或片段已结束返回空）。候选按相对路径子串过滤（大小写不敏感），分三档排序：文件名前缀命中 > 文件名子串命中 > 仅路径命中；同档浅路径在前、再按字典序。上限 `FILE_MENTION_CAP = 50`。只负责排序与封顶，禁选（如含空白的路径）由抽屉自己呈现。
- **`replaceTrailingMentionToken(draft, file)`**：把草稿末尾进行中的 `@token` 替换成选中的路径加一个尾随空格——`看 @sr` 补全成 `看 @src/main.ts `，不破坏整句。
- **`wrapFileMentions(text, resolutions)`**：生成追加在用户消息后面的指示行。一条引用生成「请用 `fs_read` 工具读取该文件的完整内容，再结合它处理本条消息」；多条依次点名；`missing` 的生成「引用的文件不存在或已删除：请向用户说明，不要尝试读取」。没有需要指示的内容时返回 `undefined`（原样发送）。

### 运行装配（`run-assembly.ts` 的 `executeRun`）

1. **工作区解析** `resolveFileMentions(text, workspace)`：每个 token 相对会话工作目录（缺省 daemon 的 `workspace`）解析，realpath 后必须落在工作区内且是普通文件 → `ok`；不是文件 → `missing`；逃逸 → 整个丢弃（不产生指示行）。
2. **合并** `combineMentionTexts`：技能点名的包装文本（见 [skills](./skills.md)）与文件点名的指示行合并成一份 `llmUserText`——两者都不匹配时保持原样。
3. **应用**：`llmUserText` 经内置 `skill-wrap` 钩子（`llm-before` 位置，见 [hooks](./hooks.md)）的 `withLastUserText` 替换发送消息里最后一条 user 消息的文本。只在这一步影响模型输入。

## 数据源：GET /fs/files（server `routes/fs.ts`）

抽屉的候选清单来自 `GET /fs/files?workdir=<绝对路径>`（缺省取 `config.workspace`），响应 `{workdir, files, truncated}`——`files` 是工作区相对路径（POSIX 分隔、仅文件、大小写不敏感排序），`truncated` 是清单是否在 5000 条处被截断。鉴权与其他 API 路由相同（Bearer）。

文件清单的产生（`listWorkspaceFiles`）：

- **git 仓库**（优先）：跑 `git ls-files -z -co --exclude-standard`——跟踪的 + 未被 ignore 的未跟踪文件，git-ignored 内容不会出现。`-z` 用 NUL 分隔（按字节切分，非 ASCII 文件名不损坏），随后按 `existsSync` 过滤掉索引里已被删除的条目。
- **非 git 仓库 / git 不可用**：递归扫描目录收集普通文件，**不进入** `.git`、`.kclaw`、`node_modules` 三个目录（readdir 本身就是磁盘实况，无需再过滤）；不可读的子目录跳过、其余照常列出。
- 两条路径都排序并封顶 5000 条。目标必须是存在的目录，否则 400。

## WebUI 抽屉（`packages/web/src/chat/`）

ChatPanel 在会话选中/工作目录变化时用 `useSilentFetch` 拉 `/fs/files?workdir=`（失败静默为空），传给 ChatView。输入框的联想菜单由斜杠命令与 @ 文件**共用一个抽屉**：正在输入的最后一个词以 `/` 开头出命令、以 `@` 开头出文件候选，首字符互斥所以两类不会同时出现。候选来自 `fileMentionCompletions`；路径含空白（无法无歧义写进消息）的条目**可见但禁选**；选中的候选经 `replaceTrailingMentionToken` 替换尾词并加尾随空格。清单被后端截断（`truncated: true`）时抽屉尾部显示一行提示。

## 边界与出错

- 邮箱地址与词中 `@` 不是引用（边界规则），不会产生指示、也不会被误读。
- 引用逃逸工作区：原文照发、无指示行——模型看到的是普通文本。
- 引用路径是目录或已删除：指示行明确告知无效，模型向用户说明而不是尝试读取。
- 清单封顶与截断：5000 条封顶、`truncated` 标记；抽屉提示截断但检索仍可用（候选过滤发生在浏览器侧）。
- 持久化与事件流保持用户原文：`fs_read` 指示只存在于发给 provider 的文本里，审计与气泡不会暴露这份包装。

## 关联

- [skills](./skills.md)：同机制的先例——点名包装、`skill-wrap` 内置钩子与 `withLastUserText`
- [hooks](./hooks.md)：`llm-before` 位置与 `skill-wrap` 钩子（文件与技能点名共用）
- [agent-loop](./agent-loop.md)：`llm-before` 改写模型视图的位置语义
- [http-api](../server/http-api.md)：`GET /fs/files` 路由与 `GET /fs/browse`（工作目录选择器，同一 `fs.ts` 文件）
- [webui](../web/webui.md)：@ 抽屉的交互（与斜杠命令共用的联想菜单）
- [protocol](./protocol.md)：message 事件携带的原文（包装不改写持久化）
