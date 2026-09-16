# tools — 内置工具清单（22 个）

> 真相源：`packages/core/src/tools/index.ts`（注册表）与 `tools/` 下各实现文件。机制见 [tools](../core/tools.md)，权限判定链见 [permissions](../core/permissions.md)。

每个工具在注册时声明两个属性，权限与调度全部从这两个属性派生：

```ts
/** tools/shared.ts — makeTool 的签名 */
makeTool(name, risk: "safe" | "sensitive", concurrency: "parallel" | "serial", fn)
```

- **risk**：`safe`（只读，权限链直接放行）/ `sensitive`（有副作用，走权限裁决）
- **concurrency**：`parallel`（一个工具批次内可并发执行）/ `serial`（串行执行）

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

## 条件注册工具（10 个）

只在对应能力被装配进 run 时加入注册表：

| 名称 | 一句话 | risk | concurrency | 注册条件 |
|------|--------|------|-------------|----------|
| `subagent_run` | 派子代理独立执行自包含任务（可后台） | safe | parallel | 主线 run 且装配了派发器（daemon 恒有；子会话没有） |
| `subagent_collect` | 按子会话 id 取回后台子代理的结题答复 | safe | parallel | 同上，且装配了收集器 |
| `create_team` | 建立本会话的 agent 团队、本会话成为组长 | safe | serial | 仅组长身份 |
| `spawn_teammate` | 招募一个组员（持久子会话 + 模型快照） | safe | serial | 仅组长身份 |
| `send_message` | 给组长或组员写信（经持久收信箱投递） | safe | parallel | 团队身份（组长或组员） |
| `list_agents` | 列出组员名单（状态、忙闲、当前任务） | safe | parallel | 团队身份 |
| `task_create` | 在团队任务板上建任务（依赖、指派） | safe | serial | 团队身份 |
| `task_update` | 按 revision 更新任务状态/认领（CAS 比对交换） | safe | serial | 团队身份 |
| `task_list` | 列出任务板全貌 | safe | parallel | 团队身份 |
| `ask_user_questions` | 向用户提 1–5 个当场拍板的问题 | safe | parallel | 装配了 ask 网关（run 装配恒注入，子 run 也带） |

## 表面收窄规则

| 场景 | 收窄 |
|------|------|
| 子代理的 run（`childRun`） | 删 `memory_save`（记忆是主线的职责）；永不带 `subagent_run`（单层委派） |
| readonly 权限模式 | 删全部 sensitive 工具（`exec` / `fs_write` / `fs_edit`）——可见性收窄，权限闸门仍是边界 |

团队工具的注册条件按身份分化：`lead` 身份（含未建队的主线会话——"预备组长"，见 [agent-team](../core/agent-team.md)）注册全部七个；`member` 身份注册 `send_message` / `list_agents` / `task_*` 五个（不含建队/招募）；不在团队里的会话（job 会话、非组员的子代理会话）一个都没有。

## MCP 工具

外部 MCP server 的工具不在此清单：每个 run 经 RunManager 的 `extraTools` 动态注入，名字与 schema 来自 server 侧（见 [mcp](../core/mcp.md)）。
