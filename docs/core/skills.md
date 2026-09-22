# skills — 技能：模型可发现、按需加载的指令包

## 职责

`packages/core/src/skills/` 实现技能（skill）的解析、双作用域扫描与指定匹配（`index.ts`），技能复用——其他 coding agent 技能的检测与软链接接入（`discovery.ts`、`links.ts`），以及**技能进化**——提案制的技能自我改进（`evolution.ts`、`proposals.ts`）；`packages/core/src/tools/skills.ts` 实现 `skill_read` / `skill_list` / `skill_create` 工具；系统提示词里的技能列表、指定的隐式包装在 run 组装（core `packages/core/src/agent/run-assembly.ts` 的 `executeRun`）每个 run 完成；管理入口在 `packages/server/src/routes/skills.ts`（CLI `/skill` 与 Web 技能页共用），技能进化的调度器在 `packages/server/src/skill-scheduler.ts`。

技能是一种"把操作规程交给模型"的机制：一个技能是一个目录，里面放一份 `SKILL.md`（YAML 头部 + Markdown 正文），描述"遇到什么情况、照什么规程做"。它不写死在代码里——把目录放进约定位置、下一个会话轮次即生效；模型需要用到时按名字把全文加载进上下文，平时不占用。

---

## 设计决策

- **渐进披露两层**：第一层是系统提示词里的一行"可用技能"列表（每个技能只出现名字 + 一句话描述，字符 budget 默认 6000、超限截断并带可见标记）；模型需要具体规程时，第二层用 `skill_read` 工具按名字加载那份 `SKILL.md` 的完整正文。平时上下文只负担清单，用到才加载全文——描述见 [compaction](./compaction.md) 的上下文 budget 动机。
- **可见性是发现渠道，不是访问控制**：`disable-model-invocation` / `user-invocable` 两个字段只决定"出现在模型/用户哪一面的列表里"，不是权限门禁——所有档位的技能都能经 `skill_read` 按名加载（用户在对话里指名"按某技能的规程办"就是被隐藏技能的合法入口）。
- **目录名是唯一身份**：技能目录名必须是 Agent Skills 规范允许的形式（小写字母数字加连字符、1–64 字符），也是 `skill_read` 的加载键与斜杠命令名。
- **项目级整目录覆盖全局**：同名技能在不同作用域并存时，项目那份整体替换全局那份（整目录覆盖，不做字段合并）。
- **兼容生态技能**：只解释五个字段，其余 frontmatter 字段一律忽略且不报错——Agent Skills 生态里的现成技能可以不改就放进目录。CRLF 换行与文件头 BOM 都兼容。
- **只改模型看到的输入**：技能指定的隐式包装是内置 `skill-wrap` hook（`llm-before` 位置，见 [hooks](./hooks.md)），只改写发给模型的那一份消息——持久化、事件流与聊天气泡保持用户原文（所见即所发）。
- **每个 run 重新扫描，以文件为准**：技能目录在每次 run 开始时重新扫描（不存在则跳过、单条损坏只跳过该条，不拖垮整个 run），改动技能文件不用重启 daemon；`/skills` 管理路由同样每次请求重新扫描，与 run 同源同规则。
- **用户面隐藏是"不存在"**：`user-invocable: false` 的技能对用户面完全不可见——列表不显示、按名调用返回 404，且 404 与"名字不存在"同响应（不向检测者泄露存在性），对齐 Claude Code"从 / 菜单隐藏"。
- **复用是链接不是复制**：其他 coding agent（Claude Code、Codex、DeepSeek harness、zCode）的技能以软链接接入，内容不复制、仍由源目录维护，外部 SKILL.md 一字不动；复用元数据与可见档位存在 kclaw 侧的旁挂文件里（见下文"技能复用"）。

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
| `user-invocable` | `true` | `false` 时从用户面（`/skill`、技能页、斜杠命令）里移除，按名调用返回 404 |

---

## 双作用域扫描（scanSkillDirs）

两个技能目录，合并按名字：

- **全局**：`<home>/skills/`（`paths.skillsDir`，见 [storage](./storage.md)）；
- **项目级**：会话工作目录下的 `.kclaw/skills/`（`<workdir>/.kclaw/skills`），作用域跟会话工作目录走。

同名时**项目那份整体覆盖全局那份**。目录不可读 / 不存在时整体跳过；单条损坏（悬空的符号链接、扫描途中被删的目录）只跳过该条，不拖垮整个作用域。符号链接的技能目录穿透加载到目标——技能复用（软链接接入）就建立在这条行为上。

合并之后，复用链接的可见档位按 realpath 覆盖两布尔（run 组装与 `/skills` 路由共用 `applyReuseTiers`，见下文"技能复用"），模型清单、指定匹配与用户接口看到的是同一份结果。

## 渐进披露的两层

### 第一层：系统提示词技能清单（skillListPrompt）

每 run 拼装系统提示词时，把模型可见的技能（未被 `disable-model-invocation` 隐藏的）渲染成一段"可用技能"清单，追加在 AGENTS.md 基础提示与 L2 认知之后（见 [run-manager](../server/run-manager.md) 的组装第 6/11 步）。清单属于系统提示词的实时段（live，见 [hooks](./hooks.md) 的分段冻结）：技能安装/卸载后下一个 run 就进清单，即时生效；对提示词缓存的代价只是实时段之后的部分失效，前面的稳定段前缀继续命中。调用检测与 `skill_read` 每个 run 重新扫描目录。清单格式：

```
## 可用技能
需要时先用 skill_read 工具按名字加载完整说明，再照说明执行：
- <技能名>: <一句话描述>
```

清单为空（没有模型可见技能）时不追加。字符 budget 默认 6000，装不下的部分截断并附一行可见标记。

### 第二层：skill_read 工具

`skill_read {name}` 按名字加载一个技能的 `SKILL.md` 完整正文（`tools/skills.ts`）。`safe` + `parallel`：只读 daemon 已经扫描过的文件，不碰工作目录。同名技能的项目副本胜出（与扫描一致）。没有该技能报 `没有叫 <name> 的技能（可用 skill_list 列出已装技能，或 /skill 查看）`；正文为空的技能报错不加载。

模型如何知道该用哪个：系统提示词清单给出名字与一句话描述；`disable-model-invocation` 的技能不在清单里，但用户在对话里直接指名（"按 commit-helper 的规程办"）时模型仍能按名加载——这是该档位技能唯一合法的入口。

清单之外还有一条自助发现通道：**`skill_list` 工具**（`{query?}`，与 `skill_read` 同族、同一份扫描结果，可见口径一致）——清单有字符 budget、技能多时截断，subagent 更是不注入清单，模型需要完整清单或按关键词找技能时调它（先 list 找到名字，再 skill_read 取正文）。

## 技能调用与隐式包装

### 调用检测（matchSkillInvocations）

用户消息里**任意位置**的 `/<技能名>` 记号，只要前一个字符不是 ASCII 字母数字，就算一次技能调用（精确按目录名匹配、仅匹配"已安装且用户可调用"的技能；`com/test` 这类 URL 片段里的 `/` 不误伤，`帮我/test` 这类未加空格的中文邻接能命中）。重复指定去重，顺序按出现顺序。

### 隐式包装（wrapSkillInvocations）

指定命中后，daemon 在**发给模型的那份输入**末尾追加一行调用指示（原文一字不动地保留，后面加一句）：命中的是技能 `<name>`，请先用 `skill_read` 读取该技能完整规程、再按规程处理本条消息；命中多个时逐个列出。这一行只存在于发给 provider 的消息里——持久化、事件流与聊天气泡保持用户输入的原文（所见即所发）。

包装经内置 `skill-wrap` hook 在 `llm-before` 位置生效（每次 `llm.stream` 之前，见 [hooks](./hooks.md)），配合 `withLastUserText` 锚定"最后一条 user 消息"——工具循环的第二轮起列表末条是 tool 消息，锚定最后一条 user 才能让改写在每一轮都生效。

**仅 `trigger: "user"` 生效**：job 提示是 daemon 生成的内部指令，不参与指定检测。

## 技能复用（软链接接入其他 agent 的技能）

kclaw 的技能目录可以以**软链接**的方式接入其他 coding agent 已有的技能：链接建在 kclaw 的技能目录里、指向外部技能目录，扫描器本就穿透符号链接加载，复用技能零改动进入全套机制（清单、指定包装、`skill_read`）。实现分两个模块（都在 `packages/core/src/skills/`）：`links.ts` 管链接与旁挂元数据，`discovery.ts` 管检测。

### 检测（discovery.ts）

- **来源**：四个内置约定目录（`~/.claude/skills`、`~/.codex/skills`、`~/.dsh/skills`（DeepSeek harness）、`~/.zcode/skills`）加上当前作用域旁挂文件里手工登记的 `extraSources` 目录；以及**已安装插件的内置技能**——读 Claude Code（`~/.claude/plugins/installed_plugins.json`）与 zCode（`~/.zcode/cli/plugins/installed_plugins.json`）的插件安装清单，对每个已安装插件在当前版本的安装路径下枚举 `skills/<name>/SKILL.md` 与 `skills/<分类>/<name>/SKILL.md` 两种层级。清单文件两种形态都解析（zCode 平铺数组、Claude 按"插件@市场"分组的每项目条目，插件名取自键），缺失或损坏视为无插件技能，检测永不因清单报错。
- **去重**：目录候选按 realpath 归一：同一份真实目录经多层软链接出现在多家（如 `.zcode` → `.claude` → `.cc-switch`）时只出一条，来源标签聚合。插件候选按"插件名 + 插件内路径"去重，同一插件装在两家时是两份独立的相同内容，合并为一条、来源聚合；与用户级目录同名的插件技能内容确实不同，保留两行。
- **来源标签**：插件技能的来源标**插件名**（superpowers、mattpocock-skills）——这是用户认识的名字；用户级技能标 agent 名。
- **状态标**：`reused`（该真实路径已被任一作用域的链接记录指向）、`conflict`（某自有技能占了同名但内容不同——同名同内容就是已复用）、`stale`（来源目录缺失或候选悬空）。任何失效都显示为状态而不是报错。
- **预览安全**：SKILL.md 正文预览接口校验请求路径必须解析到一个已发现的候选（或位于已登记来源之下）——候选的真实目录通常在 agent 目录**外面**（那些目录里只有软链接），所以单靠"在来源之下"会拒掉发现列表给出的目标。校验双条件并存，接口不是任意文件读取。

### 复用链接的版本语义

复用插件的技能时，链接指向**创建当时的版本目录**。插件升级到新版本目录后，旧链接仍可用（旧版本目录还在磁盘上），但内容已过时——链接清单的每条记录带 `current` 标（目标仍是检测正在提供的版本之一），页面据此标"已过时"，取消后重新复用一次即切到新版。链接不自动跟随插件升级（那需要一层版本解析）；Codex 的 `.system` 内置技能目录不参与检测。

### 链接与档位（links.ts）

每个作用域一份旁挂文件：全局 `~/.kclaw/skills/.links.json`，项目级 `<workdir>/.kclaw/skills/.links.json`。点开头的文件名不在技能目录名的合法集合里，扫描器天然忽略。结构：

```json
{ "links": [{ "name": "pdf", "target": "/真实/技能目录", "agent": "claude", "tier": "all" }], "extraSources": ["/额外/检测目录"] }
```

- `tier` 是复用技能的**可见档位**，四档与 frontmatter 两布尔一一对应：`all`（完全可见）/ `user`（仅用户，相当于 `disable-model-invocation: true`）/ `model`（仅模型，相当于 `user-invocable: false`）/ `off`（暂不启用，两边都隐藏、链接与 `skill_read` 仍有效）。外部 SKILL.md 属于别的 agent，不可改写——档位只能存在 kclaw 侧。
- **档位默认从源技能推断**：建链接不传 `tier` 时，按源 SKILL.md 的 frontmatter 可见性反推（`suggestTier`）——`disable-model-invocation: true` 且 `user-invocable: true` 的技能推断为 `user` 档（仅用户可指名调用）、只设 `user-invocable: true` 的推断为 `all`、`disable-model-invocation: true` 且 `user-invocable: false`（两面都隐藏）的推断为 `off` 档、其余为 `model` 档；frontmatter 无法解析时回退到 `all`。复用继承作者的可见性意图，用户显式选档位才覆盖。
- `plugin` 是归属说明（可选）：复用插件技能时记录所属插件名，跟随技能出现在所有用户面——技能页已装清单（"来自插件 X"）、CLI `/skill` 列表、两端的斜杠命令描述。模型面的系统提示词清单不带（模型只需内容，且省 budget）。归属出现前建的旧记录由链接清单接口惰性回填：目标能匹配到已安装插件就自动补名。
- **档位覆盖按 realpath 匹配**：合并扫描结果后，技能目录的 realpath 命中某条链接记录的 target 才套用档位；项目作用域的记录后应用、盖过全局（与目录覆盖同向）。只共享名字的自有技能不受影响——它该由发现列表的冲突标记提示。
- 创建链接时目标必须是存在且含 SKILL.md 的目录，链接名必须是合法技能目录名；作用域目录缺失时递归创建；写入旁挂文件原子化（临时文件 + rename，0600）。
- 旁挂文件缺失或损坏一律降级为空——它永远不阻塞技能加载主链路。
- 删除只对真正的符号链接 `unlink`：同名位置已被真实目录占据（事后手工放入）时只清记录、不动磁盘。
- **管理记录不受可见性过滤影响**：复用链接的清单直接从旁挂文件读取，不经过"用户不可见即 404"的过滤——否则档位设成 `model`（仅模型）后它在管理页消失、无法改回。管理接口本身持 token 鉴权，不影响用户面"不泄露存在性"的语义。

## 技能进化（提案制）

技能进化是"让技能库随使用变好"的机制：一轮对话（run）里卷入过的技能（被 `skill_read` 读取、被 `skill_list` 列出、被用户 `/点名`）在对话结束并空闲一段时间后，由系统自动提炼成**技能提案**（一份待确认的技能新增/修订建议），写进 `<skillsDir>/.proposals/`（点开头的目录，技能扫描器不认，见上文的目录名规则），绝不触碰已生效的技能。提案在 WebUI 技能页的「提案」页签里人工审阅：确认即写入技能目录、下一轮对话自动吃到；可驳回；已确认的可回退。对话中模型也可经 `skill_create` 工具当场发起提案，走同一个审阅状态机。整个功能在 config 中可开关，默认开启。

状态机：`proposed → applied | rejected`，`applied → reverted`；`rejected` / `reverted` 保留在磁盘上可手动清理。核心实现在 `packages/core/src/skills/proposals.ts`（提案存取与治理）与 `evolution.ts`（提炼 pipeline 与调度簿记），服务端消费端在 `packages/server/src/skill-scheduler.ts`。

### 配置（skills.evolution）

`KclawConfig.skills.evolution`（可选节，不写时取默认值）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `skills.evolution.enabled` | `true` | 总开关。`false` 时功能完全惰性：run 收尾不排检查、调度器不消费、`skill_create` 返回固定关闭文案；已有的提案文件无论开关状态都可列表查看 |
| `skills.evolution.idleMinutes` | `10` | run 结束后到提炼检查可触发的空闲窗口分钟数，与 `memory.write.idleMinutes` 互不牵动。`0` 视为关闭延迟补查（此时只剩 `skill_create` 一条提案路径）。负数/非整数按字段回退默认并警告 |

### 提炼时机

两条路径，共同点是都只产生提案文件、不碰生效技能：

**run 收尾粗查（内置 hook `skill-follow-check`，`run-after` order 40）**。每个 run 结束时（任何 stopReason）做一次**零成本、零 LLM** 的纯读检查：范围 = 该项目全部会话（**含 subagent 会话**，刻意不排除——观察盲区正是要覆盖的对象）各自的未提取增量；卷入判定 = 范围内任一消息满足之一——assistant 消息的 `tool_call` 块名字是 `skill_read` 或 `skill_list`，或 user 消息文本命中已装技能名的 `/记号`（正则与 `matchSkillInvocations` 同源，但匹配集合是**全部已装技能名**，不受 user-invocable 档位过滤——被隐藏的技能被点名同样是"卷入"）。未卷入：不排检查、不动增量进度，一次 LLM 都不调。卷入：把 `{sessionId, endTurnAt}` 写进该项目的检查表（同会话重复排 = 刷新锚点）。功能关闭（`enabled !== true`）或 `idleMinutes <= 0` 时钩子直接返回；子会话 run 不排（subagent 自己不排，它的使用由同项目后续任一主干 run 的粗查统一覆盖——粗查范围含子会话增量）。

**延迟补查（`skill-scheduler.ts`，默认每 60s 扫一次）**。sweep 照记忆调度器按 workdir 循环挂起检查，空闲门禁复用记忆侧同一纯函数 `followGateDue`：`end_turn` 后 `idleMinutes` 内项目无新活动才触发。额外规则：

- **成功才清检查**：提炼成功 resolve 才清；失败保留检查，下个 sweep 重试同一范围（记忆侧"先清后触发"靠 interval 兜扫补失败重试，技能侧没有兜扫，先清会丢批次）；
- **同一检查连败 3 次放弃**：清除该检查并记日志（`MAX_ATTEMPTS`，内存按 `workdir|sessionId` 计数，daemon 重启归零后照常补查再试）；
- **会话已删的检查无条件清掉**：`sessions.meta` 缺失的挂起检查没有活动可判、也没有提炼对象，不清会在检查表里永久堆积；
- **end_turn 后有新活动的检查清掉**：旧锚点已被新活动取代，新 run 收尾的粗查若仍卷入会重排；
- `enabled: false` 或 `idleMinutes: 0` 时 sweep 直接返回，检查停留在检查表里不动，功能重开后继续消费；daemon 重启后首次 sweep 补查已保存的检查。

### 提炼 pipeline（triggerFollow）

- **范围**：该项目全部会话（含 subagent 会话）各自增量，逐会话处理——单会话失败不阻塞其他会话（有失败时整体 reject，增量进度保留，下个 sweep 重试同一范围，全部成功才 resolve）；
- **渲染**：照记忆提炼的 `renderSegment`（含工具块——`skill_read` 的 `tool_result` 就是技能正文，提炼模型能看到"读了什么、之后做了什么"）；
- **提炼模型**：解析复用 `memory.extractModel` 的同一条链（`makeExtractLlmResolver` 共享 helper，记忆与技能两套提取器共用，行为不变：空串回退主模型、provider 条目命中走条目端点、其余按裸线上模型名发往主端点），不新增模型配置字段；
- **输出契约**：JSON `{ proposals: [...] }`，单次至多 3 条（超出丢弃并 log）；每条字段 `kind`（new/revise）、`name`、`scope`（global/project）、`title`、`rationale`、`changes`（revise 必填，改了哪里、为什么）、`content`（含 frontmatter 的完整 SKILL.md）。单条校验失败（名字不过 `isSkillDirName`、content 为空、content 超 64KB、kind 非法）丢弃该条并 log；`scope` 非法回退 `"project"`（影响面小的方向）；`revise` 的目标不存在、或目标是复用链接技能（按 scope 读 `.links.json` 命中名字）时丢弃该条并 log；
- **产出 0 条 = 安静结束**：不落文件、不发事件（"判断没有值得提的"是正常结局，照 `memory_save` 诚实空回复的精神）；
- **推进规则与记忆一致**：提炼调用异常 → 不推进、下次补查重试同一范围；拿到合法 JSON（无论 0 条还是 N 条）→ 推进各会话增量进度（JSON 不可解析按放弃处理并推进的既有取舍）；
- **每条产出**：写提案文件（`status: "proposed"`，`kind: "revise"` 时带 `baseline`）+ 一条 `skill` 审计事件（见下）。

### 提案文件与存储

提案目录 `<skillsDir>/.proposals/` 全局唯一（不分项目）。文件 `<createdEpochMs>-<name>.json`（同毫秒同名冲突追加短随机后缀），字段：

```ts
interface SkillProposal {
  id: string               // 文件名去掉 .json
  status: "proposed" | "applied" | "rejected" | "reverted"
  kind: "new" | "revise"
  name: string             // 技能目录名，isSkillDirName 校验
  scope: "global" | "project"
  workdir?: string         // scope=project 时必填
  title: string
  rationale: string        // 为什么提这个案
  changes?: string         // 修订类：改了哪里的对照说明
  content: string          // 完整提案 SKILL.md（frontmatter + 正文）
  baseline?: string        // 修订类：提案时的现正文（审阅对照展示用）
  snapshot?: string        // 修订类：apply 覆盖前的旧正文（回滚快照）
  source: "follow" | "skill_create"
  sourceSessionId: string
  createdAt: string
  decidedAt?: string       // applied/rejected 的时间
  appliedAt?: string       // 遥测计数的起点
}
```

**增量进度与挂起检查**：每项目一本账 `<skillsDir>/.proposals/state/<projectId>.json`（projectId 与记忆同一套 `projectIdFor(workdir)`），复用 `WriteLedger` 原样（trigger 只用 `follow`），照记忆系统"每会话各一本增量进度、提取失败不推进"的既有语义。单个损坏的提案文件跳过并 log，不拖垮列表。不引入 git、不用 `.bak` 文件——回滚靠提案文件内的 `snapshot`。

### 治理状态机

状态流转只经路由（core 判定、路由映射 409）：

| 操作 | 流转 | 行为 | 冲突（409） |
|------|------|------|-------------|
| `apply` | proposed → applied | `new` 在落点目录建 `<name>/SKILL.md`；`revise` 先读现正文存进提案文件 `snapshot`，再用 `content` 覆盖写 | 目标已存在同名技能（new）、修订目标已不存在（revise）、目标是复用链接技能；非法流转 |
| `revert` | applied → reverted | `revise` 把 `snapshot` 写回目标文件；`new` 删除已生效的技能目录（只删该技能目录本身） | 非法流转；修订提案缺 `snapshot` |
| `reject` | proposed → rejected | 只改状态，文件保留 | 非法流转 |
| `remove` | rejected/reverted → 删除 | 删提案文件（文件也可手动删） | 非 rejected/reverted 状态 |

- **写入落点**：`scope=global` 写 `~/.kclaw/skills/<name>/SKILL.md`，`scope=project` 写 `<workdir>/.kclaw/skills/<name>/SKILL.md`。生效路径就是每轮重扫（见上文"每个 run 重新扫描"），下一轮对话自动吃到，无需任何热加载；
- **apply 的两条非致命 warning**（不阻止写入、状态照常变 applied）：`revise` 的现正文与提案时 `baseline` 不一致（提案后正文已被第三方改动，apply 以提案内容覆盖——覆盖的是提案内容，不是用户上次看到的那份）；`scope=global` 的 `new` 落地后若任一已知项目技能目录已存在同名技能（项目副本整目录覆盖全局版，将在该项目遮蔽全局版本）。路由把 warning 原样带回，UI 走 toast 提示；
- **复用链接技能是 apply 的禁区**：目标是复用链接技能（`.links.json` 命中名字）409，文案说明复用技能由源目录维护——提炼与 `skill_create` 在产提案时已做同判，这一层是治理期的最后防线。

### 用量遥测

口径 = `appliedAt` 之后全部会话事件流里 `skill_read` 的 `tool_call` 块（`args.name` 等于提案技能名）的次数。`skill_list` 是发现通道不计入使用；用户 `/记号` 点名经隐式包装最终也落到 `skill_read`（见上文"技能调用与隐式包装"），天然计入。现算不建索引、不持久化——个人 daemon 的会话规模下列表页现算可接受。

### skill_create 工具

`skill_create {name, content, rationale?}`（`tools/skills.ts`）：模型在对话中把经验当场固化为提案的入口，`safe` + `parallel`（提案文件是 `writeFileAtomic` 原子写的独立文件，同名冲突由随机后缀化解，并发调用安全）。只在 daemon 组装了技能进化系统时注册（run 组装传入 `skillCreate` 选项；裸引擎测试不传）；`enabled: false` 时工具仍在、调用返回固定关闭文案（"技能提案未开启…"）。`name` 不过 `isSkillDirName`、`content` 超 64KB、目标是复用链接技能均报错。**kind/scope 由系统推导，模型不给这两个参数**：项目副本命中 → `project` + 当前会话 workdir（缺失回退 daemon workspace）；仅全局命中 → `global`；未装 → `new` + `project`（影响面小的方向）。已装目标自动定 `revise` 并带 `baseline`。写提案文件 + 审计事件，回复"已记录提案（新增/修订 `<name>`），待用户在技能页审阅确认"，不谎报生效。

### skill 审计事件

`SessionEvent` 新增 `skill` 家族（`protocol/session-events.ts`），技能的**全部写路径**都各落一条事件：

```ts
interface SkillEvent {
  type: "skill"; at: string
  op: "proposed" | "applied" | "rejected" | "reverted" | "deleted"
  kind: "new" | "revise"
  name: string
  scope: "global" | "project"
  source: "follow" | "skill_create" | "admin"
}
```

归属会话：`follow` / `skill_create` = 来源会话；`admin`（路由治理动作：apply/reject/revert/remove）照记忆 admin 先例——`scope=project` 落该 workdir 最近活动会话、`scope=global` 落最近全局会话，无会话则跳过。事件只做记录：不进 meta 投影、不推进 `updatedAt`（与 memory 事件同约定），权威数据在 `.proposals/` 的提案文件。

### 前端入口

- **WebUI 技能页「提案」页签**（`SkillsView.tsx`，第三个页签，带待确认数角标）：列表行 = 名字、种类徽标（新增/修订）、状态徽标、落点（全局 / 项目路径尾段）、创建时间、理由单行截断；状态筛选走服务端 `?status=`，种类筛选本地。详情右栏：title / rationale / changes；修订类把 `baseline` 与 `content` 上下两块并陈（标注"现正文 / 提案正文"，不引入 diff 依赖）。操作按钮按状态显隐：确认 / 驳回（proposed）、回退（applied，并显示"采纳后被调用 N 次"）、删除（rejected/reverted）；apply 响应带 `warning` 时走 toast 提示；
- **CLI `/skill` 命令族**（`slash.ts`）：只读子命令 `/skill proposals`（列表，带状态标记与采纳后调用次数）与 `/skill proposal <id>`（详情与完整提案正文）；治理操作只在 WebUI。

## 管理入口与前端入口

`/skills` 路由族（`packages/server/src/routes/skills.ts`）是技能管理入口，分只读、复用管理与提案治理三半。只读与复用管理始终注册、无组装依赖；提案路由族（技能进化）组装后才可用，未组装（裸 app/测试）时整体 503，不影响既有路由：

- `GET /skills?workdir=`：用户可见技能列表 `{name, displayName, description, visibility, origin}`——`visibility` 是 `all`（模型+用户）或 `user-only`（被 `disable-model-invocation` 隐藏但仍用户可见），`origin` 是 `global` / `project`；
- `GET /skills/:name?workdir=`：单个技能详情，带 `content`（SKILL.md 正文）。路径段先过白名单校验（拦目录穿越段）；`user-invocable: false` 的技能 404，与未知名字同响应；
- `GET /skills/discovery?workdir=`：检测结果 `{sources, skills, projectSources}`——发现列表（realpath 去重、来源聚合、`reused`/`conflict`/`stale` 标）与生效中的检测来源；
- `POST /skills/discovery/preview`：请求体 `{path}`，返回候选 SKILL.md 正文 `{name, body}`（路径校验见上节）；
- `POST /skills/links` / `PATCH /skills/links/:name` / `DELETE /skills/links/:name?workdir=`：建链接（同名冲突 409）、改档位、取消复用；请求体或 query 带 `workdir` 指定项目作用域（必须是绝对路径），默认为全局；
- `GET /skills/links?workdir=`：当前作用域的链接记录与 `extraSources`（直接读旁挂文件，不受可见性过滤影响）；
- `POST /skills/sources` / `DELETE /skills/sources?dir=&workdir=`：登记 / 移除自定义检测目录。

三个用户入口共用这套路由：

- **CLI `/skill [名字|proposals|proposal <id>]`**：无参列出已装技能（名字 / 作用域 / 可见性 / 描述，作用域跟会话工作目录）；带名字打印该技能的完整正文；`proposals` 列出技能提案（只读，带状态标记），`proposal <id>` 打印提案详情与完整提案正文（治理操作在 WebUI）；
- **Web 技能页**：左栏已装技能清单、可复用技能清单（检测来源徽标 + 复用开关 + "全部复用"）、已建链接清单（四档可见档位单选 + 删除）、提案页签（待确认数角标 + 状态/种类筛选 + 按状态的治理按钮），右栏正文与预览；顶部作用域下拉（默认全局，候选来自会话列表的工作目录）对前两个页签生效，提案自带 workdir/scope、与作用域下拉无关；
- **技能即斜杠命令**：每个用户可见技能在 CLI 与 Web 两端自动注册成 `/<技能名> [要求]` 命令，命令发送用户原文（是否指定了技能由 daemon 检测）；内置命令名优先——与内置重名的技能命令被丢弃，自定义 `commands/*.md`（先注册）同样优先于技能。复用技能同样获得斜杠命令。

## 边界与出错

- **技能目录与 run 解耦**：扫描失败（目录不可读、单条损坏）只影响该次扫描本身，不拖垮 run；技能列表为空时系统提示词不追加，行为与无技能完全一致。
- **指定包装不改变存储**：包装只发生在模型视图，JSONL 事件流与气泡里是用户原文。
- **`user-invocable: false` 不是安全边界**：它只把技能从用户面列表隐藏；用户指名调用（斜杠命令已隐藏，但对话里打出名字仍可）仍可经 `skill_read` 加载——隐藏的是"发现渠道"，不是"访问权"。
- **description 有截断**：`description` + `when_to_use` 拼接上限 1536 字符（对齐 Claude Code 的清单长度），超限从尾部截断。
- **提案在确认前不可见**：提案 `content` 由模型产出，但只写入点开头目录——不被 run 组装扫描、不被模型经 `skill_read` 读到、不执行；进入技能目录的唯一路径是人工确认。`skill_create` 与后台提炼产出的提案走同一状态机，无特权差异。
- **子会话的使用由主干 run 覆盖**：子会话不自己排检查（hook 跳过 childRun），但粗查与提炼的范围都含子会话的各自增量——其技能使用由同项目后续任一主干 run 的粗查统一覆盖，提案与事件的 `sourceSessionId` 记发起补查的会话。
- **提炼失败的进度语义**：提炼 LLM 异常不推进增量进度、下次补查重试同一范围，同一挂起检查连败 3 次放弃（清检查 + 记日志，内存计数、daemon 重启归零）；拿到合法 JSON（无论产出 0 条还是 N 条）即推进——"判断没有值得提的"是正常结局，不落文件不发事件。

## 关联

- [tools](./tools.md)：`skill_read` / `skill_list` / `skill_create` 在 23 个内置工具里的位置与注册
- [hooks](./hooks.md)：`skill-wrap` 内置 hook（`llm-before` 位置的指定包装）、`skill-follow-check`（`run-after` 的提炼粗查）与 `withLastUserText`
- [agent-loop](./agent-loop.md)：`llm-before` 位置在循环里的触发时机
- [run-manager](../server/run-manager.md)：系统提示词组装（基础 + 认知 + 技能清单）、技能目录每 run 扫描
- [http-api](../server/http-api.md)：`/skills` 路由族的协议细节（含提案治理路由）
- [cli](../cli/cli.md) / [webui](../web/webui.md)：`/skill` 命令与技能页、技能即斜杠命令、提案页签与只读视图
- [storage](./storage.md)：`<home>/skills/` 全局技能目录在目录树里的位置
- [memory](./memory.md)：提炼机制与"每会话增量进度、提取失败不推进"语义的同构参照
- [daemon](../server/daemon.md)：技能进化系统的组装与 skill 调度器
