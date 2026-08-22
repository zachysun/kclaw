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

```bash
npm i -g kclaw
kclaw chat
```

尚未配置模型、且在交互式终端里运行时，`kclaw chat` 会进入一个 30 秒左右的配置向导。向导只做一件事：把模型配置写入 `~/.kclaw/config.yaml`，完成后以后不再出现。

### 路线一：DeepSeek 模板（粘贴 key）

1. **选模板**：上下方向键选中 `DeepSeek`，回车。
2. **输入 API key**：粘贴 key。输入不回显（屏幕上不显示字符），粘贴后直接回车。
3. **输入模型名**：直接回车，使用默认的 `deepseek-chat`。
4. **连通测试**：kclaw 发送一个只消耗 1 个 token 的最小请求，验证 key、模型名、接口地址三项均可用。通过后写入配置文件（权限仅本用户可读写），自动进入对话。

### 路线二：Ollama（零 key）

选模板 `Ollama (local)`：接口地址已预填本机 `http://127.0.0.1:11434/v1`，key 这一步直接跳过，只输入模型名——填入前面 `ollama pull` 下载的那个名字（不确定时可先执行 `ollama list` 查看），其余步骤相同。

### 向导失败的处理

连通测试失败时，kclaw 将错误归为三类，以一句说明文字提示原因，并询问是否重试；重试回到对应步骤：

| 提示 | 含义 | 检查什么 |
|------|------|---------|
| API key 无效（401/403） | key 错误或已失效 | 重新复制粘贴一次 key |
| 模型名不对（404/400） | 服务端不识别该模型名 | Ollama 用 `ollama list` 核对；DeepSeek 直接回车使用默认值 |
| 连不上服务端 | 请求未送达 | 网络是否可用、接口地址是否正确（Ollama 需先启动） |

选「否」或按 Ctrl+C 都会正常退出，不写入任何文件；下次 `kclaw chat` 会重新进入向导。

不走向导时，可手动编写 `~/.kclaw/config.yaml`，或设置 `KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY / KCLAW_LLM_MODEL` 环境变量，格式见 [README](../README.zh-CN.md) 的「配置要点」一节。

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

- 选**允许**：命令执行，agent 获取输出后继续回答。
- 选**拒绝**：agent 收到「用户拒绝」，改用其他方式回应（例如说明无法查询）。

每次允许或拒绝都会记入审计日志，之后可以在 WebUI 的「审计」页查到；确认卡片有时限（默认 120 秒），超时按拒绝处理；回复进行中按 Ctrl+C 可取消当前这一轮。

## 4. 会话管理

REPL 里用 `/` 开头的命令管理会话：

| 命令 | 作用 |
|------|------|
| `/new 采购清单` | 创建一个带标题的新会话 |
| `/clear` | 快速创建一个不带标题的干净会话 |
| `/sessions` | 列出全部会话，用方向键选中一个，回车即切换 |
| `/help` | 列出所有可用命令（输错命令时会提示查阅） |
| `/exit` | 退出 REPL |

不手动指定标题也可以：新会话默认名为「新会话」，发出第一条消息后，kclaw 根据消息内容自动生成标题（不超过 30 字）；手动修改过的标题不会被覆盖。

历史不会丢失：每条消息都写入 `~/.kclaw/sessions/<会话id>/messages.jsonl`。要继续上次的对话，可用 `kclaw chat --session <id>` 恢复指定会话，或进入 REPL 后用 `/sessions` 选择一个。

## 5. 记忆

让 agent 记住一条用户相关信息：

```text
记住：我住在上海，习惯用中文回复
```

agent 会将其存为一条 markdown 笔记（`~/.kclaw/memory/notes/` 下的一个 `.md` 文件），并维护一份全文检索索引（SQLite FTS5——SQLite 的全文检索扩展，让关键词搜索更快）。

验证跨会话生效：

1. `/clear` 创建一个新会话。
2. 问：`我住哪？`

agent 每轮回复前都会先检索相关记忆，因此即使更换了会话，它也应知道用户住在上海。要查看、修改、删除某条记忆，直接编辑或删除对应的 `.md` 文件，kclaw 下次启动会自动同步。

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

界面是左侧会话栏加四个页面：

| 页面 | 用来做什么 |
|------|-----------|
| 对话 | 与 CLI 相同的流式对话和确认卡片；切换到别的页面时对话不中断 |
| 任务 | 定时任务的增删改、启用开关、执行结果（上一节用的就是它） |
| 审计 | 查每次工具调用的允许/拒绝记录 |
| 回收站 | 被删除的会话，可恢复或彻底删除 |

左侧会话栏可以新建、重命名、删除会话。WebUI 与 CLI 功能对等，选择哪一个仅取决于使用习惯。

## 8. 数据位置与停止方式

全部数据都在 `~/.kclaw/` 一个目录里：

```text
~/.kclaw/
├── config.yaml      # 模型配置（向导写的就是它）
├── AGENTS.md        # agent 人设，会注入系统提示词
├── token            # 访问凭证
├── daemon.json      # daemon 运行信息（端口、pid）
├── sessions/        # 每个会话一个目录，messages.jsonl 是完整对话
├── memory/          # 记忆笔记 + 检索索引
├── jobs.db          # 定时任务
├── attachments/     # 附件
└── logs/            # 日志
```

> [!TIP]
> 备份或迁移 kclaw，复制这个目录即可。

daemon 是后台常驻进程，停止方式如下：

```bash
kclaw daemon stop     # 停止 daemon
kclaw daemon status   # 查看状态（kclaw status 是同一命令的别名）
```

之后执行 `kclaw chat` 或 `kclaw web`，daemon 会自动重新启动。

遇到 `command not found: kclaw`、页面 401、端口对不上等问题，先查阅 [README](../README.zh-CN.md) 的「常见问题」表。

## 9. 下一步

- **配置要点**（[README](../README.zh-CN.md)「配置要点」一节）：`workspace` 限定文件工具的活动范围；`permissions.allow` 可以让某些命令跳过确认（如 `exec:git *`）；`exec.timeoutMs` 控制命令超时；`~/.kclaw/AGENTS.md` 定义 agent 人设。
- **扩展指南**（[extending](./extending.md)）：为 kclaw 增加新功能时的切入点。
- **架构总纲**（[architecture](./architecture.md)）：阅读内部实现时的入口文档。
