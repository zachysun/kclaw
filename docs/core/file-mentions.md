# file-mentions — @ 文件引用

用户消息里写 `@路径`，模型在回答前先读取该文件的完整内容。本篇讲引用的提取规则、解析流程与模型侧包装；抽屉的交互细节见 [webui](../web/webui.md)。

## 作用

在用户消息里用 `@路径` 引用项目文件（如「把 @src/main.ts 的逻辑讲给我听」），让模型在回答前先读取该文件的完整内容。实现分三层：纯函数层（core `packages/core/src/mentions.ts`，负责提取、候选补全与模型侧包装文本，无 Node API，浏览器构建可直接引用）、运行组装层（core `run-assembly.ts` 的 `resolveFileMentions`，把 token 解析成工作区里的真实文件）、数据源层（server `GET /fs/files`，提供抽屉的候选清单）。WebUI 的输入框用同一套纯函数做联想抽屉；手动输入与抽屉补全的引用走完全相同的解析路径，行为一致。CLI（`kclaw chat` 与 `kclaw run`）只发送原文，`@路径` 同样全部由 daemon 在这里处理，几个界面规则一致。

## 设计决策

- **只改模型看到的输入，持久化与气泡保持原文**：与技能指定同一原则（见 [skills](./skills.md)），`message` 事件、events.jsonl 与聊天气泡存的是用户输入的原文；只有发给 provider 的那份文本追加了读取指示。用户看到什么、发的是什么，系统里就存什么。包装文本记录在消息的 `llmText` 标记上、之后按标记重放（见 [agent-loop](./agent-loop.md) 的包装标记重放）。被引用文件此后被删除或改动，只影响之后的新消息，历史消息保持首次发送的字节。
- **边界规则：`@` 只在行首或空白之后才开引用**。邮箱地址（`foo@bar.com`）和词中间的 `@`（`@abc` 前面的字符不是空白）不进入提取。这条规则在纯函数提取与抽屉打开两处一致，手动输入和补全的行为天然一致。
- **逃出工作区的 token 留在原文、不产生指示**：解析按权限引擎同一口径（realpath、跟随符号链接，工作区内的链接指向外部即逃逸），引用解析不到文件（已删除、从未存在、是目录）也保留原文，但指示文本里会明确说明该引用无效，让模型不要尝试读取、向用户说明。
- **只有用户消息参与指定检测**：`trigger:"user"` 才做包装；cron 提示是 daemon 生成的内部指令，不参与指定检测（与技能指定同一开关）。
- **清单有上限**：`FILE_LIST_CAP = 5000` 条，仓库大到截断时响应带 `truncated: true`，WebUI 抽屉尾部显示一行提示（避免用户以为仓库里就这些文件）。

## 提取与解析（core `mentions.ts` + `run-assembly.ts`）

### 纯函数（`packages/core/src/mentions.ts`）

- **`extractFileMentions(text)`**：按边界规则扫描全文，把每个 `@` 到下一个空白之间的 token 提取出来；重复 token 合并、扫描顺序保留。只做语法解析，存在性与工作区边界在运行组装层判断（那里才知道工作区在哪）。
- **`fileMentionCompletions(input, files)`**：抽屉候选，输入**最后一个空白分隔的片段**以 `@` 开头才返回候选（`@` 在词中间或片段已结束返回空）。候选按相对路径子串过滤（大小写不敏感），分三档排序：文件名前缀命中 > 文件名子串命中 > 仅路径命中；同档浅路径在前、再按字典序。上限 `FILE_MENTION_CAP = 50`。只负责排序与封顶，禁选（如含空白的路径）由抽屉自己呈现。
- **`replaceTrailingMentionToken(draft, file)`**：把草稿末尾进行中的 `@token` 替换成选中的路径加一个尾随空格，例如 `看 @sr` 补全成 `看 @src/main.ts `，不破坏整句。
- **`wrapFileMentions(text, resolutions)`**：生成追加在用户消息后面的指示行。一条引用生成「请用 `fs_read` 工具读取该文件的完整内容，再结合它处理本条消息」；多条引用合并成一行，逐个列出引用并要求依次读取这些文件；`missing` 的生成「其中…引用的文件不存在或已删除：请向用户说明，不要尝试读取」。没有需要指示的内容时返回 `undefined`（原样发送）。

### 运行组装（`run-assembly.ts` 的 `executeRun`）

1. **工作区解析** `resolveFileMentions(text, workspace)`：每个 token 相对会话工作目录（默认 daemon 的 `workspace`）解析，realpath 后必须落在工作区内且是普通文件 → `ok`；不是文件 → `missing`；逃逸 → 整个丢弃（不产生指示行）。
2. **合并** `combineMentionTexts`：技能指定的包装文本（见 [skills](./skills.md)）与文件指定的指示行合并成一份 `llmUserText`；两者都不匹配时保持原样。
3. **应用**：`llmUserText` 经内置 `skill-wrap` hook（`llm-before` 位置，见 [hooks](./hooks.md)）的 `withLastUserText` 按内容锚定到本轮 user 消息（steer 插话排到列表末尾时仍按内容找到本轮消息，不会误改插话）并替换其文本。只在这一步影响模型输入；包装文本已在组装层记录到消息的 `llmText` 标记、之后按标记重放（见 [agent-loop](./agent-loop.md) 的包装标记重放）。

## 数据源：GET /fs/files（server `routes/fs.ts`）

抽屉的候选清单来自 `GET /fs/files?workdir=<绝对路径>`（默认取 `config.workspace`），响应 `{workdir, files, truncated}`：`files` 是工作区相对路径（POSIX 分隔、仅文件、大小写不敏感排序），`truncated` 是清单是否在 5000 条处被截断。鉴权与其他 API 路由相同（Bearer）。

文件清单的产生（`listWorkspaceFiles`）：

- **git 仓库**（优先）：执行 `git ls-files -z -co --exclude-standard`，列出已跟踪文件与未被 ignore 的未跟踪文件，git-ignored 内容不会出现。`-z` 用 NUL 分隔（按字节切分，非 ASCII 文件名不损坏），随后按 `existsSync` 过滤掉索引里已被删除的条目。
- **非 git 仓库 / git 不可用**：递归扫描目录收集普通文件，**不进入** `.git`、`.kclaw`、`node_modules` 三个目录（readdir 本身就是磁盘实况，无需再过滤）；不可读的子目录跳过、其余照常列出。
- 两条路径都排序并封顶 5000 条。目标必须是存在的目录，否则 400。

## 限制

- **邮箱地址与词中间的 `@` 不算引用**：提取规则要求 `@` 在行首或空白之后，`foo@bar.com` 与 `@abc` 都不进入提取。
- **引用逃出工作区的 token 留在原文、不产生指示**：解析按权限引擎同一口径（realpath、跟随符号链接），逃逸的引用整个丢弃，模型看到的是普通文本。
- **清单封顶与截断**：5000 条封顶，响应带 `truncated: true`；抽屉提示截断，候选过滤仍可用（发生在浏览器侧）。

## 错误处理

- **引用路径是目录或已删除**：指示行明确告知无效，并要求模型向用户说明、不要尝试读取。

## Reference

- [skills](./skills.md)：同机制的先例，包括指定包装、`skill-wrap` 内置 hook 与 `withLastUserText`
- [hooks](./hooks.md)：`llm-before` 位置与 `skill-wrap` hook（文件与技能指定共用）
- [agent-loop](./agent-loop.md)：`llm-before` 改写模型视图的位置语义
- [http-api](../server/http-api.md)：`GET /fs/files` 路由与 `GET /fs/browse`（工作目录选择器，同一 `fs.ts` 文件）
- [webui](../web/webui.md)：@ 抽屉的交互（与斜杠命令共用的联想菜单）
- [protocol](./protocol.md)：message 事件附带的原文（包装不改写持久化）
