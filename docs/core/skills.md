# skills — 技能包：模型可发现、按需加载的指令包

## 职责

`packages/core/src/skills/` 实现技能包（skill）的解析、双作用域扫描与点名匹配；`packages/core/src/tools/skills.ts` 实现 `skill_read` 工具；系统提示词里的技能列表、点名的隐式包装在 `packages/server/src/run.ts` 每 run 装配；只读管理面在 `packages/server/src/routes/skills.ts`（CLI `/skill` 与 Web 技能页共用）。

技能是一种"把操作规程交给模型"的机制：一个技能是一个目录，里面放一份 `SKILL.md`（YAML 头部 + Markdown 正文），描述"遇到什么情况、照什么规程做"。它不写死在代码里——把目录放进约定位置、下一个会话轮次即生效；模型需要用到时按名字把全文加载进上下文，平时不占用。

---

## 设计决策

- **渐进披露两层**：第一层是系统提示词里的一行"可用技能"列表（每个技能只出现名字 + 一句话描述，字符预算默认 6000、超限截断并带可见标记）；模型需要具体规程时，第二层用 `skill_read` 工具按名字加载那份 `SKILL.md` 的完整正文。平时上下文只负担清单，用到才加载全文——描述见 [compaction](./compaction.md) 的上下文预算动机。
- **可见性是发现渠道，不是访问控制**：`disable-model-invocation` / `user-invocable` 两个字段只决定"出现在模型/用户哪一面的列表里"，不是权限门禁——所有档位的技能都能经 `skill_read` 按名加载（用户在对话里点名"按某技能的规程办"就是被隐藏技能的合法入口）。
- **目录名是唯一身份**：技能目录名必须是 Agent Skills 规范允许的形式（小写字母数字加连字符、1–64 字符），也是 `skill_read` 的加载键与斜杠命令名。
- **项目级整目录覆盖全局**：同名技能在不同作用域并存时，项目那份整体替换全局那份（整目录覆盖，不做字段合并）。
- **兼容生态技能**：只解释五个字段，其余 frontmatter 字段一律忽略且不报错——Agent Skills 生态里的现成技能可以不改就放进目录。CRLF 换行与文件头 BOM 都容忍。
- **只改模型看到的输入**：技能点名的隐式包装走通用的 `mapLlmMessages` 钩子（见 [agent-loop](./agent-loop.md)），只改写发给模型的那一份消息——持久化、事件流与聊天气泡保持用户原文（所见即所发）。
- **每 run 现扫，文件即真相**：技能目录在每次 run 开始时重新扫描（不存在则跳过、单条损坏只跳过该条，不拖垮整个 run），改动技能文件不用重启 daemon；`/skills` 管理路由同样每次请求现扫，与 run 同源同规则。
- **用户面隐藏是"不存在"**：`user-invocable: false` 的技能对用户面完全不可见——列表不显示、点名 404，且 404 与"名字不存在"同响应（不向探测者泄露存在性），对齐 Claude Code"从 / 菜单隐藏"。

---

## SKILL.md 格式

一个技能目录形如：

```
~/.kclaw/skills/<目录名>/SKILL.md
```

`SKILL.md` 允许没有 frontmatter（合法的最小技能，全部字段取默认）；有 frontmatter 但 YAML 解析失败才算损坏（解析失败返回 undefined、该技能不加载）。frontmatter 为空（`---\n---`）合法。

只解释五个字段，其余忽略：

| 字段 | 默认 | 含义 |
|------|------|------|
| `name` | 目录名 | 显示名 |
| `description` | 正文第一段 | 干什么 / 何时用 |
| `when_to_use` | 无 | 追加到 description 之后（两者拼接后上限 1536 字符，超限截断） |
| `disable-model-invocation` | `false` | `true` 时从模型可见列表（系统提示词技能清单）里移除；仍可按名加载 |
| `user-invocable` | `true` | `false` 时从用户面（`/skill`、技能页、斜杠命令）里移除，点名 404 |

---

## 双作用域扫描（scanSkillDirs）

两个技能目录，合并按名字：

- **全局**：`<home>/skills/`（`paths.skillsDir`，见 [storage](./storage.md)）；
- **项目级**：会话工作目录下的 `.kclaw/skills/`（`<workdir>/.kclaw/skills`），作用域跟会话工作目录走。

同名时**项目那份整体覆盖全局那份**。目录不可读 / 不存在时整体跳过；单条损坏（悬空的符号链接、扫描途中被删的目录）只跳过该条，不拖垮整个作用域。符号链接的技能目录穿透加载到目标。

## 渐进披露的两层

### 第一层：系统提示词技能清单（skillListPrompt）

每 run 拼装系统提示词时，把模型可见的技能（未被 `disable-model-invocation` 隐藏的）渲染成一段"可用技能"清单，追加在 AGENTS.md 基础提示与 L2 认知之后（见 [run-manager](../server/run-manager.md) 的装配第 2/9 步）：

```
## 可用技能
需要时先用 skill_read 工具按名字加载完整说明，再照说明执行：
- <技能名>: <一句话描述>
```

清单为空（没有模型可见技能）时不追加。字符预算默认 6000，装不下的部分截断并附一行可见标记。

### 第二层：skill_read 工具

`skill_read {name}` 按名字加载一个技能的 `SKILL.md` 完整正文（`tools/skills.ts`）。`safe` + `parallel`：只读 daemon 已经扫描过的文件，不碰工作目录。同名技能的项目副本胜出（与扫描一致）。没有该技能报 `没有叫 <name> 的技能（可用技能见系统提示词列表，或 /skill 查看）`；正文为空的技能报错不加载。

模型如何知道该用哪个：系统提示词清单给出名字与一句话描述；`disable-model-invocation` 的技能不在清单里，但用户在对话里直接点名（"按 commit-helper 的规程办"）时模型仍能按名加载——这是该档位技能唯一合法的入口。

## 技能点名与隐式包装

### 点名检测（matchSkillInvocations）

用户消息里**任意位置**的 `/<技能名>` 记号，只要前一个字符不是 ASCII 字母数字，就算点名了一次该技能（精确按目录名匹配、仅匹配"已安装且用户可调用"的技能；`com/test` 这类 URL 片段里的 `/` 不误伤，`帮我/test` 这类未加空格的中文邻接能命中）。重复点名去重，顺序按出现顺序。

### 隐式包装（wrapSkillInvocations）

点名命中后，daemon 在**发给模型的那份输入**末尾追加一行调用指示（原文一字不动地保留，后面加一句）：命中的是技能 `<name>`，请先用 `skill_read` 读取该技能完整规程、再按规程处理本条消息；命中多个时逐个点名。这一行只存在于发给 provider 的消息里——持久化、事件流与聊天气泡保持用户输入的原文（所见即所发）。

包装经通用的模型视图改写钩子 `AgentDeps.mapLlmMessages` 生效（每次 `llm.stream` 之前，见 [agent-loop](./agent-loop.md)），配合 `withLastUserText` 锚定"最后一条 user 消息"——工具循环的第二轮起列表末条是 tool 消息，锚定最后一条 user 才能让改写在每一轮都生效。

**仅 `trigger: "user"` 生效**：job 提示是 daemon 生成的内部指令，不参与点名。

## 管理面与前端入口

`/skills` 路由族（`packages/server/src/routes/skills.ts`，始终注册、无装配依赖）是只读管理面：

- `GET /skills?workdir=`：用户可见技能列表 `{name, displayName, description, visibility, origin}`——`visibility` 是 `all`（模型+用户）或 `user-only`（被 `disable-model-invocation` 隐藏但仍用户可见），`origin` 是 `global` / `project`；
- `GET /skills/:name?workdir=`：单个技能详情，带 `content`（SKILL.md 正文）。路径段先过白名单校验（拦目录穿越段）；`user-invocable: false` 的技能 404，与未知名字同响应。

三个用户入口共用这套路由：

- **CLI `/skill [名字]`**：无参列出已装技能（名字 / 作用域 / 可见性 / 描述，作用域跟会话工作目录）；带名字打印该技能的完整正文；
- **Web 技能页**（只读 tab）：左栏清单、右栏正文，文件即真相、无编辑动作；
- **技能即斜杠命令**：每个用户可见技能在 CLI 与 Web 两端自动注册成 `/<技能名> [要求]` 命令，命令发送用户原文（点名交给 daemon 检测）；内置命令名优先——与内置重名的技能命令被丢弃，自定义 `commands/*.md`（先注册）同样优先于技能。

## 边界与出错

- **技能目录与 run 解耦**：扫描失败（目录不可读、单条损坏）只影响该次扫描本身，不拖垮 run；技能列表为空时系统提示词不追加，行为与无技能完全一致。
- **点名包装不改变存储**：包装只发生在模型视图，JSONL 事件流与气泡里是用户原文。
- **`user-invocable: false` 不是安全边界**：它只把技能从用户面列表隐藏；用户点名（斜杠命令已隐藏、但对话里打字点名）仍可经 `skill_read` 加载——隐藏的是"发现渠道"，不是"访问权"。
- **description 有截断**：`description` + `when_to_use` 拼接上限 1536 字符（对齐 Claude Code 的清单长度），超限从尾部截断。

## 关联

- [tools](./tools.md)：`skill_read` 在 11 个内置工具里的位置与注册
- [agent-loop](./agent-loop.md)：`mapLlmMessages` 模型视图改写钩子与 `withLastUserText`
- [run-manager](../server/run-manager.md)：系统提示词装配（基础 + 认知 + 技能清单）、技能目录每 run 扫描
- [http-api](../server/http-api.md)：`/skills` 路由族的协议细节
- [cli](../cli/cli.md) / [webui](../web/webui.md)：`/skill` 命令与技能页、技能即斜杠命令
- [storage](./storage.md)：`<home>/skills/` 全局技能目录在目录树里的位置
