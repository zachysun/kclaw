# subagents — subagent 委派

## 职责

subagent 是主对话的模型**自主派出**的短命执行单元：调用 `subagent_run` 工具、给出一段自包含的任务描述，daemon 为它开一个**独立子会话**跑完整个任务，结束时把结题答复（subagent 最后一条回复的全文）作为工具结果送回主对话。过程文本（工具输出、中间思考）不进主对话的上下文，subagent 的第一动机是**上下文隔离**；同一批工具调用里发多个 `subagent_run` 即**并行**执行互不相关的任务，是第二动机。按角色特化（预置人设的专职 subagent）明确不在当前范围。长任务可以**后台派发**（`run_in_background: true`）：派发立即返回子会话 id、不阻塞父 run，subagent 完成后结题报告**自动投递回主会话**、触发新一轮分析（见下文"后台模式"）。

三个模块分担职责：`packages/core/src/agent/subagent.ts` 放两侧共享的契约（`SubagentSpawner` 接口、subagent 系统提示词、答复截断/标题助手）；`packages/core/src/tools/subagent.ts` 是模型可见的工具执行器（薄壳：校验参数后调一次 spawner）；`packages/server/src/subagent.ts` 是 daemon 侧的 spawner 实现（真会话、真 run 提交、状态与确认转发）。

## 设计决策

- **子会话身份是唯一权威数据**：subagent 会话的 `meta.parentSessionId`（`session.created` 事件附带、投影进 meta.json）标识"这是一个 subagent、父是谁"。引擎侧一切 subagent 特化（精简系统提示词、hook 跳过、工具面裁剪、用量归属）都从这一个字段派生，没有任何运行期旗标。会话列表、审计页据此把它与普通会话区分开。

- **阻塞式调用（默认）**：`subagent_run` 执行器 await 子 run 的最终结果，把 subagent**最后一条 assistant 消息的文本块**作为工具结果返回（空的 text 块不算，拼接后去首尾空白）。答复有 16000 字符上限，超出留头尾各 4000 字符、中段以截断标记省略——过程再长也压不垮主对话。并行只来自"一批多个工具调用"，单个阻塞调用本身没有中途取回。

- **后台模式（`run_in_background: true`）**：派发立即返回子会话 id 与取回提示（不阻塞父 run），subagent 的**生命周期挂到父会话**而不是父 run——父 run 结束或中止的信号刻意不递给 spawner，后台 subagent 照常跑完；删除父会话则先取消它仍在跑的后台 subagent，再走既有的级联软删。subagent 落定时结题报告**自动投递回父会话**：报告走 `RunManager.submit`（触发 `agent`、强制排队）开启**新一轮 run**，主 agent 消化全文后回复，三端同享；报告消息带 `kind:"subagent"` note 声明"机器回投、非用户发言"，正文为状态行 + 任务原文 + 结题全文（超长头尾截断）。投递被拒（队列满 10 条 / 防自循环唤醒 budget 耗尽）时降级为旧通知（带 `kind:"system"` note 的 assistant 消息，附拒绝原因，**不触发 run**），完成事件不静默丢失。投递或回退之后，宿主发出一次可选的 `onBackgroundSettled` 回调（含子会话 id、标签、成败与结题摘录），daemon 用它把落定推送给 IM 频道。**防自循环 budget**：每主会话连续 `agent` 触发的自动唤醒上限 3 次，只有真实用户输入真正到达模型（用户 run 开跑 / steer 注入）才清零，定时任务不清零；计数仅内存，daemon 重启归零。`subagent_collect {childSessionId}` 降为按需深挖手段（只能取本会话派出的 subagent），行为不变。后台任务有独立的每父会话并发上限（`subagents.maxBackground`，与阻塞档分开计数）。

- **单层委派**：子 run 的工具面**不注册** `subagent_run` 与 `subagent_collect`（也没有 `memory_save`，见记忆隔离）——subagent 不能再派 subagent，防递归失控。

- **权限不放宽**：子 run 有自己的权限门，冻结父会话创建时的 `mode`；敏感操作照常请求人工确认。确认卡片经 spawner **转发到父会话频道**（用户正看着的地方），`noteText` 前缀"来自 subagent `<label 或会话 id>`"；裁决仍由全局 broker 按 `confirmationId` 统一处理，任何客户端答都行。Web 与 CLI 无需改动就能收到卡片。可见性同样继承：父会话为 readonly 时，子 run 的工具面按同一规则移除（sensitive 工具不可见），见 [permissions](./permissions.md)。

- **父停子停**：工具执行器把父 run 的 abort 信号递给 spawner，spawner 监听到中止即 `run.cancel(child)`——子 run 在下一个检查点停下，派发以 error 结果（"随主任务中止而停止"，附中止前产出）结束。

- **触发来源记 `agent`**：子 run 提交时 `trigger: "agent"`（用户/任务之外的第三个值）。它只做两件事：技能调用包装只认 `trigger === "user"`，subagent 不会误触；事件流里客观记录这次 run 由谁发起。

## 生命周期（一次派发）

```
主对话模型发起 subagent_run {task, label?}
  → spawner：查父会话 → 并发上限检查（超限直接 error，不建会话）
  → 建子会话（标题"subagent · <label|task 头 40 字>"，继承父 workdir/mode，
    parentSessionId 落 meta；父的会话级模型覆盖随行）
  → 订阅子频道（状态行 + 确认转发）→ submit(task, trigger:"agent", disposition:"wait")
  → 子 run 跑完（正常/中止/出错）
  → 拆订阅、清并发计数 → 结果整形回工具结果
```

子会话与普通会话走完全相同的存储路径（events.jsonl 唯一权威数据 + meta 投影），审计页照常能看它的全部事件。

**后台派发的生命周期差异**：`run_in_background: true` 时上面第 2 步的并发上限换成后台档（`maxBackground`），第 3 步后立即返回子会话 id（工具结果是 `已在后台派出 subagent「…」（会话 …）…完成后结题报告会自动投递回本会话并触发新一轮分析，届时可用 subagent_collect …`），不等待子 run 落定；子 run 完成后结题报告经 `submit(trigger:"agent")` 投递回父会话、开启新一轮 run（投递被拒则降级为系统通知，见"后台模式"），删父会话时 `cancelBackgroundForParent` 先取消在跑的后台 subagent。

## 状态行（主对话里的"实时一行"）

spawner 在子频道挂一个普通 bus 订阅者（EventBus 接受任何 `{send}` 形状），把子 run 的动静整理成一行行状态、经工具的 `onOutput` 通道变成父频道的 `tool_result.delta`——Web 对话页的 subagent 行因此**实时刷新**（默认折叠行里显示最新一行）：

- subagent 开始生成（assistant `message.created`）→ `▸ 生成中`
- 每完成一个工具调用 → `▸ 调用工具 <name>`（这条**强制立即**发出，不受节流）
- 文本增量 → `▸ 生成：<最新文本压成一行、80 字截断>`（**2 秒节流**——"每隔一段时间更新"的具体间隔）

状态行只属于阻塞派发：后台 subagent 没有等待中的工具结果可流，状态行静默（进度可见性由完成投递的新一轮 run 承担）；但 subagent 的**确认卡与问题卡**在两种模式下都转发到父频道——敏感操作不能因为后台了就不问人。

## 记忆与用量

- **记忆完全隔离**（subagent 被当成工具，不是人）：`MemorySystem` 的三处会话枚举全部排除子会话——定时扫描不提取子会话（interval 对**全部会话逐个补增量**的清单里没有它）、`recentSessionId`/`recentGlobalSessionId` 回退到不选它、follow-check 不为它挂检查。subagent 的过程不写入长期记忆。
- **用量记到父会话**：usage-ledger hook 以 `usageSessionId`（= `parentSessionId`，普通会话即自身）记录——subagent 消耗的 token 记在派它的主对话名下，用量统计按用户视角归因。

## 内置 hook 跳过（引擎侧派生）

`parentSessionId` 存在时，组装给 hook 链带 `childRun: true`，五个内置 hook 直接跳过：`memory-inject`（不注入记忆 note）、`autoname`（不自动命名，标题已带"subagent · "前缀）、`follow-check`（不挂记忆检查）、`skill-follow-check`（不排技能提炼检查——subagent 的技能使用由同项目后续主干 run 的粗查覆盖，见 [skills](./skills.md)）、`system-materials`（系统提示词不带认知与技能清单段——subagent 提示词刻意精简，将来要补材料就改 `subagentSystemPrompt` 模板）。系统提示词整体换成 `subagentSystemPrompt(workspace)`：subagent 身份、工作区、"任务即唯一指令、不要反问"、权限规则一致、结题答复是全部产出，五句话，不带 AGENTS.md 人设。

## 会话可见性与级联删除

- `GET /sessions` 默认**不列**子会话（它们不是会话列表的一等公民），`?children=true` 才列出（审计跳转与排查用）。
- `DELETE /sessions/:id`（软删）与 `POST /sessions/:id/purge`（永久删除）都**级联**到其全部子会话——删主对话连着删它的 subagent 轨迹，不留残留会话。
- Web 对话页的 `subagent_run` 工具结果行渲染"查看 subagent 审计"链接：由工具结果的 `data.childSessionId`（随持久化块写入事件流）驱动，点击即选中该子会话并切到审计 tab（审计页本来就跟随全局选中会话）。子会话对用户**只读**：ChatPanel 对子会话隐藏输入区（send/权限选择器都不渲染），`RunManager.submit` 在服务端再拦一道、拒绝 user 触发的提交。审计页可以看它的一切，但不能插话。

**与 agent 团队的交界**：团队组员也是 `parentSessionId` 指向组长的持久子会话，上面的一切基建（列表隐藏、用量归组、级联删除）原样适用。两条刻意不同：组员不随"父停"而停——运行模型的唤醒与停止语义在 [agent-team](./agent-team.md)（组长被停止不会波及组员，停止永远逐个）；组员 run 的消息由团队收信箱以 `trigger: "team"` 投递，绕过 user 触发的只读拒绝。

## 配置

| 键 | 默认 | 说明 |
|----|------|------|
| `subagents.maxConcurrent` | `4` | 每个**主会话**同时存活的**阻塞**subagent 上限（per-parent 计数，全局不设限）；超限的派发立即返回 error 结果、不建会话 |
| `subagents.maxBackground` | `4` | 每个主会话同时存活的**后台**subagent 上限，与阻塞档分开计数；超限返回 error（提示等现有后台任务结束或改用阻塞模式） |

## 关联

- 工具注册与描述：[tools](./tools.md)；循环里工具执行与中止信号：[agent-loop](./agent-loop.md)
- 内置 hook 与 childRun 跳过：[hooks](./hooks.md)；记忆归属与排除：[memory](./memory.md)
- 协议类型（`SubagentSpawner` 契约、`trigger: "agent"`、`parentSessionId`）：[protocol](./protocol.md)；会话事件与 meta：[storage](./storage.md)
- server 侧组装与 run 提交：[run-manager](../server/run-manager.md)、[daemon](../server/daemon.md)；路由（children 参数、级联删除）：[http-api](../server/http-api.md)
- Web 渲染与跳转：[webui](../web/webui.md)
