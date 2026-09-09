# subagents — 子代理委派

## 职责

子代理（subagent）是主对话的模型**自主派出**的短命执行单元：调用 `subagent_run` 工具、给出一段自包含的任务描述，daemon 为它开一个**独立子会话**跑完整个任务，结束时把结题答复作为工具结果送回主对话。过程文本（工具输出、中间思考）不进主对话的上下文——这是 v1 的第一动机**上下文隔离**；同一批工具调用里发多个 `subagent_run` 即**并行**执行互不相关的任务，是第二动机。按角色特化（预置人设的专职代理）明确不在 v1 范围。

三个模块分担职责：`packages/core/src/agent/subagent.ts` 放两侧共享的契约（`SubagentSpawner` 接口、子代理系统提示词、答复截断/标题助手）；`packages/core/src/tools/subagent.ts` 是模型可见的工具执行器（薄壳：校验参数后调一次 spawner）；`packages/server/src/subagent.ts` 是 daemon 侧的 spawner 实现（真会话、真 run 提交、状态与确认转发）。

## 设计决策

- **子会话身份是唯一真相**：子代理会话的 `meta.parentSessionId`（`session.created` 事件携带、投影进 meta.json）标识"这是一个子代理、父是谁"。引擎侧一切子代理特化——精简系统提示词、钩子跳过、工具面裁剪、用量归属——都从这一个字段派生，没有任何运行期旗标。会话列表、审计页据此把它与普通会话区分开。

- **阻塞式调用**：`subagent_run` 执行器 await 子 run 的最终结果，把子代理**最后一条 assistant 消息的文本块**作为工具结果返回（空的 text 块不算，拼接后去首尾空白）。答复有 16000 字符上限，超出留头尾各 4000 字符、中段以截断标记省略——过程再长也压不垮主对话。并行只来自"一批多个工具调用"，单个工具调用本身没有中途取回。

- **单层委派**：子 run 的工具面**不注册** `subagent_run`（也没有 `memory_save`，见记忆隔离）——子代理不能再派子代理，防递归失控。

- **权限不放宽**：子 run 有自己的权限门，冻结父会话创建时的 `mode`；敏感操作照常请求人工确认。确认卡片经 spawner **转发到父会话频道**（用户正看着的地方），`noteText` 前缀"来自子代理 `<label 或会话 id>`"；裁决仍走全局 broker 按 `confirmationId` 收口，任何客户端答都行。Web 与 CLI 无需改动就能收到卡片。

- **父停子停**：工具执行器把父 run 的 abort 信号递给 spawner，spawner 监听到中止即 `run.cancel(child)`——子 run 在下一个检查点停下，派发以 error 结果（"随主任务中止而停止"，附中止前产出）收口。

- **触发来源记 `agent`**：子 run 提交时 `trigger: "agent"`（用户/任务之外的第三个值）。它只做两件事：技能点名包装只认 `trigger === "user"`，子代理不会误触；事件流里客观记录这次 run 由谁发起。

## 生命周期（一次派发）

```
主对话模型发起 subagent_run {task, label?}
  → spawner：查父会话 → 并发上限检查（超限直接 error，不建会话）
  → 建子会话（标题"子代理 · <label|task 头 40 字>"，继承父 workdir/mode，
    parentSessionId 落 meta；父的会话级模型覆盖随行）
  → 订阅子频道（状态行 + 确认转发）→ submit(task, trigger:"agent", disposition:"wait")
  → 子 run 跑完（正常/中止/出错）
  → 拆订阅、清并发计数 → 结果整形回工具结果
```

子会话与普通会话走完全相同的存储路径（events.jsonl 唯一真相 + meta 投影），审计页照常能看它的全部事件。

## 状态行（主对话里的"实时一行"）

spawner 在子频道挂一个普通 bus 订阅者（EventBus 接受任何 `{send}` 形状），把子 run 的动静折成一行行状态、经工具的 `onOutput` 通道变成父频道的 `tool_result.delta`——Web 对话页的子代理行因此**实时刷新**（默认折叠行里显示最新一行）：

- 子代理开始生成（assistant `message.created`）→ `▸ 生成中`
- 每完成一个工具调用 → `▸ 调用工具 <name>`（这条**强制立即**发出，不受节流）
- 文本增量 → `▸ 生成：<最新文本压成一行、80 字截断>`（**2 秒节流**——"每隔一段时间更新"的具体间隔）

## 记忆与用量

- **记忆完全隔离**（子代理被当成工具，不是人）：`MemorySystem` 的三处会话枚举全部排除子会话——定时扫描不提取子会话（interval 对**全部会话逐个补增量**的清单里没有它）、`recentSessionId`/`recentGlobalSessionId` 回落不选它、follow-check 不为它挂检查。子代理的过程不沉淀为长期记忆。
- **用量记到父会话**：usage-ledger 钩子以 `usageSessionId`（= `parentSessionId`，普通会话即自身）记账——子代理烧的 token 落在派它的主对话头上，用量统计按用户视角归因。

## 内置钩子跳过（引擎侧派生）

`parentSessionId` 存在时，装配给钩子链带 `childRun: true`，四个内置钩子直接跳过：`memory-inject`（不注入记忆 note）、`autoname`（不自动命名，标题已带"子代理 · "前缀）、`follow-check`（不挂记忆检查）、`system-materials`（系统提示词不带认知与技能清单段——子代理提示词刻意精简，将来要补材料就改 `subagentSystemPrompt` 模板）。系统提示词整体换成 `subagentSystemPrompt(workspace)`：子代理身份、工作区、"任务即唯一指令、不要反问"、权限规则一致、结题答复是全部产出，五句话，不带 AGENTS.md 人设。

## 会话可见性与级联删除

- `GET /sessions` 缺省**不列**子会话（它们不是会话列表的一等公民），`?children=true` 才列出（审计跳转与排查用）。
- `DELETE /sessions/:id`（软删）与 `POST /sessions/:id/purge`（永久删除）都**级联**到其全部子会话——删主对话连着删它的子代理轨迹，不留孤儿。
- Web 对话页的 `subagent_run` 工具结果行渲染"查看子代理审计"链接：工具结果的 `data.childSessionId`（随持久化块落事件流）驱动，点击即选中该子会话并切到审计 tab——审计页本来就跟随全局选中会话。子会话对用户**只读**：ChatPanel 对子会话隐藏输入区（send/权限选择器都不渲染），`RunManager.submit` 在服务端兜底拒绝 user 触发的提交——审计页可以看它的一切，但不能插话。

## 配置

| 键 | 缺省 | 说明 |
|----|------|------|
| `subagents.maxConcurrent` | `4` | 每个**主会话**同时存活的子代理上限（per-parent 计数，全局不设限）；超限的派发立即返回 error 结果、不建会话 |

## 关联

- 工具注册与描述：[tools](./tools.md)；循环里工具执行与中止信号：[agent-loop](./agent-loop.md)
- 内置钩子与 childRun 跳过：[hooks](./hooks.md)；记忆归属与排除：[memory](./memory.md)
- 协议类型（`SubagentSpawner` 契约、`trigger: "agent"`、`parentSessionId`）：[protocol](./protocol.md)；会话事件与 meta：[storage](./storage.md)
- server 侧装配与 run 提交：[run-manager](../server/run-manager.md)、[daemon](../server/daemon.md)；路由（children 参数、级联删除）：[http-api](../server/http-api.md)
- Web 渲染与跳转：[webui](../web/webui.md)
