# kclaw

本地常驻的个人 agent：一个 daemon 掌管全部状态，CLI 与 WebUI 都只是它的客户端。

```
                    127.0.0.1（HTTP + WebSocket，Bearer token 鉴权）
   ┌────────────────────────────────────────────────────────────┐
   │                                                            │
   │  kclaw CLI ──────┐          ┌── WebUI（dist 静态托管）      │
   │                  ▼          ▼                               │
   │           @kclaw/server（daemon，唯一状态权威）              │
   │           ├─ RunManager：send_message → 会话串行 run        │
   │           ├─ 确认网关：高危工具经 WS 弹确认，落审计          │
   │           ├─ 调度器 tick：cron job 到点自动开新会话跑        │
   │           └─ 事件总线：28 种 AgentEvent 广播给订阅客户端     │
   │                          │                                 │
   │                          ▼                                 │
   │           @kclaw/core（纯库 agent 引擎：循环/工具/记忆/权限）│
   │                          │                                 │
   └──────────────────────────┼─────────────────────────────────┘
                              ▼
   ~/.kclaw/  config.yaml · AGENTS.md · token · daemon.json
              sessions/<id>/messages.jsonl（对话真相）
              memory/（markdown 笔记 + SQLite FTS5 索引）
              jobs.db · audit/ · attachments/
```

## 安装

要求：Node >= 22（CLI 启动时会检查，不满足直接退出）。

```bash
npm i -g kclaw

kclaw chat    # 第一次跑会进入配置向导：选 provider → 贴 key → 自动测连通
kclaw web     # 浏览器打开 WebUI（带 token，自动登录）
```

向导内置 DeepSeek / OpenAI / Ollama / 自定义模板，key 输入不回显，测通后写入 `~/.kclaw/config.yaml`（权限 0600）。不想走向导也可以手改配置或用环境变量，见「配置要点」。daemon 不用单独起：`kclaw chat` / `kclaw web` 发现它不在会自动拉起。

## 功能一览

- **流式对话**：CLI REPL 与 WebUI 同款体验，回复流式渲染，支持多轮与新建会话（试玩：问「`~/Downloads` 里最大的文件是哪个」会触发 exec 工具）。
- **确认卡片**：高危工具（exec、fs_edit 等）执行前弹确认（允许 / 拒绝），决策全部落审计日志。
- **会话**：对话逐条落盘 `sessions/<id>/messages.jsonl`，可随时恢复历史会话。
- **记忆**：说「记住我住在上海」→ 存为 markdown 笔记（带 SQLite FTS5 索引）；再问「我住哪？」直接命中。
- **任务**：cron 定时任务（如 `0 9 * * *` 每日早报），到点 daemon 自动开新会话执行，结果落审计。
- **审计**：权限决策全程留痕，WebUI「审计」页可查。

## 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| `command not found: kclaw` | npm 全局 bin 目录不在 PATH（`npm config get prefix` 看装到哪了） |
| `no llm provider configured` | 模型未配置：跑一次 `kclaw chat` 走配置向导，或按「配置要点」手写 config / 环境变量 |
| 页面打不开 / 401 | daemon 重启后端口与 token 会变：`kclaw web` 一步到位（自动带新 token 打开浏览器） |
| 高危操作没有确认弹框 | 命令命中了 `permissions.allow` 白名单（配置要点见下） |
| 数据在哪 | 全部在 `~/.kclaw/`：config.yaml · token · daemon.json · sessions/ · memory/ · jobs.db · logs/ |

## 常用命令

| 命令 | 作用 |
|------|------|
| `kclaw` / `kclaw chat` | 进入对话 REPL（默认动作） |
| `kclaw chat --session <id>` | 恢复指定会话 |
| `kclaw chat --think` | 显示 thinking 流（默认隐藏） |
| `kclaw web` | 浏览器打开 WebUI（自动带 token；daemon 不在会自动拉起） |
| `kclaw daemon start \| stop \| status` | daemon 生命周期（start 幂等，写 `~/.kclaw/daemon.json`；stop 发 SIGTERM） |
| `kclaw status` | `daemon status` 别名 |
| `kclaw jobs list` | 列出定时任务（name/cron/enabled/nextRunAt/lastStatus） |

REPL 内：`/exit` 退出、`/sessions` 列会话、`/new <title>` 开新会话；Ctrl+C 取消当前 run。

## WebUI

`packages/web`（React + Vite）是 daemon 的官方前端，构建产物由 daemon 静态托管，浏览器打开即用，功能与 CLI 对等（同一套 HTTP + WS API）：流式对话、确认卡片、会话、任务、审计。

日常入口就一条命令：

```bash
kclaw web    # 自动拉起 daemon（如需要），带 token 打开浏览器
```

备选（手动 token）：端口见 daemon 启动输出或 `kclaw daemon status`，token 即 `~/.kclaw/token` 的内容。二选一：

1. **URL 带 token**：`http://127.0.0.1:<port>/?token=<token>`
2. **页面输入**：不带 token 打开 `http://127.0.0.1:<port>/`，在 token 输入框粘贴一次，存入 localStorage 后无需重复。

## 配置要点（`~/.kclaw/config.yaml`）

配置向导写的就是这个文件，手写长这样：

```yaml
providers:
  default: my-provider
  entries:
    my-provider:
      baseUrl: https://api.example.com/v1   # 任意 OpenAI 兼容端点
      apiKey: sk-...
      model: some-model
```

- `providers`：如上；缺省时也可用 `KCLAW_LLM_BASE_URL / KCLAW_LLM_API_KEY / KCLAW_LLM_MODEL` 环境变量（config 优先于 env）。本地 Ollama 兼容：`baseUrl: http://127.0.0.1:11434/v1`、`apiKey: ollama`。
- `workspace`：文件工具（fs_read/fs_edit 等）的沙箱根目录，越界即拒绝。
- `permissions.allow / deny`：规则前缀匹配（如 `exec:git *`），allow 免确认、deny 直接拒绝、其余弹确认。
- `exec.timeoutMs / maxOutputBytes`：exec 工具的超时与输出截断。
- `web.tavilyApiKey`：可选，启用 web_search。
- `~/.kclaw/AGENTS.md`：agent 人设，注入系统提示词。

数据目录可用 `KCLAW_HOME` 或 `--home <dir>` 重定向（测试友好）。

## 开发

从源码构建（普通用户走上面的 `npm i -g kclaw` 即可，不用看这里）。平台：macOS 与 Linux；Windows 未承诺支持。

monorepo（pnpm workspace）：

- `packages/core`：agent 引擎，纯库（循环 / 工具 / 记忆 / 权限）
- `packages/server`：daemon（HTTP + WS + 调度 + 审计）
- `packages/cli`：CLI 客户端（源码形态）
- `packages/web`：WebUI 前端（React + Vite）
- `packages/kclaw`：npm 发布包（聚合各包产物，`npm i -g kclaw` 装的就是它）

```bash
pnpm install
pnpm build
pnpm typecheck   # 全部包 tsc --noEmit
pnpm test        # 全部包 vitest（cli/server 冒烟需先 pnpm build）
```

文档：

- [核心原理：agent 引擎](docs/core-internals.md)
- [核心原理：持久化与工具](docs/persistence-and-tools.md)
- [核心原理：daemon 与 CLI](docs/daemon-and-cli.md)
- [核心原理：WebUI 与全系统收束](docs/webui-and-system.md)
- [扩展指南：加一个新功能要动哪里](docs/extending.md)
