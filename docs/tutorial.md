# kclaw 上手教程

从零开始使用 kclaw：安装、第一次对话、会话、记忆、定时任务、WebUI，完整跟做约需 15 分钟。

> [!NOTE]
> kclaw 是一个本地运行的个人 agent：后台运行一个 daemon（守护进程，负责保管全部状态），终端 CLI 和浏览器 WebUI 都是连接它的客户端。本教程只使用 CLI 和 WebUI，daemon 会在需要时自动启动，无需单独管理。

## 1. 准备

- **Node >= 22**：终端里执行 `node -v`，主版本号不低于 22。kclaw 启动时也会检查，版本不满足会打印一行提示后退出。
- **一个模型的访问方式**，二选一：
  - **在线 API key（以 DeepSeek 为例）**：在 DeepSeek 开放平台注册并创建 API key（`sk-` 开头的一串字符）。
  - **本地 Ollama**：如不使用云服务，先[安装 Ollama](https://ollama.com) 并保持其运行，再下载一个模型，例如 `ollama pull qwen2.5`。此方式不需要任何 key。

## 2. 安装与第一次启动

kclaw 尚未发布 npm 包，需要从源码构建安装（本地部署）：

```bash
git clone https://github.com/zachysun/kclaw
cd kclaw
pnpm install     # 安装依赖（需要 Node >= 22 与 pnpm）
pnpm build       # 构建全部包，生成聚合包产物
npm i -g ./packages/kclaw   # 把聚合包安装为全局 kclaw 命令
kclaw chat
```

尚未配置模型、且在交互式终端里运行时，`kclaw chat` 会进入一个 30 秒左右的配置 wizard。wizard 只做一件事：把模型配置写入 `~/.kclaw/config.json`，完成后不再出现。

### 路线一：DeepSeek 模板（粘贴 key）

1. **选模板**：上下方向键选中 `DeepSeek`，回车。
2. **输入 API key**：粘贴 key。输入不回显（屏幕上不显示字符），粘贴后直接回车。
3. **输入模型名**：直接回车，使用默认的 `deepseek-chat`。
4. **连通测试**：kclaw 发送一个只消耗 1 个 token 的最小请求，验证 key、模型名、接口地址三项均可用。通过后写入配置文件（权限仅本用户可读写），自动进入对话。

### 路线二：Ollama（零 key）

选模板 `Ollama (local)`：接口地址已预填本机 `http://127.0.0.1:11434/v1`，key 这一步直接跳过，只输入模型名——填入前面 `ollama pull` 下载的那个名字（不确定时可先执行 `ollama list` 查看），其余步骤相同。

### wizard 失败的处理

连通测试失败时，kclaw 将错误归为三类，以一句说明文字提示原因，并询问是否重试；重试回到对应步骤：

| 提示 | 含义 | 检查什么 |
|------|------|---------|
| API key 无效（401/403） | key 错误或已失效 | 重新复制粘贴一次 key |
| 模型名不对（404/400） | 服务端不识别该模型名 | Ollama 用 `ollama list` 核对；DeepSeek 直接回车使用默认值 |
| 连不上服务端 | 请求未送达 | 网络是否可用、接口地址是否正确（Ollama 需先启动） |

选「否」或按 Ctrl+C 都会正常退出，不写入任何文件；下次 `kclaw chat` 会重新进入 wizard。

不走 wizard 时，可手动编写 `~/.kclaw/config.json`，或设置 `KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY / KCLAW_LLM_MODEL` 环境变量，字段说明见 [storage](./core/storage.md) 的「config.json 全量字段」一节。

## 3. 第一轮对话

进入 REPL（read-eval-print loop：读一行输入、处理、打印结果、再等待下一行的交互循环）后，直接输入文本发送：

```text
你好，用一句话介绍你能做什么
```

回复以流式方式逐字打印。

### 触发一次工具执行

提出一个必须执行命令才能回答的问题：

```text
~/Downloads 里最大的文件是哪个？
```

agent 会调用 exec 工具执行命令。exec 属于高危工具，执行前会显示一张**确认卡片**，列出工具名、参数和风险等级：

- 选**仅本次**：这一次允许，命令执行，agent 获取输出后继续回答。
- 选**总是允许（本项目）** 或 **总是允许（全局）**：这次允许，并把一条收紧后的放行规则存下来，之后同类的操作不再逐次询问（规则可以在 WebUI 的「权限」页查看和删除）。
- 选**拒绝**：agent 收到「用户拒绝」，改用其他方式回应（例如说明无法查询）。

每次选择都会记入审计日志，之后可以在 WebUI 的「审计」页查到；确认卡片有时限（默认 120 秒），超时按拒绝处理；回复进行中按 Ctrl+C 可取消当前这一轮。

## 4. 会话管理

REPL 里用 `/` 开头的命令管理会话：

| 命令 | 作用 |
|------|------|
| `/new 采购清单` | 创建一个带标题的新会话 |
| `/clear` | 快速创建一个不带标题的干净会话 |
| `/sessions` | 列出全部会话，用方向键选中一个，回车即切换 |
| `/model 名字` | 切换本会话的模型（只影响之后的回复）；不带参数列出可用模型，`/model default` 恢复默认 |
| `/mode [readonly\|default\|acceptEdits\|trusted\|auto]` | 切换本会话的权限模式：`readonly` 只读（写文件与执行命令会被拒绝）、`default` 默认（越界操作逐次确认）、`acceptEdits` 自动接受编辑（工作区内的文件写入不再逐次确认）、`trusted` 信任（沙箱与工作区内免确认、边界外直接拒绝）、`auto` 自动学习（反复放行的操作自动保存为规则）；无参数显示当前模式 |
| `/attach <文件路径>` | 上传附件，随你的下一条消息一起发送；不带参数查看待发附件 |
| `/compact [重点说明]` | 手动压缩当前会话的早期对话（上下文快满时，把早期对话压成摘要来腾出空间） |
| `/steer` `/wait` | 切换本会话的默认发送处置（引导正在进行的回复 / 排队等当前回复结束后执行） |
| `/interrupt <消息>` | 以「中断」方式发送：立即停掉正在进行的回复，把这条消息插到最前执行 |
| `/queue` | 查看排队中的消息（`cancel <序号>` 取消某条，`cancel all` 清空） |
| `/memory` | 查看记忆系统：列出项目，或进一步查看某个项目的主题线、某条线的全文 |
| `/help` | 列出所有可用命令（输错命令时会提示查阅） |
| `/exit` | 退出 REPL |

还可以自制命令：把 `*.md` 文件放进 `~/.kclaw/commands/`，文件名即命令名，内容是提示词模板，其中的 `{{args}}` 会替换成你输入的参数。

不手动指定标题也可以：新会话默认名为「新会话」，发出第一条消息后，kclaw 根据消息内容自动生成标题（不超过 30 字）；手动修改过的标题不会被覆盖。

历史不会丢失：每条消息都作为 `message` 事件写入 `~/.kclaw/sessions/<会话id>/events.jsonl`（会话以事件流的形式保存，每行一条事件，见 [storage](./core/storage.md)）。要继续上次的对话，可用 `kclaw chat --session <id>` 恢复指定会话，或进入 REPL 后用 `/sessions` 选择一个。

## 5. 记忆

让 agent 记住一条用户相关信息：

```text
记住：我住在上海，习惯用中文回复
```

agent 会把这条信息写进记忆系统的 markdown 文件（`~/.kclaw/memory/` 下，分两层：当前项目的**项目情节**存在 `projects/<项目id>/<主题>.md`，跨项目的长期偏好会进一步沉淀——也就是整理成不依赖单个项目的全局认知，如 `global/persona.md`）；全文检索索引是派生的 `vectors.db`（SQLite FTS5 + 向量，删掉可重建）。详细机制见 [memory](./core/memory.md)。

验证跨会话生效：

1. `/clear` 创建一个新会话。
2. 问：`我住哪？`

agent 每轮回复前都会先检索相关记忆，因此即使更换了会话，它也应知道用户住在上海。要查看、修改、删除某条记忆，可以在 WebUI 的「记忆」页点开编辑/删除，或直接编辑/删除对应的 `.md` 文件，下次启动（或下一次写入）时会重新整理索引。

## 6. 定时任务

让 kclaw 每天定时自动执行任务。进入 WebUI（下一节）切换到「任务」页，在表单里填写三项内容：

- **name**：`早报`
- **cron**：`0 9 * * *`（cron：类 Unix 系统的定时表达式，五段依次是 分 时 日 月 周，这一行表示每天 9:00）
- **prompt**：`写一份今日早报：一句晨间提醒，加一条今天值得注意的事`

创建后，daemon 每 30 秒检查一次是否有到期的任务；到点自动创建一个新会话（标题即任务名）执行 prompt，执行结果记录在这条任务上。同一页面也可以编辑任务、用行内开关停用或启用、删除任务。

终端中随时可查看：

```bash
kclaw jobs list
```

输出一张五列表格：name / cron / enabled / nextRunAt（下次触发时间）/ lastStatus（上次执行结果）。

## 7. WebUI

```bash
kclaw web
```

这一条命令依次做四件事：

1. 确认 daemon 在运行，不在则自动启动。
2. 读取 `~/.kclaw/token`（daemon 的访问凭证）。
3. 拼出带登录信息的地址。
4. 调起系统浏览器打开。

token 的处理：页面获取 token 后存入浏览器本地存储并从地址栏清除，之后刷新无需重新登录；终端打印的地址是去掉 token 的版本，可以放心复制。

界面是左侧会话栏加十一个页面：

| 页面 | 用来做什么 |
|------|-----------|
| 对话 | 与 CLI 相同的流式对话和确认卡片；切换到别的页面时对话不中断。文件可直接拖进聊天区，随下一条消息发送 |
| 任务 | 定时任务的增删改、启用开关、执行结果（上一节用的就是它） |
| 审计 | 会话事件流的逐行回看：消息与工具调用、压缩、记忆写入、每轮运行的起止、权限裁决等全部留有记录（最新在最下面） |
| 用量 | token 用量与费用统计：按天、按会话两张表，可导出 JSON |
| 回收站 | 被删除的会话，可恢复或彻底删除 |
| 记忆 | 记忆系统管理：项目情节 / 全局认知的查看与整文件编辑 |
| 技能 | 已装技能的清单与 SKILL.md 正文（只读） |
| 权限 | 沉淀下来的权限规则（全局档与项目档）的查看与删除 |
| MCP | 已配置的 MCP 服务器管理：连接状态、启停、重连、增删改（机制见 [mcp](./core/mcp.md)） |
| Model | 模型服务管理：多个 API 端点条目、默认条目切换、连通验证（机制见 [provider](./core/provider.md)） |
| IM Channel | 飞书接入管理：连接状态、凭据与白名单配置（保存即生效）、待加白发件人一键放行（机制见 [feishu-channel](./server/feishu-channel.md)） |

左侧会话栏里的会话按工作目录分组；顶部"＋ 选择工作目录新建会话"选一个目录，就在那里建一个新会话，组与单个会话都可以改名、删除。WebUI 与 CLI 功能对等，选择哪一个仅取决于使用习惯。

## 8. 数据位置与停止方式

全部数据都在 `~/.kclaw/` 一个目录里：

```text
~/.kclaw/
├── config.json      # 模型配置（wizard 写的就是它）
├── AGENTS.md        # agent 人设，会注入系统提示词
├── token            # 访问凭证
├── daemon.json      # daemon 运行信息（端口、pid）
├── sessions/        # 每个会话一个目录：events.jsonl 完整事件流（权威数据）+ meta.json 投影 + queue.jsonl 排队
├── memory/          # 记忆系统：global/（全局认知）+ projects/<项目id>/（项目情节），含 vectors.db 检索索引
├── jobs.db          # 定时任务
├── usage.db         # token 用量记录
├── attachments/     # 附件（WebUI/CLI 上传的文件保存在这里）
├── commands/        # 自定义 slash 命令（*.md）
└── logs/            # 日志
```

> [!TIP]
> 备份或搬家时，复制这个目录即可。

daemon 是后台常驻进程，停止方式如下：

```bash
kclaw daemon stop     # 停止 daemon
kclaw daemon status   # 查看状态（kclaw status 是同一命令的别名）
```

之后执行 `kclaw chat` 或 `kclaw web`，daemon 会自动重新启动。

遇到 `command not found: kclaw`，回 [README](../README.zh-CN.md) 的「安装」一节核对步骤；页面 401 或端口对不上，多半出在 token 与 daemon.json 上，见 [daemon](./server/daemon.md) 的鉴权与端口两节。

## 9. 下一步

- **配置全表**（[storage](./core/storage.md)）：`workspace` 限定文件工具的活动范围；`permissions.allow` 可以让某些命令跳过确认（如 `exec:git *`）；`exec.timeoutMs` 控制命令超时；`~/.kclaw/AGENTS.md` 定义 agent 人设。模型 provider 的配置见 [storage](./core/storage.md) 的「config.json 全量字段」一节。
- **扩展指南**（[extending](./extending.md)）：为 kclaw 增加新功能时的切入点。
- **架构总览**（[architecture](./architecture.md)）：阅读内部实现时的入口文档。
